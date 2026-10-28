"use client";
import { useEffect, useRef, useState } from "react";
import { THEMES, DEFAULT_THEME, THEME_KEY, THEME_EVENT, applyTheme, setTheme } from "@/lib/themes";

export default function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(DEFAULT_THEME);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch {}
    const key = saved && THEMES[saved] ? saved : DEFAULT_THEME;
    setActive(key);
    applyTheme(key);
    const sync = (e: Event) => setActive((e as CustomEvent<string>).detail);
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close as EventListener);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close as EventListener);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  const pick = (k: string) => {
    setTheme(k); // applies, saves, and notifies the other picker (splash <-> header)
    setOpen(false);
  };

  return (
    <div className="theme-wrap" ref={wrap}>
      <button type="button" className="theme-dot-btn" aria-label="تغيير السمة" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="theme-dot-ring" />
      </button>
      {open && (
        <div className="theme-popup" role="menu">
          <div className="theme-popup-header">🎨 اختر السمة</div>
          <div className="theme-grid">
            {Object.entries(THEMES).map(([k, t]) => (
              <button key={k} type="button" role="menuitemradio" aria-checked={k === active}
                className={`theme-card${k === active ? " active" : ""}`} onClick={() => pick(k)}>
                <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accent2})` }} />
                <span>{t.emoji} {t.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
