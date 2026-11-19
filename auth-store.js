import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';

export const DEFAULT_MONGO_URI = 'mongodb://10.0.0.230:27017/homelab_auth';
export const SESSION_COOKIE_NAME = 'homelab_session';
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ALL_PRIVILEGES = Object.freeze([
  'view_private',
  'view_logs',
  'view_agents',
  'manage_notes',
  'manage_containers',
  'create_vms',
  'manage_sites',
  'run_updates',
  'manage_settings',
  'manage_users',
  'play_games',
]);

export const ROLE_PRESETS = Object.freeze({
  owner: Object.freeze([...ALL_PRIVILEGES]),
  admin: Object.freeze(ALL_PRIVILEGES.filter((p) => p !== 'manage_users')),
  recruiter_guest: Object.freeze([
    'view_private',
    'view_logs',
    'view_agents',
    'manage_notes',
    'manage_containers',
    'create_vms',
    'manage_sites',
    'play_games',
  ]),
  player: Object.freeze(['play_games']),
});

export const ROLES = Object.freeze(Object.keys(ROLE_PRESETS));

export const GAME_IDS = Object.freeze([
  'defender',
  'icebreaker',
  'blackwall',
  'neonvector',
  'protocol',
  'overclock',
  'lightcycle',
]);

export const THEMES = Object.freeze(['yellow', 'cyan', 'crimson']);
export const LANGS = Object.freeze(['en', 'he']);

const USERNAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const PIN_RE = /^\d{4,8}$/;
const AVATAR_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SENSITIVE_KEY_RE = /(?:password|pin|token|secret|hash|salt|cookie|authorization|^key$|_key$|apikey)/i;

const CAP_SCORE = 100_000_000;
const CAP_WAVE = 100_000;
const CAP_EDDIES = 10_000_000;
const CAP_XP = 10_000_000;
const CAP_TOTAL = 2_000_000_000;
const HISTORY_LIMIT = 30;
export const MAX_PROFILE_BYTES = 128 * 1024;
export const MAX_MIDRUN_BYTES = 64 * 1024;

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

// ---------- Crypto & Password Helpers ----------
export function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(secret), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifySecret(secret, salt, expectedHashHex) {
  if (typeof secret !== 'string' || !salt || !expectedHashHex) return false;
  try {
    const derived = scryptSync(secret, String(salt), 64);
    const expected = Buffer.from(String(expectedHashHex), 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function generateStrongPassword(length = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_';
  const all = upper + lower + digits + symbols;
  const chars = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
    symbols[randomInt(symbols.length)],
  ];
  for (let i = chars.length; i < length; i += 1) {
    chars.push(all[randomInt(all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function generatePin(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(10));
  return out;
}

// ---------- Validation & Normalization ----------
export function cleanUsername(raw) {
  if (typeof raw !== 'string') throw new StoreError(400, 'Username is required.');
  const username = raw.trim();
  if (username.length < 2 || username.length > 24 || !USERNAME_RE.test(username)) {
    throw new StoreError(400, 'Username must be 2-24 chars (letters, digits, space, _ - .).');
  }
  return { username, usernameLower: username.toLowerCase() };
}

export function cleanDisplayName(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim().slice(0, 40);
  return trimmed || fallback;
}

export function cleanAvatar(raw, fallback = 'netrunner') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !AVATAR_RE.test(raw)) {
    throw new StoreError(400, 'Avatar must be 1-32 chars (letters, digits, _ -).');
  }
  return raw;
}

export function cleanRole(raw) {
  if (typeof raw !== 'string' || !ROLES.includes(raw)) {
    throw new StoreError(400, `Role must be one of: ${ROLES.join(', ')}.`);
  }
  return raw;
}

export function validateSecretForRole(role, rawSecret) {
  if (role === 'player') {
    const pin = typeof rawSecret === 'number' && Number.isFinite(rawSecret) ? String(rawSecret) : rawSecret;
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
      throw new StoreError(400, 'PIN must be 4-8 digits.');
    }
    return pin;
  }
  if (typeof rawSecret !== 'string' || rawSecret.length < 6 || rawSecret.length > 128) {
    throw new StoreError(400, 'Password must be 6-128 characters.');
  }
  return rawSecret;
}

export function cleanPrivileges(privs, role) {
  if (role === 'owner') return [...ALL_PRIVILEGES];
  if (privs === undefined) return [...ROLE_PRESETS[role]];
  if (!Array.isArray(privs)) throw new StoreError(400, 'Privileges must be an array.');
  const valid = new Set(ALL_PRIVILEGES);
  const out = [];
  for (const p of privs) {
    if (typeof p !== 'string' || !valid.has(p)) {
      throw new StoreError(400, `Unknown privilege: ${String(p)}`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function cleanGameId(raw) {
  if (typeof raw !== 'string' || !GAME_IDS.includes(raw)) {
    throw new StoreError(400, `Unknown game_id (valid: ${GAME_IDS.join(', ')}).`);
  }
  return raw;
}

export function cleanNonNegInt(raw, key, cap, fallback = 0) {
  let val = raw === undefined || raw === null ? fallback : raw;
  if (typeof val === 'boolean') val = val ? 1 : 0;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    throw new StoreError(400, `'${key}' must be a non-negative integer.`);
  }
  if (val > cap) {
    throw new StoreError(400, `'${key}' is over the sanity cap (${cap}).`);
  }
  return val;
}

export function hasPrivilege(actor, priv) {
  if (!actor) return false;
  if (actor.role === 'owner') return true;
  return Array.isArray(actor.privileges) && actor.privileges.includes(priv);
}

export function isUserExpired(user, now = Date.now()) {
  if (!user || !user.expiresAt) return false;
  const ts = new Date(user.expiresAt).getTime();
  return Number.isFinite(ts) && now >= ts;
}

export function levelFromXp(xp) {
  const x = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  while (50 * (level + 1) * level <= x) level += 1;
  return level;
}

// ---------- Game Profile Normalization ----------
const nonNegInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);

function perGameMap(src) {
  const out = {};
  for (const id of GAME_IDS) out[id] = nonNegInt(src?.[id], 0);
  return out;
}

export function emptyGameProfile(now = Date.now()) {
  return {
    v: 1,
    createdAt: now,
    xp: 0,
    eddies: 0,
    eddiesEarned: 0,
    scores: perGameMap(null),
    plays: perGameMap(null),
    wins: perGameMap(null),
    bestWaves: perGameMap(null),
    achievements: {},
    history: [],
    lastPlayed: null,
    settings: { lang: null, muted: false, theme: 'yellow' },
    migrated: true,
  };
}

export function normalizeGameProfile(raw, user = null) {
  const base = emptyGameProfile(user?.createdAt ? new Date(user.createdAt).getTime() : Date.now());
  const src = raw && typeof raw === 'object' ? raw : {};
  const s = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const ach = {};
  if (src.achievements && typeof src.achievements === 'object' && !Array.isArray(src.achievements)) {
    for (const [k, v] of Object.entries(src.achievements)) {
      if (typeof k === 'string' && k.length <= 64) {
        ach[k] = nonNegInt(v, Date.now()) || Date.now();
      }
    }
  }
  const xp = Math.min(CAP_TOTAL, Math.max(nonNegInt(user?.xp), nonNegInt(src.xp)));
  const eddies = Math.min(CAP_TOTAL, Math.max(nonNegInt(user?.eddies), nonNegInt(src.eddies)));
  const eddiesEarned = Math.min(
    CAP_TOTAL,
    Math.max(nonNegInt(user?.eddiesEarned), nonNegInt(src.eddiesEarned), eddies),
  );
  return {
    v: 1,
    createdAt: nonNegInt(src.createdAt, base.createdAt) || base.createdAt,
    xp,
    eddies,
    eddiesEarned,
    scores: perGameMap(src.scores),
    plays: perGameMap(src.plays),
    wins: perGameMap(src.wins),
    bestWaves: perGameMap(src.bestWaves),
    achievements: ach,
    history: Array.isArray(src.history)
      ? src.history
        .filter((h) => h && typeof h === 'object' && GAME_IDS.includes(h.gameId))
        .slice(0, HISTORY_LIMIT)
        .map((h) => ({
          gameId: h.gameId,
          score: nonNegInt(h.score),
          eddies: nonNegInt(h.eddies),
          xp: nonNegInt(h.xp),
          won: Boolean(h.won),
          wave: nonNegInt(h.wave),
          at: nonNegInt(h.at, Date.now()),
          best: Boolean(h.best),
        }))
      : [],
    lastPlayed: GAME_IDS.includes(src.lastPlayed) ? src.lastPlayed : null,
    settings: {
      lang: LANGS.includes(s.lang) ? s.lang : null,
      muted: Boolean(s.muted),
      theme: THEMES.includes(s.theme) ? s.theme : 'yellow',
    },
    migrated: Boolean(src.migrated ?? true),
  };
}

function mergeGameProfiles(existingRaw, incomingRaw, xp, eddies, eddiesEarned) {
  const a = normalizeGameProfile(existingRaw);
  const b = normalizeGameProfile(incomingRaw);
  const out = emptyGameProfile(Math.min(a.createdAt, b.createdAt));
  out.xp = Math.min(CAP_TOTAL, Math.max(a.xp, b.xp, nonNegInt(xp)));
  out.eddies = Math.min(CAP_TOTAL, Math.max(a.eddies, b.eddies, nonNegInt(eddies)));
  out.eddiesEarned = Math.min(CAP_TOTAL, Math.max(a.eddiesEarned, b.eddiesEarned, nonNegInt(eddiesEarned), out.eddies));
  for (const id of GAME_IDS) {
    out.scores[id] = Math.max(a.scores[id], b.scores[id]);
    out.plays[id] = Math.max(a.plays[id], b.plays[id]);
    out.wins[id] = Math.max(a.wins[id], b.wins[id]);
    out.bestWaves[id] = Math.max(a.bestWaves[id], b.bestWaves[id]);
  }
  const seen = new Set();
  out.history = [...b.history, ...a.history]
    .sort((x, y) => y.at - x.at)
    .filter((h) => {
      const k = `${h.gameId}:${h.score}:${h.at}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, HISTORY_LIMIT);
  const ach = { ...a.achievements };
  for (const [k, v] of Object.entries(b.achievements)) {
    ach[k] = ach[k] ? Math.min(ach[k], v) : v;
  }
  out.achievements = ach;
  out.lastPlayed = b.lastPlayed || a.lastPlayed || (out.history[0] ? out.history[0].gameId : null);
  out.settings = {
    lang: b.settings.lang || a.settings.lang || null,
    muted: b.settings.muted,
    theme: b.settings.theme || a.settings.theme || 'yellow',
  };
  return out;
}

// ---------- Safe Projections (NEVER leak secretHash/secretSalt/tokenHash) ----------
const isoOrNull = (d) => (d ? new Date(d).toISOString() : null);

export function toAuditEntry(d) {
  if (!d) return null;
  return {
    id: String(d._id),
    at: isoOrNull(d.at),
    actorUsername: d.actor?.username || 'anonymous',
    actorRole: d.actor?.role || '',
    actor: d.actor,
    ip: d.ip,
    action: d.action,
    target: d.target,
    status: d.status,
    sandboxTag: Boolean(d.sandboxTag),
    details: d.details || {},
  };
}

export function toPublicUser(user) {
  if (!user) return null;
  const id = String(user._id ?? user.id);
  const profile = normalizeGameProfile(user.profile, user);
  const xp = nonNegInt(user.xp);
  const eddies = nonNegInt(user.eddies);
  const eddiesEarned = Math.max(nonNegInt(user.eddiesEarned), eddies);
  return {
    id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    privileges: Array.isArray(user.privileges) ? [...user.privileges] : [...(ROLE_PRESETS[user.role] || [])],
    avatar: user.avatar || 'netrunner',
    xp,
    eddies,
    eddiesEarned,
    level: levelFromXp(xp),
    scores: profile.scores,
    plays: profile.plays,
    disabled: Boolean(user.disabled),
    expiresAt: isoOrNull(user.expiresAt),
    note: user.note || '',
    lastLoginAt: isoOrNull(user.lastLoginAt),
    createdAt: isoOrNull(user.createdAt),
    updatedAt: isoOrNull(user.updatedAt),
  };
}

export function toAdminUser(user, activeSessions = 0) {
  const base = toPublicUser(user);
  if (!base) return null;
  const profile = normalizeGameProfile(user.profile, user);
  const scores = profile.scores;
  const totalPlays = GAME_IDS.reduce((sum, g) => sum + (profile.plays[g] || 0), 0);
  const combinedScore = GAME_IDS.reduce((sum, g) => sum + (scores[g] || 0), 0);
  const bestScore = GAME_IDS.reduce((top, g) => Math.max(top, scores[g] || 0), 0);
  return {
    ...base,
    scores,
    plays: totalPlays,
    totalPlays,
    combinedScore,
    bestScore,
    profile: { scores, plays: profile.plays },
    activeSessions,
  };
}

export function toGameUserPayload(user) {
  if (!user) return null;
  const profile = normalizeGameProfile(user.profile, user);
  const xp = nonNegInt(user.xp);
  const eddies = nonNegInt(user.eddies);
  const eddiesEarned = Math.max(nonNegInt(user.eddiesEarned), eddies);
  return {
    id: String(user._id ?? user.id),
    handle: user.username,
    username: user.username,
    displayName: user.displayName || user.username,
    display_name: user.displayName || user.username,
    avatar: user.avatar || 'netrunner',
    role: user.role,
    privileges: Array.isArray(user.privileges) ? [...user.privileges] : [...(ROLE_PRESETS[user.role] || [])],
    canAccessDashboard: hasPrivilege(user, 'view_private'),
    expiresAt: isoOrNull(user.expiresAt),
    xp,
    eddies,
    eddiesEarned,
    level: levelFromXp(xp),
    profile,
    midruns: user.midruns && typeof user.midruns === 'object' ? clone(user.midruns) : {},
  };
}

export function toActor(user) {
  if (!user) return null;
  return {
    id: String(user._id ?? user.id),
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    privileges: Array.isArray(user.privileges) ? [...user.privileges] : [...(ROLE_PRESETS[user.role] || [])],
    isLegacy: Boolean(user.isLegacy),
  };
}

// ---------- Audit Sanitization ----------
export function sanitizeAuditDetails(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditDetails(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) continue;
      out[k] = sanitizeAuditDetails(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

function clone(val) {
  return structuredClone(val);
}

function toMongoId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
    return new ObjectId(id);
  }
  return id;
}

// ---------- Persistence Adapters ----------
function createMemoryDb() {
  const users = new Map();
  const sessions = new Map();
  const gameScores = [];
  const auditLogs = [];
  let settingsAuth = { _id: 'auth', allowLegacyPassword: true, updatedAt: new Date() };

  return {
    backend: 'memory',
    async ensureReady() {},
    async close() {},

    async findUserById(id) {
      const doc = users.get(String(id));
      return doc ? clone(doc) : null;
    },

    async findUserByUsernameLower(usernameLower) {
      for (const u of users.values()) {
        if (u.usernameLower === usernameLower) return clone(u);
      }
      return null;
    },

    async insertUser(doc) {
      for (const u of users.values()) {
        if (u.usernameLower === doc.usernameLower) {
          throw Object.assign(new Error('Duplicate username'), { code: 11000 });
        }
      }
      const id = randomBytes(12).toString('hex');
      const stored = clone({ ...doc, _id: id });
      users.set(id, stored);
      return clone(stored);
    },

    async updateUserById(id, setFields) {
      const key = String(id);
      const existing = users.get(key);
      if (!existing) return null;
      if (setFields.usernameLower && setFields.usernameLower !== existing.usernameLower) {
        for (const u of users.values()) {
          if (String(u._id) !== key && u.usernameLower === setFields.usernameLower) {
            throw Object.assign(new Error('Duplicate username'), { code: 11000 });
          }
        }
      }
      const next = { ...existing, ...clone(setFields) };
      users.set(key, next);
      return clone(next);
    },

    async deleteUserById(id) {
      return users.delete(String(id));
    },

    async listUsers() {
      return [...users.values()]
        .map(clone)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },

    async countUsers({ role, activeOnly = false, excludeId = null } = {}) {
      const now = Date.now();
      let count = 0;
      for (const u of users.values()) {
        if (excludeId && String(u._id) === String(excludeId)) continue;
        if (role && u.role !== role) continue;
        if (activeOnly && (u.disabled || isUserExpired(u, now))) continue;
        count += 1;
      }
      return count;
    },

    async countActiveUsersWithHigherScore(gameId, score) {
      let count = 0;
      for (const u of users.values()) {
        if (u.disabled) continue;
        if ((u.profile?.scores?.[gameId] || 0) > score) count += 1;
      }
      return count;
    },

    async insertSession(doc) {
      const id = randomBytes(12).toString('hex');
      const stored = clone({ ...doc, _id: id });
      sessions.set(id, stored);
      return clone(stored);
    },

    async findSessionByTokenHash(tokenHash) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) return clone(s);
      }
      return null;
    },

    async touchSession(id, now) {
      const s = sessions.get(String(id));
      if (s) s.lastSeenAt = now;
    },

    async revokeSessionByTokenHash(tokenHash, now) {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash && !s.revoked) {
          s.revoked = true;
          s.revokedAt = now;
          return true;
        }
      }
      return false;
    },

    async revokeSessionsByUserId(userId, exceptSessionId, now) {
      const target = String(userId);
      const keep = exceptSessionId ? String(exceptSessionId) : null;
      let count = 0;
      for (const s of sessions.values()) {
        if (String(s.userId) === target && !s.revoked && (!keep || String(s._id) !== keep)) {
          s.revoked = true;
          s.revokedAt = now;
          count += 1;
        }
      }
      return count;
    },

    async countActiveSessionsByUserMap(now) {
      const counts = new Map();
      for (const s of sessions.values()) {
        if (s.revoked) continue;
        if (new Date(s.expiresAt).getTime() <= now) continue;
        const uid = String(s.userId);
        counts.set(uid, (counts.get(uid) || 0) + 1);
      }
      return counts;
    },

    async insertGameScore(doc) {
      const id = randomBytes(12).toString('hex');
      const stored = clone({ ...doc, _id: id });
      gameScores.push(stored);
      return clone(stored);
    },

    async countGameScores() {
      return gameScores.length;
    },

    async deleteGameScoresByUserId(userId) {
      const target = String(userId);
      for (let i = gameScores.length - 1; i >= 0; i -= 1) {
        if (String(gameScores[i].userId) === target) gameScores.splice(i, 1);
      }
    },

    async insertAudit(doc) {
      const id = randomBytes(12).toString('hex');
      const stored = clone({ ...doc, _id: id });
      auditLogs.push(stored);
      return clone(stored);
    },

    async queryAuditDocs({ action, actor, role, sandboxOnly, q, limit = 150 }) {
      const needle = q ? String(q).trim().toLowerCase() : '';
      const actorNeedle = actor ? String(actor).trim().toLowerCase() : '';
      const filtered = auditLogs.filter((doc) => {
        if (action && doc.action !== action) return false;
        if (role && doc.actor?.role !== role) return false;
        if (sandboxOnly && !doc.sandboxTag) return false;
        if (actorNeedle) {
          const uname = String(doc.actor?.username || '').toLowerCase();
          const uid = String(doc.actor?.id || '').toLowerCase();
          if (uname !== actorNeedle && uid !== actorNeedle) return false;
        }
        if (needle) {
          const hay = [
            doc.action,
            doc.target,
            doc.status,
            doc.ip,
            doc.actor?.username,
            doc.actor?.displayName,
            JSON.stringify(doc.details || {}),
          ].join(' ').toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      });
      filtered.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return filtered.slice(0, limit).map(clone);
    },

    async getSandboxStats(now) {
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const byAction = {};
      const actors = new Set();
      const sandboxDocs = [];
      let totalEvents = 0;
      let last24h = 0;
      for (const doc of auditLogs) {
        if (!doc.sandboxTag) continue;
        totalEvents += 1;
        sandboxDocs.push(doc);
        if (new Date(doc.at).getTime() >= dayAgo) last24h += 1;
        byAction[doc.action] = (byAction[doc.action] || 0) + 1;
        if (doc.actor?.username) actors.add(doc.actor.username);
      }
      sandboxDocs.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      let activeGuests = 0;
      let expiredGuests = 0;
      for (const u of users.values()) {
        if (u.role !== 'recruiter_guest') continue;
        if (!u.disabled && !isUserExpired(u, now)) activeGuests += 1;
        else if (isUserExpired(u, now)) expiredGuests += 1;
      }
      return {
        count: totalEvents,
        totalEvents,
        last24h,
        activeGuests,
        expiredGuests,
        byAction,
        recentActors: [...actors],
        recent: sandboxDocs.slice(0, 12).map((d) => toAuditEntry(clone(d))),
      };
    },

    async getSettingsAuth() {
      return clone(settingsAuth);
    },

    async setSettingsAuth(patch) {
      settingsAuth = { ...settingsAuth, ...clone(patch), _id: 'auth', updatedAt: new Date() };
      return clone(settingsAuth);
    },
  };
}

function createMongoDb(mongoUri) {
  let client = null;
  let db = null;
  let connectPromise = null;

  const ensureReady = async () => {
    if (db) return db;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const c = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await c.connect();
      const database = c.db();
      await Promise.all([
        database.collection('users').createIndex({ usernameLower: 1 }, { unique: true }),
        database.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
        database.collection('sessions').createIndex({ userId: 1 }),
        database.collection('sessions').createIndex({ expiresAt: 1 }),
        database.collection('game_scores').createIndex({ userId: 1, gameId: 1 }),
        database.collection('game_scores').createIndex({ gameId: 1, score: -1 }),
        database.collection('game_scores').createIndex({ createdAt: -1 }),
        database.collection('audit_logs').createIndex({ at: -1 }),
        database.collection('audit_logs').createIndex({ action: 1, at: -1 }),
        database.collection('audit_logs').createIndex({ sandboxTag: 1, at: -1 }),
      ]).catch(() => {});
      client = c;
      db = database;
      return db;
    })();
    try {
      return await connectPromise;
    } catch (error) {
      connectPromise = null;
      throw error;
    }
  };

  const col = async (name) => (await ensureReady()).collection(name);

  return {
    backend: 'mongodb',
    ensureReady,
    async close() {
      connectPromise = null;
      db = null;
      if (client) {
        const c = client;
        client = null;
        await c.close().catch(() => {});
      }
    },

    async findUserById(id) {
      const users = await col('users');
      return users.findOne({ _id: toMongoId(id) });
    },

    async findUserByUsernameLower(usernameLower) {
      const users = await col('users');
      return users.findOne({ usernameLower });
    },

    async insertUser(doc) {
      const users = await col('users');
      const res = await users.insertOne(doc);
      return { ...doc, _id: res.insertedId };
    },

    async updateUserById(id, setFields) {
      const users = await col('users');
      return users.findOneAndUpdate(
        { _id: toMongoId(id) },
        { $set: setFields },
        { returnDocument: 'after' },
      );
    },

    async deleteUserById(id) {
      const users = await col('users');
      const res = await users.deleteOne({ _id: toMongoId(id) });
      return res.deletedCount > 0;
    },

    async listUsers() {
      const users = await col('users');
      return users.find({}).sort({ createdAt: -1 }).toArray();
    },

    async countUsers({ role, activeOnly = false, excludeId = null } = {}) {
      const users = await col('users');
      const now = new Date();
      const filter = {};
      if (role) filter.role = role;
      if (excludeId) filter._id = { $ne: toMongoId(excludeId) };
      if (activeOnly) {
        filter.disabled = { $ne: true };
        filter.$or = [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }];
      }
      return users.countDocuments(filter);
    },

    async countActiveUsersWithHigherScore(gameId, score) {
      const users = await col('users');
      return users.countDocuments({
        disabled: { $ne: true },
        [`profile.scores.${gameId}`]: { $gt: score },
      });
    },

    async insertSession(doc) {
      const sessions = await col('sessions');
      const res = await sessions.insertOne(doc);
      return { ...doc, _id: res.insertedId };
    },

    async findSessionByTokenHash(tokenHash) {
      const sessions = await col('sessions');
      return sessions.findOne({ tokenHash });
    },

    async touchSession(id, now) {
      const sessions = await col('sessions');
      await sessions.updateOne({ _id: toMongoId(id) }, { $set: { lastSeenAt: now } });
    },

    async revokeSessionByTokenHash(tokenHash, now) {
      const sessions = await col('sessions');
      const res = await sessions.updateOne(
        { tokenHash, revoked: { $ne: true } },
        { $set: { revoked: true, revokedAt: now } },
      );
      return res.modifiedCount > 0;
    },

    async revokeSessionsByUserId(userId, exceptSessionId, now) {
      const sessions = await col('sessions');
      const filter = { userId: String(userId), revoked: { $ne: true } };
      if (exceptSessionId) filter._id = { $ne: toMongoId(exceptSessionId) };
      const res = await sessions.updateMany(filter, { $set: { revoked: true, revokedAt: now } });
      return res.modifiedCount;
    },

    async countActiveSessionsByUserMap(now) {
      const sessions = await col('sessions');
      const rows = await sessions.aggregate([
        { $match: { revoked: { $ne: true }, expiresAt: { $gt: new Date(now) } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]).toArray();
      const map = new Map();
      for (const r of rows) map.set(String(r._id), r.count);
      return map;
    },

    async insertGameScore(doc) {
      const scores = await col('game_scores');
      const res = await scores.insertOne(doc);
      return { ...doc, _id: res.insertedId };
    },

    async countGameScores() {
      const scores = await col('game_scores');
      return scores.countDocuments();
    },

    async deleteGameScoresByUserId(userId) {
      const scores = await col('game_scores');
      await scores.deleteMany({ userId: String(userId) });
    },

    async insertAudit(doc) {
      const audit = await col('audit_logs');
      const res = await audit.insertOne(doc);
      return { ...doc, _id: res.insertedId };
    },

    async queryAuditDocs({ action, actor, role, sandboxOnly, q, limit = 150 }) {
      const audit = await col('audit_logs');
      const filter = {};
      if (action) filter.action = String(action);
      if (role) filter['actor.role'] = String(role);
      if (sandboxOnly) filter.sandboxTag = true;
      if (actor) {
        const val = String(actor).trim();
        const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { 'actor.username': { $regex: `^${escaped}$`, $options: 'i' } },
          { 'actor.id': val },
        ];
      }
      if (q) {
        const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = { $regex: escaped, $options: 'i' };
        const qOr = [
          { action: re },
          { target: re },
          { status: re },
          { ip: re },
          { 'actor.username': re },
          { 'actor.displayName': re },
        ];
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: qOr }];
          delete filter.$or;
        } else {
          filter.$or = qOr;
        }
      }
      return audit.find(filter).sort({ at: -1 }).limit(limit).toArray();
    },

    async getSandboxStats(now) {
      const [audit, users] = await Promise.all([col('audit_logs'), col('users')]);
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const docs = await audit.find({ sandboxTag: true }).sort({ at: -1 }).limit(1000).toArray();
      const byAction = {};
      const actors = new Set();
      let last24h = 0;
      for (const doc of docs) {
        if (new Date(doc.at) >= dayAgo) last24h += 1;
        byAction[doc.action] = (byAction[doc.action] || 0) + 1;
        if (doc.actor?.username) actors.add(doc.actor.username);
      }
      const totalEvents = await audit.countDocuments({ sandboxTag: true });
      const guests = await users.find({ role: 'recruiter_guest' }).toArray();
      let activeGuests = 0;
      let expiredGuests = 0;
      for (const g of guests) {
        if (!g.disabled && !isUserExpired(g, now)) activeGuests += 1;
        else if (isUserExpired(g, now)) expiredGuests += 1;
      }
      return {
        count: totalEvents,
        totalEvents,
        last24h,
        activeGuests,
        expiredGuests,
        byAction,
        recentActors: [...actors],
        recent: docs.slice(0, 12).map(toAuditEntry),
      };
    },

    async getSettingsAuth() {
      const settings = await col('settings');
      const doc = await settings.findOne({ _id: 'auth' });
      return doc || { _id: 'auth', allowLegacyPassword: true, updatedAt: new Date() };
    },

    async setSettingsAuth(patch) {
      const settings = await col('settings');
      return settings.findOneAndUpdate(
        { _id: 'auth' },
        { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
      );
    },
  };
}

// ---------- Store Factory ----------
export function createAuthStore({ mongoUri = process.env.MONGO_URI || DEFAULT_MONGO_URI, memory = false } = {}) {
  const db = memory ? createMemoryDb() : createMongoDb(mongoUri);

  return {
    backend: db.backend,
    isMemory: Boolean(memory),
    ensureReady: () => db.ensureReady(),
    close: () => db.close(),

    async health() {
      const [users, scores] = await Promise.all([db.countUsers(), db.countGameScores()]);
      return { ok: true, users, scores, backend: db.backend };
    },

    countOwners() {
      return db.countUsers({ role: 'owner' });
    },

    countActiveOwners(excludeId = null) {
      return db.countUsers({ role: 'owner', activeOnly: true, excludeId });
    },

    async getAuthSettings() {
      const doc = await db.getSettingsAuth();
      return { allowLegacyPassword: doc.allowLegacyPassword !== false };
    },

    async updateAuthSettings({ allowLegacyPassword }) {
      const doc = await db.setSettingsAuth({ allowLegacyPassword: Boolean(allowLegacyPassword) });
      return { allowLegacyPassword: doc.allowLegacyPassword !== false };
    },

    findUserById(id) {
      return db.findUserById(id);
    },

    async findUserByUsername(username) {
      if (typeof username !== 'string') return null;
      return db.findUserByUsernameLower(username.trim().toLowerCase());
    },

    async createUser({
      username: rawUsername,
      displayName: rawDisplayName,
      role: rawRole,
      privileges: rawPrivileges,
      password,
      pin,
      note = '',
      avatar,
      expiresAt = null,
    }) {
      const { username, usernameLower } = cleanUsername(rawUsername);
      const role = cleanRole(rawRole);
      const displayName = cleanDisplayName(rawDisplayName, username);
      const cleanedAvatar = cleanAvatar(avatar, 'netrunner');
      const privileges = cleanPrivileges(rawPrivileges, role);
      const secret = validateSecretForRole(role, role === 'player' ? (pin ?? password) : (password ?? pin));
      const { salt, hash } = hashSecret(secret);
      const now = new Date();
      const doc = {
        username,
        usernameLower,
        displayName,
        role,
        privileges,
        secretSalt: salt,
        secretHash: hash,
        disabled: false,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        note: String(note || '').slice(0, 500),
        avatar: cleanedAvatar,
        xp: 0,
        eddies: 0,
        eddiesEarned: 0,
        profile: emptyGameProfile(now.getTime()),
        midruns: {},
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        return await db.insertUser(doc);
      } catch (err) {
        if (err && err.code === 11000) throw new StoreError(409, 'Username is already taken.');
        throw err;
      }
    },

    verifyUserSecret(user, secret) {
      if (!user) return false;
      return verifySecret(String(secret ?? ''), user.secretSalt, user.secretHash);
    },

    async updateUser(id, patch) {
      const setFields = { ...patch, updatedAt: new Date() };
      return db.updateUserById(id, setFields);
    },

    async changeUserSecret(id, newSecret, role) {
      const validSecret = validateSecretForRole(role, newSecret);
      const { salt, hash } = hashSecret(validSecret);
      return db.updateUserById(id, { secretSalt: salt, secretHash: hash, updatedAt: new Date() });
    },

    async deleteUser(id) {
      await db.revokeSessionsByUserId(id, null, new Date());
      await db.deleteGameScoresByUserId(id);
      return db.deleteUserById(id);
    },

    async listUsersWithStats() {
      const [users, sessionCounts] = await Promise.all([
        db.listUsers(),
        db.countActiveSessionsByUserMap(Date.now()),
      ]);
      return users.map((u) => toAdminUser(u, sessionCounts.get(String(u._id)) || 0));
    },

    async listPublicGameUsers() {
      const users = await db.listUsers();
      return users
        .filter((u) => !u.disabled)
        .sort((a, b) => (nonNegInt(b.xp) - nonNegInt(a.xp)) || a.username.localeCompare(b.username))
        .slice(0, 500)
        .map((u) => ({
          handle: u.username,
          display_name: u.displayName || u.username,
          avatar: u.avatar || 'netrunner',
          xp: nonNegInt(u.xp),
          level: levelFromXp(u.xp),
          created_at: u.createdAt ? Math.floor(new Date(u.createdAt).getTime() / 1000) : 0,
        }));
    },

    async createSession({ userId, ip = '', userAgent = '', userExpiresAt = null, ttlMs = DEFAULT_SESSION_TTL_MS }) {
      const token = randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const now = new Date();
      let expiresMs = now.getTime() + ttlMs;
      if (userExpiresAt) {
        const cap = new Date(userExpiresAt).getTime();
        if (Number.isFinite(cap) && cap < expiresMs) expiresMs = cap;
      }
      const doc = {
        tokenHash,
        userId: String(userId),
        createdAt: now,
        expiresAt: new Date(expiresMs),
        revoked: false,
        revokedAt: null,
        ip: String(ip || '').slice(0, 128),
        userAgent: String(userAgent || '').slice(0, 300),
        lastSeenAt: now,
      };
      const session = await db.insertSession(doc);
      return { token, session };
    },

    async resolveSession(token) {
      if (typeof token !== 'string' || !token || token.length > 256) return null;
      const session = await db.findSessionByTokenHash(hashToken(token));
      if (!session || session.revoked) return null;
      const now = Date.now();
      if (new Date(session.expiresAt).getTime() <= now) return null;
      const user = await db.findUserById(session.userId);
      if (!user) return null;
      if (!user.disabled && !isUserExpired(user, now)) {
        const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
        if (now - lastSeen > 15_000) {
          db.touchSession(session._id, new Date(now)).catch(() => {});
        }
      }
      return { session, user };
    },

    revokeSession(token) {
      if (typeof token !== 'string' || !token) return Promise.resolve(false);
      return db.revokeSessionByTokenHash(hashToken(token), new Date());
    },

    revokeUserSessions(userId, { exceptSessionId = null } = {}) {
      return db.revokeSessionsByUserId(userId, exceptSessionId, new Date());
    },

    async updateGameProfile(userId, { xp, eddies, eddiesEarned, avatar, profile } = {}) {
      const user = await db.findUserById(userId);
      if (!user) throw new StoreError(404, 'User not found.');
      const nextAvatar = avatar !== undefined ? cleanAvatar(avatar, user.avatar || 'netrunner') : (user.avatar || 'netrunner');
      if (profile !== undefined) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          throw new StoreError(400, "'profile' must be a JSON object.");
        }
        const bytes = Buffer.byteLength(JSON.stringify(profile), 'utf8');
        if (bytes > MAX_PROFILE_BYTES) throw new StoreError(413, 'Profile too large (max 128KB).');
      }
      const nextXp = xp !== undefined ? Math.max(nonNegInt(user.xp), cleanNonNegInt(xp, 'xp', CAP_TOTAL)) : nonNegInt(user.xp);
      const nextEddies = eddies !== undefined ? Math.max(nonNegInt(user.eddies), cleanNonNegInt(eddies, 'eddies', CAP_TOTAL)) : nonNegInt(user.eddies);
      const nextEarned = eddiesEarned !== undefined
        ? Math.max(nonNegInt(user.eddiesEarned), cleanNonNegInt(eddiesEarned, 'eddiesEarned', CAP_TOTAL), nextEddies)
        : Math.max(nonNegInt(user.eddiesEarned), nextEddies);
      const mergedProfile = profile !== undefined
        ? mergeGameProfiles(user.profile, profile, nextXp, nextEddies, nextEarned)
        : normalizeGameProfile(user.profile, { ...user, xp: nextXp, eddies: nextEddies, eddiesEarned: nextEarned });
      return db.updateUserById(user._id, {
        avatar: nextAvatar,
        xp: mergedProfile.xp,
        eddies: mergedProfile.eddies,
        eddiesEarned: mergedProfile.eddiesEarned,
        profile: mergedProfile,
        updatedAt: new Date(),
      });
    },

    async setMidRun(userId, gameId, snapshot) {
      const validGame = cleanGameId(gameId);
      const bytes = Buffer.byteLength(JSON.stringify(snapshot ?? {}), 'utf8');
      if (bytes > MAX_MIDRUN_BYTES) throw new StoreError(413, 'Mid-run snapshot too large (max 64KB).');
      const user = await db.findUserById(userId);
      if (!user) throw new StoreError(404, 'User not found.');
      const midruns = user.midruns && typeof user.midruns === 'object' ? { ...user.midruns } : {};
      midruns[validGame] = { data: snapshot ?? {}, saved_at: Math.floor(Date.now() / 1000) };
      const updated = await db.updateUserById(user._id, { midruns, updatedAt: new Date() });
      return updated.midruns;
    },

    async clearMidRun(userId, gameId) {
      const validGame = cleanGameId(gameId);
      const user = await db.findUserById(userId);
      if (!user) throw new StoreError(404, 'User not found.');
      const midruns = user.midruns && typeof user.midruns === 'object' ? { ...user.midruns } : {};
      delete midruns[validGame];
      const updated = await db.updateUserById(user._id, { midruns, updatedAt: new Date() });
      return updated.midruns;
    },

    async recordGameScore({ userId, gameId, score, wave = 0, won = false, eddies = 0, xp = 0 }) {
      const validGame = cleanGameId(gameId);
      const validScore = cleanNonNegInt(score, 'score', CAP_SCORE);
      const validWave = cleanNonNegInt(wave, 'wave', CAP_WAVE, 0);
      const validEddies = cleanNonNegInt(eddies, 'eddies', CAP_EDDIES, 0);
      const validXp = cleanNonNegInt(xp, 'xp', CAP_XP, 0);
      const didWin = Boolean(won);

      const user = await db.findUserById(userId);
      if (!user) throw new StoreError(404, 'User not found.');

      const now = new Date();
      await db.insertGameScore({
        userId: String(user._id),
        username: user.username,
        gameId: validGame,
        score: validScore,
        wave: validWave,
        won: didWin,
        eddies: validEddies,
        xp: validXp,
        createdAt: now,
      });

      const profile = normalizeGameProfile(user.profile, user);
      const prevBest = profile.scores[validGame] || 0;
      const isNewBest = validScore > prevBest;
      const bestScore = Math.max(prevBest, validScore);
      profile.scores[validGame] = bestScore;
      profile.plays[validGame] = (profile.plays[validGame] || 0) + 1;
      if (didWin) profile.wins[validGame] = (profile.wins[validGame] || 0) + 1;
      profile.bestWaves[validGame] = Math.max(profile.bestWaves[validGame] || 0, validWave);
      profile.lastPlayed = validGame;
      profile.xp = Math.min(CAP_TOTAL, profile.xp + validXp);
      profile.eddies = Math.min(CAP_TOTAL, profile.eddies + validEddies);
      profile.eddiesEarned = Math.min(CAP_TOTAL, profile.eddiesEarned + validEddies);

      const updated = await db.updateUserById(user._id, {
        xp: profile.xp,
        eddies: profile.eddies,
        eddiesEarned: profile.eddiesEarned,
        profile,
        updatedAt: now,
      });

      const higherCount = await db.countActiveUsersWithHigherScore(validGame, bestScore);
      return {
        isNewBest,
        bestScore,
        rank: 1 + higherCount,
        xp: updated.xp,
        eddies: updated.eddies,
        user: updated,
      };
    },

    async getLeaderboard({ game = 'all', limit = 20 } = {}) {
      if (game !== 'all') cleanGameId(game);
      const lim = Math.max(1, Math.min(100, Number(limit) || 20));
      const users = (await db.listUsers()).filter((u) => !u.disabled);

      const games = GAME_IDS.map((g) => {
        let players = 0;
        let topScore = 0;
        for (const u of users) {
          const sc = u.profile?.scores?.[g] || 0;
          const pl = u.profile?.plays?.[g] || 0;
          if (sc > 0 || pl > 0) {
            players += 1;
            if (sc > topScore) topScore = sc;
          }
        }
        return { game_id: g, players, top_score: topScore };
      });

      let entries = [];
      if (game === 'all') {
        const rows = [];
        for (const u of users) {
          const profile = normalizeGameProfile(u.profile, u);
          const combinedScore = GAME_IDS.reduce((s, g) => s + (profile.scores[g] || 0), 0);
          const gamesPlayed = GAME_IDS.reduce((s, g) => s + (profile.plays[g] || 0), 0);
          if (combinedScore <= 0 && gamesPlayed <= 0) continue;
          rows.push({
            handle: u.username,
            display_name: u.displayName || u.username,
            avatar: u.avatar || 'netrunner',
            role: u.role,
            combined_score: combinedScore,
            xp: profile.xp,
            level: levelFromXp(profile.xp),
            eddies: profile.eddies,
            games_played: gamesPlayed,
          });
        }
        rows.sort((a, b) => (b.combined_score - a.combined_score) || (b.xp - a.xp) || a.handle.localeCompare(b.handle));
        entries = rows.slice(0, lim).map((r, idx) => ({ rank: idx + 1, ...r }));
      } else {
        const rows = [];
        for (const u of users) {
          const profile = normalizeGameProfile(u.profile, u);
          const sc = profile.scores[game] || 0;
          const pl = profile.plays[game] || 0;
          if (sc <= 0 && pl <= 0) continue;
          rows.push({
            handle: u.username,
            display_name: u.displayName || u.username,
            avatar: u.avatar || 'netrunner',
            role: u.role,
            score: sc,
            wave: profile.bestWaves[game] || 0,
            plays: pl,
            xp: profile.xp,
            eddies: profile.eddies,
            updated_at: u.updatedAt ? Math.floor(new Date(u.updatedAt).getTime() / 1000) : 0,
          });
        }
        rows.sort((a, b) => (b.score - a.score) || (a.updated_at - b.updated_at) || a.handle.localeCompare(b.handle));
        entries = rows.slice(0, lim).map((r, idx) => ({ rank: idx + 1, ...r }));
      }
      return { game, entries, games };
    },

    async writeAudit({ actor = null, ip = '', action, target = '', status = 'ok', details = {}, sandboxTag = false }) {
      const safeActor = actor
        ? {
          id: String(actor.id ?? actor._id ?? ''),
          username: String(actor.username || 'unknown'),
          displayName: String(actor.displayName || actor.username || 'unknown'),
          role: String(actor.role || 'unknown'),
          isLegacy: Boolean(actor.isLegacy),
        }
        : { id: 'anonymous', username: 'anonymous', displayName: 'Anonymous', role: 'anonymous', isLegacy: false };
      const doc = {
        at: new Date(),
        actor: safeActor,
        ip: String(ip || '').slice(0, 128),
        action: String(action || ''),
        target: target != null ? String(target).slice(0, 200) : '',
        status: String(status || 'ok'),
        sandboxTag: Boolean(sandboxTag || safeActor.role === 'recruiter_guest'),
        details: sanitizeAuditDetails(details || {}),
      };
      return db.insertAudit(doc);
    },

    async queryAudit({ action = '', actor = '', role = '', sandboxOnly = false, q = '', limit = 150 } = {}) {
      const lim = Math.max(1, Math.min(500, Number(limit) || 150));
      const docs = await db.queryAuditDocs({
        action: String(action || '').trim(),
        actor: String(actor || '').trim(),
        role: String(role || '').trim(),
        sandboxOnly: sandboxOnly === true || sandboxOnly === '1' || sandboxOnly === 'true',
        q: String(q || '').trim(),
        limit: lim,
      });
      return docs.map(toAuditEntry);
    },

    getSandboxSummary() {
      return db.getSandboxStats(Date.now());
    },
  };
}
