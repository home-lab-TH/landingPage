// Server-reported game results (WILDCARD // 2077).
//
// The Colyseus game server on CT 113 POSTs one finished match to
// POST /api/game/results with a service token. This module holds the pure
// parts (no express, no Mongo) so they can be unit-tested on their own:
// token check, strict body validation, the XP / eddies rules and the request
// handler factory. The store method that writes the awards is
// `recordWildcardMatch` in auth-store.js.
//
// Contract: arcade-2077 / wildcard-server/README.md, "Results contract".

import { createHash, timingSafeEqual } from 'node:crypto';

/** Name of the environment variable that holds the shared service token. The value is entered by the owner on CT 105. */
export const SERVICE_TOKEN_ENV = 'DASHBOARD_SERVICE_TOKEN';

export const MATCH_GAME = 'wildcard';
export const MIN_SERVICE_TOKEN_LENGTH = 24;
/** A match shorter than this cannot be a real game against anyone: it earns no XP. */
export const MIN_AWARD_DURATION_MS = 20_000;

// ---------- Service token ----------

/**
 * Constant-time check of `Authorization: Bearer <token>` against the expected token.
 * Both sides are hashed first, so neither the content nor the length of the
 * expected token leaks through timing.
 */
export function bearerMatches(authorizationHeader, expected) {
  if (typeof expected !== 'string' || expected.length < MIN_SERVICE_TOKEN_LENGTH) return false;
  if (typeof authorizationHeader !== 'string') return false;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(authorizationHeader.trim());
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---------- Strict validation ----------

const MATCH_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_CODE_RE = /^[A-Z]{5}$/;
const HANDLE_RE = /^[A-Za-z0-9_\-. ]{1,64}$/;
const KINDS = ['user', 'guest', 'bot'];
const TOP_KEYS = ['game', 'matchId', 'roomCode', 'startedAt', 'endedAt', 'durationMs', 'options', 'humanPlayers', 'players'];
const OPTION_KEYS = ['seats', 'stacking', 'turnSeconds'];
const PLAYER_KEYS = [
  'seat', 'kind', 'handle', 'name', 'role', 'rank', 'winner', 'cardsLeft', 'handPoints', 'score', 'afk', 'timeouts', 'botTurns',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isoMs = (v) => {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return NaN;
  return Date.parse(v);
};

function checkKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown field "${key}"`);
  }
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${where}: missing field "${key}"`);
  }
}

/**
 * Strictly validate a match result body. Unknown or missing fields are errors.
 * Returns `{ ok: true, value }` (value is a clean copy) or `{ ok: false, errors }`.
 */
export function validateMatchResult(body) {
  const errors = [];
  if (!isObj(body)) return { ok: false, errors: ['body must be a JSON object'] };
  checkKeys(body, TOP_KEYS, 'body', errors);
  if (errors.length) return { ok: false, errors };

  if (body.game !== MATCH_GAME) errors.push(`game must be "${MATCH_GAME}"`);
  if (typeof body.matchId !== 'string' || !MATCH_ID_RE.test(body.matchId)) errors.push('matchId must be 8-64 chars of [A-Za-z0-9_-]');
  if (typeof body.roomCode !== 'string' || !ROOM_CODE_RE.test(body.roomCode)) errors.push('roomCode must be 5 capital letters');

  const started = isoMs(body.startedAt);
  const ended = isoMs(body.endedAt);
  if (Number.isNaN(started)) errors.push('startedAt must be an ISO 8601 timestamp');
  if (Number.isNaN(ended)) errors.push('endedAt must be an ISO 8601 timestamp');
  if (!Number.isNaN(started) && !Number.isNaN(ended) && ended < started) errors.push('endedAt is before startedAt');
  if (!isInt(body.durationMs, 0, 86_400_000)) errors.push('durationMs must be an integer 0..86400000');

  let seats = 0;
  if (!isObj(body.options)) {
    errors.push('options must be an object');
  } else {
    checkKeys(body.options, OPTION_KEYS, 'options', errors);
    if (!isInt(body.options.seats, 2, 4)) errors.push('options.seats must be 2, 3 or 4');
    else seats = body.options.seats;
    if (typeof body.options.stacking !== 'boolean') errors.push('options.stacking must be a boolean');
    if (![0, 15, 30].includes(body.options.turnSeconds)) errors.push('options.turnSeconds must be 0, 15 or 30');
  }
  if (!isInt(body.humanPlayers, 0, 4)) errors.push('humanPlayers must be an integer 0..4');

  if (!Array.isArray(body.players)) {
    errors.push('players must be an array');
  } else {
    if (seats && body.players.length !== seats) errors.push('players must have exactly options.seats entries');
    const seenSeats = new Set();
    const seenHandles = new Set();
    let winners = 0;
    let humans = 0;
    body.players.forEach((p, i) => {
      const where = `players[${i}]`;
      if (!isObj(p)) { errors.push(`${where} must be an object`); return; }
      checkKeys(p, PLAYER_KEYS, where, errors);
      if (!isInt(p.seat, 0, 3) || (seats && p.seat >= seats)) errors.push(`${where}.seat out of range`);
      else if (seenSeats.has(p.seat)) errors.push(`${where}.seat is duplicated`);
      else seenSeats.add(p.seat);
      if (!KINDS.includes(p.kind)) errors.push(`${where}.kind must be user, guest or bot`);
      if (p.kind === 'user') {
        if (typeof p.handle !== 'string' || !HANDLE_RE.test(p.handle)) errors.push(`${where}.handle must be a dashboard handle`);
        else {
          const lower = p.handle.toLowerCase();
          if (seenHandles.has(lower)) errors.push(`${where}.handle appears twice`);
          seenHandles.add(lower);
        }
      } else if (p.handle !== null) {
        errors.push(`${where}.handle must be null for guests and bots`);
      }
      if (p.kind !== 'bot') humans++;
      if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 40) errors.push(`${where}.name must be 1-40 chars`);
      if (p.role !== null && (typeof p.role !== 'string' || p.role.length > 32)) errors.push(`${where}.role must be a string or null`);
      if (!isInt(p.rank, 1, 4)) errors.push(`${where}.rank must be an integer 1..4`);
      if (typeof p.winner !== 'boolean') errors.push(`${where}.winner must be a boolean`);
      else if (p.winner) {
        winners++;
        if (p.rank !== 1) errors.push(`${where}: the winner must have rank 1`);
      }
      if (!isInt(p.cardsLeft, 0, 108)) errors.push(`${where}.cardsLeft must be an integer 0..108`);
      if (!isInt(p.handPoints, 0, 5400)) errors.push(`${where}.handPoints must be an integer 0..5400`);
      if (!isInt(p.score, 0, 16_200)) errors.push(`${where}.score must be an integer 0..16200`);
      if (typeof p.afk !== 'boolean') errors.push(`${where}.afk must be a boolean`);
      if (!isInt(p.timeouts, 0, 10_000)) errors.push(`${where}.timeouts must be a non-negative integer`);
      if (!isInt(p.botTurns, 0, 10_000)) errors.push(`${where}.botTurns must be a non-negative integer`);
      if (p.kind !== 'user' && p.afk === true) errors.push(`${where}.afk is only meaningful for users`);
    });
    if (winners !== 1) errors.push('exactly one player must be the winner');
    if (isInt(body.humanPlayers, 0, 4) && humans !== body.humanPlayers) errors.push('humanPlayers does not match the players list');
  }

  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true,
    value: {
      game: MATCH_GAME,
      matchId: body.matchId,
      roomCode: body.roomCode,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      durationMs: body.durationMs,
      options: { seats: body.options.seats, stacking: body.options.stacking, turnSeconds: body.options.turnSeconds },
      humanPlayers: body.humanPlayers,
      players: body.players.map((p) => ({
        seat: p.seat,
        kind: p.kind,
        handle: p.kind === 'user' ? p.handle.toLowerCase() : null,
        name: p.name,
        role: p.role,
        rank: p.rank,
        winner: p.winner,
        cardsLeft: p.cardsLeft,
        handPoints: p.handPoints,
        score: p.score,
        afk: p.afk,
        timeouts: p.timeouts,
        botTurns: p.botTurns,
      })),
    },
  };
}

// ---------- XP / eddies rules (the dashboard decides, the server only reports facts) ----------

/**
 * Same XP curve as the other cabinets' `defaultRunXp` in the hub SDK:
 * 10 + min(200, score/50) + 50 for a win. A game against bots only (one human)
 * pays half, so it cannot be farmed.
 */
export function computeAward(player, match) {
  const won = player.winner === true;
  const score = player.score;
  let xp = 10 + Math.min(200, Math.floor(score / 50)) + (won ? 50 : 0);
  let eddies = won ? Math.min(250, 10 + Math.floor(score / 4)) : 5;
  if (match.humanPlayers === 1) {
    xp = Math.max(5, Math.floor(xp / 2));
    eddies = Math.floor(eddies / 2);
  }
  return { score, won, wave: 0, xp, eddies };
}

// ---------- Request handler ----------

const rateWindowMs = 15 * 60_000;
const rateMaxFailures = 20;

/**
 * Express handler for POST /api/game/results.
 *
 * - `getToken()` returns the expected service token (read from the environment on every request).
 * - `store.recordWildcardMatch(result)` writes the awards, idempotent on matchId.
 * - `audit(request, action, target, status, details)` writes an audit-log entry (never throws).
 * - `visitor(request)` is the client address used for the failure throttle.
 */
export function createResultsHandler({ store, getToken, audit, visitor = () => '?', now = Date.now }) {
  const failures = new Map();
  const throttled = (who) => {
    const f = failures.get(who);
    return Boolean(f && now() - f.first < rateWindowMs && f.count >= rateMaxFailures);
  };
  const noteFailure = (who) => {
    const t = now();
    const f = failures.get(who);
    if (!f || t - f.first >= rateWindowMs) failures.set(who, { first: t, count: 1 });
    else f.count += 1;
    if (failures.size > 500) {
      for (const [k, v] of failures) if (t - v.first >= rateWindowMs) failures.delete(k);
    }
  };
  const header = (request, name) => (typeof request.get === 'function' ? request.get(name) : request.headers?.[name.toLowerCase()]);
  const serviceActor = { id: 'service:wildcard-server', username: 'wildcard-server', displayName: 'WILDCARD game server', role: 'service' };
  const logAudit = (request, action, target, status, details) => {
    request.actor = serviceActor;
    return audit(request, action, target, status, details);
  };
  const fail = (response, status, error, extra = {}) =>
    response.status(status).json({ ok: false, error, message: error, ...extra });

  return async function resultsHandler(request, response) {
    const who = visitor(request);
    const expected = getToken();
    if (typeof expected !== 'string' || expected.length < MIN_SERVICE_TOKEN_LENGTH) {
      return fail(response, 503, 'Results endpoint is not configured.');
    }
    if (throttled(who)) {
      response.setHeader('Retry-After', '900');
      return fail(response, 429, 'Too many failed attempts.');
    }
    if (!bearerMatches(header(request, 'authorization'), expected)) {
      noteFailure(who);
      await logAudit(request, 'game.results', 'wildcard', 'denied', { reason: 'bad_token' });
      response.setHeader('WWW-Authenticate', 'Bearer');
      return fail(response, 401, 'Invalid service token.');
    }

    const checked = validateMatchResult(request.body);
    if (!checked.ok) {
      await logAudit(request, 'game.results', 'wildcard', 'error', { reason: 'invalid_body', errors: checked.errors.slice(0, 5) });
      return fail(response, 400, 'Invalid match result.', { errors: checked.errors });
    }
    const result = checked.value;
    const key = header(request, 'idempotency-key');
    if (key !== undefined && key !== '' && key !== result.matchId) {
      await logAudit(request, 'game.results', result.matchId, 'error', { reason: 'idempotency_key_mismatch' });
      return fail(response, 400, 'Idempotency-Key must equal matchId.');
    }

    let outcome;
    try {
      outcome = await store.recordWildcardMatch(result);
    } catch (error) {
      await logAudit(request, 'game.results', result.matchId, 'error', { reason: 'store_failed' });
      return fail(response, 500, 'Could not store the match.');
    }
    if (outcome.inProgress) {
      response.setHeader('Retry-After', '2');
      return fail(response, 503, 'This match is being processed; retry shortly.');
    }
    await logAudit(request, 'game.results', result.matchId, 'ok', {
      roomCode: result.roomCode,
      humanPlayers: result.humanPlayers,
      duplicate: outcome.duplicate,
      awarded: outcome.awards.filter((a) => a.status === 'awarded').map((a) => ({ handle: a.handle, xp: a.xp, eddies: a.eddies })),
      skipped: outcome.awards.filter((a) => a.status !== 'awarded').map((a) => ({ handle: a.handle, reason: a.reason })),
    });
    return response.status(200).json({ ok: true, matchId: result.matchId, duplicate: outcome.duplicate, awards: outcome.awards });
  };
}
