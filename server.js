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

// ---------- /api/health ----------
app.get('/api/health', (_request, response) => {
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
app.get('/api/services', async (_request, response) => {
  if (Date.now() - siteCache.at < 30000 && siteCache.data) return response.json(siteCache.data);
  const extra = (await routes()).map((r) => ({ id: `route:${r.name}`, check: `http://10.0.0.250${r.path}` }));
  const results = await Promise.all([...services.sites, ...extra].map(async (site) => ({ id: site.id, ...(await probe(site.check)) })));
  siteCache = { at: Date.now(), data: { at: new Date().toISOString(), results } };
  return response.json(siteCache.data);
});

// ---------- create / delete (one main password) ----------
// DASHBOARD_PASSWORD (or the older PROVISION_PASSWORD) unlocks create and delete.
// Delete only works on guests that carry the "dashboard" tag, i.e. ones this page created.
const mainPassword = () => process.env.DASHBOARD_PASSWORD || process.env.PROVISION_PASSWORD || '';
const passwordOk = (request) => {
  const expected = mainPassword();
  const given = request.get('x-dashboard-password') ?? request.get('x-provision-password') ?? '';
  if (!expected) return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
const guard = (request, response) => {
  if (!mainPassword()) { response.status(503).json({ message: 'Create/delete is off. Set DASHBOARD_PASSWORD in .env on FrontPage.' }); return false; }
  if (!statsConfigured()) { response.status(503).json({ message: 'Proxmox is not configured (PROXMOX_URL, PROXMOX_NODE, token).' }); return false; }
  if (!passwordOk(request)) { response.status(401).json({ message: 'Wrong password.' }); return false; }
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
  return passwordOk(request) ? response.json({ ok: true }) : response.status(401).json({ message: 'Wrong password.' });
});

// LXC: created from an OS template (PROXMOX_LXC_OSTEMPLATE, e.g. local:vztmpl/debian-13-standard_..._amd64.tar.zst).
// VM: cloned from PROXMOX_VM_TEMPLATE (a VM converted to a template), then cores/memory are set.
app.post('/api/proxmox/provision', async (request, response) => {
  if (!guard(request, response)) return undefined;
  const { type, name, cores, memory, disk } = request.body ?? {};
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
        unprivileged: '1', features: 'nesting=1', onboot: '1', start: '1', tags: TAG,
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
      await pve(`/nodes/${node()}/qemu/${newid}/config`, { method: 'PUT', form: { cores: String(cpu), memory: String(ram), tags: TAG, onboot: '1' } });
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
  if (!passwordOk(request)) return response.status(401).json({ message: 'Wrong password.' });
  const { name, target, title } = request.body ?? {};
  try {
    const route = await proxyAgent('PUT', `/routes/${encodeURIComponent(String(name || ''))}`, { target, title: title || name, kind: 'custom' });
    routeCache.at = 0; siteCache.at = 0;
    return response.json(route);
  } catch (error) { return fail(response, error); }
});

const unlocked = (request, response) => {
  if (!mainPassword()) { response.status(503).json({ message: 'Set DASHBOARD_PASSWORD first.' }); return false; }
  if (!passwordOk(request)) { response.status(401).json({ message: 'Wrong password.' }); return false; }
  return true;
};
const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

// Start building a WordPress site (optionally written by Gemini). Runs in the background on the site agent;
// the page polls /api/wordpress/jobs/:name, which also publishes the route once the site is ready.
app.post('/api/wordpress', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = String(request.body?.name || '').trim().toLowerCase();
  const { title = '', password = '', prompt = '' } = request.body ?? {};
  try {
    return response.status(202).json(await siteAgent('POST', '/sites', { name, title: String(title), password: String(password), prompt: String(prompt) }));
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
};
setInterval(syncSites, 30000).unref();

// Ask Gemini to change an existing site ("add a contact page", "make it more formal").
app.post('/api/wordpress/:name/ai', async (request, response) => {
  if (!unlocked(request, response)) return;
  const name = request.params.name;
  if (!SITE_NAME.test(name)) return response.status(400).json({ message: 'Bad name.' });
  try {
    return response.status(202).json(await siteAgent('POST', `/sites/${name}/ai`, { prompt: String(request.body?.prompt || '') }));
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
  if (!passwordOk(request)) return response.status(401).json({ message: 'Wrong password.' });
  const name = request.params.name;
  try {
    const route = (await proxyAgent('GET', '/routes')).routes.find((r) => r.name === name);
    if (!route) return response.status(404).json({ message: `No site ${name}.` });
    deleting.add(name);
    try {
      await proxyAgent('DELETE', `/routes/${encodeURIComponent(name)}`);
      if (route.kind === 'wordpress') await siteAgent('DELETE', `/sites/${encodeURIComponent(name)}`, undefined, 60000);
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

// ---------- static site ----------
app.use(express.static(path.join(__dirname, 'dist')));
app.use((_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => console.log(`Homelab dashboard listening on http://localhost:${port}`));
