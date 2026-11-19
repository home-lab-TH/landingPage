import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A small "!" next to a control. Hover (mouse), focus (keyboard) or tap (touch) shows what it does.
// The tip is drawn on top of everything (portal) and kept inside the screen.
export function Help({ title, children, big = false }: { title: string; children: ReactNode; big?: boolean }) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const show = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(big ? 420 : 340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 12));
    const below = r.bottom + 10; const above = window.innerHeight - r.top + 10;
    setStyle(r.bottom > window.innerHeight * 0.62 ? { left, bottom: above, width } : { left, top: below, width });
  }, [big]);
  const hide = useCallback(() => setStyle(null), []);
  const onPointerEnter = useCallback((e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === 'mouse') show();
  }, [show]);
  const onPointerLeave = useCallback((e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === 'mouse') hide();
  }, [hide]);
  const onClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    show();
  }, [show]);
  useEffect(() => {
    if (!style) return undefined;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) hide(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', hide, true); };
  }, [style, hide]);
  return (
    <span className={`help ${big ? 'big' : ''}`} ref={wrap}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}>
      <button type="button" className="help-btn" aria-label={`What is this: ${title}`} aria-expanded={!!style}
        onClick={onClick} onFocus={show} onBlur={hide}>!</button>
      {style && createPortal(<span role="tooltip" className={`help-pop ${big ? 'big' : ''}`} style={style}><strong>{title}</strong><span>{children}</span></span>, document.body)}
    </span>
  );
}
