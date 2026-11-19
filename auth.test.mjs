import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import {
  ALL_PRIVILEGES,
  ROLE_PRESETS,
  createAuthStore,
  hashSecret,
  sanitizeAuditDetails,
  verifySecret,
} from './auth-store.js';
import { createApp } from './server.js';

async function startTestApp(opts = {}) {
  const store = opts.store || createAuthStore({ memory: true });
  const tempDir = path.join(os.tmpdir(), `homelab-auth-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const app = createApp({
    store,
    notesFile: path.join(tempDir, 'notes.json'),
    uptimeFile: path.join(tempDir, 'uptime.json'),
    backgroundJobs: false,
    ...opts,
  });
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const req = async (method, route, { body, headers = {}, cookie } = {}) => {
    const reqHeaders = { ...headers };
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
    if (cookie) reqHeaders.Cookie = cookie;
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    const cookieHeader = setCookies
      .map((sc) => sc.split(';')[0])
      .filter((pair) => pair.includes('=') && !pair.endsWith('='))
      .join('; ');
    return { status: res.status, ok: res.ok, data, headers: res.headers, setCookies, cookie: cookieHeader };
  };

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    rmSync(tempDir, { recursive: true, force: true });
  };

  return { app, store, baseUrl, req, close };
}

async function bootstrapOwner(tApp, { username = 'aviowner', password = 'OwnerSecret!99', mainPassword } = {}) {
  const res = await tApp.req('POST', '/api/auth/bootstrap', {
    body: { username, displayName: 'Avi Owner', password, ...(mainPassword !== undefined ? { mainPassword } : {}) },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.ok(res.cookie.includes('homelab_session='));
  return res;
}

test('01. auth-store scrypt hashing and audit secret stripping', () => {
  const { salt, hash } = hashSecret('TopSecret123');
  assert.equal(salt.length, 32);
  assert.equal(hash.length, 128);
  assert.equal(verifySecret('TopSecret123', salt, hash), true);
  assert.equal(verifySecret('WrongSecret', salt, hash), false);

  const sanitized = sanitizeAuditDetails({
    safeField: 'hello',
    password: 'leak',
    newPassword: 'leak',
    pin: '1234',
    token: 'tok',
    key: 'AIzaLeak',
    apiKey: 'AIzaLeak2',
    secret: 'sec',
    nested: { authorization: 'Bearer x', ok: 42 },
  });
  assert.deepEqual(sanitized, { safeField: 'hello', nested: { ok: 42 } });
});

test('02. fresh store auth/me reports needsBootstrap=true and unauthenticated', async (t) => {
  const tApp = await startTestApp();
  t.after(tApp.close);

  const me = await tApp.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.authenticated, false);
  assert.equal(me.data.needsBootstrap, true);
  assert.equal(me.data.allowLegacyPassword, true);
  assert.equal(me.data.user, null);
});

test('03. bootstrap requires DASHBOARD_PASSWORD when set in env', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'MasterEnvPass!42';
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const bad = await tApp.req('POST', '/api/auth/bootstrap', {
    body: { username: 'owner1', password: 'OwnerPass!1', mainPassword: 'wrong' },
  });
  assert.equal(bad.status, 401);

  const good = await bootstrapOwner(tApp, { username: 'owner1', password: 'OwnerPass!1', mainPassword: 'MasterEnvPass!42' });
  assert.equal(good.data.user.role, 'owner');
  assert.deepEqual(good.data.user.privileges, ALL_PRIVILEGES);
  assert.equal(good.data.user.secretHash, undefined);
  assert.equal(good.data.user.secretSalt, undefined);
});

test('04. duplicate bootstrap is blocked with 409', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  await bootstrapOwner(tApp);
  const dup = await tApp.req('POST', '/api/auth/bootstrap', {
    body: { username: 'owner2', password: 'AnotherPassword!1' },
  });
  assert.equal(dup.status, 409);
});

test('05. login sets HttpOnly SameSite=Lax cookie and Secure when x-forwarded-proto=https', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  await bootstrapOwner(tApp, { username: 'OwnerCase', password: 'OwnerSecret!99' });

  const httpLogin = await tApp.req('POST', '/api/auth/login', {
    body: { username: 'ownercase', password: 'OwnerSecret!99' },
  });
  assert.equal(httpLogin.status, 200);
  assert.equal(httpLogin.data.user.username, 'OwnerCase');
  assert.ok(httpLogin.setCookies[0].includes('HttpOnly'));
  assert.ok(httpLogin.setCookies[0].includes('SameSite=Lax'));
  assert.equal(httpLogin.setCookies[0].includes('Secure'), false);

  const httpsLogin = await tApp.req('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-Proto': 'https' },
    body: { username: 'ownercase', password: 'OwnerSecret!99' },
  });
  assert.equal(httpsLogin.status, 200);
  assert.ok(httpsLogin.setCookies[0].includes('Secure'));

  const me = await tApp.req('GET', '/api/auth/me', { cookie: httpsLogin.cookie });
  assert.equal(me.data.authenticated, true);
  assert.equal(me.data.needsBootstrap, false);
  assert.equal(me.data.user.username, 'OwnerCase');
});

test('06. login rate limit blocks after 10 failures in 15 minutes with 429', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  await bootstrapOwner(tApp, { username: 'rateowner', password: 'OwnerSecret!99' });

  for (let i = 1; i <= 9; i += 1) {
    const fail = await tApp.req('POST', '/api/auth/login', {
      headers: { 'X-Forwarded-For': '10.99.99.5' },
      body: { username: 'rateowner', password: `wrong-${i}` },
    });
    assert.equal(fail.status, 401);
  }
  const tenth = await tApp.req('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-For': '10.99.99.5' },
    body: { username: 'rateowner', password: 'wrong-10' },
  });
  assert.equal(tenth.status, 429);

  // Even the valid password is blocked from that IP while locked
  const locked = await tApp.req('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-For': '10.99.99.5' },
    body: { username: 'rateowner', password: 'OwnerSecret!99' },
  });
  assert.equal(locked.status, 429);

  // Another IP is unaffected
  const otherIp = await tApp.req('POST', '/api/auth/login', {
    headers: { 'X-Forwarded-For': '10.99.99.6' },
    body: { username: 'rateowner', password: 'OwnerSecret!99' },
  });
  assert.equal(otherIp.status, 200);
});

test('07. player self-registration validates PIN & username uniqueness and enforces play_games only', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'MainOwner' });

  const badPin = await tApp.req('POST', '/api/auth/register', { body: { username: 'p1', pin: '12' } });
  assert.equal(badPin.status, 400);

  const badUser = await tApp.req('POST', '/api/auth/register', { body: { username: 'bad!user', pin: '1234' } });
  assert.equal(badUser.status, 400);

  const dupOwner = await tApp.req('POST', '/api/auth/register', { body: { username: 'mainowner', pin: '1234' } });
  assert.equal(dupOwner.status, 409);

  const reg = await tApp.req('POST', '/api/auth/register', {
    body: { username: 'CyberPlayer', pin: '2077', avatar: 'solo' },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.created, true);
  assert.equal(reg.data.user.role, 'player');
  assert.deepEqual(reg.data.user.privileges, ['play_games']);

  const notesDenied = await tApp.req('GET', '/api/notes', { cookie: reg.cookie });
  assert.equal(notesDenied.status, 403);
  assert.equal(notesDenied.data.message, 'Missing privilege: manage_notes');

  const adminDenied = await tApp.req('GET', '/api/admin/users', { cookie: reg.cookie });
  assert.equal(adminDenied.status, 403);
  assert.equal(adminDenied.data.message, 'Missing privilege: manage_users');

  // Verify denied access was recorded in audit logs
  const audit = await tApp.req('GET', '/api/admin/audit?action=rbac.denied', { cookie: owner.cookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.logs.length >= 2);
  assert.equal(audit.data.logs[0].status, 'denied');
});

test('08. logout revokes session token and clears cookie', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  await bootstrapOwner(tApp, { username: 'logoutowner', password: 'OwnerSecret!99' });
  const login = await tApp.req('POST', '/api/auth/login', {
    body: { username: 'logoutowner', password: 'OwnerSecret!99' },
  });
  const token = login.data.token;

  const okNotes = await tApp.req('GET', '/api/notes', { cookie: login.cookie });
  assert.equal(okNotes.status, 200);

  const out = await tApp.req('POST', '/api/auth/logout', { cookie: login.cookie });
  assert.equal(out.status, 200);
  assert.ok(out.setCookies[0].includes('Max-Age=0'));

  const afterCookie = await tApp.req('GET', '/api/notes', { cookie: login.cookie });
  assert.equal(afterCookie.status, 401);

  const afterBearer = await tApp.req('GET', '/api/notes', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(afterBearer.status, 401);
});

test('09. change-password revokes other sessions while keeping caller session active', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const boot = await bootstrapOwner(tApp, { username: 'pwowner', password: 'OldPassword!1' });
  const sA = await tApp.req('POST', '/api/auth/login', { body: { username: 'pwowner', password: 'OldPassword!1' } });
  const sB = await tApp.req('POST', '/api/auth/login', { body: { username: 'pwowner', password: 'OldPassword!1' } });

  const badCurr = await tApp.req('POST', '/api/auth/change-password', {
    cookie: sA.cookie,
    body: { currentPassword: 'wrong', newPassword: 'NewPassword!2' },
  });
  assert.equal(badCurr.status, 401);

  const changed = await tApp.req('POST', '/api/auth/change-password', {
    cookie: sA.cookie,
    body: { currentPassword: 'OldPassword!1', newPassword: 'NewPassword!2' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.revokedOtherSessions, 2);

  // Session A stays active
  const meA = await tApp.req('GET', '/api/notes', { cookie: sA.cookie });
  assert.equal(meA.status, 200);

  // Session B and bootstrap session are revoked
  const meB = await tApp.req('GET', '/api/notes', { cookie: sB.cookie });
  assert.equal(meB.status, 401);
  const meBoot = await tApp.req('GET', '/api/notes', { cookie: boot.cookie });
  assert.equal(meBoot.status, 401);

  // Old password rejected, new password works
  const oldLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'pwowner', password: 'OldPassword!1' } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'pwowner', password: 'NewPassword!2' } });
  assert.equal(newLogin.status, 200);
});

test('10. admin privilege delegation rules: only owner creates owners, grants manage_users, or modifies owners', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'boss', password: 'OwnerSecret!99' });

  // Standard admin lacks manage_users
  const mkStdAdmin = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'stdadmin', role: 'admin', password: 'AdminPass!1' },
  });
  assert.equal(mkStdAdmin.status, 201);
  assert.equal(mkStdAdmin.data.user.privileges.includes('manage_users'), false);

  const stdLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'stdadmin', password: 'AdminPass!1' } });
  const stdUsersDenied = await tApp.req('GET', '/api/admin/users', { cookie: stdLogin.cookie });
  assert.equal(stdUsersDenied.status, 403);

  // Owner grants manage_users explicitly to superadmin
  const mkSuperAdmin = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'superadmin', role: 'admin', password: 'AdminPass!2', privileges: [...ROLE_PRESETS.admin, 'manage_users'] },
  });
  assert.equal(mkSuperAdmin.status, 201);
  const superLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'superadmin', password: 'AdminPass!2' } });

  // Superadmin cannot create an owner
  const noOwner = await tApp.req('POST', '/api/admin/users', {
    cookie: superLogin.cookie,
    body: { username: 'rogueowner', role: 'owner', password: 'OwnerPass!9' },
  });
  assert.equal(noOwner.status, 403);

  // Superadmin cannot grant manage_users
  const noGrant = await tApp.req('POST', '/api/admin/users', {
    cookie: superLogin.cookie,
    body: { username: 'subadmin', role: 'admin', password: 'AdminPass!3', privileges: ['manage_users'] },
  });
  assert.equal(noGrant.status, 403);

  // Superadmin cannot demote/disable/delete owner
  const noModOwner = await tApp.req('PATCH', `/api/admin/users/${owner.data.user.id}`, {
    cookie: superLogin.cookie,
    body: { disabled: true },
  });
  assert.equal(noModOwner.status, 403);

  const noDelOwner = await tApp.req('DELETE', `/api/admin/users/${owner.data.user.id}`, {
    cookie: owner.cookie,
  });
  assert.equal(noDelOwner.status, 403);
});

test('11. recruiter guest Full Sandbox preset, auto-generated password, sandbox-guest Proxmox tag, and RBAC blocks', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const pveCalls = [];
  const mockPve = async (apiPath, opts = {}) => {
    pveCalls.push({ apiPath, opts });
    if (apiPath === '/cluster/nextid') return 220;
    if (apiPath.endsWith('/lxc') && opts.method === 'POST') return 'UPID:pve:001:create';
    return [];
  };
  const tApp = await startTestApp({ pveImpl: mockPve });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });

  const createGuest = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'recruiter1', displayName: 'Jane Recruiter', role: 'recruiter_guest', durationHours: 24, note: 'Acme Corp interview' },
  });
  assert.equal(createGuest.status, 201);
  assert.ok(createGuest.data.generatedPassword);
  assert.equal(createGuest.data.generatedPassword.length, 12);
  assert.deepEqual(createGuest.data.user.privileges, ROLE_PRESETS.recruiter_guest);

  const guestLogin = await tApp.req('POST', '/api/auth/login', {
    body: { username: 'recruiter1', password: createGuest.data.generatedPassword },
  });
  assert.equal(guestLogin.status, 200);

  // Allowed sandbox actions: notes + Proxmox provision
  const putNotes = await tApp.req('PUT', '/api/notes', {
    cookie: guestLogin.cookie,
    body: { note: 'Recruiter sandbox check', todos: [{ text: 'Inspect VMs', done: true }] },
  });
  assert.equal(putNotes.status, 200);

  const prov = await tApp.req('POST', '/api/proxmox/provision', {
    cookie: guestLogin.cookie,
    body: { type: 'lxc', name: 'demo-box', cores: 2, memory: 512, disk: 8 },
  });
  assert.equal(prov.status, 202);
  assert.equal(prov.data.id, 220);
  const lxcCall = pveCalls.find((c) => c.apiPath.endsWith('/lxc') && c.opts.method === 'POST');
  assert.ok(lxcCall);
  assert.ok(lxcCall.opts.form.tags.includes('sandbox-guest'));

  // Blocked routes for recruiter_guest
  assert.equal((await tApp.req('GET', '/api/admin/users', { cookie: guestLogin.cookie })).status, 403);
  assert.equal((await tApp.req('GET', '/api/updates', { cookie: guestLogin.cookie })).status, 403);
  assert.equal((await tApp.req('PUT', '/api/ai/key', { cookie: guestLogin.cookie, body: { key: 'AIzaTest' } })).status, 403);

  // Audit check: sandboxOnly=1 includes notes.update & guest.provision with sandboxTag=true
  const audit = await tApp.req('GET', '/api/admin/audit?sandboxOnly=1', { cookie: owner.cookie });
  assert.equal(audit.status, 200);
  const actions = audit.data.logs.map((l) => l.action);
  assert.ok(actions.includes('notes.update'));
  assert.ok(actions.includes('guest.provision'));
  assert.ok(audit.data.logs.every((l) => l.sandboxTag === true));
  assert.equal(audit.data.sandboxSummary.activeGuests, 1);
  assert.ok(audit.data.sandboxSummary.totalEvents >= 2);
});

test('12. CT 102 is hard-blocked on delete and power even for owner and guest, and CT 101/105 stop is blocked', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  let pveTouched = false;
  const tApp = await startTestApp({
    pveImpl: async () => { pveTouched = true; return []; },
  });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const mkGuest = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'guest102', role: 'recruiter_guest', password: 'GuestPass!99' },
  });
  assert.equal(mkGuest.status, 201);
  const guest = await tApp.req('POST', '/api/auth/login', { body: { username: 'guest102', password: 'GuestPass!99' } });

  assert.equal((await tApp.req('DELETE', '/api/guests/102', { cookie: owner.cookie })).status, 403);
  assert.equal((await tApp.req('DELETE', '/api/guests/102', { cookie: guest.cookie })).status, 403);
  assert.equal((await tApp.req('POST', '/api/guests/102/power/stop', { cookie: owner.cookie })).status, 403);
  assert.equal((await tApp.req('POST', '/api/guests/102/power/restart', { cookie: guest.cookie })).status, 403);
  assert.equal((await tApp.req('POST', '/api/guests/101/power/stop', { cookie: owner.cookie })).status, 403);
  assert.equal((await tApp.req('POST', '/api/guests/105/power/stop', { cookie: owner.cookie })).status, 403);
  assert.equal(pveTouched, false);

  const audit = await tApp.req('GET', '/api/admin/audit?action=guest.delete_vm', { cookie: owner.cookie });
  assert.equal(audit.data.logs.length, 2);
  assert.equal(audit.data.logs[0].status, 'denied');
});

test('13. recruiter guest expiry immediately rejects existing sessions and login with 401, extendable by owner', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const created = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'timedguest', role: 'recruiter_guest', password: 'GuestPass!1', durationHours: 1 },
  });
  const guestId = created.data.user.id;
  const login = await tApp.req('POST', '/api/auth/login', { body: { username: 'timedguest', password: 'GuestPass!1' } });
  assert.equal(login.status, 200);
  assert.equal((await tApp.req('GET', '/api/notes', { cookie: login.cookie })).status, 200);

  // Expire guest in the past
  const expiredAt = new Date(Date.now() - 5000).toISOString();
  const patchExp = await tApp.req('PATCH', `/api/admin/users/${guestId}`, {
    cookie: owner.cookie,
    body: { expiresAt: expiredAt },
  });
  assert.equal(patchExp.status, 200);

  // Existing session rejected with 401 'Guest account has expired.'
  const rejectedDash = await tApp.req('GET', '/api/notes', { cookie: login.cookie });
  assert.equal(rejectedDash.status, 401);
  assert.equal(rejectedDash.data.message, 'Guest account has expired.');

  const rejectedGame = await tApp.req('GET', '/api/game/me', { cookie: login.cookie });
  assert.equal(rejectedGame.status, 401);
  assert.equal(rejectedGame.data.message, 'Guest account has expired.');

  // Re-login rejected with 401 'Guest account has expired.'
  const relogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'timedguest', password: 'GuestPass!1' } });
  assert.equal(relogin.status, 401);
  assert.equal(relogin.data.message, 'Guest account has expired.');

  // Owner extends guest -> login works again
  const extend = await tApp.req('PATCH', `/api/admin/users/${guestId}`, {
    cookie: owner.cookie,
    body: { extendHours: 12 },
  });
  assert.equal(extend.status, 200);
  const reloginOk = await tApp.req('POST', '/api/auth/login', { body: { username: 'timedguest', password: 'GuestPass!1' } });
  assert.equal(reloginOk.status, 200);
});

test('14. disabled user rejected with 403 and last active owner protected from disable/demote', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'soloowner', password: 'OwnerSecret!99' });

  // Cannot disable or demote last active owner
  assert.equal((await tApp.req('PATCH', `/api/admin/users/${owner.data.user.id}`, {
    cookie: owner.cookie,
    body: { disabled: true },
  })).status, 400);
  assert.equal((await tApp.req('PATCH', `/api/admin/users/${owner.data.user.id}`, {
    cookie: owner.cookie,
    body: { role: 'admin' },
  })).status, 400);

  // Create normal user, log in, then disable
  const created = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'normaladmin', role: 'admin', password: 'AdminPass!99' },
  });
  const uLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'normaladmin', password: 'AdminPass!99' } });
  assert.equal(uLogin.status, 200);

  await tApp.req('PATCH', `/api/admin/users/${created.data.user.id}`, {
    cookie: owner.cookie,
    body: { disabled: true },
  });
  assert.equal((await tApp.req('GET', '/api/notes', { cookie: uLogin.cookie })).status, 401);
  const disLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'normaladmin', password: 'AdminPass!99' } });
  assert.equal(disLogin.status, 403);
  assert.equal(disLogin.data.message, 'Account is disabled.');
});

test('15. admin password reset revokes all active sessions and returns one-time newPassword', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const created = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'resetme', role: 'admin', password: 'InitialPass!1' },
  });
  const s1 = await tApp.req('POST', '/api/auth/login', { body: { username: 'resetme', password: 'InitialPass!1' } });
  const s2 = await tApp.req('POST', '/api/auth/login', { body: { username: 'resetme', password: 'InitialPass!1' } });

  const reset = await tApp.req('POST', `/api/admin/users/${created.data.user.id}/reset-password`, {
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(reset.status, 200);
  assert.ok(reset.data.newPassword);
  assert.equal(reset.data.newPassword.length, 12);

  assert.equal((await tApp.req('GET', '/api/notes', { cookie: s1.cookie })).status, 401);
  assert.equal((await tApp.req('GET', '/api/notes', { cookie: s2.cookie })).status, 401);
  assert.equal((await tApp.req('POST', '/api/auth/login', { body: { username: 'resetme', password: 'InitialPass!1' } })).status, 401);
  assert.equal((await tApp.req('POST', '/api/auth/login', { body: { username: 'resetme', password: reset.data.newPassword } })).status, 200);
});

test('16. explicit revoke-sessions and delete non-owner user', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const created = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'tempuser', role: 'recruiter_guest', password: 'TempPass!1' },
  });
  const s1 = await tApp.req('POST', '/api/auth/login', { body: { username: 'tempuser', password: 'TempPass!1' } });
  assert.equal(s1.status, 200);

  const rev = await tApp.req('POST', `/api/admin/users/${created.data.user.id}/revoke-sessions`, { cookie: owner.cookie });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.revokedCount, 1);
  assert.equal((await tApp.req('GET', '/api/notes', { cookie: s1.cookie })).status, 401);

  const del = await tApp.req('DELETE', `/api/admin/users/${created.data.user.id}`, { cookie: owner.cookie });
  assert.equal(del.status, 200);
  const list = await tApp.req('GET', '/api/admin/users', { cookie: owner.cookie });
  assert.equal(list.data.users.some((u) => u.username === 'tempuser'), false);
});

test('17. legacy main password compatibility and owner disabling allowLegacyPassword', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = 'LegacyMasterPassword!77';
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  // Legacy login works initially
  const leg = await tApp.req('POST', '/api/login', { headers: { 'x-dashboard-password': 'LegacyMasterPassword!77' } });
  assert.equal(leg.status, 200);
  assert.equal(leg.data.ok, true);

  // Legacy header cannot disable allowLegacyPassword while 0 DB owners exist
  const cantDisableYet = await tApp.req('PUT', '/api/admin/settings', {
    headers: { 'x-dashboard-password': 'LegacyMasterPassword!77' },
    body: { allowLegacyPassword: false },
  });
  assert.equal(cantDisableYet.status, 400);

  // Bootstrap real owner
  const owner = await bootstrapOwner(tApp, { username: 'realowner', password: 'OwnerPass!88', mainPassword: 'LegacyMasterPassword!77' });

  // Non-owner with manage_users cannot toggle settings
  const superAdmin = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'adm2', role: 'admin', password: 'AdminPass!88', privileges: [...ROLE_PRESETS.admin, 'manage_users'] },
  });
  assert.equal(superAdmin.status, 201);
  const admLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'adm2', password: 'AdminPass!88' } });
  const admSetDenied = await tApp.req('PUT', '/api/admin/settings', {
    cookie: admLogin.cookie,
    body: { allowLegacyPassword: false },
  });
  assert.equal(admSetDenied.status, 403);

  // Owner disables allowLegacyPassword
  const disable = await tApp.req('PUT', '/api/admin/settings', {
    cookie: owner.cookie,
    body: { allowLegacyPassword: false },
  });
  assert.equal(disable.status, 200);
  assert.equal(disable.data.settings.allowLegacyPassword, false);

  // Legacy login and legacy headers are now blocked
  assert.equal((await tApp.req('POST', '/api/login', { headers: { 'x-dashboard-password': 'LegacyMasterPassword!77' } })).status, 403);
  assert.equal((await tApp.req('GET', '/api/notes', { headers: { 'x-dashboard-password': 'LegacyMasterPassword!77' } })).status, 401);
});

test('18. /api/health returns public disk summary without serials, full serials for view_private', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp({
    hostAgentImpl: async (_m, p) => {
      if (p === '/health') {
        return {
          status: 'ok',
          disks: [{ dev: '/dev/nvme0n1', model: 'WD Black', size_gb: 1000, passed: true, temp: 38, ssd: true, state: 'ok', wear: 2, serial: 'SECRET-SERIAL-999' }],
        };
      }
      return {};
    },
  });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const player = await tApp.req('POST', '/api/auth/register', { body: { username: 'gamer', pin: '1337' } });

  const anonHealth = await tApp.req('GET', '/api/health');
  assert.equal(anonHealth.status, 200);
  assert.equal(anonHealth.data.disks[0].serial, undefined);

  const playerHealth = await tApp.req('GET', '/api/health', { cookie: player.cookie });
  assert.equal(playerHealth.status, 200);
  assert.equal(playerHealth.data.disks[0].serial, undefined);

  const ownerHealth = await tApp.req('GET', '/api/health', { cookie: owner.cookie });
  assert.equal(ownerHealth.status, 200);
  assert.equal(ownerHealth.data.disks[0].serial, 'SECRET-SERIAL-999');
});

test('19. audit log filtering & zero secret leaks across passwords, PINs, API keys, and tokens', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp({
    siteAgentImpl: async (method, p) => (method === 'PUT' && p === '/ai/key' ? { ok: true } : {}),
  });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'auditowner', password: 'SuperOwnerSecret!99' });
  const guest = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'auditguest', role: 'recruiter_guest', password: 'GuestSecret!99' },
  });
  const guestLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'auditguest', password: 'GuestSecret!99' } });
  await tApp.req('POST', '/api/auth/register', { body: { username: 'auditplayer', pin: '9876' } });
  await tApp.req('PUT', '/api/ai/key', { cookie: owner.cookie, body: { key: 'AIzaSecretGeminiKey999' } });
  await tApp.req('PUT', '/api/notes', { cookie: guestLogin.cookie, body: { note: 'hello' } });

  const allAudit = await tApp.req('GET', '/api/admin/audit?limit=100', { cookie: owner.cookie });
  assert.equal(allAudit.status, 200);
  const rawAuditJson = JSON.stringify(allAudit.data);
  assert.equal(rawAuditJson.includes('SuperOwnerSecret!99'), false);
  assert.equal(rawAuditJson.includes('GuestSecret!99'), false);
  assert.equal(rawAuditJson.includes('9876'), false);
  assert.equal(rawAuditJson.includes('AIzaSecretGeminiKey999'), false);
  assert.equal(rawAuditJson.includes(guestLogin.data.token), false);

  const usersJson = JSON.stringify((await tApp.req('GET', '/api/admin/users', { cookie: owner.cookie })).data);
  assert.equal(usersJson.includes('SuperOwnerSecret!99'), false);
  assert.equal(usersJson.includes('secretHash'), false);

  const qSearch = await tApp.req('GET', '/api/admin/audit?actor=auditguest&sandboxOnly=1&q=notes', { cookie: owner.cookie });
  assert.equal(qSearch.data.logs.length, 1);
  assert.equal(qSearch.data.logs[0].action, 'notes.update');
  assert.equal(guest.status, 201);
});

test('20. Game Hub SSO flow: admin logs in on /api/auth/login -> /api/game/me -> score -> leaderboard -> midrun', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'CyberAdmin', displayName: 'Cyber Admin', role: 'admin', password: 'AdminGamePass!1' },
  });

  const health = await tApp.req('GET', '/api/game/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.backend, 'memory');

  // Admin logs in on dashboard SSO endpoint
  const ssoLogin = await tApp.req('POST', '/api/auth/login', {
    body: { username: 'CyberAdmin', password: 'AdminGamePass!1' },
  });
  assert.equal(ssoLogin.status, 200);

  // Same cookie automatically resolves Admin on /api/game/me
  const gameMe = await tApp.req('GET', '/api/game/me', { cookie: ssoLogin.cookie });
  assert.equal(gameMe.status, 200);
  assert.equal(gameMe.data.ok, true);
  assert.equal(gameMe.data.user.handle, 'CyberAdmin');
  assert.equal(gameMe.data.user.role, 'admin');
  assert.equal(gameMe.data.user.canAccessDashboard, true);

  // Submit score via SSO cookie
  const sc1 = await tApp.req('POST', '/api/game/score', {
    cookie: ssoLogin.cookie,
    body: { game_id: 'defender', score: 12500, wave: 20, won: true, eddies: 600, xp: 350 },
  });
  assert.equal(sc1.status, 200);
  assert.equal(sc1.data.ok, true);
  assert.equal(sc1.data.isNewBest, true);
  assert.equal(sc1.data.bestScore, 12500);
  assert.equal(sc1.data.rank, 1);

  // Player registers via /api/game/auth and beats admin score
  const pGame = await tApp.req('POST', '/api/game/auth', {
    body: { handle: 'NightV', pin: '2077', avatar: 'solo' },
  });
  assert.equal(pGame.status, 201);
  assert.equal(pGame.data.created, true);
  assert.equal(pGame.data.user.canAccessDashboard, false);
  assert.ok(pGame.cookie.includes('homelab_session='));

  const sc2 = await tApp.req('POST', '/api/game/score', {
    headers: { Authorization: `Bearer ${pGame.data.token}` },
    body: { game_id: 'defender', score: 18000, wave: 20, won: true, eddies: 900, xp: 500 },
  });
  assert.equal(sc2.status, 200);
  assert.equal(sc2.data.rank, 1);

  // Leaderboard checks
  const lbGame = await tApp.req('GET', '/api/game/leaderboard?game=defender&limit=10');
  assert.equal(lbGame.status, 200);
  assert.equal(lbGame.data.entries.length, 2);
  assert.equal(lbGame.data.entries[0].handle, 'NightV');
  assert.equal(lbGame.data.entries[0].score, 18000);
  assert.equal(lbGame.data.entries[1].handle, 'CyberAdmin');

  const lbAll = await tApp.req('GET', '/api/game/leaderboard?game=all');
  assert.equal(lbAll.status, 200);
  assert.equal(lbAll.data.entries[0].combined_score, 18000);
  assert.equal(lbAll.data.games.length, 7);

  // Admin stats visible in /api/admin/users
  const adminUsers = await tApp.req('GET', '/api/admin/users', { cookie: owner.cookie });
  const cyberAdminRow = adminUsers.data.users.find((u) => u.username === 'CyberAdmin');
  assert.equal(cyberAdminRow.xp, 350);
  assert.equal(cyberAdminRow.eddies, 600);
  assert.equal(cyberAdminRow.bestScore, 12500);
  assert.equal(cyberAdminRow.plays, 1);

  // Save, read, and delete mid-run checkpoint
  const saveMid = await tApp.req('PUT', '/api/game/midrun/icebreaker', {
    cookie: ssoLogin.cookie,
    body: { wave: 7, hp: 82, label: 'Wave 7' },
  });
  assert.equal(saveMid.status, 200);
  assert.equal(saveMid.data.midruns.icebreaker.data.wave, 7);

  const getMid = await tApp.req('GET', '/api/game/midrun/icebreaker', { cookie: ssoLogin.cookie });
  assert.equal(getMid.status, 200);
  assert.equal(getMid.data.midrun.data.wave, 7);

  const delMid = await tApp.req('DELETE', '/api/game/midrun/icebreaker', { cookie: ssoLogin.cookie });
  assert.equal(delMid.status, 200);
  assert.equal(delMid.data.midruns.icebreaker, undefined);
});

test('21. Game Hub /api/game/auth supports username+password login for admin/guest and X-Hub-Token', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'recruiter_game', role: 'recruiter_guest', password: 'RecruiterPass!77', durationHours: 8 },
  });

  const gLogin = await tApp.req('POST', '/api/game/auth', {
    body: { username: 'recruiter_game', password: 'RecruiterPass!77' },
  });
  assert.equal(gLogin.status, 200);
  assert.equal(gLogin.data.created, false);
  assert.equal(gLogin.data.user.role, 'recruiter_guest');
  assert.equal(gLogin.data.user.canAccessDashboard, true);
  assert.ok(gLogin.data.user.expiresAt);

  // X-Hub-Token works on /api/game/me
  const viaHubTok = await tApp.req('GET', '/api/game/me', { headers: { 'X-Hub-Token': gLogin.data.token } });
  assert.equal(viaHubTok.status, 200);
  assert.equal(viaHubTok.data.user.handle, 'recruiter_game');
});

test('22. Game Hub profile sync merges safely without regressing higher server XP/scores and enforces 128KB/64KB caps', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const p = await tApp.req('POST', '/api/game/auth', { body: { handle: 'SyncRunner', pin: '5555' } });
  await tApp.req('POST', '/api/game/score', {
    cookie: p.cookie,
    body: { game_id: 'protocol', score: 4000, wave: 4, won: true, eddies: 200, xp: 300 },
  });

  const synced = await tApp.req('PUT', '/api/game/profile', {
    cookie: p.cookie,
    body: {
      xp: 100, // lower than server 300 -> must NOT regress
      eddies: 500,
      avatar: 'techie',
      profile: {
        scores: { protocol: 1000, neonvector: 9000 },
        achievements: { first_jack: 1700000000000 },
        settings: { lang: 'he', muted: true, theme: 'cyan' },
      },
    },
  });
  assert.equal(synced.status, 200);
  assert.equal(synced.data.user.xp, 300);
  assert.equal(synced.data.user.eddies, 500);
  assert.equal(synced.data.user.avatar, 'techie');
  assert.equal(synced.data.user.profile.scores.protocol, 4000);
  assert.equal(synced.data.user.profile.scores.neonvector, 9000);
  assert.equal(synced.data.user.profile.settings.lang, 'he');

  // 64KB mid-run limit
  const bigMid = await tApp.req('PUT', '/api/game/midrun/protocol', {
    cookie: p.cookie,
    body: { blob: 'x'.repeat(70 * 1024) },
  });
  assert.equal(bigMid.status, 413);

  // 128KB profile limit
  const bigProfile = await tApp.req('PUT', '/api/game/profile', {
    cookie: p.cookie,
    body: { profile: { achievements: { huge: 1 }, note: 'y'.repeat(135 * 1024) } },
  });
  assert.equal(bigProfile.status, 413);
});

test('23. Game Hub validation rejects unknown game_id, invalid scores, and malformed JSON cleanly', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const p = await tApp.req('POST', '/api/game/auth', { body: { handle: 'Validator', pin: '1234' } });

  assert.equal((await tApp.req('POST', '/api/game/score', {
    cookie: p.cookie,
    body: { game_id: 'unknown_game', score: 100 },
  })).status, 400);

  assert.equal((await tApp.req('POST', '/api/game/score', {
    cookie: p.cookie,
    body: { game_id: 'defender', score: -5 },
  })).status, 400);

  assert.equal((await tApp.req('GET', '/api/game/leaderboard?limit=abc')).status, 400);
  assert.equal((await tApp.req('GET', '/api/nonexistent-endpoint')).status, 404);

  // Malformed JSON
  const rawRes = await fetch(`${tApp.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad-json',
  });
  assert.equal(rawRes.status, 400);
});

test('24. protected dashboard routes enforce exact RBAC privileges and write audit logs', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp({
    proxyAgentImpl: async (m, p) => (m === 'GET' && p === '/routes' ? { routes: [{ name: 'demo', kind: 'custom', path: '/demo/' }] } : { ok: true }),
    hostAgentImpl: async (m, p) => (m === 'GET' && p === '/logs' ? { sources: [] } : { ok: true, jobs: [] }),
    hubCallImpl: async (m, p) => (m === 'GET' && p.startsWith('/api/agents') ? { agents: [{ id: 1, name: 'agent1', role: 'ops', status: 'idle' }] } : { task: { id: 't1', title: 'Check logs', status: 'assigned', priority: 'high' } }),
    pveImpl: async () => [],
  });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const logsOnly = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'logviewer', role: 'admin', password: 'LogPass!1', privileges: ['view_logs'] },
  });
  assert.equal(logsOnly.status, 201);
  const lvLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'logviewer', password: 'LogPass!1' } });

  assert.equal((await tApp.req('GET', '/api/logs', { cookie: lvLogin.cookie })).status, 200);
  assert.equal((await tApp.req('GET', '/api/hub', { cookie: lvLogin.cookie })).status, 403);
  assert.equal((await tApp.req('POST', '/api/routes', { cookie: lvLogin.cookie, body: { name: 'r1', target: 'http://10.0.0.1' } })).status, 403);

  // Owner creates hub task & route and deletes route -> audited
  const taskRes = await tApp.req('POST', '/api/hub/tasks', {
    cookie: owner.cookie,
    body: { title: 'Check logs', assigned_to: 'agent1', priority: 'high' },
  });
  assert.equal(taskRes.status, 201);

  const routeCreate = await tApp.req('POST', '/api/routes', {
    cookie: owner.cookie,
    body: { name: 'demo', target: 'http://10.0.0.99:8080', title: 'Demo' },
  });
  assert.equal(routeCreate.status, 200);

  const routeDel = await tApp.req('DELETE', '/api/routes/demo', { cookie: owner.cookie });
  assert.equal(routeDel.status, 200);

  const audit = await tApp.req('GET', '/api/admin/audit', { cookie: owner.cookie });
  const actions = audit.data.logs.map((l) => l.action);
  assert.ok(actions.includes('hub.task_create'));
  assert.ok(actions.includes('route.create'));
  assert.ok(actions.includes('route.delete'));
});

test('25. MongoDB store constructs lazily without immediate network failure on boot', async () => {
  // Unreachable port: creating store + app must NOT throw synchronously or reject at boot
  const lazyStore = createAuthStore({ mongoUri: 'mongodb://127.0.0.1:1/homelab_auth_test' });
  assert.equal(lazyStore.backend, 'mongodb');
  const app = createApp({ store: lazyStore, backgroundJobs: false });
  assert.ok(app);
  await lazyStore.close();
});

test('26. recruiter guest sandbox mutations on aisites, apps, and updates/CT102 rules', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const hostCalls = [];
  const tApp = await startTestApp({
    proxyAgentImpl: async () => ({ routes: [] }),
    hostAgentImpl: async (m, p, b) => {
      hostCalls.push({ m, p, b });
      return { job: 'host-demo-1', ok: true, updates: [] };
    },
  });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'sandbox_dev', role: 'recruiter_guest', password: 'GuestPass!77' },
  });
  const guest = await tApp.req('POST', '/api/auth/login', { body: { username: 'sandbox_dev', password: 'GuestPass!77' } });

  const aiSite = await tApp.req('POST', '/api/aisites', {
    cookie: guest.cookie,
    body: { name: 'portfolio-demo', prompt: 'Make a synthwave portfolio', quality: 'fast' },
  });
  assert.equal(aiSite.status, 202);

  const appCreate = await tApp.req('POST', '/api/apps', {
    cookie: guest.cookie,
    body: { name: 'node-demo', source_type: 'git', source: 'https://example.com/repo.git' },
  });
  assert.equal(appCreate.status, 202);

  // Owner updates apply excludes CT 102 automatically
  await tApp.req('POST', '/api/updates/apply', {
    cookie: owner.cookie,
    body: { targets: [101, 102, 105] },
  });
  const applyCall = hostCalls.find((c) => c.p === '/updates/apply');
  assert.deepEqual(applyCall.b.targets, [101, 105]);

  const audit = await tApp.req('GET', '/api/admin/audit?sandboxOnly=1', { cookie: owner.cookie });
  const actions = audit.data.logs.map((l) => l.action);
  assert.ok(actions.includes('aisite.create'));
  assert.ok(actions.includes('app.create'));
});

test('27. admin validation guards & public /api/game/users strips sensitive fields', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });

  assert.equal((await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'badpriv', role: 'admin', password: 'AdminPass!1', privileges: ['unknown_priv'] },
  })).status, 400);

  assert.equal((await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'baddur', role: 'recruiter_guest', durationHours: -5 },
  })).status, 400);

  await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'secretnotes', role: 'recruiter_guest', password: 'GuestPass!1', note: 'Private recruiter info' },
  });

  const pubUsers = await tApp.req('GET', '/api/game/users');
  assert.equal(pubUsers.status, 200);
  const raw = JSON.stringify(pubUsers.data);
  assert.equal(raw.includes('Private recruiter info'), false);
  assert.equal(raw.includes('privileges'), false);
  assert.equal(raw.includes('secretHash'), false);
});

test('28. /api/game/me enforces auth/disabled and /api/auth/me clears stale expired cookie', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'owner', password: 'OwnerSecret!99' });
  const unauthGame = await tApp.req('GET', '/api/game/me');
  assert.equal(unauthGame.status, 401);

  const created = await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'staleguest', role: 'recruiter_guest', password: 'GuestPass!1', durationHours: 2 },
  });
  const login = await tApp.req('POST', '/api/auth/login', { body: { username: 'staleguest', password: 'GuestPass!1' } });

  await tApp.req('PATCH', `/api/admin/users/${created.data.user.id}`, {
    cookie: owner.cookie,
    body: { expiresAt: new Date(Date.now() - 1000).toISOString() },
  });

  const meRes = await tApp.req('GET', '/api/auth/me', { cookie: login.cookie });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.authenticated, false);
  assert.equal(meRes.data.message, 'Guest account has expired.');
  assert.ok(meRes.setCookies[0].includes('Max-Age=0'));
});

test('29. options.dashboardPassword works and __sso__ sentinel in x-dashboard-password never triggers lockout', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp({ dashboardPassword: 'OptionMainPass!22' });
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  // Repeated __sso__ headers without cookie must NOT increment legacy wrong-password misses
  for (let i = 0; i < 8; i += 1) {
    const res = await tApp.req('GET', '/api/notes', {
      headers: { 'x-dashboard-password': '__sso__', 'X-Forwarded-For': '10.88.88.1' },
    });
    assert.equal(res.status, 401);
  }

  // Real legacy password from options.dashboardPassword still works without lockout
  const ok = await tApp.req('POST', '/api/login', {
    headers: { 'x-dashboard-password': 'OptionMainPass!22', 'X-Forwarded-For': '10.88.88.1' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
});

test('30. /api/auth/me, /api/admin/users, and /api/admin/audit expose complete UI contract fields', async (t) => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  const tApp = await startTestApp();
  t.after(async () => {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
    await tApp.close();
  });

  const owner = await bootstrapOwner(tApp, { username: 'contract_owner', password: 'OwnerSecret!99' });
  await tApp.req('POST', '/api/game/score', {
    cookie: owner.cookie,
    body: { game_id: 'defender', score: 4500, wave: 10, won: true, eddies: 200, xp: 150 },
  });
  await tApp.req('POST', '/api/admin/users', {
    cookie: owner.cookie,
    body: { username: 'sb_guest', role: 'recruiter_guest', password: 'GuestPass!1', durationHours: 4 },
  });
  const guestLogin = await tApp.req('POST', '/api/auth/login', { body: { username: 'sb_guest', password: 'GuestPass!1' } });
  await tApp.req('PUT', '/api/notes', { cookie: guestLogin.cookie, body: { note: 'sandbox test' } });

  const me = await tApp.req('GET', '/api/auth/me', { cookie: owner.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.scores.defender, 4500);
  assert.equal(me.data.user.plays.defender, 1);

  const users = await tApp.req('GET', '/api/admin/users', { cookie: owner.cookie });
  const row = users.data.users.find((u) => u.username === 'contract_owner');
  assert.equal(row.plays, 1);
  assert.equal(row.totalPlays, 1);
  assert.equal(row.combinedScore, 4500);
  assert.equal(row.profile.plays.defender, 1);
  assert.equal(row.activeSessions, 1);

  const audit = await tApp.req('GET', '/api/admin/audit?role=owner', { cookie: owner.cookie });
  assert.ok(audit.data.logs.every((l) => l.actorRole === 'owner' && typeof l.actorUsername === 'string'));
  assert.ok(audit.data.sandboxSummary.count >= 2);
  assert.ok(Array.isArray(audit.data.sandboxSummary.recent) && audit.data.sandboxSummary.recent.length >= 2);
});
