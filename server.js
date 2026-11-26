import express from 'express';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { SERVICE_TOKEN_ENV, createResultsHandler } from './game-results.js';
import {
  ALL_PRIVILEGES,
  ROLE_PRESETS,
  SESSION_COOKIE_NAME,
  StoreError,
  cleanAvatar,
  cleanDisplayName,
  cleanPrivileges,
  cleanRole,
  createAuthStore,
  generatePin,
  generateStrongPassword,
  hasPrivilege,
  isUserExpired,
  toActor,
  toAdminUser,
  toGameUserPayload,
  toPublicUser,
} from './auth-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const services = JSON.parse(readFileSync(path.join(__dirname, 'src/config/services.json'), 'utf8'));

// ---------- Cookie & IP helpers ----------
const parseCookies = (header = '') => {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
};

const isHttpsRequest = (request) => Boolean(
  request.secure
  || String(request.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase() === 'https'
  || String(request.get('cf-visitor') || '').includes('"https"'),
);

const setSessionCookie = (request, response, token, expiresAt) => {
  const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (isHttpsRequest(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
};

const clearSessionCookie = (request, response) => {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (isHttpsRequest(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
};

// Prefer Cloudflare's client IP or the first X-Forwarded-For entry so visitors behind Cloudflare Tunnel -> CT 101 nginx don't share one rate-limit bucket
const visitor = (request) => request.get('cf-connecting-ip')?.trim() || String(request.get('x-forwarded-for') || '').split(',')[0].trim() || request.socket?.remoteAddress || '?';

const timingSafeMatch = (aStr, bStr) => {
  if (!aStr || !bStr) return false;
  const a = Buffer.from(String(aStr));
  const b = Buffer.from(String(bStr));
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---------- Proxmox & Agent default helpers ----------
// Proxmox uses a self-signed certificate on :8006. Set PROXMOX_INSECURE_TLS=1 to accept it
// (only on a trusted network such as the LAN or Tailscale).
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const baseUrl = () => (process.env.PROXMOX_URL || '').replace(/\/$/, '');

const defaultPve = (apiPath, { method = 'GET', form, read = false } = {}) => new Promise((resolve, reject) => {
  // One token can do both; a separate read-only token is used for stats when set.
  const id = read ? (process.env.PROXMOX_READ_TOKEN_ID || process.env.PROXMOX_TOKEN_ID) : (process.env.PROXMOX_TOKEN_ID || process.env.PROXMOX_READ_TOKEN_ID);
  const secret = read ? (process.env.PROXMOX_READ_TOKEN_SECRET || process.env.PROXMOX_TOKEN_SECRET) : (process.env.PROXMOX_TOKEN_SECRET || process.env.PROXMOX_READ_TOKEN_SECRET);
  const url = new URL(baseUrl() + apiPath);
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const request = https.request(url, {
    method,
    agent: process.env.PROXMOX_INSECURE_TLS === '1' ? insecureAgent : undefined,
    timeout: 8000,
    headers: {
      Authorization: `PVEAPIToken=${id}=${secret}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
    },
  }, (response) => {
    let raw = '';
    response.on('data', (chunk) => { raw += chunk; });
    response.on('end', () => {
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON error page */ }
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(payload.errors ? JSON.stringify(payload.errors) : `Proxmox answered ${response.statusCode}`));
      } else resolve(payload.data);
    });
  });
  request.on('timeout', () => request.destroy(new Error('Proxmox did not answer in time.')));
  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

const defaultAgent = async (base, token, method, apiPath, body, timeoutMs = 20000) => {
  if (!base || !token) throw Object.assign(new Error('Sites are not set up yet (agent URL/token missing in .env).'), { status: 503 });
  const response = await fetch(base.replace(/\/$/, '') + apiPath, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `Agent answered ${response.status}`), { status: response.status });
  return data;
};

const defaultHubCall = async (method, apiPath, body) => {
  const base = (process.env.HUB_URL || '').replace(/\/$/, '');
  const key = process.env.HUB_API_KEY || '';
  if (!base || !key) throw Object.assign(new Error('The agents hub is not set up yet (HUB_URL and HUB_API_KEY in .env on FrontPage).'), { status: 503 });
  const response = await fetch(base + apiPath, {
    method,
    signal: AbortSignal.timeout(12000),
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || `Hub answered ${response.status}`), { status: response.status });
  return data;
};

// ---------- App Factory ----------
export function createApp(options = {}) {
  const app = express();
  const store = options.store || createAuthStore();
  app.locals.store = store;

  const pve = options.pveImpl || defaultPve;
  const pveIsInjected = Boolean(options.pveImpl);
  const proxyAgent = options.proxyAgentImpl || ((method, apiPath, body) => defaultAgent(process.env.PROXY_AGENT_URL, process.env.PROXY_AGENT_TOKEN, method, apiPath, body));
  const siteAgent = options.siteAgentImpl || ((method, apiPath, body, ms) => defaultAgent(process.env.SITE_AGENT_URL, process.env.SITE_AGENT_TOKEN, method, apiPath, body, ms));
  const hostAgent = options.hostAgentImpl || ((method, apiPath, body, ms) => defaultAgent(process.env.HOST_AGENT_URL, process.env.HOST_AGENT_TOKEN, method, apiPath, body, ms));
  const hubCall = options.hubCallImpl || defaultHubCall;
  const hostConfigured = () => Boolean(options.hostAgentImpl || process.env.HOST_AGENT_URL);

  const NOTES_FILE = options.notesFile || process.env.NOTES_FILE || path.join(__dirname, 'data', 'notes.json');
  const UPTIME_FILE = options.uptimeFile || path.join(__dirname, 'data', 'uptime.json');
  const runBg = options.backgroundJobs === true;

  app.use(express.json({ limit: '256kb' }));

  const statsConfigured = () => pveIsInjected || Boolean(
    baseUrl()
    && process.env.PROXMOX_NODE
    && (process.env.PROXMOX_READ_TOKEN_ID || process.env.PROXMOX_TOKEN_ID)
    && (process.env.PROXMOX_READ_TOKEN_SECRET || process.env.PROXMOX_TOKEN_SECRET),
  );
  const node = () => encodeURIComponent(process.env.PROXMOX_NODE || 'pve');

  // ---------- Rate Limiters ----------
  const mainPassword = () => (options.dashboardPassword !== undefined
    ? String(options.dashboardPassword ?? '')
    : (process.env.DASHBOARD_PASSWORD || process.env.PROVISION_PASSWORD || ''));
  const readLegacyHeader = (request) => {
    const raw = request.get('x-dashboard-password') ?? request.get('x-provision-password') ?? '';
    return raw === '__sso__' ? '' : raw;
  };
  const misses = new Map();
  let allMisses = [];
  let lastSlowTry = 0;

  const lockedOut = (request) => {
    const now = Date.now();
    const m = misses.get(visitor(request));
    if (m && m.until > now) return Math.ceil((m.until - now) / 1000);
    allMisses = allMisses.filter((t) => now - t < 15 * 60000);
    if (allMisses.length >= 30 && now - lastSlowTry < 10000) return Math.ceil((10000 - (now - lastSlowTry)) / 1000);
    return 0;
  };

  const recordLegacyMiss = (request) => {
    const now = Date.now();
    const who = visitor(request);
    const m = misses.get(who) && now - misses.get(who).first < 15 * 60000 ? misses.get(who) : { count: 0, first: now, until: 0 };
    m.count += 1;
    if (m.count >= 5) m.until = now + 15 * 60000;
    misses.set(who, m);
    allMisses.push(now);
    lastSlowTry = now;
    console.warn(`[login] wrong password from ${who} (${m.count} in 15 min${m.until ? ', locked for 15 min' : ''})`);
  };

  const passwordOk = (request) => {
    const expected = mainPassword();
    const given = readLegacyHeader(request);
    if (!expected || !given) return false;
    if (lockedOut(request)) return false;
    const ok = timingSafeMatch(given, expected);
    if (ok) {
      misses.delete(visitor(request));
      return true;
    }
    recordLegacyMiss(request);
    return false;
  };

  const lockMessage = (request) => {
    const s = lockedOut(request);
    return s ? `Too many wrong passwords. Try again in ${s > 60 ? `${Math.ceil(s / 60)} min` : `${s} s`}.` : 'Wrong password.';
  };

  // SSO login rate limiter: 10 fails / 15 min per IP -> 429
  const loginFails = new Map();
  const LOGIN_FAIL_LIMIT = 10;
  const LOGIN_FAIL_WINDOW = 15 * 60000;

  const loginLockSeconds = (ip) => {
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (!rec) return 0;
    if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
    if (now - rec.first >= LOGIN_FAIL_WINDOW) {
      loginFails.delete(ip);
      return 0;
    }
    return 0;
  };

  const recordLoginFail = (ip) => {
    const now = Date.now();
    const prev = loginFails.get(ip);
    const rec = prev && now - prev.first < LOGIN_FAIL_WINDOW ? prev : { count: 0, first: now, until: 0 };
    rec.count += 1;
    if (rec.count >= LOGIN_FAIL_LIMIT) rec.until = now + LOGIN_FAIL_WINDOW;
    loginFails.set(ip, rec);
    return rec;
  };

  const clearLoginFails = (ip) => {
    loginFails.delete(ip);
  };

  // ---------- Unified Auth Resolver & RBAC Middleware ----------
  const LEGACY_OWNER_ACTOR = Object.freeze({
    id: 'legacy-owner',
    username: 'owner',
    displayName: 'Legacy Main Password',
    role: 'owner',
    privileges: [...ALL_PRIVILEGES],
    isLegacy: true,
  });

  const extractToken = (request) => {
    const auth = String(request.get('authorization') || '');
    if (auth.toLowerCase().startsWith('bearer ')) {
      const t = auth.slice(7).trim();
      if (t) return { token: t, source: 'bearer' };
    }
    const hubTok = String(request.get('x-hub-token') || '').trim();
    if (hubTok) return { token: hubTok, source: 'hub-header' };
    const cookies = parseCookies(request.get('cookie'));
    const cookieTok = String(cookies[SESSION_COOKIE_NAME] || '').trim();
    if (cookieTok) return { token: cookieTok, source: 'cookie' };
    return { token: '', source: null };
  };

  const resolveActor = async (request) => {
    const { token, source } = extractToken(request);
    if (token) {
      const found = await store.resolveSession(token);
      if (!found) {
        return { actor: null, hadToken: true, tokenSource: source, authStatus: 401, authError: 'Invalid or expired session.' };
      }
      const { session, user } = found;
      if (user.disabled) {
        return { actor: null, hadToken: true, tokenSource: source, authStatus: 403, authError: 'Account is disabled.', blockedUser: user };
      }
      if (isUserExpired(user)) {
        return { actor: null, hadToken: true, tokenSource: source, authStatus: 401, authError: 'Guest account has expired.', blockedUser: user };
      }
      return { actor: toActor(user), session, user, hadToken: true, tokenSource: source };
    }

    const givenLegacy = readLegacyHeader(request);
    if (givenLegacy !== '') {
      const settings = await store.getAuthSettings();
      if (!settings.allowLegacyPassword) {
        return { actor: null, hadToken: false, authStatus: 401, authError: 'Legacy main password login has been disabled.' };
      }
      if (!mainPassword()) {
        return { actor: null, hadToken: false, authStatus: 503, authError: 'Create/delete is off. Set DASHBOARD_PASSWORD in .env on FrontPage.' };
      }
      if (lockedOut(request)) {
        return { actor: null, hadToken: false, authStatus: 429, authError: lockMessage(request) };
      }
      if (passwordOk(request)) {
        return { actor: LEGACY_OWNER_ACTOR, session: null, user: null, hadToken: false };
      }
      return { actor: null, hadToken: false, authStatus: lockedOut(request) ? 429 : 401, authError: lockMessage(request) };
    }

    return { actor: null, hadToken: false, authStatus: 401, authError: 'Authentication required.' };
  };

  const requirePriv = (priv) => async (request, response, next) => {
    const res = await resolveActor(request);
    if (!res.actor) {
      if (res.blockedUser) {
        await store.writeAudit({
          actor: toActor(res.blockedUser),
          ip: visitor(request),
          action: 'auth.access_denied',
          target: request.originalUrl || request.path,
          status: 'denied',
          details: { reason: res.authError, requiredPriv: priv },
        }).catch(() => {});
      }
      const msg = res.authError || 'Authentication required.';
      return response.status(res.authStatus || 401).json({ message: msg, error: msg });
    }
    request.actor = res.actor;
    request.authSession = res.session || null;
    request.authUser = res.user || null;
    if (!hasPrivilege(res.actor, priv)) {
      await store.writeAudit({
        actor: res.actor,
        ip: visitor(request),
        action: 'rbac.denied',
        target: request.originalUrl || request.path,
        status: 'denied',
        details: { requiredPriv: priv, method: request.method },
      }).catch(() => {});
      const msg = `Missing privilege: ${priv}`;
      return response.status(403).json({ message: msg, error: msg });
    }
    return next();
  };

  const audit = (request, action, target = '', status = 'ok', details = {}, extra = {}) =>
    store.writeAudit({
      actor: request.actor || extra.actor || null,
      ip: visitor(request),
      action,
      target,
      status,
      sandboxTag: extra.sandboxTag ?? (request.actor?.role === 'recruiter_guest'),
      details,
    }).catch(() => {});

  // ---------- Unified SSO Auth Endpoints (/api/auth/*) ----------
  app.get('/api/auth/me', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const [res, ownerCount, settings] = await Promise.all([
      resolveActor(request),
      store.countOwners(),
      store.getAuthSettings(),
    ]);
    const needsBootstrap = ownerCount === 0;
    if (res.actor) {
      const publicUser = res.actor.isLegacy
        ? { ...res.actor, avatar: 'netrunner', xp: 0, eddies: 0, eddiesEarned: 0, level: 1, disabled: false, expiresAt: null }
        : toPublicUser(res.user);
      return response.json({
        authenticated: true,
        needsBootstrap,
        allowLegacyPassword: settings.allowLegacyPassword,
        user: publicUser,
      });
    }
    if (res.hadToken && res.tokenSource === 'cookie') {
      clearSessionCookie(request, response);
    }
    return response.json({
      authenticated: false,
      needsBootstrap,
      allowLegacyPassword: settings.allowLegacyPassword,
      user: null,
      ...(res.hadToken && res.authError ? { message: res.authError, error: res.authError } : {}),
    });
  });

  app.post('/api/auth/bootstrap', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body = request.body ?? {};
    const ownerCount = await store.countOwners();
    if (ownerCount > 0) {
      await audit(request, 'auth.bootstrap', String(body.username || ''), 'denied', { reason: 'already_bootstrapped' });
      return response.status(409).json({ message: 'Owner account already exists. Bootstrap is closed.' });
    }
    const expectedMain = mainPassword();
    if (expectedMain) {
      if (lockedOut(request)) {
        return response.status(429).json({ message: lockMessage(request) });
      }
      const givenMain = body.mainPassword ?? readLegacyHeader(request);
      if (!timingSafeMatch(givenMain, expectedMain)) {
        recordLegacyMiss(request);
        await audit(request, 'auth.bootstrap', String(body.username || ''), 'failed', { reason: 'bad_main_password' });
        return response.status(lockedOut(request) ? 429 : 401).json({
          message: lockedOut(request) ? lockMessage(request) : 'Valid main dashboard password is required to bootstrap owner.',
        });
      }
      misses.delete(visitor(request));
    }

    const user = await store.createUser({
      username: body.username,
      displayName: body.displayName,
      role: 'owner',
      privileges: [...ALL_PRIVILEGES],
      password: body.password,
      avatar: body.avatar,
    });
    const { token, session } = await store.createSession({
      userId: user._id,
      ip: visitor(request),
      userAgent: request.get('user-agent') || '',
    });
    const updated = await store.updateUser(user._id, { lastLoginAt: new Date() });
    setSessionCookie(request, response, token, session.expiresAt);
    await store.writeAudit({
      actor: toActor(updated),
      ip: visitor(request),
      action: 'auth.bootstrap',
      target: updated.username,
      status: 'ok',
    });
    return response.status(201).json({ ok: true, user: toPublicUser(updated) });
  });

  app.post('/api/auth/login', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const ip = visitor(request);
    const lockSec = loginLockSeconds(ip);
    const body = request.body ?? {};
    const username = String(body.username ?? body.handle ?? '').trim();
    if (lockSec > 0) {
      await store.writeAudit({
        actor: null,
        ip,
        action: 'auth.login_failed',
        target: username,
        status: 'denied',
        details: { reason: 'rate_limited', retryAfterSec: lockSec },
      }).catch(() => {});
      return response.status(429).json({ message: `Too many failed login attempts. Try again in ${Math.ceil(lockSec / 60)} min.` });
    }

    const secret = body.password ?? body.pin;
    const user = await store.findUserByUsername(username);
    if (!user || (typeof secret !== 'string' && typeof secret !== 'number') || !store.verifyUserSecret(user, String(secret))) {
      const rec = recordLoginFail(ip);
      await store.writeAudit({
        actor: null,
        ip,
        action: 'auth.login_failed',
        target: username,
        status: 'failed',
        details: { attemptsInWindow: rec.count },
      }).catch(() => {});
      if (rec.until > Date.now()) {
        return response.status(429).json({ message: 'Too many failed login attempts. Locked for 15 minutes.' });
      }
      return response.status(401).json({ message: 'Invalid username or password.' });
    }

    if (user.disabled) {
      await store.writeAudit({
        actor: toActor(user),
        ip,
        action: 'auth.login_failed',
        target: user.username,
        status: 'denied',
        details: { reason: 'disabled' },
      }).catch(() => {});
      return response.status(403).json({ message: 'Account is disabled.' });
    }

    if (isUserExpired(user)) {
      await store.writeAudit({
        actor: toActor(user),
        ip,
        action: 'auth.login_failed',
        target: user.username,
        status: 'denied',
        details: { reason: 'expired' },
      }).catch(() => {});
      return response.status(401).json({ message: 'Guest account has expired.' });
    }

    clearLoginFails(ip);
    const { token, session } = await store.createSession({
      userId: user._id,
      ip,
      userAgent: request.get('user-agent') || '',
      userExpiresAt: user.expiresAt,
    });
    const updated = await store.updateUser(user._id, { lastLoginAt: new Date() });
    setSessionCookie(request, response, token, session.expiresAt);
    await store.writeAudit({
      actor: toActor(updated),
      ip,
      action: 'auth.login',
      target: updated.username,
      status: 'ok',
      details: { role: updated.role },
    }).catch(() => {});
    return response.json({ ok: true, token, user: toPublicUser(updated) });
  });

  app.post('/api/auth/register', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body = request.body ?? {};
    const user = await store.createUser({
      username: body.username ?? body.handle,
      displayName: body.displayName,
      role: 'player',
      privileges: [...ROLE_PRESETS.player],
      pin: body.pin,
      avatar: body.avatar,
    });
    const { token, session } = await store.createSession({
      userId: user._id,
      ip: visitor(request),
      userAgent: request.get('user-agent') || '',
    });
    const updated = await store.updateUser(user._id, { lastLoginAt: new Date() });
    setSessionCookie(request, response, token, session.expiresAt);
    await store.writeAudit({
      actor: toActor(updated),
      ip: visitor(request),
      action: 'auth.register',
      target: updated.username,
      status: 'ok',
    }).catch(() => {});
    return response.status(201).json({ ok: true, created: true, token, user: toPublicUser(updated) });
  });

  app.post('/api/auth/logout', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const { token } = extractToken(request);
    let actor = null;
    if (token) {
      const found = await store.resolveSession(token).catch(() => null);
      if (found?.user) actor = toActor(found.user);
      await store.revokeSession(token).catch(() => {});
    }
    clearSessionCookie(request, response);
    if (actor) {
      await store.writeAudit({ actor, ip: visitor(request), action: 'auth.logout', target: actor.username, status: 'ok' }).catch(() => {});
    }
    return response.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const res = await resolveActor(request);
    if (!res.actor) {
      return response.status(res.authStatus || 401).json({ message: res.authError || 'Authentication required.' });
    }
    if (res.actor.isLegacy || !res.user) {
      return response.status(400).json({ message: 'Legacy main password cannot be changed here; update DASHBOARD_PASSWORD in .env.' });
    }
    const body = request.body ?? {};
    const currentSecret = body.currentPassword ?? body.currentPin ?? '';
    const newSecret = body.newPassword ?? body.newPin;
    if (!store.verifyUserSecret(res.user, String(currentSecret))) {
      await store.writeAudit({
        actor: res.actor,
        ip: visitor(request),
        action: 'auth.change_password',
        target: res.user.username,
        status: 'failed',
      }).catch(() => {});
      return response.status(401).json({ message: 'Current password is incorrect.' });
    }
    await store.changeUserSecret(res.user._id, newSecret, res.user.role);
    const revokedCount = await store.revokeUserSessions(res.user._id, {
      exceptSessionId: res.session?._id || null,
    });
    await store.writeAudit({
      actor: res.actor,
      ip: visitor(request),
      action: 'auth.change_password',
      target: res.user.username,
      status: 'ok',
      details: { revokedOtherSessions: revokedCount },
    }).catch(() => {});
    return response.json({ ok: true, revokedOtherSessions: revokedCount });
  });

  // ---------- Admin Users & Audit Endpoints (manage_users) ----------
  app.get('/api/admin/users', requirePriv('manage_users'), async (_request, response) => {
    const [users, settings] = await Promise.all([
      store.listUsersWithStats(),
      store.getAuthSettings(),
    ]);
    return response.json({
      users,
      privileges: ALL_PRIVILEGES,
      presets: ROLE_PRESETS,
      settings,
    });
  });

  app.post('/api/admin/users', requirePriv('manage_users'), async (request, response) => {
    const body = request.body ?? {};
    const role = cleanRole(body.role);
    if (role === 'owner' && request.actor.role !== 'owner') {
      await audit(request, 'user.create', String(body.username || ''), 'denied', { reason: 'non_owner_create_owner' });
      return response.status(403).json({ message: 'Only an owner can create another owner account.' });
    }
    const privileges = cleanPrivileges(body.privileges, role);
    if (role !== 'owner' && privileges.includes('manage_users') && request.actor.role !== 'owner') {
      await audit(request, 'user.create', String(body.username || ''), 'denied', { reason: 'non_owner_grant_manage_users' });
      return response.status(403).json({ message: 'Only an owner can grant manage_users privilege.' });
    }

    let expiresAt = null;
    if (body.durationHours !== undefined && body.durationHours !== null && body.durationHours !== '') {
      const hrs = Number(body.durationHours);
      if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 8760) {
        return response.status(400).json({ message: 'durationHours must be between 0 and 8760.' });
      }
      expiresAt = new Date(Date.now() + hrs * 3600_000);
    } else if (body.expiresAt !== undefined) {
      if (body.expiresAt !== null && body.expiresAt !== '') {
        const dt = new Date(body.expiresAt);
        if (Number.isNaN(dt.getTime())) return response.status(400).json({ message: 'Invalid expiresAt date.' });
        expiresAt = dt;
      }
    } else if (role === 'recruiter_guest') {
      expiresAt = new Date(Date.now() + 48 * 3600_000);
    }

    const suppliedSecret = body.password ?? body.pin;
    let generatedPassword = null;
    let secretToUse = suppliedSecret;
    if (suppliedSecret === undefined || suppliedSecret === null || suppliedSecret === '') {
      generatedPassword = role === 'player' ? generatePin(6) : generateStrongPassword(12);
      secretToUse = generatedPassword;
    }

    const created = await store.createUser({
      username: body.username,
      displayName: body.displayName,
      role,
      privileges,
      password: role === 'player' ? undefined : secretToUse,
      pin: role === 'player' ? secretToUse : undefined,
      note: body.note || '',
      avatar: body.avatar,
      expiresAt,
    });

    await audit(
      request,
      role === 'recruiter_guest' ? 'guest.create' : 'user.create',
      created.username,
      'ok',
      { role, privileges, expiresAt: created.expiresAt, note: created.note, autoGeneratedSecret: Boolean(generatedPassword) },
    );

    return response.status(201).json({
      ok: true,
      user: toAdminUser(created, 0),
      ...(generatedPassword ? { generatedPassword } : {}),
    });
  });

  app.patch('/api/admin/users/:id', requirePriv('manage_users'), async (request, response) => {
    const target = await store.findUserById(request.params.id);
    if (!target) return response.status(404).json({ message: 'User not found.' });

    if (target.role === 'owner' && request.actor.role !== 'owner') {
      await audit(request, 'user.update', target.username, 'denied', { reason: 'non_owner_modify_owner' });
      return response.status(403).json({ message: 'Only an owner can modify an owner account.' });
    }

    const body = request.body ?? {};
    const patch = {};
    let nextRole = target.role;

    if (body.role !== undefined) {
      nextRole = cleanRole(body.role);
      if (nextRole === 'owner' && request.actor.role !== 'owner') {
        await audit(request, 'user.update', target.username, 'denied', { reason: 'non_owner_promote_owner' });
        return response.status(403).json({ message: 'Only an owner can promote a user to owner.' });
      }
      if (target.role === 'owner' && nextRole !== 'owner') {
        const otherOwners = await store.countActiveOwners(target._id);
        if (otherOwners < 1) {
          return response.status(400).json({ message: 'Cannot demote the last active owner.' });
        }
      }
      patch.role = nextRole;
    }

    if (body.privileges !== undefined) {
      const nextPrivs = cleanPrivileges(body.privileges, nextRole);
      if (nextRole !== 'owner' && nextPrivs.includes('manage_users') && request.actor.role !== 'owner') {
        await audit(request, 'user.update', target.username, 'denied', { reason: 'non_owner_grant_manage_users' });
        return response.status(403).json({ message: 'Only an owner can grant manage_users privilege.' });
      }
      patch.privileges = nextPrivs;
    } else if (body.role !== undefined && body.role !== target.role) {
      patch.privileges = [...ROLE_PRESETS[nextRole]];
    }

    if (body.displayName !== undefined) {
      patch.displayName = cleanDisplayName(body.displayName, target.username);
    }
    if (body.note !== undefined) {
      patch.note = String(body.note || '').slice(0, 500);
    }
    if (body.avatar !== undefined) {
      patch.avatar = cleanAvatar(body.avatar, target.avatar || 'netrunner');
    }
    if (body.disabled !== undefined) {
      const nextDisabled = Boolean(body.disabled);
      if (nextDisabled && target.role === 'owner' && nextRole === 'owner') {
        const otherOwners = await store.countActiveOwners(target._id);
        if (otherOwners < 1) {
          return response.status(400).json({ message: 'Cannot disable the last active owner.' });
        }
      }
      patch.disabled = nextDisabled;
    }

    let extended = false;
    if (body.extendHours !== undefined) {
      const hrs = Number(body.extendHours);
      if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 8760) {
        return response.status(400).json({ message: 'extendHours must be between 0 and 8760.' });
      }
      const base = Math.max(Date.now(), target.expiresAt ? new Date(target.expiresAt).getTime() : Date.now());
      patch.expiresAt = new Date(base + hrs * 3600_000);
      extended = true;
    } else if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        patch.expiresAt = null;
      } else {
        const dt = new Date(body.expiresAt);
        if (Number.isNaN(dt.getTime())) return response.status(400).json({ message: 'Invalid expiresAt date.' });
        patch.expiresAt = dt;
        if (!target.expiresAt || dt.getTime() > new Date(target.expiresAt).getTime()) extended = true;
      }
    }

    const updated = await store.updateUser(target._id, patch);
    if (patch.disabled === true) {
      await store.revokeUserSessions(target._id);
    }

    let action = 'user.update';
    if (target.role === 'recruiter_guest' && patch.disabled === true) action = 'guest.revoke';
    else if (target.role === 'recruiter_guest' && extended) action = 'guest.extend';

    await audit(request, action, updated.username, 'ok', { changed: Object.keys(patch) });
    return response.json({ ok: true, user: toAdminUser(updated, 0) });
  });

  app.post('/api/admin/users/:id/reset-password', requirePriv('manage_users'), async (request, response) => {
    const target = await store.findUserById(request.params.id);
    if (!target) return response.status(404).json({ message: 'User not found.' });
    if (target.role === 'owner' && request.actor.role !== 'owner') {
      await audit(request, 'user.reset_password', target.username, 'denied', { reason: 'non_owner_reset_owner' });
      return response.status(403).json({ message: 'Only an owner can reset an owner password.' });
    }
    const raw = request.body?.password ?? request.body?.pin;
    const newPassword = raw !== undefined && raw !== ''
      ? raw
      : (target.role === 'player' ? generatePin(6) : generateStrongPassword(12));
    await store.changeUserSecret(target._id, newPassword, target.role);
    const revokedCount = await store.revokeUserSessions(target._id);
    await audit(request, 'user.reset_password', target.username, 'ok', { role: target.role, revokedSessions: revokedCount });
    return response.json({ ok: true, newPassword: String(newPassword) });
  });

  app.post('/api/admin/users/:id/revoke-sessions', requirePriv('manage_users'), async (request, response) => {
    const target = await store.findUserById(request.params.id);
    if (!target) return response.status(404).json({ message: 'User not found.' });
    if (target.role === 'owner' && request.actor.role !== 'owner') {
      await audit(request, 'user.revoke_sessions', target.username, 'denied', { reason: 'non_owner_revoke_owner' });
      return response.status(403).json({ message: 'Only an owner can revoke owner sessions.' });
    }
    const revokedCount = await store.revokeUserSessions(target._id);
    await audit(request, 'user.revoke_sessions', target.username, 'ok', { revokedCount });
    return response.json({ ok: true, revokedCount });
  });

  app.delete('/api/admin/users/:id', requirePriv('manage_users'), async (request, response) => {
    const target = await store.findUserById(request.params.id);
    if (!target) return response.status(404).json({ message: 'User not found.' });
    if (target.role === 'owner') {
      await audit(request, 'user.delete', target.username, 'denied', { reason: 'cannot_delete_owner' });
      return response.status(403).json({ message: 'Owner accounts cannot be deleted. Demote first if another owner exists.' });
    }
    if (String(target._id) === String(request.actor.id)) {
      return response.status(400).json({ message: 'Cannot delete your own active account.' });
    }
    await store.deleteUser(target._id);
    await audit(request, 'user.delete', target.username, 'ok', { role: target.role });
    return response.json({ ok: true, deleted: String(target._id) });
  });

  app.get('/api/admin/audit', requirePriv('manage_users'), async (request, response) => {
    const [logs, sandboxSummary] = await Promise.all([
      store.queryAudit({
        action: request.query.action,
        actor: request.query.actor,
        role: request.query.role,
        sandboxOnly: request.query.sandboxOnly,
        q: request.query.q,
        limit: request.query.limit ?? 150,
      }),
      store.getSandboxSummary(),
    ]);
    return response.json({ logs, sandboxSummary });
  });

  app.put('/api/admin/settings', requirePriv('manage_users'), async (request, response) => {
    if (request.actor.role !== 'owner') {
      await audit(request, 'settings.update', 'auth', 'denied', { reason: 'owner_required' });
      return response.status(403).json({ message: 'Only an owner can modify authentication settings.' });
    }
    const { allowLegacyPassword } = request.body ?? {};
    if (typeof allowLegacyPassword !== 'boolean') {
      return response.status(400).json({ message: 'allowLegacyPassword must be a boolean.' });
    }
    if (!allowLegacyPassword) {
      const activeOwners = await store.countActiveOwners();
      if (activeOwners < 1) {
        return response.status(400).json({ message: 'Create at least one active owner account before disabling the legacy main password.' });
      }
    }
    const settings = await store.updateAuthSettings({ allowLegacyPassword });
    await audit(request, 'settings.update', 'auth', 'ok', { allowLegacyPassword: settings.allowLegacyPassword });
    return response.json({ ok: true, settings });
  });

  // ---------- Unified Game Hub API (/api/game/*) ----------
  app.use('/api/game', (request, response, next) => {
    const origin = request.get('origin');
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Token');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return response.status(204).end();
    return next();
  });

  const requireGameUser = async (request, response, next) => {
    const { token, source } = extractToken(request);
    if (!token) {
      const msg = 'Sign in first (missing token or session).';
      return response.status(401).json({ error: msg, message: msg });
    }
    const found = await store.resolveSession(token);
    if (!found) {
      if (source === 'cookie') clearSessionCookie(request, response);
      const msg = 'Invalid or expired session.';
      return response.status(401).json({ error: msg, message: msg });
    }
    const { session, user } = found;
    if (user.disabled) {
      const msg = 'Account is disabled.';
      return response.status(403).json({ error: msg, message: msg });
    }
    if (isUserExpired(user)) {
      const msg = 'Guest account has expired.';
      return response.status(401).json({ error: msg, message: msg });
    }
    if (!hasPrivilege(user, 'play_games')) {
      const msg = 'Missing privilege: play_games';
      return response.status(403).json({ error: msg, message: msg });
    }
    request.actor = toActor(user);
    request.authSession = session;
    request.authUser = user;
    return next();
  };

  app.get('/api/game/health', async (_request, response) => {
    try {
      return response.json(await store.health());
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Database unavailable.';
      return response.status(503).json({ ok: false, error: msg, message: msg });
    }
  });

  app.post('/api/game/auth', async (request, response) => {
    const ip = visitor(request);
    const lockSec = loginLockSeconds(ip);
    if (lockSec > 0) {
      const msg = `Too many failed attempts - try again in ${Math.ceil(lockSec / 60)} min`;
      return response.status(429).json({ error: msg, message: msg });
    }

    const body = request.body ?? {};
    const hasPassword = body.password !== undefined;
    const hasPin = body.pin !== undefined;

    if (hasPassword && !hasPin) {
      const username = String(body.username ?? body.handle ?? '').trim();
      const user = await store.findUserByUsername(username);
      if (!user || typeof body.password !== 'string' || !store.verifyUserSecret(user, body.password)) {
        const rec = recordLoginFail(ip);
        await store.writeAudit({
          actor: null,
          ip,
          action: 'auth.game_login_failed',
          target: username,
          status: 'failed',
          details: { mode: 'password', attemptsInWindow: rec.count },
        }).catch(() => {});
        const status = rec.until > Date.now() ? 429 : 401;
        const msg = status === 429 ? 'Too many failed login attempts. Locked for 15 minutes.' : 'Invalid username or password.';
        return response.status(status).json({ error: msg, message: msg });
      }
      if (user.disabled) return response.status(403).json({ error: 'Account is disabled.', message: 'Account is disabled.' });
      if (isUserExpired(user)) return response.status(401).json({ error: 'Guest account has expired.', message: 'Guest account has expired.' });
      if (!hasPrivilege(user, 'play_games')) {
        return response.status(403).json({ error: 'Missing privilege: play_games', message: 'Missing privilege: play_games' });
      }

      clearLoginFails(ip);
      const { token, session } = await store.createSession({
        userId: user._id,
        ip,
        userAgent: request.get('user-agent') || '',
        userExpiresAt: user.expiresAt,
      });
      const updated = await store.updateUser(user._id, { lastLoginAt: new Date() });
      setSessionCookie(request, response, token, session.expiresAt);
      await store.writeAudit({
        actor: toActor(updated),
        ip,
        action: 'auth.game_login',
        target: updated.username,
        status: 'ok',
        details: { mode: 'password' },
      }).catch(() => {});
      return response.json({ ok: true, created: false, token, user: toGameUserPayload(updated) });
    }

    if (hasPin) {
      const handleRaw = body.handle ?? body.username;
      const avatar = cleanAvatar(body.avatar, 'netrunner');
      const pinStr = typeof body.pin === 'number' && Number.isFinite(body.pin) ? String(body.pin) : body.pin;
      if (typeof pinStr !== 'string' || !/^\d{4,8}$/.test(pinStr)) {
        return response.status(400).json({ error: 'PIN must be 4-8 digits.', message: 'PIN must be 4-8 digits.' });
      }
      const existing = typeof handleRaw === 'string' ? await store.findUserByUsername(handleRaw) : null;
      if (!existing) {
        const created = await store.createUser({
          username: handleRaw,
          role: 'player',
          privileges: [...ROLE_PRESETS.player],
          pin: pinStr,
          avatar,
        });
        clearLoginFails(ip);
        const { token, session } = await store.createSession({
          userId: created._id,
          ip,
          userAgent: request.get('user-agent') || '',
        });
        const updated = await store.updateUser(created._id, { lastLoginAt: new Date() });
        setSessionCookie(request, response, token, session.expiresAt);
        await store.writeAudit({
          actor: toActor(updated),
          ip,
          action: 'auth.register',
          target: updated.username,
          status: 'ok',
          details: { via: 'game_hub' },
        }).catch(() => {});
        return response.status(201).json({ ok: true, created: true, token, user: toGameUserPayload(updated) });
      }

      if (!store.verifyUserSecret(existing, pinStr)) {
        const rec = recordLoginFail(ip);
        await store.writeAudit({
          actor: null,
          ip,
          action: 'auth.game_login_failed',
          target: existing.username,
          status: 'failed',
          details: { mode: 'pin', attemptsInWindow: rec.count },
        }).catch(() => {});
        const status = rec.until > Date.now() ? 429 : 401;
        const msg = status === 429 ? 'Too many wrong PINs - try again in 15 minutes' : 'Wrong PIN for this Netrunner handle';
        return response.status(status).json({ error: msg, message: msg });
      }
      if (existing.disabled) return response.status(403).json({ error: 'Account is disabled.', message: 'Account is disabled.' });
      if (isUserExpired(existing)) return response.status(401).json({ error: 'Guest account has expired.', message: 'Guest account has expired.' });
      if (!hasPrivilege(existing, 'play_games')) {
        return response.status(403).json({ error: 'Missing privilege: play_games', message: 'Missing privilege: play_games' });
      }

      clearLoginFails(ip);
      const { token, session } = await store.createSession({
        userId: existing._id,
        ip,
        userAgent: request.get('user-agent') || '',
        userExpiresAt: existing.expiresAt,
      });
      const updated = await store.updateUser(existing._id, { lastLoginAt: new Date() });
      setSessionCookie(request, response, token, session.expiresAt);
      await store.writeAudit({
        actor: toActor(updated),
        ip,
        action: 'auth.game_login',
        target: updated.username,
        status: 'ok',
        details: { mode: 'pin' },
      }).catch(() => {});
      return response.json({ ok: true, created: false, token, user: toGameUserPayload(updated) });
    }

    return response.status(400).json({
      error: 'Provide handle + pin or username + password.',
      message: 'Provide handle + pin or username + password.',
    });
  });

  app.get('/api/game/me', requireGameUser, (request, response) => {
    return response.json({ ok: true, user: toGameUserPayload(request.authUser) });
  });

  app.put('/api/game/profile', requireGameUser, async (request, response) => {
    const body = request.body ?? {};
    const updated = await store.updateGameProfile(request.authUser._id, {
      xp: body.xp,
      eddies: body.eddies,
      eddiesEarned: body.eddiesEarned,
      avatar: body.avatar,
      profile: body.profile,
    });
    return response.json({ ok: true, user: toGameUserPayload(updated) });
  });

  app.get('/api/game/midrun/:gameId', requireGameUser, async (request, response) => {
    const { gameId } = request.params;
    const payload = toGameUserPayload(request.authUser);
    if (!Object.prototype.hasOwnProperty.call(payload.profile.scores, gameId)) {
      return response.status(400).json({ error: 'Unknown game_id.', message: 'Unknown game_id.' });
    }
    return response.json({ ok: true, game_id: gameId, midrun: payload.midruns[gameId] || null });
  });

  app.put('/api/game/midrun/:gameId', requireGameUser, async (request, response) => {
    const midruns = await store.setMidRun(request.authUser._id, request.params.gameId, request.body ?? {});
    return response.json({ ok: true, game_id: request.params.gameId, midruns });
  });

  app.delete('/api/game/midrun/:gameId', requireGameUser, async (request, response) => {
    const midruns = await store.clearMidRun(request.authUser._id, request.params.gameId);
    return response.json({ ok: true, game_id: request.params.gameId, midruns });
  });

  app.post('/api/game/score', requireGameUser, async (request, response) => {
    const body = request.body ?? {};
    const result = await store.recordGameScore({
      userId: request.authUser._id,
      gameId: body.game_id ?? body.gameId,
      score: body.score,
      wave: body.wave ?? 0,
      won: Boolean(body.won),
      eddies: body.eddies ?? 0,
      xp: body.xp ?? 0,
    });
    return response.json({
      ok: true,
      isNewBest: result.isNewBest,
      bestScore: result.bestScore,
      rank: result.rank,
      xp: result.xp,
      eddies: result.eddies,
    });
  });

  // Server-reported results (WILDCARD // 2077). Not a user endpoint: the game server on CT 113 authenticates with
  // `Authorization: Bearer <DASHBOARD_SERVICE_TOKEN>` (compared in constant time; the value lives only in the env),
  // and the body is validated strictly. Idempotent on matchId / Idempotency-Key.
  app.post('/api/game/results', createResultsHandler({
    store,
    getToken: () => process.env[SERVICE_TOKEN_ENV],
    audit,
    visitor,
  }));

  app.get('/api/game/leaderboard', async (request, response) => {
    const game = String(request.query.game || 'all');
    const rawLimit = request.query.limit ?? '20';
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit)) {
      return response.status(400).json({ error: 'limit must be an integer', message: 'limit must be an integer' });
    }
    return response.json(await store.getLeaderboard({ game, limit }));
  });

  app.get('/api/game/users', async (_request, response) => {
    return response.json({ users: await store.listPublicGameUsers() });
  });

  // ---------- /api/ping (liveness for the deploy check; /api/health is the host-agent health panel) ----------
  app.get('/api/ping', (_request, response) => {
    response.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ---------- /api/stats: host, containers, storage (cached 5 s) ----------
  let statsCache = { at: 0, data: null };
  app.get('/api/stats', async (_request, response) => {
    if (!statsConfigured()) return response.status(503).json({ configured: false, message: 'Set PROXMOX_URL, PROXMOX_NODE and a read token (PROXMOX_READ_TOKEN_ID / PROXMOX_READ_TOKEN_SECRET) in .env.' });
    if (Date.now() - statsCache.at < 5000 && statsCache.data) return response.json(statsCache.data);
    const nodeName = node();
    try {
      const [status, lxc, qemu, storage] = await Promise.all([
        pve(`/nodes/${nodeName}/status`, { read: true }),
        pve(`/nodes/${nodeName}/lxc`, { read: true }),
        pve(`/nodes/${nodeName}/qemu`, { read: true }).catch(() => []),
        pve(`/nodes/${nodeName}/storage`, { read: true }).catch(() => []),
      ]);
      const guest = (type) => (g) => ({
        id: Number(g.vmid), name: g.name, type, status: g.status,
        cpu: g.cpu ?? 0, cpus: g.cpus ?? g.maxcpu ?? 1,
        mem: g.mem ?? 0, maxmem: g.maxmem ?? 0,
        disk: g.disk ?? 0, maxdisk: g.maxdisk ?? 0, uptime: g.uptime ?? 0,
        tags: String(g.tags || '').split(/[;, ]+/).filter(Boolean),
      });
      const data = {
        configured: true,
        node: process.env.PROXMOX_NODE,
        host: {
          cpu: status.cpu ?? 0, cpus: status.cpuinfo?.cpus ?? 0, model: status.cpuinfo?.model ?? '',
          mem: status.memory?.used ?? 0, maxmem: status.memory?.total ?? 0,
          disk: status.rootfs?.used ?? 0, maxdisk: status.rootfs?.total ?? 0,
          uptime: status.uptime ?? 0, load: status.loadavg ?? [], version: status.pveversion ?? '',
        },
        guests: [...(lxc || []).map(guest('lxc')), ...(qemu || []).map(guest('vm'))].sort((a, b) => a.id - b.id),
        storage: (storage || []).filter((s) => s.active).map((s) => ({ name: s.storage, type: s.type, used: s.used ?? 0, total: s.total ?? 0 })),
        at: new Date().toISOString(),
      };
      statsCache = { at: Date.now(), data };
      return response.json(data);
    } catch (error) {
      return response.status(502).json({ configured: true, message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
    }
  });

  // ---------- /api/services: is each site answering? (cached 30 s) ----------
  let siteCache = { at: 0, data: null };
  let routeCache = { at: 0, data: [] };
  const routes = async () => {
    if (Date.now() - routeCache.at < 15000) return routeCache.data;
    try { routeCache = { at: Date.now(), data: (await proxyAgent('GET', '/routes')).routes || [] }; } catch { routeCache = { at: Date.now(), data: [] }; }
    return routeCache.data;
  };
  const probe = async (url) => {
    const started = Date.now();
    try {
      const result = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      return { up: result.status < 400, code: result.status, ms: Date.now() - started };
    } catch {
      return { up: false, code: 0, ms: Date.now() - started };
    }
  };
  const BUCKET = 5 * 60000;
  const KEEP = 7 * 24 * 12;
  let uptime = (() => { try { return JSON.parse(readFileSync(UPTIME_FILE, 'utf8')); } catch { return {}; } })();
  const recordUptime = (results) => {
    const t = Math.floor(Date.now() / BUCKET) * BUCKET;
    for (const r of results) {
      const list = uptime[r.id] ?? (uptime[r.id] = []);
      let b = list[list.length - 1];
      if (!b || b.t !== t) { b = { t, ok: 0, n: 0, ms: 0 }; list.push(b); if (list.length > KEEP) list.splice(0, list.length - KEEP); }
      b.n += 1; if (r.up) { b.ok += 1; b.ms += r.ms; }
    }
    try { mkdirSync(path.dirname(UPTIME_FILE), { recursive: true }); writeFileSync(UPTIME_FILE + '.tmp', JSON.stringify(uptime)); renameSync(UPTIME_FILE + '.tmp', UPTIME_FILE); } catch { /* disk full: keep it in memory */ }
  };
  const probeAll = async () => {
    const extra = (await routes().catch(() => [])).map((r) => ({ id: `route:${r.name}`, check: `http://10.0.0.250${r.path}` }));
    const results = await Promise.all([...services.sites, ...extra].map(async (site) => ({ id: site.id, ...(await probe(site.check)) })));
    siteCache = { at: Date.now(), data: { at: new Date().toISOString(), results } };
    recordUptime(results);
    return siteCache.data;
  };

  app.get('/api/services', async (_request, response) => {
    if (Date.now() - siteCache.at < 30000 && siteCache.data) return response.json(siteCache.data);
    return response.json(await probeAll());
  });
  app.get('/api/uptime', (request, response) => {
    const hours = Math.max(1, Math.min(168, Number(request.query.hours) || 24));
    const since = Date.now() - hours * 3600000;
    const out = {};
    for (const [id, list] of Object.entries(uptime)) {
      const recent = list.filter((b) => b.t >= since);
      const n = recent.reduce((a, b) => a + b.n, 0);
      const ok = recent.reduce((a, b) => a + b.ok, 0);
      out[id] = { pct: n ? Math.round((ok / n) * 10000) / 100 : null, ms: ok ? Math.round(recent.reduce((a, b) => a + b.ms, 0) / ok) : null, buckets: recent.map((b) => [b.t, b.n ? b.ok / b.n : null, b.ok ? Math.round(b.ms / b.ok) : null]) };
    }
    response.json({ hours, sites: out });
  });

  // ---------- graphs: Proxmox keeps CPU, memory, network and disk history (RRD) ----------
  const rrdCache = new Map();
  const rrd = async (apiPath, timeframe) => {
    const key = `${apiPath}|${timeframe}`;
    const hit = rrdCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await pve(`${apiPath}/rrddata?timeframe=${timeframe}&cf=AVERAGE`, { read: true });
    rrdCache.set(key, { at: Date.now(), data });
    return data;
  };
  const TIMEFRAMES = { hour: 'hour', day: 'day', week: 'week', month: 'month' };
  app.get('/api/history', async (request, response) => {
    if (!statsConfigured()) return response.status(503).json({ message: 'Proxmox is not configured.' });
    const tf = TIMEFRAMES[request.query.range] || 'day';
    try {
      const rows = await rrd(`/nodes/${node()}`, tf);
      return response.json({ range: tf, points: (rows || []).filter((r) => r.cpu !== undefined).map((r) => ({
        t: r.time * 1000, cpu: r.cpu, mem: r.memtotal ? r.memused / r.memtotal : null, load: r.loadavg ?? null,
        netin: r.netin ?? null, netout: r.netout ?? null, iowait: r.iowait ?? null, root: r.roottotal ? r.rootused / r.roottotal : null,
      })) });
    } catch (error) { return response.status(502).json({ message: error.message }); }
  });
  app.get('/api/history/guest/:id', async (request, response) => {
    if (!statsConfigured()) return response.status(503).json({ message: 'Proxmox is not configured.' });
    const id = Number(request.params.id);
    const tf = TIMEFRAMES[request.query.range] || 'day';
    if (!Number.isInteger(id) || id < 100) return response.status(400).json({ message: 'Bad ID.' });
    try {
      const kind = request.query.type === 'vm' ? 'qemu' : 'lxc';
      const rows = await rrd(`/nodes/${node()}/${kind}/${id}`, tf);
      return response.json({ range: tf, points: (rows || []).filter((r) => r.cpu !== undefined).map((r) => ({
        t: r.time * 1000, cpu: r.cpu, mem: r.maxmem ? r.mem / r.maxmem : null, netin: r.netin ?? null, netout: r.netout ?? null,
      })) });
    } catch (error) { return response.status(502).json({ message: error.message }); }
  });

  // ---------- legacy login & Proxmox create / delete / power ----------
  const TAG = 'dashboard';
  const instanceName = /^[a-z0-9][a-z0-9-]{1,49}$/;
  const waitTask = async (upid, seconds = 240) => {
    for (let i = 0; i < seconds / 2; i += 1) {
      const state = await pve(`/nodes/${node()}/tasks/${encodeURIComponent(upid)}/status`);
      if (state?.status === 'stopped') return state.exitstatus;
      await new Promise((done) => setTimeout(done, 2000));
    }
    return 'timeout';
  };

  app.post('/api/login', async (request, response) => {
    const settings = await store.getAuthSettings();
    if (!settings.allowLegacyPassword) {
      await store.writeAudit({
        actor: LEGACY_OWNER_ACTOR,
        ip: visitor(request),
        action: 'auth.legacy_login',
        target: 'legacy-owner',
        status: 'denied',
        details: { reason: 'legacy_disabled' },
      }).catch(() => {});
      return response.status(403).json({ message: 'Legacy password login has been disabled. Sign in with your account.' });
    }
    if (!mainPassword()) return response.status(503).json({ message: 'No password set on the server yet.' });
    if (passwordOk(request)) {
      await store.writeAudit({
        actor: LEGACY_OWNER_ACTOR,
        ip: visitor(request),
        action: 'auth.legacy_login',
        target: 'legacy-owner',
        status: 'ok',
      }).catch(() => {});
      return response.json({ ok: true });
    }
    const status = lockedOut(request) ? 429 : 401;
    await store.writeAudit({
      actor: null,
      ip: visitor(request),
      action: 'auth.legacy_login',
      target: 'legacy-owner',
      status: 'failed',
      details: { locked: status === 429 },
    }).catch(() => {});
    return response.status(status).json({ message: lockMessage(request) });
  });

  // LXC: created from an OS template (PROXMOX_LXC_OSTEMPLATE, e.g. local:vztmpl/debian-13-standard_..._amd64.tar.zst).
  // VM: cloned from PROXMOX_VM_TEMPLATE (a VM converted to a template), then cores/memory are set.
  app.post('/api/proxmox/provision', requirePriv('create_vms'), async (request, response) => {
    if (!statsConfigured()) return response.status(503).json({ message: 'Proxmox is not configured (PROXMOX_URL, PROXMOX_NODE, token).' });
    const { type, name, cores, memory, disk } = request.body ?? {};
    const loginPassword = String(request.body?.password || '');
    if (loginPassword && loginPassword.length < 8) return response.status(400).json({ message: 'The login password needs at least 8 characters.' });
    if ((type !== 'vm' && type !== 'lxc') || typeof name !== 'string' || !instanceName.test(name)) return response.status(400).json({ message: 'Use a name with lowercase letters, numbers, and hyphens.' });
    const cpu = Number(cores);
    const ram = Number(memory);
    const size = Number(disk ?? 8);
    if (!Number.isInteger(cpu) || cpu < 1 || cpu > 8 || !Number.isInteger(ram) || ram < 256 || ram > 8192 || !Number.isInteger(size) || size < 2 || size > 100) return response.status(400).json({ message: 'Choose 1-8 cores, 256-8192 MiB memory and a 2-100 GB disk.' });
    const storage = process.env.PROXMOX_STORAGE || 'local-lvm';
    const bridge = process.env.PROXMOX_BRIDGE || 'vmbr0';
    const isGuest = request.actor.role === 'recruiter_guest';
    const tags = isGuest ? `${TAG};sandbox-guest` : TAG;

    try {
      const newid = Number(await pve('/cluster/nextid'));
      if (type === 'lxc') {
        const ostemplate = process.env.PROXMOX_LXC_OSTEMPLATE;
        if (!ostemplate && !pveIsInjected) return response.status(503).json({ message: 'Set PROXMOX_LXC_OSTEMPLATE in .env.' });
        const task = await pve(`/nodes/${node()}/lxc`, { method: 'POST', form: {
          vmid: String(newid), hostname: name, ostemplate: ostemplate || 'local:vztmpl/debian.tar.zst', cores: String(cpu), memory: String(ram), swap: '512',
          rootfs: `${storage}:${size}`, net0: `name=eth0,bridge=${bridge},ip=dhcp,firewall=1`,
          unprivileged: '1', features: 'nesting=1', onboot: '1', start: '1', tags, ...(loginPassword ? { password: loginPassword } : {}),
        } });
        await audit(request, 'guest.provision', `lxc:${name}#${newid}`, 'ok', { type, name, id: newid, cores: cpu, memory: ram, disk: size, tags }, { sandboxTag: isGuest });
        response.status(202).json({ id: newid, task });
        if (!pveIsInjected) waitTask(task).then((s) => console.log(`LXC ${newid} (${name}): ${s}`)).catch((e) => console.error(e));
        return undefined;
      }
      const template = process.env.PROXMOX_VM_TEMPLATE;
      if (!template && !pveIsInjected) return response.status(503).json({ message: 'VMs need a template: set PROXMOX_VM_TEMPLATE (ID of a VM template).' });
      const task = await pve(`/nodes/${node()}/qemu/${encodeURIComponent(template || '9000')}/clone`, { method: 'POST', form: { newid: String(newid), name, full: '1', storage } });
      await audit(request, 'guest.provision', `vm:${name}#${newid}`, 'ok', { type, name, id: newid, cores: cpu, memory: ram, disk: size, tags }, { sandboxTag: isGuest });
      response.status(202).json({ id: newid, task });
      if (!pveIsInjected) {
        (async () => {
          const state = await waitTask(task);
          if (state !== 'OK') return console.error(`Clone ${newid} failed: ${state}`);
          await pve(`/nodes/${node()}/qemu/${newid}/config`, { method: 'PUT', form: { cores: String(cpu), memory: String(ram), tags, onboot: '1', ...(loginPassword ? { cipassword: loginPassword } : {}) } });
          await pve(`/nodes/${node()}/qemu/${newid}/resize`, { method: 'PUT', form: { disk: 'scsi0', size: `${size}G` } }).catch((e) => console.warn(`VM ${newid}: disk not resized (${e.message})`));
          await pve(`/nodes/${node()}/qemu/${newid}/status/start`, { method: 'POST' });
          console.log(`VM ${newid} (${name}) ready`);
        })().catch((error) => console.error(`VM ${newid} follow-up failed:`, error));
      }
      return undefined;
    } catch (error) {
      return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
    }
  });

  // 102 is Jacob's (never touched). 101 (proxy) and 105 (this dashboard) can restart but not stop.
  const NO_TOUCH = new Set([102]);
  const NO_STOP = new Set([101, 105]);
  const POWER = { start: 'start', stop: 'shutdown', restart: 'reboot' };

  app.delete('/api/guests/:id', requirePriv('create_vms'), async (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 100) return response.status(400).json({ message: 'Bad ID.' });
    if (NO_TOUCH.has(id)) {
      await audit(request, 'guest.delete_vm', String(id), 'denied', { reason: 'protected_ct102' });
      return response.status(403).json({ message: `Guest ${id} is off-limits here.` });
    }
    if (!statsConfigured()) return response.status(503).json({ message: 'Proxmox is not configured (PROXMOX_URL, PROXMOX_NODE, token).' });
    try {
      const [lxc, qemu] = await Promise.all([pve(`/nodes/${node()}/lxc`), pve(`/nodes/${node()}/qemu`).catch(() => [])]);
      const found = (lxc || []).find((g) => Number(g.vmid) === id) ? 'lxc' : (qemu || []).find((g) => Number(g.vmid) === id) ? 'qemu' : null;
      if (!found) return response.status(404).json({ message: `No guest ${id}.` });
      const config = await pve(`/nodes/${node()}/${found}/${id}/config`);
      const tags = String(config?.tags || '').split(/[;, ]+/);
      if (!tags.includes(TAG)) return response.status(403).json({ message: `Guest ${id} was not created by the dashboard, so it can't be deleted here.` });
      const status = await pve(`/nodes/${node()}/${found}/${id}/status/current`);
      if (status?.status === 'running') await waitTask(await pve(`/nodes/${node()}/${found}/${id}/status/stop`, { method: 'POST' }), 60);
      const task = await pve(`/nodes/${node()}/${found}/${id}?purge=1&destroy-unreferenced-disks=1`, { method: 'DELETE' });
      statsCache = { at: 0, data: null };
      await audit(request, 'guest.delete_vm', `${found}:${id}`, 'ok', { id, kind: found });
      return response.status(202).json({ id, task });
    } catch (error) {
      return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
    }
  });

  app.post('/api/guests/:id/power/:action', requirePriv('manage_containers'), async (request, response) => {
    const id = Number(request.params.id);
    const action = request.params.action;
    if (!Number.isInteger(id) || !(action in POWER)) return response.status(400).json({ message: 'Bad request.' });
    if (NO_TOUCH.has(id)) {
      await audit(request, 'guest.power', String(id), 'denied', { action, reason: 'protected_ct102' });
      return response.status(403).json({ message: `Guest ${id} is off-limits here.` });
    }
    if (action === 'stop' && NO_STOP.has(id)) {
      await audit(request, 'guest.power', String(id), 'denied', { action, reason: 'no_stop_critical' });
      return response.status(403).json({ message: `Guest ${id} can only be restarted, not stopped (the site would go down).` });
    }
    if (!statsConfigured()) return response.status(503).json({ message: 'Proxmox is not configured (PROXMOX_URL, PROXMOX_NODE, token).' });
    try {
      const [lxc, qemu] = await Promise.all([pve(`/nodes/${node()}/lxc`), pve(`/nodes/${node()}/qemu`).catch(() => [])]);
      const kind = (lxc || []).some((g) => Number(g.vmid) === id) ? 'lxc' : (qemu || []).some((g) => Number(g.vmid) === id) ? 'qemu' : null;
      if (!kind) return response.status(404).json({ message: `No guest ${id}.` });
      const task = await pve(`/nodes/${node()}/${kind}/${id}/status/${POWER[action]}`, { method: 'POST', form: action === 'stop' ? { timeout: '60', forceStop: '1' } : undefined });
      statsCache = { at: 0, data: null };
      await audit(request, 'guest.power', `${kind}:${id}`, 'ok', { id, kind, action });
      return response.status(202).json({ id, action, task });
    } catch (error) {
      return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
    }
  });

  // ---------- sites: proxy routes + WordPress sites (via the two LAN agents) ----------
  const fail = (response, error) => response.status(error.status && error.status < 600 ? (error.status === 401 ? 502 : error.status) : 502).json({ message: error.message || 'Agent not reachable.' });

  // Public: which extra sites exist (no internal addresses).
  app.get('/api/routes', async (_request, response) => {
    response.json({ routes: (await routes()).map((r) => ({ name: r.name, title: r.title, path: r.path, kind: r.kind })) });
  });

  app.post('/api/routes', requirePriv('manage_sites'), async (request, response) => {
    const { name, target, title } = request.body ?? {};
    try {
      const route = await proxyAgent('PUT', `/routes/${encodeURIComponent(String(name || ''))}`, { target, title: title || name, kind: 'custom' });
      routeCache.at = 0;
      siteCache.at = 0;
      await audit(request, 'route.create', String(name || ''), 'ok', { title: title || name });
      return response.json(route);
    } catch (error) { return fail(response, error); }
  });

  const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

  // Start building a WordPress site (optionally written by Gemini). Runs in the background on the site agent;
  // the page polls /api/wordpress/jobs/:name, which also publishes the route once the site is ready.
  app.post('/api/wordpress', requirePriv('manage_sites'), async (request, response) => {
    const name = String(request.body?.name || '').trim().toLowerCase();
    const { title = '', password = '', prompt = '', quality = 'fast' } = request.body ?? {};
    try {
      const result = await siteAgent('POST', '/sites', { name, title: String(title), password: String(password), prompt: String(prompt), quality });
      await audit(request, 'wordpress.create', name, 'ok', { title: String(title), quality });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });

  const routed = new Set();
  app.get('/api/wordpress/jobs/:name', requirePriv('manage_sites'), async (request, response) => {
    const name = request.params.name;
    if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
    try {
      const job = await siteAgent('GET', `/jobs/${name}`);
      if (job.state === 'done' && job.kind === 'create' && !routed.has(name)) {
        try {
          const target = new URL(process.env.SITE_AGENT_URL);
          target.port = String(job.result.port);
          target.pathname = '/';
          await proxyAgent('PUT', `/routes/${name}`, { path: `/sites/${name}/`, target: target.toString(), kind: 'wordpress', title: job.result.title });
          routed.add(name);
          routeCache.at = 0;
          siteCache.at = 0;
        } catch (error) {
          await siteAgent('DELETE', `/sites/${name}`, undefined, 60000).catch(() => {});
          return response.json({ ...job, state: 'failed', error: `Could not publish the site: ${error.message}`, result: null });
        }
      }
      return response.json(job);
    } catch (error) { return fail(response, error); }
  });

  // Safety net: publish any finished WordPress site that has no route yet (e.g. the tab was closed mid-build).
  const deleting = new Set();
  const syncSites = async () => {
    if (!process.env.SITE_AGENT_URL || !process.env.PROXY_AGENT_URL) return;
    try {
      const [{ sites = [] }, { routes: have = [] }] = await Promise.all([siteAgent('GET', '/sites'), proxyAgent('GET', '/routes')]);
      for (const site of sites) {
        if (site.status === 'building' || deleting.has(site.name) || have.some((r) => r.name === site.name)) continue;
        const target = new URL(process.env.SITE_AGENT_URL);
        target.port = String(site.port);
        target.pathname = '/';
        await proxyAgent('PUT', `/routes/${site.name}`, { path: `/sites/${site.name}/`, target: target.toString(), kind: 'wordpress', title: site.title });
        routed.add(site.name);
        routeCache.at = 0;
      }
    } catch { /* agents down: try again next round */ }
    if (!process.env.HOST_AGENT_URL) return;
    try {
      const [{ apps = [] }, { routes: have = [] }] = await Promise.all([hostAgent('GET', '/apps'), proxyAgent('GET', '/routes')]);
      for (const a of apps) {
        const target = `http://${a.ip}:${a.port}/`;
        const route = have.find((r) => r.name === a.name);
        if (deleting.has(a.name) || !a.ip || (route && route.target === target)) continue;
        await proxyAgent('PUT', `/routes/${a.name}`, { target, kind: a.kind === 'aisite' ? 'aisite' : 'app', title: a.title || a.name });
        routeCache.at = 0;
      }
    } catch { /* host agent down */ }
  };

  // Ask Gemini to change an existing site ("add a contact page", "make it more formal").
  app.post('/api/wordpress/:name/ai', requirePriv('manage_sites'), async (request, response) => {
    const name = request.params.name;
    if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
    try {
      const quality = request.body?.quality === 'best' ? 'best' : 'fast';
      const result = await siteAgent('POST', `/sites/${name}/ai`, { prompt: String(request.body?.prompt || ''), quality });
      await audit(request, 'wordpress.ai_edit', name, 'ok', { quality });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });

  // Is a Gemini key saved on the websites server? (yes/no only)
  app.get('/api/ai', async (_request, response) => {
    try { return response.json({ ai: (await siteAgent('GET', '/ai')).ai }); } catch { return response.json({ ai: false }); }
  });
  app.put('/api/ai/key', requirePriv('manage_settings'), async (request, response) => {
    try {
      const rawKey = String(request.body?.key || '');
      const result = await siteAgent('PUT', '/ai/key', { key: rawKey });
      await audit(request, 'ai_key.update', 'gemini', 'ok', { configured: Boolean(rawKey) });
      return response.json(result);
    } catch (error) { return fail(response, error); }
  });

  app.delete('/api/routes/:name', requirePriv('manage_sites'), async (request, response) => {
    const name = request.params.name;
    try {
      const route = (await proxyAgent('GET', '/routes')).routes.find((r) => r.name === name);
      if (!route) return response.status(404).json({ message: `No site ${name}.` });
      deleting.add(name);
      try {
        await proxyAgent('DELETE', `/routes/${encodeURIComponent(name)}`);
        if (route.kind === 'wordpress') await siteAgent('DELETE', `/sites/${encodeURIComponent(name)}`, undefined, 60000);
        if (route.kind === 'app' || route.kind === 'aisite') {
          const foundApp = ((await hostAgent('GET', '/apps')).apps || []).find((a) => a.name === name);
          if (foundApp) await hostAgent('DELETE', `/apps/${foundApp.ctid}`, undefined, 120000);
        }
      } finally { deleting.delete(name); routed.delete(name); }
      routeCache.at = 0;
      siteCache.at = 0;
      await audit(request, 'route.delete', name, 'ok', { kind: route.kind });
      return response.json({ deleted: name, kind: route.kind });
    } catch (error) { return fail(response, error); }
  });

  // ---------- notes: saved prompts, to-dos and a scratch note ----------
  // Kept in data/notes.json next to the app; the deploy leaves data/ alone.
  const emptyNotes = () => ({ note: '', prompts: [], todos: [], updated: null });
  const readNotes = () => { try { return { ...emptyNotes(), ...JSON.parse(readFileSync(NOTES_FILE, 'utf8')) }; } catch { return emptyNotes(); } };
  const cleanItems = (list, extra) => (Array.isArray(list) ? list : []).slice(0, 300).map((item) => ({
    id: String(item?.id || Math.random().toString(36).slice(2)).slice(0, 40),
    text: String(item?.text || '').slice(0, 4000),
    at: String(item?.at || new Date().toISOString()).slice(0, 40),
    ...extra(item),
  })).filter((item) => item.text.trim());

  app.get('/api/notes', requirePriv('manage_notes'), (_request, response) => {
    response.json(readNotes());
  });
  app.put('/api/notes', requirePriv('manage_notes'), async (request, response) => {
    const body = request.body ?? {};
    const notes = {
      note: String(body.note ?? '').slice(0, 20000),
      prompts: cleanItems(body.prompts, () => ({})),
      todos: cleanItems(body.todos, (item) => ({ done: !!item?.done })),
      updated: new Date().toISOString(),
    };
    try {
      mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
      writeFileSync(NOTES_FILE + '.tmp', JSON.stringify(notes, null, 2));
      renameSync(NOTES_FILE + '.tmp', NOTES_FILE);
      await audit(request, 'notes.update', 'notes', 'ok', { promptsCount: notes.prompts.length, todosCount: notes.todos.length });
      return response.json(notes);
    } catch (error) { return response.status(500).json({ message: `Could not save notes: ${error.message}` }); }
  });

  // ---------- apps on their own container (host agent builds them in the background) ----------
  app.get('/api/apps', requirePriv('manage_sites'), async (_request, response) => {
    try { return response.json(await hostAgent('GET', '/apps')); } catch (error) { return fail(response, error); }
  });
  app.post('/api/apps', requirePriv('create_vms'), async (request, response) => {
    const b = request.body ?? {};
    const name = String(b.name || '').trim().toLowerCase();
    if (['sites', 'codezi', 'api', 'assets', 'landing', 'docker-avi', 'jacobflightmonitor'].includes(name)) return response.status(400).json({ message: `${name} is already used by the server, pick another name.` });
    if ((await routes()).some((r) => r.name === name)) return response.status(400).json({ message: `A site called ${name} already exists.` });
    try {
      const result = await hostAgent('POST', '/apps', { name, title: String(b.title || name), source_type: b.source_type, source: String(b.source || ''), port: Number(b.port) || 80, cores: Number(b.cores) || 1, memory: Number(b.memory) || 1024, disk: Number(b.disk) || 8 });
      await audit(request, 'app.create', name, 'ok', { source_type: b.source_type, port: Number(b.port) || 80 });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });
  app.post('/api/apps/:ctid/update', requirePriv('manage_sites'), async (request, response) => {
    if (!/^\d+$/.test(request.params.ctid)) return response.status(400).json({ message: 'Bad id.' });
    if (NO_TOUCH.has(Number(request.params.ctid))) {
      await audit(request, 'app.update', String(request.params.ctid), 'denied', { reason: 'protected_ct102' });
      return response.status(403).json({ message: `Guest ${request.params.ctid} is off-limits here.` });
    }
    try {
      const result = await hostAgent('POST', `/apps/${request.params.ctid}/update`);
      await audit(request, 'app.update', String(request.params.ctid), 'ok');
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });

  // ---------- history: every build, AI edit and app deploy, with its log ----------
  const JOB_ID = /^[a-z]+-[a-z0-9-]+-\d+$/;
  app.get('/api/activity', requirePriv('view_logs'), async (_request, response) => {
    const [sitesJobs, hostJobs] = await Promise.all([
      siteAgent('GET', '/jobs').then((b) => (b.jobs || []).map((j) => ({ ...j, source: 'site' }))).catch(() => []),
      hostConfigured() ? hostAgent('GET', '/jobs').then((b) => (b.jobs || []).map((j) => ({ ...j, source: 'host' }))).catch(() => []) : [],
    ]);
    const jobs = [...sitesJobs, ...hostJobs].sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, 100);
    return response.json({ jobs });
  });
  app.get('/api/activity/:source/:id', requirePriv('view_logs'), async (request, response) => {
    const { source, id } = request.params;
    if (!JOB_ID.test(id) || !['site', 'host'].includes(source)) return response.status(400).json({ message: 'Bad id.' });
    try {
      const job = await (source === 'site' ? siteAgent : hostAgent)('GET', `/jobs/${id}`);
      // a finished app build gets its address published here (and by the 30 s sync as a fallback)
      if (source === 'host' && (job.kind === 'app' || job.kind === 'aisite') && job.state === 'done' && job.result && !routed.has(job.name)) {
        await proxyAgent('PUT', `/routes/${job.name}`, { target: job.result.target, kind: job.kind === 'aisite' ? 'aisite' : 'app', title: job.result.title || job.name }).catch(() => {});
        routed.add(job.name);
        routeCache.at = 0;
      }
      return response.json(job);
    } catch (error) { return fail(response, error); }
  });

  // ---------- AI websites on their own container (host agent; Gemini writes HTML/CSS, nginx serves it) ----------
  app.get('/api/aisites/candidates', requirePriv('manage_sites'), async (_request, response) => {
    try { return response.json(await hostAgent('GET', '/aisites/candidates')); } catch (error) { return fail(response, error); }
  });
  app.post('/api/aisites', requirePriv('manage_sites'), async (request, response) => {
    const b = request.body ?? {};
    const name = String(b.name || '').trim().toLowerCase();
    if (b.ctid !== undefined && b.ctid !== null && b.ctid !== '' && NO_TOUCH.has(Number(b.ctid))) {
      await audit(request, 'aisite.create', String(b.ctid), 'denied', { name, reason: 'protected_ct102' });
      return response.status(403).json({ message: `Guest ${b.ctid} is off-limits here.` });
    }
    if (['sites', 'codezi', 'api', 'assets', 'docker-avi', 'jacobflightmonitor'].includes(name)) return response.status(400).json({ message: `${name} is already used by the server, pick another name.` });
    if ((await routes()).some((r) => r.name === name)) return response.status(400).json({ message: `A site called ${name} already exists.` });
    try {
      const quality = b.quality === 'best' ? 'best' : 'fast';
      const result = await hostAgent('POST', '/aisites', { name, prompt: String(b.prompt || ''), quality, ctid: b.ctid ? Number(b.ctid) : null });
      await audit(request, 'aisite.create', name, 'ok', { quality });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });
  app.post('/api/aisites/:ctid/:action', requirePriv('manage_sites'), async (request, response) => {
    const { ctid, action } = request.params;
    if (!/^\d+$/.test(ctid) || !['edit', 'undo'].includes(action)) return response.status(400).json({ message: 'Bad request.' });
    if (NO_TOUCH.has(Number(ctid))) {
      await audit(request, `aisite.${action}`, String(ctid), 'denied', { reason: 'protected_ct102' });
      return response.status(403).json({ message: `Guest ${ctid} is off-limits here.` });
    }
    try {
      const quality = request.body?.quality === 'best' ? 'best' : 'fast';
      const result = await hostAgent('POST', `/aisites/${ctid}/${action}`, { prompt: String(request.body?.prompt || ''), quality });
      await audit(request, `aisite.${action}`, String(ctid), 'ok', { quality });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });
  app.post('/api/wordpress/:name/undo', requirePriv('manage_sites'), async (request, response) => {
    const name = request.params.name;
    if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
    try {
      const job = String(request.body?.job || '');
      const result = await siteAgent('POST', `/sites/${name}/undo`, { job });
      await audit(request, 'wordpress.undo', name, 'ok', { job });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });

  // ---------- health and updates (host agent) ----------
  app.get('/api/health', async (request, response) => {
    if (!hostConfigured()) return response.status(503).json({ message: 'The host agent is not installed.' });
    try {
      const [h, resolved] = await Promise.all([
        hostAgent('GET', '/health', undefined, 60000),
        resolveActor(request),
      ]);
      if (resolved.actor && hasPrivilege(resolved.actor, 'view_private')) return response.json(h);
      // visitors who lack view_private see the readings, not the disk serial details
      return response.json({ ...h, disks: (h.disks || []).map(({ dev, model, size_gb, passed, temp, ssd, state, wear }) => ({ dev, model, size_gb, passed, temp, ssd, state, wear })) });
    } catch (error) { return fail(response, error); }
  });
  app.get('/api/updates', requirePriv('run_updates'), async (_request, response) => {
    try { return response.json(await hostAgent('GET', '/updates')); } catch (error) { return fail(response, error); }
  });
  app.post('/api/updates/check', requirePriv('run_updates'), async (_request, response) => {
    try { return response.status(202).json(await hostAgent('POST', '/updates/check')); } catch (error) { return fail(response, error); }
  });
  app.post('/api/updates/apply', requirePriv('run_updates'), async (request, response) => {
    const targets = (Array.isArray(request.body?.targets) ? request.body.targets : []).map(Number).filter((t) => Number.isInteger(t) && t >= 100 && t !== 102);
    try {
      const result = await hostAgent('POST', '/updates/apply', { targets });
      await audit(request, 'updates.apply', 'proxmox-guests', 'ok', { targets });
      return response.status(202).json(result);
    } catch (error) { return fail(response, error); }
  });

  // ---------- logs ----------
  const taskLines = async (limit) => {
    const tasks = await pve(`/nodes/${node()}/tasks?limit=${limit}`);
    return (tasks || []).map((t) => `${new Date(t.starttime * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${t.type}${t.id ? ` ${t.id}` : ''} by ${t.user}: ${t.status || 'running'}`).reverse();
  };
  app.get('/api/logs', requirePriv('view_logs'), async (_request, response) => {
    const base = [{ key: 'proxmox-tasks', label: 'Proxmox: recent tasks (create, start, stop, backups)', group: 'Server' }];
    try { return response.json({ sources: [...base, ...((await hostAgent('GET', '/logs')).sources || [])], host: true }); } catch (error) { return response.json({ sources: base, host: false, message: error.message }); }
  });
  app.get('/api/logs/:key', requirePriv('view_logs'), async (request, response) => {
    const key = request.params.key;
    const lines = Math.max(10, Math.min(2000, Number(request.query.lines) || 200));
    if (!/^[a-z0-9-]{2,60}$/.test(key)) return response.status(400).json({ message: 'Bad log name.' });
    if (key === 'ct-102' || key === 'app-102') {
      await audit(request, 'logs.read', key, 'denied', { reason: 'protected_ct102' });
      return response.status(403).json({ message: 'Guest 102 is off-limits here.' });
    }
    try {
      if (key === 'proxmox-tasks') return response.json({ key, lines: await taskLines(Math.min(lines, 500)) });
      return response.json(await hostAgent('GET', `/logs/${key}?lines=${lines}`, undefined, 30000));
    } catch (error) { return fail(response, error); }
  });

  // ---------- agents hub (CT 111, Mission Control) ----------
  const rows = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);
  const slimAgent = (a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, last_seen: a.last_seen ?? null, last_activity: a.last_activity ?? '' });
  const slimTask = (t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assigned_to: t.assigned_to ?? null, updated_at: t.updated_at ?? t.created_at ?? null, tags: Array.isArray(t.tags) ? t.tags : [], description: t.description ?? '', created_at: t.created_at ?? null });
  const slimComment = (c) => ({ id: c.id, author: c.author ?? c.created_by ?? 'agent', body: c.content ?? c.body ?? c.text ?? '', at: c.created_at ?? null });
  const slimActivity = (e) => ({ id: e.id, type: e.type, actor: e.actor ?? '', description: e.description ?? '', at: e.created_at ?? null });

  let hubCache = { at: 0, data: null };
  app.get('/api/hub', requirePriv('view_agents'), async (_request, response) => {
    if (hubCache.data && Date.now() - hubCache.at < 5000) return response.json(hubCache.data);
    try {
      const [agents, tasks, activity] = await Promise.all([
        hubCall('GET', '/api/agents?limit=50'),
        hubCall('GET', '/api/tasks?limit=60'),
        hubCall('GET', '/api/activities?limit=25'),
      ]);
      const data = {
        agents: rows(agents, 'agents').map(slimAgent),
        tasks: rows(tasks, 'tasks').map(slimTask),
        activity: rows(activity, 'activities').map(slimActivity),
        at: new Date().toISOString(),
      };
      hubCache = { at: Date.now(), data };
      return response.json(data);
    } catch (error) { return fail(response, error); }
  });

  // One task + its comments (phone-worker posts the agent's output as a comment when it finishes).
  app.get('/api/hub/tasks/:id', requirePriv('view_agents'), async (request, response) => {
    const id = String(request.params.id);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return response.status(400).json({ message: 'Bad task id.' });
    try {
      const got = await hubCall('GET', `/api/tasks/${id}`);
      const task = got?.task ?? got;
      let comments;
      try { comments = rows(await hubCall('GET', `/api/tasks/${id}/comments`), 'comments'); } catch (error) {
        if (error.status !== 404) throw error;
        comments = Array.isArray(task?.comments) ? task.comments : [];
      }
      return response.json({ task: slimTask(task), comments: comments.map(slimComment) });
    } catch (error) { return fail(response, error); }
  });

  const HUB_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
  // Dashboard model choice -> the tag phone-worker.py reads (opus/haiku/sonnet for claude-ops, antigravity for Gemini).
  const HUB_MODEL_TAGS = { sonnet: 'sonnet', opus: 'opus', haiku: 'haiku', gemini: 'antigravity' };
  app.post('/api/hub/tasks', requirePriv('view_agents'), async (request, response) => {
    const title = String(request.body?.title ?? '').trim();
    const description = String(request.body?.description ?? '').trim();
    const assigned = String(request.body?.assigned_to ?? '').trim();
    const priority = String(request.body?.priority ?? 'medium').trim();
    if (title.length < 3 || title.length > 200) return response.status(400).json({ message: 'Give the task a title of 3 to 200 characters.' });
    if (description.length > 4000) return response.status(400).json({ message: 'That description is too long (4000 characters max).' });
    if (!HUB_PRIORITIES.has(priority)) return response.status(400).json({ message: 'Priority must be low, medium, high or critical.' });
    const model = String(request.body?.model ?? '').trim();
    if (model && !Object.hasOwn(HUB_MODEL_TAGS, model)) return response.status(400).json({ message: 'Model must be sonnet, opus, haiku or gemini.' });
    const rawTags = request.body?.tags ?? [];
    if (!Array.isArray(rawTags) || rawTags.length > 5 || !rawTags.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(x))) {
      return response.status(400).json({ message: 'Tags must be up to 5 short letters/digits/-/_ words.' });
    }
    const extraTags = [...new Set([...(model ? [HUB_MODEL_TAGS[model]] : []), ...rawTags.map((x) => x.toLowerCase())])].filter((x) => x !== 'from-dashboard').slice(0, 5);
    try {
      const known = rows(await hubCall('GET', '/api/agents?limit=50'), 'agents').map((a) => a.name);
      if (assigned && !known.includes(assigned)) return response.status(400).json({ message: `Unknown agent "${assigned}".` });
      const created = await hubCall('POST', '/api/tasks', {
        title, description, priority,
        status: assigned ? 'assigned' : 'inbox',
        ...(assigned ? { assigned_to: assigned } : {}),
        created_by: request.actor?.username || 'dashboard',
        tags: ['from-dashboard', ...extraTags],
      });
      hubCache = { at: 0, data: null };
      const task = created?.task ?? created;
      await audit(request, 'hub.task_create', title, 'ok', { assigned_to: assigned || null, priority, tags: extraTags });
      return response.status(201).json({ task: slimTask(task) });
    } catch (error) { return fail(response, error); }
  });

  // Unmatched /api/* routes return JSON 404 instead of index.html
  app.use('/api', (_request, response) => {
    response.status(404).json({ message: 'Not found.', error: 'not found' });
  });

  // ---------- static site ----------
  // sw.js must always be revalidated so a new deploy is picked up; manifest.webmanifest and icon.svg are plain static files.
  app.use(express.static(path.join(__dirname, 'dist'), { setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use((_request, response) => {
    response.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });

  // ---------- JSON & StoreError handler ----------
  app.use((err, _request, response, _next) => {
    if (err instanceof StoreError) {
      return response.status(err.status).json({ message: err.message, error: err.message });
    }
    if (err?.type === 'entity.too.large') {
      return response.status(413).json({ message: 'Payload too large.', error: 'Payload too large.' });
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return response.status(400).json({ message: 'Invalid JSON body.', error: 'Invalid JSON body.' });
    }
    console.error('[server] unhandled error:', err?.message || err);
    return response.status(500).json({ message: 'Internal server error.', error: 'Internal server error.' });
  });

  if (runBg) {
    setInterval(() => { probeAll().catch(() => {}); }, 60000).unref();
    setInterval(syncSites, 30000).unref();
  }

  return app;
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const port = process.env.PORT || 3000;
  const app = createApp({ backgroundJobs: true });
  app.listen(port, () => console.log(`Homelab dashboard listening on http://localhost:${port}`));
}
