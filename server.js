import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
  if (missing.length || !process.env[templateSetting]) return response.status(503).json({ message: `Proxmox is not configured. Set ${[...missing, templateSetting].filter((setting, index, values) => values.indexOf(setting) === index).join(', ')}.` });
  if ((type !== 'vm' && type !== 'lxc') || typeof name !== 'string' || !instanceName.test(name)) return response.status(400).json({ message: 'Use a name with lowercase letters, numbers, and hyphens.' });

  const cpu = Number(cores); const ram = Number(memory);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16 || !Number.isInteger(ram) || ram < 512 || ram > 32768) return response.status(400).json({ message: 'Choose between 1-16 CPU cores and 512-32768 MiB of memory.' });

  const baseUrl = process.env.PROXMOX_URL.replace(/\/$/, '');
  const headers = { Authorization: `PVEAPIToken=${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}` };
  try {
    const nextIdResponse = await fetch(`${baseUrl}/cluster/nextid`, { headers });
    const nextIdPayload = await nextIdResponse.json();
    if (!nextIdResponse.ok) throw new Error(nextIdPayload.errors ? JSON.stringify(nextIdPayload.errors) : 'Could not reserve an ID.');
    const resource = type === 'vm' ? 'qemu' : 'lxc';
    const form = new URLSearchParams({ newid: String(nextIdPayload.data), name, full: '1', cores: String(cpu), memory: String(ram) });
    const cloneResponse = await fetch(`${baseUrl}/nodes/${encodeURIComponent(process.env.PROXMOX_NODE)}/${resource}/${encodeURIComponent(process.env[templateSetting])}/clone`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const clonePayload = await cloneResponse.json();
    if (!cloneResponse.ok) throw new Error(clonePayload.errors ? JSON.stringify(clonePayload.errors) : 'Proxmox rejected the clone request.');
    return response.status(202).json({ task: clonePayload.data });
  } catch (error) {
    return response.status(502).json({ message: error instanceof Error ? error.message : 'Could not reach Proxmox through the Tailscale network.' });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use((_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => console.log(`Orbit Hub is listening on http://localhost:${port}`));
