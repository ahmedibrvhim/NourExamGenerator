// Checks that a written chemical equation is balanced (same atoms on both sides).
// Returns true (balanced), false (clearly unbalanced) or null (cannot be parsed -> do not judge).
const SUB: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };

function parseFormula(f: string): Record<string, number> | null {
  let i = 0;
  const group = (): Record<string, number> | null => {
    const out: Record<string, number> = {};
    while (i < f.length) {
      const ch = f[i];
      if (ch === "(" || ch === "[") {
        i++;
        const inner = group();
        if (!inner || (f[i] !== ")" && f[i] !== "]")) return null;
        i++;
        let n = ""; while (i < f.length && /\d/.test(f[i])) n += f[i++];
        const m = n ? parseInt(n) : 1;
        for (const [k, v] of Object.entries(inner)) out[k] = (out[k] ?? 0) + v * m;
      } else if (ch === ")" || ch === "]") return out;
      else if (/[A-Z]/.test(ch)) {
        let el = ch; i++;
        if (i < f.length && /[a-z]/.test(f[i])) el += f[i++];
        let n = ""; while (i < f.length && /\d/.test(f[i])) n += f[i++];
        out[el] = (out[el] ?? 0) + (n ? parseInt(n) : 1);
      } else return null;
    }
    return out;
  };
  const r = group();
  return r && i === f.length && Object.keys(r).length ? r : null;
}

export function balanceCheck(eq: string): boolean | null {
  let s = eq.replace(/[₀-₉]/g, (c) => SUB[c]).replace(/\((?:g|s|l|aq)\)/gi, "").replace(/[\u200E\u200F\u202A-\u202E]/g, "");
  s = s.replace(/[⟶⟹]/g, "→").replace(/->/g, "→").replace(/[⇌⇄]/g, "→").replace(/\s*=\s*/g, "→");
  const parts = s.split("→");
  if (parts.length !== 2) return null;
  const side = (t: string): Record<string, number> | null => {
    const tot: Record<string, number> = {};
    for (const raw of t.split("+")) {
      const term = raw.replace(/\s+/g, "");
      if (!term) return null;
      const m = term.match(/^(\d+)?(.+)$/);
      if (!m) return null;
      const f = parseFormula(m[2]);
      if (!f) return null;
      const k = m[1] ? parseInt(m[1]) : 1;
      for (const [el, n] of Object.entries(f)) tot[el] = (tot[el] ?? 0) + n * k;
    }
    return tot;
  };
  const a = side(parts[0]), b = side(parts[1]);
  if (!a || !b) return null;
  const els = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const e of els) if ((a[e] ?? 0) !== (b[e] ?? 0)) return false;
  return true;
}
