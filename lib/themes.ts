// Same palettes as the CenterApp theme engine (main.html), so both apps look alike.
export type Theme = {
  label: string; emoji: string;
  bg: string; bg1: string; bg2: string;
  accent: string; accent2: string; rgb: string;
  logoA: string; logoB: string;
};

export const THEMES: Record<string, Theme> = {
  midnight: { label: "Midnight", emoji: "🌙", bg: "#05080f", bg1: "#090e1c", bg2: "#0e1528", accent: "#6366f1", accent2: "#8b5cf6", rgb: "99,102,241", logoA: "#818cf8", logoB: "#c084fc" },
  crimson:  { label: "Crimson",  emoji: "🔴", bg: "#0f0508", bg1: "#1a0810", bg2: "#200c14", accent: "#f43f5e", accent2: "#fb7185", rgb: "244,63,94",  logoA: "#fb7185", logoB: "#fda4af" },
  forest:   { label: "Forest",   emoji: "🌿", bg: "#040d08", bg1: "#071410", bg2: "#0a1c15", accent: "#10b981", accent2: "#34d399", rgb: "16,185,129", logoA: "#34d399", logoB: "#6ee7b7" },
  ocean:    { label: "Ocean",    emoji: "🌊", bg: "#030c12", bg1: "#061420", bg2: "#091b2a", accent: "#0ea5e9", accent2: "#38bdf8", rgb: "14,165,233", logoA: "#38bdf8", logoB: "#7dd3fc" },
  amber:    { label: "Amber",    emoji: "🔥", bg: "#0d0800", bg1: "#180f00", bg2: "#1f1400", accent: "#f59e0b", accent2: "#fbbf24", rgb: "245,158,11", logoA: "#fcd34d", logoB: "#fb923c" },
  rose:     { label: "Rose",     emoji: "🌸", bg: "#0f050c", bg1: "#1a0916", bg2: "#210d1c", accent: "#e879f9", accent2: "#f0abfc", rgb: "232,121,249", logoA: "#f0abfc", logoB: "#e879f9" },
  slate:    { label: "Slate",    emoji: "🩶", bg: "#060809", bg1: "#0d1117", bg2: "#141a22", accent: "#94a3b8", accent2: "#cbd5e1", rgb: "148,163,184", logoA: "#cbd5e1", logoB: "#94a3b8" },
  gold:     { label: "Gold",     emoji: "👑", bg: "#0a0800", bg1: "#130f00", bg2: "#1a1400", accent: "#eab308", accent2: "#ca8a04", rgb: "234,179,8",  logoA: "#fde047", logoB: "#eab308" },
};

export const DEFAULT_THEME = "ocean";

export function applyTheme(key: string) {
  const t = THEMES[key];
  if (!t) return;
  const s = document.documentElement.style;
  s.setProperty("--bg", t.bg);
  s.setProperty("--bg-1", t.bg1);
  s.setProperty("--bg-2", t.bg2);
  s.setProperty("--accent", t.accent);
  s.setProperty("--accent-2", t.accent2);
  s.setProperty("--accent-rgb", t.rgb);
  s.setProperty("--logo-a", t.logoA);
  s.setProperty("--logo-b", t.logoB);
  // phone browser bar / installed-app title bar follows the theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg);
}

export const THEME_KEY = "centerapp-exams-theme";
export const THEME_EVENT = "centerapp-theme-change";

// Applies + saves a theme and tells every ThemePicker on the page (splash and header) so they stay in sync.
export function setTheme(key: string) {
  if (!THEMES[key]) return;
  applyTheme(key);
  try { localStorage.setItem(THEME_KEY, key); } catch {}
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: key }));
}

// Inline script run in <head> before first paint, so the saved theme shows with no colour flash.
export function themeBootScript(): string {
  const small: Record<string, Record<string, string>> = {};
  for (const [k, t] of Object.entries(THEMES)) {
    small[k] = { "--bg": t.bg, "--bg-1": t.bg1, "--bg-2": t.bg2, "--accent": t.accent, "--accent-2": t.accent2, "--accent-rgb": t.rgb, "--logo-a": t.logoA, "--logo-b": t.logoB };
  }
  return `try{var T=${JSON.stringify(small)},d=document.documentElement,k=localStorage.getItem(${JSON.stringify(THEME_KEY)});` +
    `var t=T[k]||T[${JSON.stringify(DEFAULT_THEME)}];for(var p in t)d.style.setProperty(p,t[p]);` +
    `if(sessionStorage.getItem("centerapp-splash-seen"))d.setAttribute("data-splash","done")}catch(e){}`;
}
