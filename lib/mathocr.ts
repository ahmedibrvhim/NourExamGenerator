// Local math reader (no AI, no network). Tesseract reads a line of text well but cannot read STACKED math:
//   - a fraction (numerator / bar / denominator) is split into separate lines,
//   - a square root sign is dropped or read as "~", "(", "v".
// This module looks at the page picture itself: it finds fraction bars and radical signs by their shape,
// reads the numerator / denominator / radicand each as its own small picture, erases the structure from the page,
// lets Tesseract read the rest, and puts the structures back at the right place in the text.
//
// Output notation (the exam sheet draws it as real stacked fractions and roots, see mathHtml in exam.ts):
//   fraction  (a)/(b)   or  a/b when both sides are one simple token      e.g.  3/4   (2x + 1)/(x - 3)
//   root      √(x + 4)  or  √25 when the radicand is one simple token      cube root:  ³√(27)
//   power     x²  (superscript digits)  or  x^n
// This file has no imports so it can be tested in Node as well as in the browser.

export type Gray = { data: Uint8Array | Uint8ClampedArray; w: number; h: number };
export type Box = { x0: number; y0: number; x1: number; y1: number }; // inclusive pixel box
export type Sym = { text: string; bbox: Box };
export type Word = { text: string; bbox: Box; symbols?: Sym[]; conf?: number };
export type Line = { text: string; bbox: Box; words: Word[]; conf?: number };
// recognize(): "page" = normal page/paragraph reading, "line" = the picture is ONE line of text.
export type Engine = { recognize(g: Gray, mode: "page" | "line", whitelist?: string): Promise<Line[]> };

// characters allowed when reading a small crop (numerator, denominator, radicand). Capital letters and o / l / i / e / f / g / j are left out on purpose:
// inside a formula they are almost always the digits 4 / 5 / 8 / 0 / 1 / 6 / 9 / 7 that the engine confuses them with.
export const MATH_WHITELIST = "0123456789+-−×÷=()<>.,xyzabcdhkmnpqrstuvwπ%";

// ---------------------------------------------------------------- small helpers
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** Arabic-Indic / Persian digits -> English digits (the books use 0-9). */
export function normDigits(t: string): string {
  return t.replace(/[٠-٩۰-۹]/g, (c) => String(AR_DIGITS.includes(c) ? AR_DIGITS.indexOf(c) : FA_DIGITS.indexOf(c))).replace(/٫/g, ".").replace(/٬/g, ",");
}
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const toSup = (s: string) => s.replace(/[0-9]/g, (d) => SUP[+d]);
const isSimple = (s: string) => /^[0-9]+(?:\.[0-9]+)?[a-zA-Z]?$/.test(s) || /^[a-zA-Z]$/.test(s) || /^\.{3,}$/.test(s);
const wrap = (s: string) => (isSimple(s) ? s : `(${s})`);
const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);

function otsu(d: ArrayLike<number>): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i++) hist[d[i]]++;
  const total = d.length; let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

type Blob = { x0: number; y0: number; x1: number; y1: number; area: number };
type Ctx = { w: number; h: number; mask: Uint8Array; ii: Int32Array; th: number; blobs: Blob[] };
const ctxCache = new WeakMap<Gray, Ctx | null>();
const ctxOf = (g: Gray, thHint?: number) => { if (!ctxCache.has(g)) ctxCache.set(g, makeCtx(g, thHint)); return ctxCache.get(g) ?? null; };
function makeCtx(g: Gray, thHint?: number): Ctx | null {
  const { w, h } = g;
  const thr = Math.min(200, Math.max(60, otsu(g.data)));
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = g.data[i] < thr ? 1 : 0;
  // integral image: count ink in any rectangle in O(1)
  const W = w + 1, ii = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += mask[y * w + x]; ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + row; }
  }
  const blobs = components(mask, w, h);
  const th = thHint || textHeight(blobs);
  return th ? { w, h, mask, ii, th, blobs } : null;
}
const cnt = (c: Ctx, x0: number, y0: number, x1: number, y1: number) => {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(c.w - 1, x1); y1 = Math.min(c.h - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = c.w + 1;
  return c.ii[(y1 + 1) * W + x1 + 1] - c.ii[y0 * W + x1 + 1] - c.ii[(y1 + 1) * W + x0] + c.ii[y0 * W + x0];
};

// Connected blobs of ink (8-neighbours).
function components(mask: Uint8Array, w: number, h: number): Blob[] {
  const lab = new Int32Array(w * h), parent: number[] = [0];
  const find = (a: number) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let next = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    let m = 0;
    const nb = [x > 0 ? lab[i - 1] : 0, y > 0 && x > 0 ? lab[i - w - 1] : 0, y > 0 ? lab[i - w] : 0, y > 0 && x < w - 1 ? lab[i - w + 1] : 0];
    for (const l of nb) if (l) { const r = find(l); if (!m) m = r; else if (r !== m) { parent[Math.max(r, m)] = Math.min(r, m); m = Math.min(r, m); } }
    if (!m) { parent.push(next); m = next++; }
    lab[i] = m;
  }
  const box = new Map<number, Blob>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lab[y * w + x]; if (!l) continue;
    const r = find(l), b = box.get(r);
    if (!b) box.set(r, { x0: x, y0: y, x1: x, y1: y, area: 1 }); else { if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; b.area++; }
  }
  return [...box.values()];
}
// Typical character height of the picture (60th percentile of the heights of the blobs that look like characters).
function textHeight(blobs: Blob[]): number {
  const hs: number[] = [];
  for (const b of blobs) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    if (b.area >= 15 && bh >= 8 && bh <= 160 && bw <= bh * 2.5) hs.push(bh);
  }
  if (hs.length < 6) return 0;
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length * 0.6)];
}

// ---------------------------------------------------------------- finding horizontal bars (fraction bars, root overlines)
type Bar = { x0: number; x1: number; y0: number; y1: number };
function findBars(c: Ctx): Bar[] {
  const { w, h, mask, th } = c;
  const minL = Math.max(8, Math.round(0.4 * th)), maxT = Math.max(3, Math.round(0.26 * th)), gapOk = 2;
  let active: (Bar & { hit: boolean })[] = [];
  const done: Bar[] = [];
  for (let y = 0; y < h; y++) {
    const runs: [number, number][] = [];
    let s = -1, blank = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && mask[y * w + x] === 1;
      if (on) { if (s < 0) s = x; blank = 0; }
      else if (s >= 0) {
        blank++;
        if (x >= w || blank > gapOk) { const e = x - blank; if (e - s + 1 >= minL) runs.push([s, e]); s = -1; blank = 0; }
      }
    }
    const nextActive: (Bar & { hit: boolean })[] = [];
    for (const [a, b] of runs) {
      let m: (Bar & { hit: boolean }) | undefined;
      for (const bar of active) {
        if (bar.hit) continue;
        const ov = Math.min(b, bar.x1) - Math.max(a, bar.x0) + 1;
        if (ov >= 0.7 * Math.min(b - a + 1, bar.x1 - bar.x0 + 1)) { m = bar; break; }
      }
      if (m) { m.hit = true; m.y1 = y; m.x0 = Math.min(m.x0, a); m.x1 = Math.max(m.x1, b); nextActive.push(m); }
      else nextActive.push({ x0: a, x1: b, y0: y, y1: y, hit: true });
    }
    for (const bar of active) if (!bar.hit && bar.y1 - bar.y0 + 1 <= maxT) done.push({ x0: bar.x0, x1: bar.x1, y0: bar.y0, y1: bar.y1 });
    for (const bar of nextActive) bar.hit = false;
    active = nextActive;
  }
  for (const bar of active) if (bar.y1 - bar.y0 + 1 <= maxT) done.push({ x0: bar.x0, x1: bar.x1, y0: bar.y0, y1: bar.y1 });
  return done;
}

// Looks away from a bar (dir -1 = up, +1 = down) for the ink that touches it: the numerator / denominator / radicand.
type Side = { y0: number; y1: number; x0: number; x1: number; gap: number; h: number };
function side(c: Ctx, cx0: number, cx1: number, from: number, dir: 1 | -1, maxExt: number): Side | null {
  const th = c.th, maxGap = Math.round(0.8 * th), joinGap = Math.round(0.3 * th);
  let y = from, blank = 0, first = -1, last = -1;
  for (let k = 0; k < maxGap + maxExt; k++, y += dir) {
    if (y < 0 || y >= c.h) break;
    const has = cnt(c, cx0, y, cx1, y) > 0;
    if (first < 0) { if (has) { first = last = y; } else if (k >= maxGap) break; }
    else if (has) { last = y; blank = 0; }
    else if (++blank > joinGap) break;
    if (first >= 0 && Math.abs(last - first) >= maxExt) break;
  }
  if (first < 0) return null;
  const ya = Math.min(first, last), yb = Math.max(first, last);
  let xa = cx1, xb = cx0;
  for (let x = cx0; x <= cx1; x++) if (cnt(c, x, ya, x, yb) > 0) { if (x < xa) xa = x; xb = x; }
  return { y0: ya, y1: yb, x0: xa, x1: xb, gap: Math.abs(first - from), h: yb - ya + 1 };
}

// a side that holds only a row of small dots ("......"): a blank the student has to fill in
function dotted(c: Ctx, sd: Side): boolean {
  const dots = c.blobs.filter((b) => b.x0 >= sd.x0 - 1 && b.x1 <= sd.x1 + 1 && b.y0 >= sd.y0 - 1 && b.y1 <= sd.y1 + 1);
  if (dots.length < 4) return false;
  return dots.every((b) => b.y1 - b.y0 + 1 <= 0.3 * c.th && b.x1 - b.x0 + 1 <= 0.3 * c.th);
}

export type Structure = {
  kind: "frac" | "root" | "pow" | "div" | "eq";
  th: number;     // typical character height of the picture (passed down when the parts are read)
  box: Box;       // erased from the page before the normal reading
  xMid: number; yMid: number;   // where it sits on the page (to put the result back in the right line)
  parts: Box[];   // crops that are read separately: frac = [numerator, denominator], root = [radicand], pow = [exponent]
  index?: Box;    // root index (the small 3 of a cube root)
  blank?: boolean[]; // frac: which part is a dotted blank ("......")
};

const inside = (a: Box, b: Box) => a.x0 >= b.x0 - 2 && a.x1 <= b.x1 + 2 && a.y0 >= b.y0 - 2 && a.y1 <= b.y1 + 2;

export function findStructures(g: Gray, thHint?: number): Structure[] {
  const c = ctxOf(g, thHint);
  if (!c) return [];
  const { th, w, h } = c;
  const bars = findBars(c);
  const out: Structure[] = [];
  const m = Math.max(2, Math.round(0.15 * th));

  // ---- equals sign: two short parallel bars, close together, nothing between them (Tesseract drops it in sparse rows)
  const consumed = new Set<Bar>();
  for (const a of bars) {
    const aw = a.x1 - a.x0 + 1;
    if (consumed.has(a) || aw < 0.3 * th || aw > 1.3 * th || a.y1 - a.y0 + 1 > Math.max(3, 0.18 * th)) continue;
    const b = bars.find((q) => q !== a && !consumed.has(q) && q.y0 > a.y1 && q.y0 - a.y1 - 1 >= 0.08 * th && q.y0 - a.y1 - 1 <= 0.42 * th &&
      Math.abs((q.x1 - q.x0) - (a.x1 - a.x0)) <= 0.3 * aw && Math.abs(q.x0 - a.x0) <= 0.25 * aw && q.y1 - q.y0 + 1 <= Math.max(3, 0.18 * th));
    if (!b) continue;
    // between the two bars only a stray tail in the MIDDLE is allowed (the "?" written above an "="). A letter (e, a, s, E) has ink at its edges there.
    const gy0 = a.y1 + 1, gy1 = b.y0 - 1, edge = Math.max(2, Math.round(0.28 * aw));
    if (cnt(c, a.x0, gy0, a.x0 + edge, gy1) + cnt(c, a.x1 - edge, gy0, a.x1, gy1) > 0 || cnt(c, a.x0, gy0, a.x1, gy1) > 0.25 * aw * (gy1 - gy0 + 1)) continue;
    if (cnt(c, a.x0, a.y0 - Math.round(0.1 * th), a.x1, a.y0 - 2) > 0.5 * aw && cnt(c, a.x0, b.y1 + 2, a.x1, b.y1 + Math.round(0.1 * th)) > 0.5 * aw) continue; // glued above and below: part of a letter / table
    consumed.add(a); consumed.add(b);
    out.push({ kind: "eq", th, xMid: (a.x0 + a.x1) / 2, yMid: (a.y0 + b.y1) / 2, box: { x0: Math.min(a.x0, b.x0) - 2, y0: a.y0 - 2, x1: Math.max(a.x1, b.x1) + 2, y1: b.y1 + 2 }, parts: [] });
  }

  for (const bar of bars) {
    if (consumed.has(bar)) continue;
    const bw = bar.x1 - bar.x0 + 1, bt = bar.y1 - bar.y0 + 1;
    if (bw > 9 * th || bw > w * 0.45) continue;

    // ---- division sign ÷ : a short bar with ONE small dot right above and ONE right below (Tesseract reads it as "+")
    if (bw >= 0.3 * th && bw <= 0.95 * th && bt <= Math.max(3, 0.2 * th)) {
      const cx = (bar.x0 + bar.x1) / 2, dots = c.blobs.filter((d) => {
        const dw = d.x1 - d.x0 + 1, dh = d.y1 - d.y0 + 1;
        return d.area >= 6 && dw <= 0.32 * th && dh <= 0.32 * th && dw >= 2 && dh >= 2 && Math.abs((d.x0 + d.x1) / 2 - cx) <= 0.2 * th;
      });
      const above = dots.find((d) => bar.y0 - d.y1 >= 1 && bar.y0 - d.y1 <= 0.4 * th), below = dots.find((d) => d.y0 - bar.y1 >= 1 && d.y0 - bar.y1 <= 0.4 * th);
      if (above && below && cnt(c, bar.x0 - 3, above.y0 - Math.round(0.3 * th), bar.x1 + 3, above.y0 - 2) === 0 && cnt(c, bar.x0 - 3, below.y1 + 2, bar.x1 + 3, below.y1 + Math.round(0.3 * th)) === 0) {
        out.push({ kind: "div", th, xMid: cx, yMid: (bar.y0 + bar.y1) / 2, box: { x0: bar.x0 - 2, y0: above.y0 - 2, x1: bar.x1 + 2, y1: below.y1 + 2 }, parts: [] });
        continue;
      }
    }

    // ---- fraction: a thin clean bar with a numerator right above and a denominator right below
    if (bw >= 0.7 * th && bt <= Math.max(3, 0.22 * th)) fraction: {
      const mid0 = bar.x0 + Math.round(bw * 0.15), mid1 = bar.x1 - Math.round(bw * 0.15);
      const dirty = cnt(c, mid0, bar.y0 - 2, mid1, bar.y0 - 2) + cnt(c, mid0, bar.y1 + 2, mid1, bar.y1 + 2);
      if (dirty > (mid1 - mid0 + 1) * 0.8) break fraction;         // glued to text on both sides: not a clean bar
      const cx0 = bar.x0 - m, cx1 = bar.x1 + m, ext = Math.round(1.5 * th);
      const halo = 3;   // a blurred scan has a 1-2 px grey halo around the bar: start looking past it
      const up = side(c, cx0, cx1, bar.y0 - halo, -1, ext), dn = side(c, cx0, cx1, bar.y1 + halo, 1, ext);
      if (!up || !dn) break fraction;
      const blankUp = dotted(c, up), blankDn = dotted(c, dn);                       // "......" : a blank to fill in
      if ((up.h < 0.5 * th && !blankUp) || (dn.h < 0.5 * th && !blankDn)) break fraction;   // too small to be digits: a "=" sign, a dot, Arabic dots
      if (blankUp && blankDn) break fraction;
      if (up.x1 - up.x0 + 1 < 0.15 * bw || dn.x1 - dn.x0 + 1 < 0.15 * bw) break fraction;
      const upW = up.x1 - up.x0 + 1, dnW = dn.x1 - dn.x0 + 1;
      if (!blankUp && !blankDn && upW <= 2 * bt + 2 && dnW <= 2 * bt + 2) break fraction;     // thin vertical strokes above AND below = a "+" sign
      if (!blankUp && !blankDn && upW <= 3 * bt + 2 && dnW <= 3 * bt + 2 && Math.abs(up.h - dn.h) <= 0.3 * Math.max(up.h, dn.h) && Math.abs(bw - (up.h + dn.h + bt)) <= 0.35 * bw) break fraction; // blurred "+"
      const bc = (bar.x0 + bar.x1) / 2, off = 0.35 * bw + 0.3 * th;
      if (Math.abs((up.x0 + up.x1) / 2 - bc) > off || Math.abs((dn.x0 + dn.x1) / 2 - bc) > off) break fraction; // not centred on the bar
      // text that runs on past both ends of the bar = an underline or a dash inside a sentence
      const runsOn = (s: Side) => cnt(c, cx0 - 3, s.y0, cx0 - 1, s.y1) > 0 && cnt(c, cx1 + 1, s.y0, cx1 + 3, s.y1) > 0;
      if (runsOn(up) || runsOn(dn)) break fraction;
      // table line: vertical lines cross the bar at both ends
      const vl = Math.round(0.45 * th);   // a letter's crossbar (e, B, H, A) or a table line: strokes go up AND down at BOTH ends
      const crossEnd = (x: number) => cnt(c, x - 1, bar.y0 - vl, x + 1, bar.y0 - 1) >= 3 && cnt(c, x - 1, bar.y1 + 1, x + 1, bar.y1 + vl) >= 3;
      if (crossEnd(bar.x0) && crossEnd(bar.x1)) break fraction;
      const x0 = Math.min(bar.x0, up.x0, dn.x0) - 2, x1 = Math.max(bar.x1, up.x1, dn.x1) + 2;
      out.push({
        kind: "frac", th, xMid: (bar.x0 + bar.x1) / 2, yMid: (bar.y0 + bar.y1) / 2,
        box: { x0, y0: up.y0 - 2, x1, y1: dn.y1 + 2 },
        parts: [{ x0, y0: up.y0 - 1, x1, y1: up.y1 + 1 }, { x0, y0: dn.y0 - 1, x1, y1: dn.y1 + 1 }], blank: [blankUp, blankDn],
      });
      continue;
    }

    // ---- square root: an overline with nothing above it, the radicand below it, and the "check" stroke joined to its left end
    if (bw >= 0.55 * th && bt <= Math.max(3, 0.28 * th)) {
      if (cnt(c, bar.x0, bar.y0 - Math.round(0.35 * th), bar.x1, bar.y0 - 3) > 0.15 * bw) continue; // something sits above: not an overline
      const under = cnt(c, bar.x0 + 2, bar.y1 + 3, bar.x1, bar.y1 + Math.round(0.8 * th));
      if (under < 0.25 * th) continue;                                                        // nothing under it: a dash, not a root
      // flood fill from the bar to find the check stroke
      const wx0 = Math.max(0, bar.x0 - Math.round(1.1 * th)), wx1 = Math.min(w - 1, bar.x1 + Math.round(0.3 * th));
      const wy0 = Math.max(0, bar.y0 - Math.round(0.3 * th)), wy1 = Math.min(h - 1, bar.y1 + Math.round(1.7 * th));
      const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, seen = new Uint8Array(ww * wh);
      const seedX = bar.x0 + 1, seedY = Math.round((bar.y0 + bar.y1) / 2);
      if (!c.mask[seedY * w + seedX]) continue;
      const stack = [seedX, seedY]; seen[(seedY - wy0) * ww + (seedX - wx0)] = 1;
      let vx0 = seedX, vy1 = seedY, tipX = seedX, n = 0;
      const limX = bar.x0 + 1;   // the check stroke lies left of the overline's start
      while (stack.length) {
        const y = stack.pop() as number, x = stack.pop() as number; n++;
        if (x <= limX) { if (x < vx0) vx0 = x; if (y > vy1) { vy1 = y; tipX = x; } }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
          const k = (ny - wy0) * ww + (nx - wx0);
          if (seen[k] || !c.mask[ny * w + nx]) continue;
          seen[k] = 1; stack.push(nx, ny);
        }
      }
      if (vx0 > bar.x0 - 0.2 * th) continue;       // no check stroke on the left
      if (vy1 < bar.y1 + 0.7 * th) continue;       // the check stroke does not reach down
      // the long stroke of the radical is a straight diagonal from the tip of the "V" up to the left end of the overline.
      // (Arabic letters have bars and hooks too, but not a straight diagonal in exactly this place.)
      if (bar.x0 - tipX < 0.1 * th) continue;
      let onLine = 0; const N = 12;
      for (let k = 1; k <= N; k++) {
        const t = k / (N + 1), px = Math.round(tipX + (bar.x0 - tipX) * t), py = Math.round(vy1 + (bar.y1 - vy1) * t);
        if (cnt(c, px - 2, py, px + 2, py) > 0) onLine++;
      }
      if (onLine < N * 0.8) continue;
      // the radicand: below the overline, to the right of the stroke
      const rad = side(c, bar.x0 + 3, bar.x1, bar.y1 + 3, 1, Math.round(1.4 * th));
      // the radicand must sit mostly under the overline
      if (!rad || rad.h < 0.4 * th || rad.x1 - rad.x0 + 1 < 0.45 * bw || rad.x0 < bar.x0 - 0.1 * th) continue;
      const radY1 = Math.max(vy1, rad.y1) + Math.round(0.15 * th);
      // index (small digit above the left tick): ink in that corner that is not part of the root itself
      let ix0 = 1e9, iy0 = 1e9, ix1 = -1, iy1 = -1, ic = 0;
      for (let y = Math.max(0, bar.y0 - Math.round(0.45 * th)); y <= Math.min(h - 1, bar.y0 + Math.round(0.5 * th)); y++) {
        for (let x = Math.max(0, vx0 - Math.round(0.8 * th)); x <= Math.max(0, bar.x0 - 2); x++) {
          if (!c.mask[y * w + x]) continue;
          if (x >= wx0 && y >= wy0 && y <= wy1 && seen[(y - wy0) * ww + (x - wx0)]) continue;
          ic++; if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
        }
      }
      const index = ic >= 0.1 * th * th * 0.2 && ix1 - ix0 >= 2 && iy1 - iy0 >= 0.2 * th && iy1 - iy0 <= 0.8 * th ? { x0: ix0 - 2, y0: iy0 - 2, x1: ix1 + 2, y1: iy1 + 2 } : undefined;
      out.push({
        kind: "root", th, xMid: (bar.x0 + bar.x1) / 2, yMid: (bar.y1 + radY1) / 2,
        box: { x0: Math.min(vx0, index?.x0 ?? vx0) - 2, y0: Math.min(bar.y0, index?.y0 ?? bar.y0) - 2, x1: bar.x1 + 2, y1: radY1 + 2 },
        parts: [{ x0: bar.x0 + 3, y0: bar.y1 + 1, x1: bar.x1 + 1, y1: radY1 }],
        index,
      });
    }
  }

  // ---- power: a small blob (or a few) raised at the upper right of a full-size character:  x²  cm²  5³  10⁻²
  const small = c.blobs.filter((b) => { const bh = b.y1 - b.y0 + 1, bw = b.x1 - b.x0 + 1; return b.area >= 10 && bh >= 0.28 * th && bh <= 0.68 * th && bw <= th; }).sort((a, b) => a.x0 - b.x0);
  const used = new Set<Blob>();
  for (const first of small) {
    if (used.has(first)) continue;
    let C = { ...first }; used.add(first);
    for (const nb of small) if (!used.has(nb) && nb.x0 - C.x1 <= 0.3 * th && nb.x0 >= C.x0 && Math.abs((nb.y0 + nb.y1) / 2 - (C.y0 + C.y1) / 2) <= 0.3 * th) { used.add(nb); C = { x0: C.x0, y0: Math.min(C.y0, nb.y0), x1: Math.max(C.x1, nb.x1), y1: Math.max(C.y1, nb.y1), area: C.area + nb.area }; }
    let base: Blob | undefined;
    for (const b of c.blobs) {
      const bh = b.y1 - b.y0 + 1, gap = C.x0 - b.x1;
      if (b === first || bh < 0.45 * th || bh > 1.6 * th || b.area < 20 || gap < -0.1 * th || gap > 0.3 * th) continue;
      if (C.y1 > b.y0 + 0.65 * bh || C.y0 > b.y0 + 0.2 * bh || C.y0 < b.y0 - 0.8 * th) continue;   // must sit in the upper part of the base
      if (!base || gap < C.x0 - base.x1) base = b;
    }
    if (!base) continue;
    out.push({ kind: "pow", th, xMid: (C.x0 + C.x1) / 2, yMid: (base.y0 + base.y1) / 2, box: { x0: C.x0 - 2, y0: C.y0 - 2, x1: C.x1 + 2, y1: C.y1 + 2 }, parts: [{ x0: C.x0 - 3, y0: C.y0 - 3, x1: C.x1 + 3, y1: C.y1 + 3 }] });
  }

  // the outermost structure wins; the inner ones are found again when its parts are read
  const uniq = out.filter((a, i) => !out.some((b, j) => j !== i && inside(a.box, b.box) && (!inside(b.box, a.box) || j < i)));
  return uniq.map((s) => ({ ...s, box: { x0: Math.max(0, s.box.x0), y0: Math.max(0, s.box.y0), x1: Math.min(w - 1, s.box.x1), y1: Math.min(h - 1, s.box.y1) } }));
}

// ---------------------------------------------------------------- decimal points
// Tesseract often drops the tiny dot of "1.5" and returns "15". When two digits sit next to each other and a small square dot
// lies between them at the baseline, the dot is put back.
function addDecimals(lines: Line[], g: Gray, thHint?: number): Line[] {
  const c = ctxOf(g, thHint);
  if (!c) return lines;
  const th = c.th;
  const dots = c.blobs.filter((b) => { const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1; return b.area >= 6 && w >= 2 && h >= 2 && w <= 0.3 * th && h <= 0.3 * th && w / h <= 2.2 && h / w <= 2.2; });
  if (!dots.length) return lines;
  const dg = /^[0-9٠-٩]$/;
  for (const l of lines) for (const wd of l.words) {
    const sy = wd.symbols;
    if (!sy || sy.length < 2) continue;
    const out: Sym[] = [];
    for (let i = 0; i < sy.length; i++) {
      out.push(sy[i]);
      const a = sy[i], b = sy[i + 1];
      if (!b || !dg.test(a.text) || !dg.test(b.text)) continue;
      const gap = b.bbox.x0 - a.bbox.x1;
      if (gap < 2 || gap > 0.6 * th) continue;
      const base = Math.max(a.bbox.y1, b.bbox.y1);
      const d = dots.find((d) => d.x0 >= a.bbox.x1 - 2 && d.x1 <= b.bbox.x0 + 0.25 * th && d.y1 >= base - 0.25 * th && d.y1 <= base + 0.15 * th);
      if (d) out.push({ text: ".", bbox: { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 } });
    }
    if (out.length !== sy.length) { wd.symbols = out; wd.text = out.map((x) => x.text).join(""); }
  }
  return lines;
}

// ---------------------------------------------------------------- picture helpers
export function crop(g: Gray, b: Box, pad = 14): Gray {
  const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(g.w - 1, b.x1), y1 = Math.min(g.h - 1, b.y1);
  const cw = Math.max(1, x1 - x0 + 1), ch = Math.max(1, y1 - y0 + 1), W = cw + pad * 2, H = ch + pad * 2;
  const data = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) data[(y + pad) * W + x + pad] = g.data[(y0 + y) * g.w + x0 + x];
  return { data, w: W, h: H };
}
function erase(g: Gray, boxes: Box[]): Gray {
  const data = new Uint8Array(g.data); // copy
  for (const b of boxes) for (let y = Math.max(0, b.y0); y <= Math.min(g.h - 1, b.y1); y++) data.fill(255, y * g.w + Math.max(0, b.x0), y * g.w + Math.min(g.w - 1, b.x1) + 1);
  return { data, w: g.w, h: g.h };
}

// ---------------------------------------------------------------- Tesseract output -> Line[]
/** Reads lines, words and symbols (with boxes) out of a tesseract.js result (v5: data.blocks, or data.lines). */
export function linesFrom(data: any): Line[] {
  const bb = (b: any): Box => ({ x0: b?.x0 ?? 0, y0: b?.y0 ?? 0, x1: b?.x1 ?? 0, y1: b?.y1 ?? 0 });
  const raw: any[] = data?.lines?.length ? data.lines
    : (data?.blocks ?? []).flatMap((bl: any) => (bl.paragraphs ?? []).flatMap((p: any) => p.lines ?? []));
  const lines: Line[] = raw.map((l: any) => ({
    text: String(l.text ?? "").replace(/\s+$/, ""), bbox: bb(l.bbox),
    conf: typeof l.confidence === "number" ? l.confidence : undefined,
    words: (l.words ?? []).map((w: any) => ({ text: String(w.text ?? ""), bbox: bb(w.bbox), conf: typeof w.confidence === "number" ? w.confidence : undefined, symbols: (w.symbols ?? []).map((s: any) => ({ text: String(s.text ?? ""), bbox: bb(s.bbox) })) })),
  }));
  if (!lines.length && data?.text) return String(data.text).split("\n").filter((t: string) => t.trim()).map((t: string, i: number) => ({ text: t, bbox: { x0: 0, y0: i * 40, x1: 100, y1: i * 40 + 30 }, words: [] }));
  return lines;
}

// Text of a run of symbols, with small raised characters written as powers: x² , x^n
function symbolsText(sy: Sym[], fallback: string): string {
  if (sy.length < 2 || hasArabic(fallback)) return fallback;
  const hs = sy.map((s) => s.bbox.y1 - s.bbox.y0 + 1).sort((a, b) => a - b), ref = hs[Math.floor(hs.length * 0.75)];
  const base = sy.filter((s) => s.bbox.y1 - s.bbox.y0 + 1 >= 0.8 * ref);
  if (!base.length) return fallback;
  const bots = base.map((s) => s.bbox.y1).sort((a, b) => a - b), baseBottom = bots[Math.floor(bots.length / 2)], baseTop = Math.min(...base.map((s) => s.bbox.y0)); // median bottom = the baseline (g, p, y reach below it)
  let out = "", prevRaised = false;
  sy.forEach((s, i) => {
    const sh = s.bbox.y1 - s.bbox.y0 + 1, raised = i > 0 && sh < 0.75 * ref && s.bbox.y1 < baseBottom - 0.25 * ref && s.bbox.y0 <= baseTop + 0.3 * ref && /^[0-9]$/.test(s.text);
    if (raised) out += toSup(s.text);
    else out += s.text;
    prevRaised = raised;
  });
  return out;
}
const wordText = (wd: Word) => symbolsText((wd.symbols ?? []).filter((s) => s.text), wd.text);
// A word cut where there is a wide gap between two symbols (Tesseract sometimes glues "7)" and a far "-" into one word box).
type Seg = { x: number; x1: number; t: string };
function segments(wd: Word): Seg[] {
  const sy = (wd.symbols ?? []).filter((s) => s.text);
  if (sy.length < 2) return [{ x: (wd.bbox.x0 + wd.bbox.x1) / 2, x1: wd.bbox.x1, t: wd.text }];
  const mh = sy.map((s) => s.bbox.y1 - s.bbox.y0 + 1).sort((a, b) => a - b)[Math.floor(sy.length / 2)];
  const out: Seg[] = [];
  let cur: Sym[] = [];
  const flush = () => { if (cur.length) { out.push({ x: (Math.min(...cur.map((s) => s.bbox.x0)) + Math.max(...cur.map((s) => s.bbox.x1))) / 2, x1: Math.max(...cur.map((s) => s.bbox.x1)), t: symbolsText(cur, cur.map((s) => s.text).join("")) }); cur = []; } };
  for (let i = 0; i < sy.length; i++) {
    if (cur.length) { const prev = cur[cur.length - 1], gap = Math.min(Math.abs(sy[i].bbox.x0 - prev.bbox.x1), Math.abs(prev.bbox.x0 - sy[i].bbox.x1)); if (gap > 1.1 * mh) flush(); }
    cur.push(sy[i]);
  }
  flush();
  return out;
}
const isRtl = (ws: Seg[], text: string) => { let d = 0; for (let i = 1; i < ws.length; i++) d += Math.sign(ws[i].x - ws[i - 1].x); return d < 0 || (d === 0 && hasArabic(text)); };
// In a right-to-left line Tesseract lists every word from the right. A run of math inside it (no Arabic letters) is read left-to-right: turn it round.
function renderWords(ws: Seg[], rtl: boolean): string {
  if (!rtl) return ws.map((w) => w.t).join(" ");
  const out: Seg[] = [];
  for (let i = 0; i < ws.length;) {
    if (hasArabic(ws[i].t)) { out.push(ws[i++]); continue; }
    let j = i; while (j < ws.length && !hasArabic(ws[j].t)) j++;
    const run = ws.slice(i, j);
    out.push(...(run.length > 1 && run[0].x > run[run.length - 1].x ? run.reverse() : run));
    i = j;
  }
  return out.map((w) => w.t).join(" ");
}
const lineText = (l: Line) => { if (!l.words.length) return l.text; const ws = l.words.flatMap(segments); return renderWords(ws, isRtl(ws, l.text)); };

// ---------------------------------------------------------------- reading
const MAX_DEPTH = 3;
const MIN_CONF = 40;   // real digits read at 75-96 on the sample pages, Arabic strokes at 0-35
// "strong" = reads like a real term of a formula: numbers, up to three variable letters, + - × ÷ and brackets (no stray words)
const strong = (t: string) => {
  if (/^\.{3,}$/.test(t)) return true;
  const terms = t.replace(/\s/g, "").split(/[+\-−×÷=]/).filter(Boolean);
  return terms.length > 0 && terms.every((x) => /^\(?(?:[0-9]+(?:\.[0-9]+)?[a-z]{0,2}|[a-z]{1,3})\)?$/i.test(x));
};
// a numerator / denominator / radicand must look like math: digits, one or a few variables, operators, brackets
const plausible = (t: string) => /^[0-9a-zA-Zπ.,+\-−×÷=()<>%\s]+$/.test(t) && /[0-9a-zA-Z]/.test(t) && t.replace(/\s/g, "").length <= 14 && !/[a-zA-Z]\s+[a-zA-Z]/.test(t) && !/[0-9]\s+[a-zA-Z]{2,}/.test(t);

function upscale2(g: Gray): Gray {
  const w = g.w * 2, h = g.h * 2, data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.h - 1, (y - 0.5) / 2), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(g.h - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.w - 1, (x - 0.5) / 2), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(g.w - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const a = g.data[y0 * g.w + x0], b = g.data[y0 * g.w + x1], c = g.data[y1 * g.w + x0], d = g.data[y1 * g.w + x1];
      data[y * w + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return { data, w, h };
}

// reads a small crop at double size (more pixels per stroke = fewer 4/A, 1/7, x/× mistakes)
async function readUp(en: Engine, g: Gray, depth: number, th: number): Promise<Read> {
  const up = upscale2(g), r = await readMathEx(en, up, depth, "line", th * 2);
  return r;
}

async function readStructure(en: Engine, g: Gray, s: Structure, depth: number): Promise<string | null> {
  const dbg = (t: string | null, conf: number) => { if ((globalThis as any).process?.env?.MDBG) console.error("STRUCT", s.kind, Math.round(s.xMid), Math.round(s.yMid), JSON.stringify(t), "conf", Math.round(conf)); };
  if (s.kind === "div") return " ÷ ";
  if (s.kind === "eq") return " = ";
  if (s.kind === "pow") {
    const r = await en.recognize(upscale2(crop(g, s.parts[0], 8)), "line", "0123456789n");
    const t = r.map((l) => l.text).join("").replace(/[^0-9n]/g, "").slice(0, 3);
    dbg(t, minConf(r));
    if (!t || t === "0" || t === "00" || minConf(r) < MIN_CONF) return null;   // "30°": the little circle is a degree sign, not a power of 0
    return /^[0-9]+$/.test(t) ? toSup(t) : t.length === 1 ? "^" + t : null;
  }
  const parts: string[] = []; let conf = 100;
  for (let k = 0; k < s.parts.length; k++) {
    if (s.blank?.[k]) { parts.push("....."); continue; }                      // a row of dots = a blank to fill in
    const p = s.parts[k], small = p.y1 - p.y0 < 1.3 * s.th;                  // small crops read better when enlarged
    const r = small ? await readUp(en, crop(g, p), depth + 1, s.th) : await readMathEx(en, crop(g, p), depth + 1, "line", s.th);
    parts.push(r.text.replace(/\s*\n\s*/g, " ").trim()); conf = Math.min(conf, r.conf);
  }
  if (s.kind === "frac") {
    const [a, b] = parts;
    dbg(`${a} / ${b}`, conf);
    const blank = !!(s.blank?.[0] || s.blank?.[1]);
    if (!plausible(a) || !plausible(b) || (conf < MIN_CONF && !(strong(a) && strong(b)) && !blank)) return null;      // not a fraction: Arabic letters, dots and strokes read as noise
    return ` ${wrap(a)}/${wrap(b)} `;
  }
  let idx = "";
  if (s.index) {
    const r = await en.recognize(crop(g, s.index, 10), "line", "0123456789");
    idx = r.map((l) => l.text).join("").replace(/\D/g, "").slice(0, 2);
  }
  const rad = parts[0];
  dbg(rad, conf);
  if (!plausible(rad) || (conf < MIN_CONF && !strong(rad))) return null;
  return ` ${idx ? toSup(idx) : ""}√${isSimple(rad) ? rad : `(${rad})`} `;
}

/** Reads a picture that may contain math. mode "line" = one line (crops), "page" = a whole page. */
export async function readMath(en: Engine, g: Gray, depth = 0, mode: "page" | "line" = "page", thHint?: number): Promise<string> {
  return (await readMathEx(en, g, depth, mode, thHint)).text;
}
// average confidence of the words, weighted by their length (one stray "+" or "=" must not sink a good reading)
const minConf = (ls: Line[]) => { let n = 0, t = 0; for (const l of ls) for (const w of l.words.length ? l.words : [{ text: l.text, conf: l.conf } as Word]) { const k = Math.max(1, w.text.replace(/\s/g, "").length); n += k; t += (w.conf ?? 100) * k; } return n ? t / n : 0; };
export type Read = { text: string; conf: number };
export async function readMathEx(en: Engine, g: Gray, depth = 0, mode: "page" | "line" = "page", thHint?: number): Promise<Read> {
  let st = depth < MAX_DEPTH ? findStructures(g, thHint) : [];
  const wl = depth > 0 ? MATH_WHITELIST : undefined;
  if (!st.length) {
    let ls = await en.recognize(g, mode, wl);
    if (!ls.length && wl) ls = await en.recognize(g, mode);
    return { text: addDecimals(ls, g, thHint).map(lineText).join("\n"), conf: minConf(ls) };
  }
  let texts: string[] = [];
  const read: (string | null)[] = [];
  for (const s of st) read.push(await readStructure(en, g, s, depth));
  st = st.filter((_, i) => read[i] !== null); texts = read.filter((t): t is string => t !== null);
  if (!st.length) { const ls = await en.recognize(g, mode, wl); return { text: addDecimals(ls, g, thHint).map(lineText).join("\n"), conf: minConf(ls) }; }
  const lines = addDecimals(await en.recognize(erase(g, st.map((s) => s.box)), mode, wl), g, thHint);
  return { text: merge(lines, st, texts, g.h), conf: minConf(lines) };
}

// Puts each structure's text back into the line it came from, at the right place between the words.
function merge(lines: Line[], st: Structure[], texts: string[], pageH: number): string {
  type Item = { y: number; x0: number; x1: number; words: Seg[]; rtl: boolean; plain?: string; fresh?: boolean };
  const items: Item[] = lines.map((l) => {
    const ws = l.words.flatMap(segments);
    return { y: (l.bbox.y0 + l.bbox.y1) / 2, x0: l.bbox.x0, x1: l.bbox.x1, words: ws, rtl: isRtl(ws, l.text), plain: l.words.length ? undefined : l.text };
  });
  const order = st.map((_, i) => i).sort((a, b) => st[a].xMid - st[b].xMid);
  for (const i of order) {
    const s = st[i], t = texts[i].trim(), tall = s.box.y1 - s.box.y0 + 1;
    // the gap left by the erased structure can make Tesseract cut one row into two lines: join the two halves again
    const row = items.filter((it) => !it.fresh && Math.abs(it.y - s.yMid) <= Math.max(12, tall * 0.55));
    const L = row.filter((it) => it.x1 <= s.xMid + 10).sort((a, b) => b.x1 - a.x1)[0];
    const R = row.filter((it) => it.x0 >= s.xMid - 10).sort((a, b) => a.x0 - b.x0)[0];
    if (L && R && L !== R && !L.plain && !R.plain && R.x0 - L.x1 < tall * 2 + (s.box.x1 - s.box.x0)) {
      const first = items.indexOf(L) < items.indexOf(R) ? L : R;
      const merged: Item = { y: (L.y + R.y) / 2, x0: L.x0, x1: R.x1, rtl: L.rtl, words: L.rtl ? [...R.words, ...L.words] : [...L.words, ...R.words] };
      items.splice(items.indexOf(first), 1, merged);
      items.splice(items.indexOf(first === L ? R : L), 1);
    }
    let best: Item | undefined, bd = 1e9;
    for (const it of items) {
      if (it.fresh || Math.abs(it.y - s.yMid) > Math.max(12, tall * 0.55)) continue;
      const dx = s.xMid < it.x0 ? it.x0 - s.xMid : s.xMid > it.x1 ? s.xMid - it.x1 : 0;
      if (dx < bd) { bd = dx; best = it; }
    }
    const reach = Math.max(tall * 3, s.th * 6);
    if (best && bd < reach && !best.plain && s.kind === "pow") {
      // a power sticks to the character on its left (no space): x + ² -> x²
      const th = s.th, left = best.words.filter((w) => w.x1 <= s.box.x0 + 0.3 * th && s.box.x0 - w.x1 < 0.6 * th).sort((a, b) => b.x1 - a.x1)[0];
      if (left) left.t += t; else best.words.push({ x: s.xMid, x1: s.box.x1, t });
      best.x0 = Math.min(best.x0, s.box.x0); best.x1 = Math.max(best.x1, s.box.x1);
    } else if (best && bd < reach && !best.plain) {
      const ws = best.words; let pos = ws.length;
      for (let k = 0; k < ws.length; k++) if (best.rtl ? ws[k].x < s.xMid : ws[k].x > s.xMid) { pos = k; break; }
      ws.splice(pos, 0, { x: s.xMid, x1: s.box.x1, t });
      best.x0 = Math.min(best.x0, s.box.x0); best.x1 = Math.max(best.x1, s.box.x1);
    } else if (best && bd < reach) {
      best.plain = (best.plain ?? "") + " " + t;
    } else {
      // a row that holds only structures ("2/5 = 4/10"): put them on ONE line, left to right
      const row = items.find((it) => it.fresh && Math.abs(it.y - s.yMid) <= Math.max(12, tall * 0.55) && s.box.x0 - it.x1 < s.th * 6 && it.x0 - s.box.x1 < s.th * 6);
      if (row) { row.words.push({ x: s.xMid, x1: s.box.x1, t }); row.words.sort((a, b) => a.x - b.x); row.x0 = Math.min(row.x0, s.box.x0); row.x1 = Math.max(row.x1, s.box.x1); row.y = (row.y + s.yMid) / 2; }
      else items.push({ y: s.yMid, x0: s.box.x0, x1: s.box.x1, words: [{ x: s.xMid, x1: s.box.x1, t }], rtl: false, fresh: true });
    }
  }
  // fresh lines go to their place by height; the others keep Tesseract's reading order
  const base = items.filter((i) => !i.fresh), fresh = items.filter((i) => i.fresh).sort((a, b) => a.y - b.y);
  const res: Item[] = [...base];
  for (const f of fresh) {
    let at = res.length;
    for (let k = 0; k < res.length; k++) if (res[k].y > f.y + 4 && res[k].x1 >= f.x0 && res[k].x0 <= f.x1) { at = k; break; }
    res.splice(at, 0, f);
  }
  return res.map((i) => (i.plain !== undefined ? i.plain : renderWords(i.words, i.rtl)).replace(/\s{2,}/g, " ").trim()).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- pages laid out in ruled cells
// Workbook pages put the questions in a grid: horizontal rules between sections, vertical rules between columns of cells.
// Reading the page as one block mixes the columns. Here the rules are found, and every cell is read on its own, in reading order
// (right-to-left when the page is Arabic).
type Rule = { x0: number; x1: number; y0: number; y1: number };
function verticalRules(c: Ctx, y0: number, y1: number): Rule[] {
  const { w, mask, th } = c, minLen = Math.max(Math.round(2.5 * th), Math.round(0.5 * (y1 - y0 + 1))), found: Rule[] = [];
  for (let x = 0; x < w; x++) {
    let run = 0, gap = 0, start = 0, bestLen = 0, bestStart = 0;
    for (let y = y0; y <= y1; y++) {
      if (mask[y * w + x]) { if (!run) start = y; run += 1 + gap; gap = 0; if (run > bestLen) { bestLen = run; bestStart = start; } }
      else if (run && ++gap > 2) { run = 0; gap = 0; }
    }
    if (bestLen >= minLen) found.push({ x0: x, x1: x, y0: bestStart, y1: bestStart + bestLen - 1 });
  }
  const out: Rule[] = [];   // neighbouring columns are one (thick) rule
  for (const r of found) { const l = out[out.length - 1]; if (l && r.x0 - l.x1 <= Math.max(2, 0.3 * th)) { l.x1 = r.x1; l.y0 = Math.min(l.y0, r.y0); l.y1 = Math.max(l.y1, r.y1); } else out.push({ ...r }); }
  return out.filter((r) => r.x1 - r.x0 + 1 <= Math.max(6, 0.35 * th));
}
export function splitCells(g: Gray, thHint?: number): { boxes: Box[]; th: number } | null {
  const c = ctxOf(g, thHint);
  if (!c) return null;
  const { w, h, th } = c;
  // horizontal rules that run across most of the page
  const hr = findBars(c).filter((b) => b.x1 - b.x0 + 1 >= 0.5 * w && b.y1 - b.y0 + 1 <= Math.max(4, 0.2 * th)).map((b) => ({ y0: b.y0, y1: b.y1 })).sort((a, b) => a.y0 - b.y0);
  const edges: number[][] = []; let top = 0;
  for (const r of hr) { if (r.y0 - top > 2 * th) edges.push([top, r.y0 - 3]); top = r.y1 + 3; }
  if (h - top > 2 * th) edges.push([top, h - 1]);
  const boxes: Box[] = []; let cells = 0;
  for (const [a, b] of edges) {
    const rules = verticalRules(c, a, b);
    if (!rules.length) { boxes.push({ x0: 0, y0: a, x1: w - 1, y1: b }); continue; }
    const ry0 = Math.max(a, Math.min(...rules.map((r) => r.y0)) - 2), ry1 = Math.min(b, Math.max(...rules.map((r) => r.y1)) + 2);
    if (ry0 - a > 1.5 * th) boxes.push({ x0: 0, y0: a, x1: w - 1, y1: ry0 - 1 });           // heading above the cells
    let left = 0; const cuts = [...rules.map((r) => [r.x0, r.x1] as [number, number]), [w, w] as [number, number]];
    for (const [rx0, rx1] of cuts) { if (rx0 - left > 3 * th) { boxes.push({ x0: left, y0: ry0, x1: rx0 - 3, y1: ry1 }); cells++; } left = rx1 + 3; }
    if (b - ry1 > 1.5 * th) boxes.push({ x0: 0, y0: ry1 + 1, x1: w - 1, y1: b });             // text below the cells
  }
  return cells >= 2 ? { boxes, th } : null;
}
/** Reads a whole page: ruled cells one by one (right-to-left on an Arabic page), everything else as one block. */
export async function readMathPage(en: Engine, g: Gray): Promise<string> {
  const sp = splitCells(g);
  if (!sp) return readMath(en, g);
  const texts: { box: Box; text: string }[] = [];
  for (const b of sp.boxes) {
    const piece = crop(g, b, 10);
    const t = (await readMathEx(en, piece, 0, "page", sp.th)).text.trim();
    if (t) texts.push({ box: b, text: t });
  }
  const arabic = (texts.map((t) => t.text).join("").match(/[\u0600-\u06FF]/g) ?? []).length > 12;
  // bands top to bottom; inside a band the cells right-to-left (Arabic) or left-to-right
  const out: string[] = []; let i = 0;
  while (i < texts.length) {
    let j = i + 1;
    while (j < texts.length && texts[j].box.y0 === texts[i].box.y0 && texts[j].box.y1 === texts[i].box.y1) j++;
    const row = texts.slice(i, j).sort((a, b) => (arabic ? b.box.x0 - a.box.x0 : a.box.x0 - b.box.x0));
    for (const r of row) out.push(r.text);
    i = j;
  }
  return out.join("\n");
}

/** Final clean-up for a math page: English digits, tidy spaces around operators. */
export function cleanMathText(t: string): string {
  return normDigits(t)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/([0-9)a-z])\s+[xX]\s+(?=[0-9(√])/g, "$1 × ")           // "12 x 3" between numbers is a multiplication sign
    .replace(/\s*\/\s*/g, (m, off, s) => (/[0-9)a-zA-Z]$/.test(s.slice(0, off)) && /^[0-9(a-zA-Z√]/.test(s.slice(off + m.length)) ? "/" : m))
    .replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
