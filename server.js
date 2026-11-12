import express from 'express';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;
const services = JSON.parse(readFileSync(path.join(__dirname, 'src/config/services.json'), 'utf8'));

app.use(express.json());

// ---------- Proxmox API helper ----------
// Proxmox uses a self-signed certificate on :8006. Set PROXMOX_INSECURE_TLS=1 to accept it
// (only on a trusted network such as the LAN or Tailscale).
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const baseUrl = () => (process.env.PROXMOX_URL || '').replace(/\/$/, '');

const pve = (apiPath, { method = 'GET', form, read = false } = {}) => new Promise((resolve, reject) => {
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

const statsConfigured = () => Boolean(baseUrl() && process.env.PROXMOX_NODE
  && (process.env.PROXMOX_READ_TOKEN_ID || process.env.PROXMOX_TOKEN_ID)
  && (process.env.PROXMOX_READ_TOKEN_SECRET || process.env.PROXMOX_TOKEN_SECRET));

// ---------- /api/ping (liveness for the deploy check; /api/health is the host-agent health panel) ----------
app.get('/api/ping', (_request, response) => {
  response.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- /api/stats: host, containers, storage (cached 5 s) ----------
let statsCache = { at: 0, data: null };
app.get('/api/stats', async (_request, response) => {
  if (!statsConfigured()) return response.status(503).json({ configured: false, message: 'Set PROXMOX_URL, PROXMOX_NODE and a read token (PROXMOX_READ_TOKEN_ID / PROXMOX_READ_TOKEN_SECRET) in .env.' });
  if (Date.now() - statsCache.at < 5000 && statsCache.data) return response.json(statsCache.data);
  const node = encodeURIComponent(process.env.PROXMOX_NODE);
  try {
    const [status, lxc, qemu, storage] = await Promise.all([
      pve(`/nodes/${node}/status`, { read: true }),
      pve(`/nodes/${node}/lxc`, { read: true }),
      pve(`/nodes/${node}/qemu`, { read: true }).catch(() => []),
      pve(`/nodes/${node}/storage`, { read: true }).catch(() => []),
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
const probe = async (url) => {
  const started = Date.now();
  try {
    const result = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return { up: result.status < 400, code: result.status, ms: Date.now() - started };
  } catch {
    return { up: false, code: 0, ms: Date.now() - started };
  }
};
const UPTIME_FILE = path.join(__dirname, 'data', 'uptime.json');
const BUCKET = 5 * 60000; const KEEP = 7 * 24 * 12;
let uptime = (() => { try { return JSON.parse(readFileSync(UPTIME_FILE, 'utf8')); } catch { return {}; } })();
const record = (results) => {
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
  record(results);
  return siteCache.data;
};
setInterval(() => { probeAll().catch(() => {}); }, 60000).unref();
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
    const n = recent.reduce((a, b) => a + b.n, 0); const ok = recent.reduce((a, b) => a + b.ok, 0);
    out[id] = { pct: n ? Math.round((ok / n) * 10000) / 100 : null, ms: ok ? Math.round(recent.reduce((a, b) => a + b.ms, 0) / ok) : null, buckets: recent.map((b) => [b.t, b.n ? b.ok / b.n : null, b.ok ? Math.round(b.ms / b.ok) : null]) };
  }
  response.json({ hours, sites: out });
});

// ---------- graphs: Proxmox keeps CPU, memory, network and disk history (RRD) ----------
const rrdCache = new Map();
const rrd = async (apiPath, timeframe) => {
  const key = `${apiPath}|${timeframe}`; const hit = rrdCache.get(key);
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
  const id = Number(request.params.id); const tf = TIMEFRAMES[request.query.range] || 'day';
  if (!Number.isInteger(id) || id < 100) return response.status(400).json({ message: 'Bad ID.' });
  try {
    const kind = request.query.type === 'vm' ? 'qemu' : 'lxc';
    const rows = await rrd(`/nodes/${node()}/${kind}/${id}`, tf);
    return response.json({ range: tf, points: (rows || []).filter((r) => r.cpu !== undefined).map((r) => ({
      t: r.time * 1000, cpu: r.cpu, mem: r.maxmem ? r.mem / r.maxmem : null, netin: r.netin ?? null, netout: r.netout ?? null,
    })) });
  } catch (error) { return response.status(502).json({ message: error.message }); }
});

// ---------- create / delete (one main password) ----------
// DASHBOARD_PASSWORD (or the older PROVISION_PASSWORD) unlocks create and delete.
// Delete only works on guests that carry the "dashboard" tag, i.e. ones this page created.
const mainPassword = () => process.env.DASHBOARD_PASSWORD || process.env.PROVISION_PASSWORD || '';
// Wrong passwords are counted per visitor (see visitor()) and in total.
// 5 misses in 15 minutes lock that visitor out for 15 minutes; 30 misses in total slow everyone to one try per 10 s,
// so guessing is hopeless but the owner can still get in. Every miss is written to the dashboard log.
const misses = new Map(); let allMisses = []; let lastSlowTry = 0;
// the last X-Forwarded-For entry is the one Tailscale's proxy added, so a visitor cannot fake it
const visitor = (request) => String(request.get('x-forwarded-for') || '').split(',').pop().trim() || request.socket.remoteAddress || '?';
const lockedOut = (request) => {
  const now = Date.now(); const m = misses.get(visitor(request));
  if (m && m.until > now) return Math.ceil((m.until - now) / 1000);
  allMisses = allMisses.filter((t) => now - t < 15 * 60000);
  if (allMisses.length >= 30 && now - lastSlowTry < 10000) return Math.ceil((10000 - (now - lastSlowTry)) / 1000);
  return 0;
};
const passwordOk = (request) => {
  const expected = mainPassword();
  const given = request.get('x-dashboard-password') ?? request.get('x-provision-password') ?? '';
  if (!expected || !given) return false;
  if (lockedOut(request)) return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  const now = Date.now(); const who = visitor(request);
  if (ok) { misses.delete(who); return true; }
  const m = misses.get(who) && now - misses.get(who).first < 15 * 60000 ? misses.get(who) : { count: 0, first: now, until: 0 };
  m.count += 1; if (m.count >= 5) m.until = now + 15 * 60000;
  misses.set(who, m); allMisses.push(now); lastSlowTry = now;
  console.warn(`[login] wrong password from ${who} (${m.count} in 15 min${m.until ? ', locked for 15 min' : ''})`);
  return false;
};
const lockMessage = (request) => { const s = lockedOut(request); return s ? `Too many wrong passwords. Try again in ${s > 60 ? `${Math.ceil(s / 60)} min` : `${s} s`}.` : 'Wrong password.'; };
const guard = (request, response) => {
  if (!mainPassword()) { response.status(503).json({ message: 'Create/delete is off. Set DASHBOARD_PASSWORD in .env on FrontPage.' }); return false; }
  if (!statsConfigured()) { response.status(503).json({ message: 'Proxmox is not configured (PROXMOX_URL, PROXMOX_NODE, token).' }); return false; }
  if (!passwordOk(request)) { response.status(lockedOut(request) ? 429 : 401).json({ message: lockMessage(request) }); return false; }
  return true;
};
const node = () => encodeURIComponent(process.env.PROXMOX_NODE || '');
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

app.post('/api/login', (request, response) => {
  if (!mainPassword()) return response.status(503).json({ message: 'No password set on the server yet.' });
  return passwordOk(request) ? response.json({ ok: true }) : response.status(lockedOut(request) ? 429 : 401).json({ message: lockMessage(request) });
});

// LXC: created from an OS template (PROXMOX_LXC_OSTEMPLATE, e.g. local:vztmpl/debian-13-standard_..._amd64.tar.zst).
// VM: cloned from PROXMOX_VM_TEMPLATE (a VM converted to a template), then cores/memory are set.
app.post('/api/proxmox/provision', async (request, response) => {
  if (!guard(request, response)) return undefined;
  const { type, name, cores, memory, disk } = request.body ?? {};
  const loginPassword = String(request.body?.password || '');
  if (loginPassword && loginPassword.length < 8) return response.status(400).json({ message: 'The login password needs at least 8 characters.' });
  if ((type !== 'vm' && type !== 'lxc') || typeof name !== 'string' || !instanceName.test(name)) return response.status(400).json({ message: 'Use a name with lowercase letters, numbers, and hyphens.' });
  const cpu = Number(cores); const ram = Number(memory); const size = Number(disk ?? 8);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 8 || !Number.isInteger(ram) || ram < 256 || ram > 8192 || !Number.isInteger(size) || size < 2 || size > 100) return response.status(400).json({ message: 'Choose 1-8 cores, 256-8192 MiB memory and a 2-100 GB disk.' });
  const storage = process.env.PROXMOX_STORAGE || 'local-lvm';
  const bridge = process.env.PROXMOX_BRIDGE || 'vmbr0';
  try {
    const newid = Number(await pve('/cluster/nextid'));
    if (type === 'lxc') {
      const ostemplate = process.env.PROXMOX_LXC_OSTEMPLATE;
      if (!ostemplate) return response.status(503).json({ message: 'Set PROXMOX_LXC_OSTEMPLATE in .env.' });
      const task = await pve(`/nodes/${node()}/lxc`, { method: 'POST', form: {
        vmid: String(newid), hostname: name, ostemplate, cores: String(cpu), memory: String(ram), swap: '512',
        rootfs: `${storage}:${size}`, net0: `name=eth0,bridge=${bridge},ip=dhcp,firewall=1`,
        unprivileged: '1', features: 'nesting=1', onboot: '1', start: '1', tags: TAG, ...(loginPassword ? { password: loginPassword } : {}),
      } });
      response.status(202).json({ id: newid, task });
      waitTask(task).then((s) => console.log(`LXC ${newid} (${name}): ${s}`)).catch((e) => console.error(e));
      return undefined;
    }
    const template = process.env.PROXMOX_VM_TEMPLATE;
    if (!template) return response.status(503).json({ message: 'VMs need a template: set PROXMOX_VM_TEMPLATE (ID of a VM template).' });
    const task = await pve(`/nodes/${node()}/qemu/${encodeURIComponent(template)}/clone`, { method: 'POST', form: { newid: String(newid), name, full: '1', storage } });
    response.status(202).json({ id: newid, task });
    (async () => {
      const state = await waitTask(task);
      if (state !== 'OK') return console.error(`Clone ${newid} failed: ${state}`);
      await pve(`/nodes/${node()}/qemu/${newid}/config`, { method: 'PUT', form: { cores: String(cpu), memory: String(ram), tags: TAG, onboot: '1', ...(loginPassword ? { cipassword: loginPassword } : {}) } });
      await pve(`/nodes/${node()}/qemu/${newid}/resize`, { method: 'PUT', form: { disk: 'scsi0', size: `${size}G` } }).catch((e) => console.warn(`VM ${newid}: disk not resized (${e.message})`));
      await pve(`/nodes/${node()}/qemu/${newid}/status/start`, { method: 'POST' });
      console.log(`VM ${newid} (${name}) ready`);
    })().catch((error) => console.error(`VM ${newid} follow-up failed:`, error));
    return undefined;
  } catch (error) {
    return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
  }
});

app.delete('/api/guests/:id', async (request, response) => {
  if (!guard(request, response)) return undefined;
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id < 100) return response.status(400).json({ message: 'Bad ID.' });
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
    return response.status(202).json({ id, task });
  } catch (error) {
    return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
  }
});

// ---------- start / stop / restart (main password) ----------
// 102 is Jacob's (never touched). 101 (proxy) and 105 (this dashboard) can restart but not stop.
const NO_TOUCH = new Set([102]);
const NO_STOP = new Set([101, 105]);
const POWER = { start: 'start', stop: 'shutdown', restart: 'reboot' };
app.post('/api/guests/:id/power/:action', async (request, response) => {
  if (!guard(request, response)) return undefined;
  const id = Number(request.params.id); const action = request.params.action;
  if (!Number.isInteger(id) || !(action in POWER)) return response.status(400).json({ message: 'Bad request.' });
  if (NO_TOUCH.has(id)) return response.status(403).json({ message: `Guest ${id} is off-limits here.` });
  if (action === 'stop' && NO_STOP.has(id)) return response.status(403).json({ message: `Guest ${id} can only be restarted, not stopped (the site would go down).` });
  try {
    const [lxc, qemu] = await Promise.all([pve(`/nodes/${node()}/lxc`), pve(`/nodes/${node()}/qemu`).catch(() => [])]);
    const kind = (lxc || []).some((g) => Number(g.vmid) === id) ? 'lxc' : (qemu || []).some((g) => Number(g.vmid) === id) ? 'qemu' : null;
    if (!kind) return response.status(404).json({ message: `No guest ${id}.` });
    const task = await pve(`/nodes/${node()}/${kind}/${id}/status/${POWER[action]}`, { method: 'POST', form: action === 'stop' ? { timeout: '60', forceStop: '1' } : undefined });
    statsCache = { at: 0, data: null };
    return response.status(202).json({ id, action, task });
  } catch (error) {
    return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
  }
});

// ---------- sites: proxy routes + WordPress sites (via the two LAN agents) ----------
const agent = async (base, token, method, path, body, timeoutMs = 20000) => {
  if (!base || !token) throw Object.assign(new Error('Sites are not set up yet (agent URL/token missing in .env).'), { status: 503 });
  const response = await fetch(base.replace(/\/$/, '') + path, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `Agent answered ${response.status}`), { status: response.status });
  return data;
};
const proxyAgent = (method, path, body) => agent(process.env.PROXY_AGENT_URL, process.env.PROXY_AGENT_TOKEN, method, path, body);
const siteAgent = (method, path, body, ms) => agent(process.env.SITE_AGENT_URL, process.env.SITE_AGENT_TOKEN, method, path, body, ms);
const hostAgent = (method, path, body, ms) => agent(process.env.HOST_AGENT_URL, process.env.HOST_AGENT_TOKEN, method, path, body, ms);
const fail = (response, error) => response.status(error.status && error.status < 600 ? (error.status === 401 ? 502 : error.status) : 502).json({ message: error.message || 'Agent not reachable.' });

let routeCache = { at: 0, data: [] };
const routes = async () => {
  if (Date.now() - routeCache.at < 15000) return routeCache.data;
  try { routeCache = { at: Date.now(), data: (await proxyAgent('GET', '/routes')).routes || [] }; } catch { routeCache = { at: Date.now(), data: [] }; }
  return routeCache.data;
};

// Public: which extra sites exist (no internal addresses).
app.get('/api/routes', async (_request, response) => {
  response.json({ routes: (await routes()).map((r) => ({ name: r.name, title: r.title, path: r.path, kind: r.kind })) });
});

app.post('/api/routes', async (request, response) => {
  if (!mainPassword()) return response.status(503).json({ message: 'Set DASHBOARD_PASSWORD first.' });
  if (!passwordOk(request)) return response.status(lockedOut(request) ? 429 : 401).json({ message: lockMessage(request) });
  const { name, target, title } = request.body ?? {};
  try {
    const route = await proxyAgent('PUT', `/routes/${encodeURIComponent(String(name || ''))}`, { target, title: title || name, kind: 'custom' });
    routeCache.at = 0; siteCache.at = 0;
    return response.json(route);
  } catch (error) { return fail(response, error); }
});

const unlocked = (request, response) => {
  if (!mainPassword()) { response.status(503).json({ message: 'Set DASHBOARD_PASSWORD first.' }); return false; }
  if (!passwordOk(request)) { response.status(lockedOut(request) ? 429 : 401).json({ message: lockMessage(request) }); return false; }
  return true;
};
const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

// Start building a WordPress site (optionally written by Gemini). Runs in the background on the site agent;
// the page polls /api/wordpress/jobs/:name, which also publishes the route once the site is ready.
app.post('/api/wordpress', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = String(request.body?.name || '').trim().toLowerCase();
  const { title = '', password = '', prompt = '', quality = 'fast' } = request.body ?? {};
  try {
    return response.status(202).json(await siteAgent('POST', '/sites', { name, title: String(title), password: String(password), prompt: String(prompt), quality }));
  } catch (error) { return fail(response, error); }
});

const routed = new Set();
app.get('/api/wordpress/jobs/:name', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = request.params.name;
  if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
  try {
    const job = await siteAgent('GET', `/jobs/${name}`);
    if (job.state === 'done' && job.kind === 'create' && !routed.has(name)) {
      try {
        const target = new URL(process.env.SITE_AGENT_URL); target.port = String(job.result.port); target.pathname = '/';
        await proxyAgent('PUT', `/routes/${name}`, { path: `/sites/${name}/`, target: target.toString(), kind: 'wordpress', title: job.result.title });
        routed.add(name); routeCache.at = 0; siteCache.at = 0;
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
      const target = new URL(process.env.SITE_AGENT_URL); target.port = String(site.port); target.pathname = '/';
      await proxyAgent('PUT', `/routes/${site.name}`, { path: `/sites/${site.name}/`, target: target.toString(), kind: 'wordpress', title: site.title });
      routed.add(site.name); routeCache.at = 0;
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
setInterval(syncSites, 30000).unref();

// Ask Gemini to change an existing site ("add a contact page", "make it more formal").
app.post('/api/wordpress/:name/ai', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = request.params.name;
  if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
  try {
    return response.status(202).json(await siteAgent('POST', `/sites/${name}/ai`, { prompt: String(request.body?.prompt || ''), quality: request.body?.quality === 'best' ? 'best' : 'fast' }));
  } catch (error) { return fail(response, error); }
});

// Is a Gemini key saved on the websites server? (yes/no only)
app.get('/api/ai', async (_request, response) => {
  try { return response.json({ ai: (await siteAgent('GET', '/ai')).ai }); } catch { return response.json({ ai: false }); }
});
app.put('/api/ai/key', async (request, response) => {
  if (!unlocked(request, response)) return;
  try { return response.json(await siteAgent('PUT', '/ai/key', { key: String(request.body?.key || '') })); } catch (error) { return fail(response, error); }
});

app.delete('/api/routes/:name', async (request, response) => {
  if (!mainPassword()) return response.status(503).json({ message: 'Set DASHBOARD_PASSWORD first.' });
  if (!passwordOk(request)) return response.status(lockedOut(request) ? 429 : 401).json({ message: lockMessage(request) });
  const name = request.params.name;
  try {
    const route = (await proxyAgent('GET', '/routes')).routes.find((r) => r.name === name);
    if (!route) return response.status(404).json({ message: `No site ${name}.` });
    deleting.add(name);
    try {
      await proxyAgent('DELETE', `/routes/${encodeURIComponent(name)}`);
      if (route.kind === 'wordpress') await siteAgent('DELETE', `/sites/${encodeURIComponent(name)}`, undefined, 60000);
      if (route.kind === 'app' || route.kind === 'aisite') {
        const app = ((await hostAgent('GET', '/apps')).apps || []).find((a) => a.name === name);
        if (app) await hostAgent('DELETE', `/apps/${app.ctid}`, undefined, 120000);
      }
    } finally { deleting.delete(name); routed.delete(name); }
    routeCache.at = 0; siteCache.at = 0;
    return response.json({ deleted: name, kind: route.kind });
  } catch (error) { return fail(response, error); }
});

// ---------- notes: saved prompts, to-dos and a scratch note (main password) ----------
// Kept in data/notes.json next to the app; the deploy leaves data/ alone.
const NOTES_FILE = process.env.NOTES_FILE || path.join(__dirname, 'data', 'notes.json');
const emptyNotes = () => ({ note: '', prompts: [], todos: [], updated: null });
const readNotes = () => { try { return { ...emptyNotes(), ...JSON.parse(readFileSync(NOTES_FILE, 'utf8')) }; } catch { return emptyNotes(); } };
const cleanItems = (list, extra) => (Array.isArray(list) ? list : []).slice(0, 300).map((item) => ({
  id: String(item?.id || Math.random().toString(36).slice(2)).slice(0, 40),
  text: String(item?.text || '').slice(0, 4000),
  at: String(item?.at || new Date().toISOString()).slice(0, 40),
  ...extra(item),
})).filter((item) => item.text.trim());

app.get('/api/notes', (request, response) => {
  if (!unlocked(request, response)) return;
  response.json(readNotes());
});
app.put('/api/notes', (request, response) => {
  if (!unlocked(request, response)) return;
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
    return response.json(notes);
  } catch (error) { return response.status(500).json({ message: `Could not save notes: ${error.message}` }); }
});


// ---------- apps on their own container (host agent builds them in the background) ----------
app.get('/api/apps', async (request, response) => {
  if (!unlocked(request, response)) return;
  try { return response.json(await hostAgent('GET', '/apps')); } catch (error) { return fail(response, error); }
});
app.post('/api/apps', async (request, response) => {
  if (!unlocked(request, response)) return;
  const b = request.body ?? {};
  const name = String(b.name || '').trim().toLowerCase();
  if (['sites', 'codezi', 'api', 'assets', 'landing', 'docker-avi'].includes(name)) return response.status(400).json({ message: `${name} is already used by the server, pick another name.` });
  if ((await routes()).some((r) => r.name === name)) return response.status(400).json({ message: `A site called ${name} already exists.` });
  try {
    return response.status(202).json(await hostAgent('POST', '/apps', { name, title: String(b.title || name), source_type: b.source_type, source: String(b.source || ''), port: Number(b.port) || 80, cores: Number(b.cores) || 1, memory: Number(b.memory) || 1024, disk: Number(b.disk) || 8 }));
  } catch (error) { return fail(response, error); }
});
app.post('/api/apps/:ctid/update', async (request, response) => {
  if (!unlocked(request, response)) return;
  if (!/^\d+$/.test(request.params.ctid)) return response.status(400).json({ message: 'Bad id.' });
  try { return response.status(202).json(await hostAgent('POST', `/apps/${request.params.ctid}/update`)); } catch (error) { return fail(response, error); }
});

// ---------- history: every build, AI edit and app deploy, with its log ----------
const JOB_ID = /^[a-z]+-[a-z0-9-]+-\d+$/;
app.get('/api/activity', async (request, response) => {
  if (!unlocked(request, response)) return;
  const [sitesJobs, hostJobs] = await Promise.all([
    siteAgent('GET', '/jobs').then((b) => (b.jobs || []).map((j) => ({ ...j, source: 'site' }))).catch(() => []),
    process.env.HOST_AGENT_URL ? hostAgent('GET', '/jobs').then((b) => (b.jobs || []).map((j) => ({ ...j, source: 'host' }))).catch(() => []) : [],
  ]);
  const jobs = [...sitesJobs, ...hostJobs].sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, 100);
  return response.json({ jobs });
});
app.get('/api/activity/:source/:id', async (request, response) => {
  if (!unlocked(request, response)) return;
  const { source, id } = request.params;
  if (!JOB_ID.test(id) || !['site', 'host'].includes(source)) return response.status(400).json({ message: 'Bad id.' });
  try {
    const job = await (source === 'site' ? siteAgent : hostAgent)('GET', `/jobs/${id}`);
    // a finished app build gets its address published here (and by the 30 s sync as a fallback)
    if (source === 'host' && (job.kind === 'app' || job.kind === 'aisite') && job.state === 'done' && job.result && !routed.has(job.name)) {
      await proxyAgent('PUT', `/routes/${job.name}`, { target: job.result.target, kind: job.kind === 'aisite' ? 'aisite' : 'app', title: job.result.title || job.name }).catch(() => {});
      routed.add(job.name); routeCache.at = 0;
    }
    return response.json(job);
  } catch (error) { return fail(response, error); }
});


// ---------- AI websites on their own container (host agent; Gemini writes HTML/CSS, nginx serves it) ----------
app.get('/api/aisites/candidates', async (request, response) => {
  if (!unlocked(request, response)) return;
  try { return response.json(await hostAgent('GET', '/aisites/candidates')); } catch (error) { return fail(response, error); }
});
app.post('/api/aisites', async (request, response) => {
  if (!unlocked(request, response)) return;
  const b = request.body ?? {}; const name = String(b.name || '').trim().toLowerCase();
  if (['sites', 'codezi', 'api', 'assets', 'docker-avi', 'jacobflightmonitor'].includes(name)) return response.status(400).json({ message: `${name} is already used by the server, pick another name.` });
  if ((await routes()).some((r) => r.name === name)) return response.status(400).json({ message: `A site called ${name} already exists.` });
  try {
    return response.status(202).json(await hostAgent('POST', '/aisites', { name, prompt: String(b.prompt || ''), quality: b.quality === 'best' ? 'best' : 'fast', ctid: b.ctid ? Number(b.ctid) : null }));
  } catch (error) { return fail(response, error); }
});
app.post('/api/aisites/:ctid/:action', async (request, response) => {
  if (!unlocked(request, response)) return;
  const { ctid, action } = request.params;
  if (!/^\d+$/.test(ctid) || !['edit', 'undo'].includes(action)) return response.status(400).json({ message: 'Bad request.' });
  try { return response.status(202).json(await hostAgent('POST', `/aisites/${ctid}/${action}`, { prompt: String(request.body?.prompt || ''), quality: request.body?.quality === 'best' ? 'best' : 'fast' })); } catch (error) { return fail(response, error); }
});
app.post('/api/wordpress/:name/undo', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = request.params.name;
  if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
  try { return response.status(202).json(await siteAgent('POST', `/sites/${name}/undo`, { job: String(request.body?.job || '') })); } catch (error) { return fail(response, error); }
});

// ---------- health and updates (host agent) ----------
app.get('/api/health', async (request, response) => {
  if (!process.env.HOST_AGENT_URL) return response.status(503).json({ message: 'The host agent is not installed.' });
  try {
    const h = await hostAgent('GET', '/health', undefined, 60000);
    if (passwordOk(request)) return response.json(h);
    // visitors who are not unlocked see the readings, not the disk serial details
    return response.json({ ...h, disks: (h.disks || []).map(({ dev, model, size_gb, passed, temp, ssd, state, wear }) => ({ dev, model, size_gb, passed, temp, ssd, state, wear })) });
  } catch (error) { return fail(response, error); }
});
app.get('/api/updates', async (request, response) => {
  if (!unlocked(request, response)) return;
  try { return response.json(await hostAgent('GET', '/updates')); } catch (error) { return fail(response, error); }
});
app.post('/api/updates/check', async (request, response) => {
  if (!unlocked(request, response)) return;
  try { return response.status(202).json(await hostAgent('POST', '/updates/check')); } catch (error) { return fail(response, error); }
});
app.post('/api/updates/apply', async (request, response) => {
  if (!unlocked(request, response)) return;
  const targets = (Array.isArray(request.body?.targets) ? request.body.targets : []).map(Number).filter((t) => Number.isInteger(t) && t >= 100 && t !== 102);
  try { return response.status(202).json(await hostAgent('POST', '/updates/apply', { targets })); } catch (error) { return fail(response, error); }
});

// ---------- logs ----------
const taskLines = async (limit) => {
  const tasks = await pve(`/nodes/${node()}/tasks?limit=${limit}`);
  return (tasks || []).map((t) => `${new Date(t.starttime * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${t.type}${t.id ? ` ${t.id}` : ''} by ${t.user}: ${t.status || 'running'}`).reverse();
};
app.get('/api/logs', async (request, response) => {
  if (!unlocked(request, response)) return;
  const base = [{ key: 'proxmox-tasks', label: 'Proxmox: recent tasks (create, start, stop, backups)', group: 'Server' }];
  try { return response.json({ sources: [...base, ...((await hostAgent('GET', '/logs')).sources || [])], host: true }); } catch (error) { return response.json({ sources: base, host: false, message: error.message }); }
});
app.get('/api/logs/:key', async (request, response) => {
  if (!unlocked(request, response)) return;
  const key = request.params.key;
  const lines = Math.max(10, Math.min(2000, Number(request.query.lines) || 200));
  if (!/^[a-z0-9-]{2,60}$/.test(key)) return response.status(400).json({ message: 'Bad log name.' });
  try {
    if (key === 'proxmox-tasks') return response.json({ key, lines: await taskLines(Math.min(lines, 500)) });
    return response.json(await hostAgent('GET', `/logs/${key}?lines=${lines}`, undefined, 30000));
  } catch (error) { return fail(response, error); }
});

// ---------- agents hub (CT 111, Mission Control) ----------
// The phone front door for the hub. The browser never talks to the hub and never sees its API key:
// this server holds HUB_API_KEY and proxies. The key is admin on the hub, so every route here is
// behind the main password (unlocked()), and only the fields the page needs are passed through.
// CT 105 reaches the hub over the LAN at http://10.0.0.152:3005 (CT 105 has no Tailscale, and
// MC_ALLOWED_HOSTS on the hub already lists 10.0.0.152, so the Host check passes).
const hubCall = async (method, apiPath, body) => {
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
const rows = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);
// Mission Control is alpha and its schema may shift between releases, so read defensively and
// never assume a field is there.
const slimAgent = (a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, last_seen: a.last_seen ?? null, last_activity: a.last_activity ?? '' });
const slimTask = (t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, assigned_to: t.assigned_to ?? null, updated_at: t.updated_at ?? t.created_at ?? null, tags: Array.isArray(t.tags) ? t.tags : [] });
const slimActivity = (e) => ({ id: e.id, type: e.type, actor: e.actor ?? '', description: e.description ?? '', at: e.created_at ?? null });

let hubCache = { at: 0, data: null };
app.get('/api/hub', async (request, response) => {
  if (!unlocked(request, response)) return;
  if (hubCache.data && Date.now() - hubCache.at < 5000) return response.json(hubCache.data);
  try {
    // One round trip for the phone: everything the page shows, in one response.
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

const HUB_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
app.post('/api/hub/tasks', async (request, response) => {
  if (!unlocked(request, response)) return;
  const title = String(request.body?.title ?? '').trim();
  const description = String(request.body?.description ?? '').trim();
  const assigned = String(request.body?.assigned_to ?? '').trim();
  const priority = String(request.body?.priority ?? 'medium').trim();
  if (title.length < 3 || title.length > 200) return response.status(400).json({ message: 'Give the task a title of 3 to 200 characters.' });
  if (description.length > 4000) return response.status(400).json({ message: 'That description is too long (4000 characters max).' });
  if (!HUB_PRIORITIES.has(priority)) return response.status(400).json({ message: 'Priority must be low, medium, high or critical.' });
  try {
    // Only an agent the hub actually knows may be assigned, so a typo cannot park a task nowhere.
    const known = rows(await hubCall('GET', '/api/agents?limit=50'), 'agents').map((a) => a.name);
    if (assigned && !known.includes(assigned)) return response.status(400).json({ message: `Unknown agent "${assigned}".` });
    const created = await hubCall('POST', '/api/tasks', {
      title, description, priority,
      status: assigned ? 'assigned' : 'inbox',
      ...(assigned ? { assigned_to: assigned } : {}),
      created_by: 'dashboard',
      tags: ['from-dashboard'],
    });
    hubCache = { at: 0, data: null };
    const task = created?.task ?? created;
    return response.status(201).json({ task: slimTask(task) });
  } catch (error) { return fail(response, error); }
});

// ---------- static site ----------
app.use(express.static(path.join(__dirname, 'dist')));
app.use((_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => console.log(`Homelab dashboard listening on http://localhost:${port}`));
