import express from 'express';
import https from 'node:https';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
  const id = read ? (process.env.PROXMOX_READ_TOKEN_ID || process.env.PROXMOX_TOKEN_ID) : process.env.PROXMOX_TOKEN_ID;
  const secret = read ? (process.env.PROXMOX_READ_TOKEN_SECRET || process.env.PROXMOX_TOKEN_SECRET) : process.env.PROXMOX_TOKEN_SECRET;
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
  const results = await Promise.all(services.sites.map(async (site) => ({ id: site.id, ...(await probe(site.check)) })));
  siteCache = { at: Date.now(), data: { at: new Date().toISOString(), results } };
  return response.json(siteCache.data);
});

// ---------- /api/proxmox/provision (password protected) ----------
const requiredProxmoxSettings = ['PROXMOX_URL', 'PROXMOX_TOKEN_ID', 'PROXMOX_TOKEN_SECRET', 'PROXMOX_NODE'];
const instanceName = /^[a-z0-9][a-z0-9-]{1,49}$/;

// Provisioning is off unless PROVISION_PASSWORD is set, and every request must send it.
const provisionAllowed = (request) => {
  const expected = process.env.PROVISION_PASSWORD;
  const given = request.get('x-provision-password') ?? '';
  if (!expected) return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

app.post('/api/proxmox/provision', async (request, response) => {
  if (!process.env.PROVISION_PASSWORD) return response.status(503).json({ message: 'Provisioning is disabled. Set PROVISION_PASSWORD on the server to enable it.' });
  if (!provisionAllowed(request)) return response.status(401).json({ message: 'Wrong provisioning password.' });
  const { type, name, cores, memory } = request.body ?? {};
  const missing = requiredProxmoxSettings.filter((setting) => !process.env[setting]);
  const templateSetting = type === 'vm' ? 'PROXMOX_VM_TEMPLATE' : 'PROXMOX_LXC_TEMPLATE';
  if (missing.length || !process.env[templateSetting]) return response.status(503).json({ message: `Proxmox is not configured. Set ${[...new Set([...missing, templateSetting])].join(', ')}.` });
  if ((type !== 'vm' && type !== 'lxc') || typeof name !== 'string' || !instanceName.test(name)) return response.status(400).json({ message: 'Use a name with lowercase letters, numbers, and hyphens.' });

  const cpu = Number(cores); const ram = Number(memory);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16 || !Number.isInteger(ram) || ram < 512 || ram > 32768) return response.status(400).json({ message: 'Choose between 1-16 CPU cores and 512-32768 MiB of memory.' });

  try {
    const node = encodeURIComponent(process.env.PROXMOX_NODE);
    const newid = await pve('/cluster/nextid');
    const resource = type === 'vm' ? 'qemu' : 'lxc';
    // The clone API takes no cores/memory: clone first, then set them once the clone task has finished.
    const form = { newid: String(newid), full: '1', [type === 'vm' ? 'name' : 'hostname']: name };
    const task = await pve(`/nodes/${node}/${resource}/${encodeURIComponent(process.env[templateSetting])}/clone`, { method: 'POST', form });
    response.status(202).json({ task, id: newid });
    (async () => {
      for (let i = 0; i < 120; i += 1) {
        const state = await pve(`/nodes/${node}/tasks/${encodeURIComponent(task)}/status`);
        if (state?.status === 'stopped') {
          if (state.exitstatus !== 'OK') return console.error(`Clone ${newid} failed: ${state.exitstatus}`);
          await pve(`/nodes/${node}/${resource}/${newid}/config`, { method: 'PUT', form: { cores: String(cpu), memory: String(ram) } });
          return console.log(`Provisioned ${type} ${newid} (${name}): ${cpu} cores, ${ram} MiB`);
        }
        await new Promise((done) => setTimeout(done, 2000));
      }
      console.error(`Clone ${newid} still running after 4 minutes; cores/memory not applied.`);
    })().catch((error) => console.error(`Provision follow-up for ${newid} failed:`, error));
    return undefined;
  } catch (error) {
    return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox.' });
  }
});

// ---------- static site ----------
app.use(express.static(path.join(__dirname, 'dist')));
app.use((_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => console.log(`Homelab dashboard listening on http://localhost:${port}`));
