// Tests for the server-reported WILDCARD results endpoint, without express:
// token check, strict validation, XP rules, idempotency, guest / bot / afk handling,
// and the request handler driven with plain request / response objects.
// (The same flow through the real HTTP stack is test 32 in auth.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_AWARD_DURATION_MS,
  bearerMatches,
  computeAward,
  createResultsHandler,
  validateMatchResult,
} from './game-results.js';
import { GAME_IDS, createAuthStore } from './auth-store.js';

const TOKEN = 'unit-test-service-token-0123456789abcdef';

function player(seat, over = {}) {
  return {
    seat, kind: 'bot', handle: null, name: `Bot ${seat + 1}`, role: null, rank: seat + 1, winner: false,
    cardsLeft: 3, handPoints: 20, score: 0, afk: false, timeouts: 0, botTurns: 0, ...over,
  };
}

function match(over = {}) {
  return {
    game: 'wildcard',
    matchId: 'm-0123456789abcdef',
    roomCode: 'BCDFG',
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: '2026-11-20T10:05:00.000Z',
    durationMs: 300_000,
    options: { seats: 4, stacking: false, turnSeconds: 30 },
    humanPlayers: 2,
    players: [
      player(0, { kind: 'user', handle: 'NightV', name: 'NightV', role: 'player', rank: 1, winner: true, cardsLeft: 0, handPoints: 0, score: 120 }),
      player(1, { kind: 'guest', name: 'Sam', rank: 3 }),
      player(2, { rank: 2 }),
      player(3, { rank: 4 }),
    ],
    ...over,
  };
}

async function newStore(handles = ['nightv']) {
  const store = createAuthStore({ memory: true });
  for (const h of handles) await store.createUser({ username: h, displayName: h, role: 'player', pin: '123456' });
  return { store };
}

const xpOf = async (store, handle) => (await store.findUserByUsername(handle)).xp;

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function fakeReq(body, headers = {}, ip = '1.2.3.4') {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { body, get: (n) => h[n.toLowerCase()], headers: h, ip };
}

test('bearerMatches: right token only, scheme case-insensitive, weak or missing secret never matches', () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  assert.equal(bearerMatches(TOKEN, TOKEN), false);
  assert.equal(bearerMatches(undefined, TOKEN), false);
  assert.equal(bearerMatches('Bearer ', TOKEN), false);
  assert.equal(bearerMatches('Bearer short', 'short'), false);
  assert.equal(bearerMatches('Bearer ', ''), false);
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, undefined), false);
});

test('validateMatchResult: accepts the README example shape, lower-cases handles', () => {
  const r = validateMatchResult(match());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.players[0].handle, 'nightv');
  assert.equal(r.value.players[1].handle, null);
});

test('validateMatchResult: strict (unknown/missing fields, bad types, inconsistent data)', () => {
  const bad = (mutate) => {
    const m = match();
    mutate(m);
    const r = validateMatchResult(m);
    assert.equal(r.ok, false);
    return r.errors.join(' | ');
  };
  assert.match(bad((m) => { m.extra = 1; }), /unknown field "extra"/);
  assert.match(bad((m) => { delete m.roomCode; }), /missing field "roomCode"/);
  assert.match(bad((m) => { m.players[0].xp = 999; }), /unknown field "xp"/);
  assert.match(bad((m) => { m.game = 'defender'; }), /game must be/);
  assert.match(bad((m) => { m.matchId = 'a/b'; }), /matchId/);
  assert.match(bad((m) => { m.roomCode = 'bcdfg'; }), /roomCode/);
  assert.match(bad((m) => { m.endedAt = '2026-11-20T09:00:00.000Z'; }), /before startedAt/);
  assert.match(bad((m) => { m.options.turnSeconds = 20; }), /turnSeconds/);
  assert.match(bad((m) => { m.options.seats = 5; }), /seats/);
  assert.match(bad((m) => { m.players.pop(); }), /exactly options.seats/);
  assert.match(bad((m) => { m.players[1].seat = 0; }), /duplicated/);
  assert.match(bad((m) => { m.players[0].handle = null; }), /handle must be a dashboard handle/);
  assert.match(bad((m) => { m.players[1].handle = 'sam'; }), /handle must be null/);
  assert.match(bad((m) => { m.players[0].score = -5; }), /score/);
  assert.match(bad((m) => { m.players[0].score = 1.5; }), /score/);
  assert.match(bad((m) => { m.players[0].winner = 'yes'; }), /winner must be a boolean/);
  assert.match(bad((m) => { m.players[2].winner = true; m.players[2].rank = 1; }), /exactly one player/);
  assert.match(bad((m) => { m.players[1].afk = true; }), /afk is only meaningful/);
  assert.match(bad((m) => { m.humanPlayers = 3; }), /humanPlayers does not match/);
  assert.match(bad((m) => { m.players[1] = { ...m.players[0], seat: 1, rank: 2, winner: false }; }), /appears twice/);
  assert.equal(validateMatchResult(null).ok, false);
  assert.equal(validateMatchResult([]).ok, false);
  assert.equal(validateMatchResult('x').ok, false);
});

test('computeAward: win pays more than a loss, solo against bots pays half, caps hold', () => {
  const m = match();
  const win = computeAward(m.players[0], m);
  assert.deepEqual(win, { score: 120, won: true, wave: 0, xp: 10 + 2 + 50, eddies: 10 + 30 });
  const loss = computeAward({ ...m.players[0], winner: false, score: 0 }, m);
  assert.equal(loss.xp, 10);
  assert.equal(loss.eddies, 5);
  const solo = computeAward(m.players[0], { ...m, humanPlayers: 1 });
  assert.equal(solo.xp, 31);
  assert.equal(solo.eddies, 20);
  const huge = computeAward({ ...m.players[0], score: 16_200 }, m);
  assert.equal(huge.xp, 10 + 200 + 50);
  assert.equal(huge.eddies, 250);
});

test('GAME_IDS includes wildcard (leaderboards, profiles and /api/game/score accept it)', () => {
  assert.ok(GAME_IDS.includes('wildcard'));
});

test('recordWildcardMatch: pays only existing, active, non-afk users; guests and bots never', async () => {
  const { store } = await newStore(['nightv', 'idle', 'gone']);
  const m = match({
    humanPlayers: 4,
    players: [
      player(0, { kind: 'user', handle: 'nightv', name: 'NightV', role: 'player', rank: 1, winner: true, cardsLeft: 0, handPoints: 0, score: 120 }),
      player(1, { kind: 'user', handle: 'idle', name: 'Idle', role: 'player', rank: 2, afk: true }),
      player(2, { kind: 'user', handle: 'ghost', name: 'Ghost', role: 'player', rank: 3 }),
      player(3, { kind: 'guest', name: 'Sam', rank: 4 }),
    ],
  });
  const v = validateMatchResult(m);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const out = await store.recordWildcardMatch(v.value);
  assert.equal(out.duplicate, false);
  const byHandle = Object.fromEntries(out.awards.map((a) => [a.handle, a]));
  assert.equal(byHandle.nightv.status, 'awarded');
  assert.equal(byHandle.nightv.xp, 62);
  assert.equal(byHandle.idle.reason, 'afk');
  assert.equal(byHandle.ghost.reason, 'unknown_user');
  assert.equal(out.awards.length, 3, 'guests and bots get no entry at all');
  const lb = await store.getLeaderboard({ game: 'wildcard', limit: 10 });
  assert.equal(lb.entries.length, 1);
  assert.equal(lb.entries[0].score, 120);
  assert.equal(await xpOf(store, 'nightv'), 62);
  assert.equal(await xpOf(store, 'idle'), 0);
  assert.equal(await xpOf(store, 'gone'), 0);
});

test('recordWildcardMatch: idempotent on matchId (a retry never pays twice)', async () => {
  const { store } = await newStore(['nightv']);
  const v = validateMatchResult(match());
  const first = await store.recordWildcardMatch(v.value);
  const second = await store.recordWildcardMatch(v.value);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.awards, first.awards);
  assert.equal(await xpOf(store, 'nightv'), 62, 'XP is paid exactly once');
  const lb = await store.getLeaderboard({ game: 'wildcard', limit: 10 });
  assert.equal(lb.entries.length, 1);
});

test('recordWildcardMatch: a very short match earns nothing; a second match is a new match', async () => {
  const { store } = await newStore(['nightv']);
  const short = validateMatchResult(match({ matchId: 'short-0123456789', durationMs: MIN_AWARD_DURATION_MS - 1 }));
  const out = await store.recordWildcardMatch(short.value);
  assert.equal(out.awards[0].reason, 'too_short');
  const real = validateMatchResult(match({ matchId: 'real-01234567890' }));
  const out2 = await store.recordWildcardMatch(real.value);
  assert.equal(out2.awards[0].status, 'awarded');
});

test('recordWildcardMatch: a crash half way resumes later without paying anyone twice', async () => {
  const { store } = await newStore(['nightv', 'second']);
  const m = match({
    humanPlayers: 3,
    players: [
      player(0, { kind: 'user', handle: 'nightv', name: 'NightV', role: 'player', rank: 1, winner: true, cardsLeft: 0, handPoints: 0, score: 120 }),
      player(1, { kind: 'user', handle: 'second', name: 'Second', role: 'player', rank: 2 }),
      player(2, { kind: 'guest', name: 'Sam', rank: 3 }),
      player(3, { rank: 4 }),
    ],
  });
  const v = validateMatchResult(m).value;
  const realRecord = store.recordGameScore.bind(store);
  let boom = true;
  store.recordGameScore = async (args) => {
    if (boom && args.userId !== undefined && (await store.findUserByUsername('second'))._id === args.userId) throw new Error('db down');
    return realRecord(args);
  };
  const t0 = Date.now();
  await assert.rejects(store.recordWildcardMatch(v, { now: () => t0 }), /db down/);
  assert.equal(await xpOf(store, 'nightv'), 62, 'the first user was already paid');
  const early = await store.recordWildcardMatch(v, { now: () => t0 + 1000 });
  assert.equal(early.inProgress, true, 'a concurrent retry waits');
  boom = false;
  const later = await store.recordWildcardMatch(v, { now: () => t0 + 60_000 });
  assert.equal(later.inProgress, false);
  assert.equal(await xpOf(store, 'nightv'), 62, 'nightv is not paid twice');
  assert.equal(await xpOf(store, 'second'), 10);
  const done = await store.recordWildcardMatch(v, { now: () => t0 + 61_000 });
  assert.equal(done.duplicate, true);
  assert.equal(done.awards.length, 2);
});

test('handler: auth, validation, idempotency, audit, throttle', async () => {
  const { store } = await newStore(['nightv']);
  const audits = [];
  let token = TOKEN;
  let t = 1_000_000;
  const handler = createResultsHandler({
    store,
    getToken: () => token,
    audit: async (request, action, target, status, details) => { audits.push({ action, target, status, details, actor: request.actor }); },
    visitor: (r) => r.ip,
    now: () => t,
  });
  const call = async (req) => { const res = fakeRes(); await handler(req, res); return res; };
  const auth = { Authorization: `Bearer ${TOKEN}` };

  // not configured -> 503, never open
  token = undefined;
  assert.equal((await call(fakeReq(match(), auth))).statusCode, 503);
  token = 'short';
  assert.equal((await call(fakeReq(match(), auth))).statusCode, 503);
  token = TOKEN;

  // missing / wrong token -> 401 + audit, nothing stored
  assert.equal((await call(fakeReq(match()))).statusCode, 401);
  assert.equal((await call(fakeReq(match(), { Authorization: 'Bearer nope' }))).statusCode, 401);
  assert.equal(audits.at(-1).status, 'denied');
  assert.equal(audits.at(-1).actor.role, 'service');
  assert.equal((await store.getLeaderboard({ game: 'wildcard' })).entries.length, 0);

  // bad body -> 400 with reasons
  const bad = await call(fakeReq({ ...match(), game: 'x' }, auth));
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.body.errors.length > 0);

  // Idempotency-Key must equal matchId
  const mism = await call(fakeReq(match(), { ...auth, 'Idempotency-Key': 'other-key-0123456' }));
  assert.equal(mism.statusCode, 400);

  // success, then the same request again: 200 both times, paid once
  const ok1 = await call(fakeReq(match(), { ...auth, 'Idempotency-Key': match().matchId }));
  assert.equal(ok1.statusCode, 200);
  assert.equal(ok1.body.duplicate, false);
  assert.equal(ok1.body.awards[0].status, 'awarded');
  const ok2 = await call(fakeReq(match(), auth));
  assert.equal(ok2.statusCode, 200);
  assert.equal(ok2.body.duplicate, true);
  const okAudit = audits.filter((a) => a.status === 'ok');
  assert.equal(okAudit.length, 2);
  assert.equal(okAudit[0].action, 'game.results');
  assert.equal(okAudit[0].target, match().matchId);
  assert.equal(okAudit[0].details.awarded[0].handle, 'nightv');
  assert.equal(okAudit[1].details.duplicate, true);
  assert.equal(JSON.stringify(audits).includes(TOKEN), false, 'the token never reaches the audit log');
  const lb = await store.getLeaderboard({ game: 'wildcard' });
  assert.equal(lb.entries.length, 1);

  // throttle: 20 bad tokens from one address -> 429, even with the right token afterwards; other addresses unaffected
  for (let i = 0; i < 20; i++) await call(fakeReq(match(), { Authorization: 'Bearer wrong' }, '9.9.9.9'));
  assert.equal((await call(fakeReq(match(), auth, '9.9.9.9'))).statusCode, 429);
  assert.equal((await call(fakeReq(match({ matchId: 'other-0123456789' }), auth, '8.8.8.8'))).statusCode, 200);
  t += 16 * 60_000;
  assert.equal((await call(fakeReq(match({ matchId: 'later-0123456789' }), auth, '9.9.9.9'))).statusCode, 200);
});
