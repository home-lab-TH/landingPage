import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// A small "!" next to a control. Hover (mouse), focus (keyboard) or tap (touch) shows what it does.
export function Help({ title, children, big = false }: { title: string; children: ReactNode; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState('');
  const wrap = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) {
      const x = r.left + r.width / 2;
      const side = x > window.innerWidth - 170 ? 'left' : x < 170 ? 'right' : '';
      setPlace(`${side} ${r.bottom > window.innerHeight - 240 ? 'up' : ''}`);
    }
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className={`help ${big ? 'big' : ''}`} ref={wrap}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') show(); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOpen(false); }}>
      <button type="button" className="help-btn" aria-label={`What is this: ${title}`} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); show(); }} onFocus={show} onBlur={() => setOpen(false)}>!</button>
      {open && <span role="tooltip" className={`help-pop ${place}`}><strong>{title}</strong><span>{children}</span></span>}
    </span>
  );
}
