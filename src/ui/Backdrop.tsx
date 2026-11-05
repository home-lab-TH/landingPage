import { useEffect, useRef } from 'react';

// Live network map behind the dashboard: the hub is the Proxmox host, every other node is a real
// container or VM. Running guests glow and send packets to the hub; stopped ones fade. The cursor
// gently pushes nodes away and lights up nearby links. Static when the user prefers reduced motion.
export type BackdropGuest = { id: number; status: string };
type Node = { id: number; x: number; y: number; vx: number; vy: number; up: boolean; r: number };

const seeded = (n: number) => { const x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };

export function Backdrop({ guests }: { guests: BackdropGuest[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const nodes = useRef<Node[]>([]);
  const list = useRef(guests);
  list.current = guests;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0; let h = 0; let dpr = 1; let raf = 0; let t = 0;
    const mouse = { x: -9999, y: -9999 };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      el.width = w * dpr; el.height = h * dpr; el.style.width = `${w}px`; el.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const sync = () => {
      const want = list.current.length ? list.current : Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, status: 'running' }));
      const have = new Map(nodes.current.map((n) => [n.id, n]));
      nodes.current = want.map((g) => {
        const old = have.get(g.id);
        if (old) { old.up = g.status === 'running'; return old; }
        const a = seeded(g.id) * Math.PI * 2; const d = 0.22 + seeded(g.id + 7) * 0.26;
        return { id: g.id, x: w * (0.5 + Math.cos(a) * d * 1.4), y: h * (0.5 + Math.sin(a) * d), vx: (seeded(g.id + 3) - 0.5) * 0.18, vy: (seeded(g.id + 5) - 0.5) * 0.18, up: g.status === 'running', r: 2.4 + seeded(g.id + 11) * 1.6 };
      });
    };

    const draw = () => {
      t += 1;
      ctx.clearRect(0, 0, w, h);
      const hub = { x: w * 0.62 + Math.sin(t / 900) * 30, y: h * 0.42 + Math.cos(t / 1100) * 20 };
      for (const n of nodes.current) {
        if (!still) {
          n.x += n.vx; n.y += n.vy;
          const dx = n.x - mouse.x; const dy = n.y - mouse.y; const dist = Math.hypot(dx, dy);
          if (dist < 140 && dist > 0) { n.x += (dx / dist) * (140 - dist) * 0.02; n.y += (dy / dist) * (140 - dist) * 0.02; }
          const hx = n.x - hub.x; const hy = n.y - hub.y; const hd = Math.hypot(hx, hy);
          if (hd > Math.min(w, h) * 0.55) { n.vx -= hx * 0.00002; n.vy -= hy * 0.00002; }
          if (n.x < 20 || n.x > w - 20) n.vx *= -1;
          if (n.y < 20 || n.y > h - 20) n.vy *= -1;
        }
      }
      // links between nearby guests
      const ns = nodes.current;
      for (let i = 0; i < ns.length; i += 1) {
        for (let j = i + 1; j < ns.length; j += 1) {
          const d = Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
          if (d < 260) {
            const near = Math.hypot((ns[i].x + ns[j].x) / 2 - mouse.x, (ns[i].y + ns[j].y) / 2 - mouse.y) < 180;
            ctx.strokeStyle = `rgba(155, 140, 255, ${(1 - d / 260) * (near ? 0.35 : 0.12)})`;
            ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ns[i].x, ns[i].y); ctx.lineTo(ns[j].x, ns[j].y); ctx.stroke();
          }
        }
      }
      // spokes to the hub with packets
      for (const n of ns) {
        const near = Math.hypot(n.x - mouse.x, n.y - mouse.y) < 180;
        ctx.strokeStyle = n.up ? `rgba(79, 227, 193, ${near ? 0.32 : 0.1})` : 'rgba(120, 130, 160, 0.05)';
        ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(n.x, n.y); ctx.stroke();
        if (n.up) {
          const p = ((t * 0.004 + seeded(n.id) ) % 1);
          const back = n.id % 2 === 0;
          const k = back ? 1 - p : p;
          const px = hub.x + (n.x - hub.x) * k; const py = hub.y + (n.y - hub.y) * k;
          ctx.fillStyle = 'rgba(79, 227, 193, 0.85)'; ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      // guest nodes
      for (const n of ns) {
        const pulse = n.up ? 0.5 + Math.sin(t / 40 + n.id) * 0.5 : 0;
        if (n.up) {
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 18);
          g.addColorStop(0, `rgba(79, 227, 193, ${0.18 + pulse * 0.12})`); g.addColorStop(1, 'rgba(79, 227, 193, 0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, 18, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = n.up ? '#7ff0d6' : 'rgba(140, 150, 180, 0.45)';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = n.up ? 'rgba(200, 245, 235, 0.35)' : 'rgba(160, 170, 200, 0.22)';
        ctx.font = '10px "Geist Mono", ui-monospace, monospace';
        ctx.fillText(String(n.id), n.x + 7, n.y - 6);
      }
      // hub
      const hg = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, 46);
      hg.addColorStop(0, 'rgba(155, 140, 255, 0.35)'); hg.addColorStop(1, 'rgba(155, 140, 255, 0)');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hub.x, hub.y, 46, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(190, 180, 255, 0.6)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(hub.x, hub.y, 7 + Math.sin(t / 60) * 1.2, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#c9c1ff'; ctx.beginPath(); ctx.arc(hub.x, hub.y, 3.2, 0, Math.PI * 2); ctx.fill();
      if (!still && !document.hidden) raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onLeave = () => { mouse.x = -9999; mouse.y = -9999; };
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(draw); };
    const onResize = () => { resize(); if (still) draw(); };
    resize(); sync(); raf = requestAnimationFrame(draw);
    const resync = window.setInterval(() => { sync(); if (still) draw(); }, 2000);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf); window.clearInterval(resync);
      window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave); document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return (
    <div className="backdrop" aria-hidden="true">
      <div className="aurora a1" /><div className="aurora a2" /><div className="aurora a3" />
      <canvas ref={canvas} />
      <div className="grain" />
    </div>
  );
}
