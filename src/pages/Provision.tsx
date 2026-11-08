import { useState } from 'react';
import type { FormEvent } from 'react';
import { Help } from '../ui/Help';
import { Icon, Login } from '../lib';
import type { ProvisionType } from '../lib';

export default function Provision({ pass, onLogin }: { pass: string; onLogin: (p: string) => void }) {
  const [type, setType] = useState<ProvisionType>('lxc');
  const [name, setName] = useState('');
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(2048);
  const [disk, setDisk] = useState(8);
  const [loginPass, setLoginPass] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState('loading'); setMessage('');
    try {
      const response = await fetch('./api/proxmox/provision', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dashboard-password': pass }, body: JSON.stringify({ type, name, cores, memory, disk, password: loginPass }) });
      const data: { message?: string; task?: string; id?: number } = await response.json();
      if (!response.ok) throw new Error(data.message || 'Proxmox did not accept the request.');
      setState('success'); setMessage(`Creating ${type.toUpperCase()} ${data.id ?? ''} (${name}). It shows up on the Overview in a minute; delete it there if you don't need it.`);
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Unable to reach the provisioning service.'); }
  };

  return (
    <>
      <header className="page-head"><div><p className="eyebrow">Proxmox</p><h1>Create a container or VM <Help big title="This page: Create">Make a new guest on Proxmox. A container (LXC) is light and starts in seconds, good for one app or Docker. A VM is a full computer, cloned from your VM template. New guests get the dashboard tag, so you can delete them from the Overview later.</Help></h1><p className="lede">Containers start from a fresh Debian image; VMs are cloned from your VM template.</p></div></header>
      {!pass ? <Login onLogin={onLogin} /> : <form className="panel form" onSubmit={submit}>
        <div className="segmented" role="radiogroup">
          <Help title="Container or VM">Container: shares the server's Linux kernel, uses little memory, best for most apps. VM: its own operating system, for Windows or anything that needs full isolation.</Help>
          <button type="button" className={type === 'lxc' ? 'on' : ''} onClick={() => setType('lxc')}><Icon name="box" />Container (LXC)</button>
          <button type="button" className={type === 'vm' ? 'on' : ''} onClick={() => setType('vm')}><Icon name="server" />Virtual machine</button>
        </div>
        <label><span>Name <Help title="Name">The guest's hostname. Lowercase letters, digits and dashes.</Help></span><input required minLength={2} maxLength={50} pattern="[a-z0-9][a-z0-9-]*" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. paperless" /></label>
        <div className="pair">
          <label><span>CPU cores <Help title="CPU cores">How many processor threads it may use. 1–2 is plenty for a small app.</Help></span><input type="number" min={1} max={8} value={cores} onChange={(e) => setCores(Number(e.target.value))} /></label>
          <label><span>Memory (MiB) <Help title="Memory">RAM in MiB: 1024 = 1 GB. The server has 16 GB shared by everything.</Help></span><input type="number" min={256} max={8192} step={256} value={memory} onChange={(e) => setMemory(Number(e.target.value))} /></label>
        </div>
        <label><span>Disk (GB) <Help title="Disk">Disk size in GB. It can be grown later in Proxmox, not shrunk. VMs start from a 3 GB image that is grown to this size.</Help></span><input type="number" min={type === 'vm' ? 4 : 2} max={100} value={disk} onChange={(e) => setDisk(Number(e.target.value))} /></label>
        <label><span>Login password (optional) <Help title="Login password">The password to log in to the new machine: user root for a container, user debian for a VM (Debian 13). Leave empty to set it later in Proxmox (containers can always be opened from the Proxmox console).</Help></span><input type="password" minLength={8} autoComplete="new-password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="8+ characters" /></label>
        <button className="primary" disabled={state === 'loading'} type="submit"><Icon name="plus" />{state === 'loading' ? 'Creating…' : `Create ${type === 'lxc' ? 'container' : 'VM'}`}</button>
        {state !== 'idle' && state !== 'loading' && <p className={`message ${state}`}>{message}</p>}
      </form>}
    </>
  );
}
