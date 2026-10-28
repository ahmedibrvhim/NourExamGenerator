// Reads the chosen pages (locally, no AI request) and finds the sentences each question type can be built from:
//   عرّف / اكتب المصطلح  <- definitions and named terms ("يُسمّى", "هو", "يُعرَّف")
//   قارن                 <- comparisons ("الفرق بين", "بينما", "يختلف", "على عكس")
//   علّل                 <- cause and effect ("لأن", "بسبب", "لذلك", "مما يؤدي")
//   معادلات              <- chemical equations
//   اختر / صح وخطأ / أكمل <- plain facts (any sentence that states something)
// The result tells the teacher which types the pages can support, and how many of each one copy of the exam should have.
// The same sentences are also given to the AI as "key sentences", so the questions come from the best material of the pages.
import type { Avail, Kind } from "@/lib/subjects";

export const norm = (s: string) =>
  s.normalize("NFKC").replace(/[ً-ٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

export type Signals = {
  facts: number;          // sentences that state a fact
  define: string[];       // "X هو ..." / "يُعرَّف ..." / "يُقصد بـ ..."
  term: string[];         // "... يُسمّى X" / "يُطلق عليه X"
  compare: string[];
  reason: string[];
  equations: string[];
  problems: string[];     // "احسب / أوجد ..." with numbers and units
  laws: string[];         // formulas such as "V = I × R"
};

// A heading is not a sentence. Lines of one paragraph are joined, then cut at . ? ! ؟
export function splitSentences(text: string): string[] {
  const paras: string[] = [];
  let buf = "";
  const flush = () => { if (buf) { paras.push(buf); buf = ""; } };
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (!l) { flush(); continue; }
    if (l.length < 28 && !/[.؟?!:،,؛;]$/.test(l)) { flush(); continue; } // short line without punctuation = heading
    buf += (buf ? " " : "") + l;
  }
  flush();
  const out: string[] = [];
  for (const p of paras) for (const m of p.match(/[^.؟?!]+[.؟?!]?/g) ?? []) { const t = m.trim(); if (t.length >= 25 && t.length <= 320) out.push(t); }
  return out;
}

// patterns run on the normalised sentence (no diacritics, أ/إ/آ -> ا, ى -> ي, ة -> ه)
const DEF = /^(?:\S+\s+){1,7}?(?:هو|هي|هم|يعد|تعد|يعتبر|تعتبر|يمثل|تمثل|عباره عن|يقصد به|تقصد به)\s+\S/;
const DEF_WORD = /(?:يعرف|تعرف|نعرف|يقصد ب|المقصود ب|تعريف)/;
const TERM = /(?:يسمي|تسمي|يسمون|سمي|سميت|يطلق عليه|يطلق عليها|تطلق عليه|تطلق عليها|يعرف باسم|تعرف باسم|ما يسمي|ما يعرف ب|المصطلح)/;
const COMPARE = /(?:الفرق بين|يختلف|تختلف|اختلاف|مقارنه|قارن|بينما|في حين|علي عكس|بعكس|يتشابه|تتشابه|تشابه|وجه الشبه|اوجه الشبه|وجه الاختلاف|اوجه الاختلاف|اما\s+\S+(?:\s+\S+){0,5}\s+ف)/;
const REASON = /(?:لان|لانه|لانها|بسبب|نتيجه ل|ولذلك|لذلك|مما يؤدي|مما يجعل|مما يسبب|يرجع ذلك|يعود ذلك|حيث ان|ينتج عن|يؤدي الي|نظرا ل|تبعا ل|علل)/;

// chemical equations: formulas (with coefficients / subscripts) joined by "+" and an arrow, e.g. "2H₂ + O₂ → 2H₂O"
const FORM = "\\d*[A-Z][A-Za-z0-9₀-₉()\\[\\]]*(?:\\((?:g|s|l|aq)\\))?";
const SIDE = `${FORM}(?:\\s*\\+\\s*${FORM})*`;
const EQ = new RegExp(`${SIDE}\\s*(?:→|⟶|->|⇌|⇄|⟹)\\s*${SIDE}`, "g");

// numeric problems: a calculation verb with numbers, or several quantities with science units
const CALC = /(?:احسب|اوجد|ما قيمه|ما مقدار|كم يبلغ|مساله|مسايل|تمرين|مثال)/;
const NUM = "[0-9٠-٩]+(?:[.,٫][0-9٠-٩]+)?";
const UNIT = new RegExp(`${NUM}\\s*(?:فولت|امبير|اوم|نيوتن|جول|واط|كيلو\\S*|كجم|جم|مول|لتر|متر|سم|مم|ثانيه|دقيقه|ساعه|هرتز|درجه|°|م/ث|كم/س|v\\b|a\\b|n\\b|j\\b|w\\b|kg|g\\b|cm|mm|m\\b|s\\b|mol|hz|ohm|Ω)`, "gi");
const HASNUM = /[0-9٠-٩]/;
// a law written as a formula on its own line: "V = I × R", "شدة التيار = كمية الكهربية ÷ الزمن"
const isLaw = (l: string) => l.length >= 5 && l.length <= 90 && l.includes("=") && !/[→⟶⇌⇄]|->/.test(l) && (/[×÷*\/]/.test(l) || /^\s*[A-Za-z]{1,3}\s*=/.test(l)) && !/^[\d\s.=+\-]+$/.test(l);

const clip = (s: string, n = 190) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function extractSignals(text: string): Signals {
  const sig: Signals = { facts: 0, define: [], term: [], compare: [], reason: [], equations: [], problems: [], laws: [] };
  const seen = new Set<string>();
  for (const s of splitSentences(text)) {
    const n = norm(s);
    if (HASNUM.test(n) && ((CALC.test(n)) || (n.match(UNIT) ?? []).length >= 2)) sig.problems.push(clip(s)); // problems are often written as questions: check before the question filter
    if (/[؟?]\s*$/.test(s) || s.length < 30) continue;       // a question is not a fact
    const key = n.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    sig.facts++;
    const isTerm = TERM.test(n);
    if (isTerm) sig.term.push(clip(s));
    if (!isTerm && (DEF.test(n) || DEF_WORD.test(n))) sig.define.push(clip(s));
    if (COMPARE.test(n)) sig.compare.push(clip(s));
    if (REASON.test(n)) sig.reason.push(clip(s));
  }
  const laws = new Set<string>();
  for (const l of text.split("\n")) if (isLaw(l)) laws.add(clip(l.replace(/\s+/g, " ").trim(), 120));
  sig.laws = [...laws];
  const eq = new Set<string>();
  for (const m of text.matchAll(EQ)) {
    const e = m[0].replace(/\s+/g, " ").trim();
    if (e.includes("+") || /[a-z0-9₀-₉]/.test(e.replace(/\s/g, "").replace(/→.*/, ""))) eq.add(e); // "A → B" alone is probably a diagram, not a reaction
  }
  sig.equations = [...eq];
  return sig;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Which question types do these pages support, and how many of each would a balanced copy of the exam have?
export function evidenceFor(sig: Signals, pages: number): Avail {
  const S = sig.facts, D = sig.define.length, T = sig.term.length, C = sig.compare.length, R = sig.reason.length, E = sig.equations.length, P = sig.problems.length, L = sig.laws.length;
  const tooShort = "الصفحات المحددة قصيرة لا تكفي لأسئلة";
  const raw: Record<Exclude<Kind, "essay">, { n: number; ok: boolean; why: string; w: number; cap: number }> = {
    mcq:     { n: S,     ok: S >= 6,     why: tooShort,                                                              w: 4,   cap: S },
    tf:      { n: S,     ok: S >= 6,     why: tooShort,                                                              w: 3,   cap: S },
    fill:    { n: S,     ok: S >= 6,     why: tooShort,                                                              w: 3,   cap: S },
    reason:  { n: R,     ok: R >= 2,     why: "لم تُرصد عبارات تعليل (لأن / بسبب / لذلك…) في الصفحات المحددة",        w: 2,   cap: R },
    term:    { n: T + D, ok: T + D >= 3, why: "لم تُرصد مصطلحات أو تعريفات كافية في الصفحات المحددة",                  w: 2,   cap: Math.ceil((T + D) * 0.6) },
    define:  { n: T + D, ok: T + D >= 2, why: "لم تُرصد تعريفات في الصفحات المحددة",                                    w: 2,   cap: T + D },
    compare: { n: C,     ok: C >= 2,     why: "لم تُرصد مقارنات (الفرق بين / بينما / يختلف…) في الصفحات المحددة",      w: 1.5, cap: C },
    balance: { n: E,     ok: E >= 1,     why: "لم تُرصد معادلات كيميائية في الصفحات المحددة",                           w: 2,   cap: E },
    write:   { n: E,     ok: E >= 1,     why: "لم تُرصد معادلات كيميائية في الصفحات المحددة",                           w: 2,   cap: E },
    problem: { n: P + L, ok: L >= 1 || P >= 2, why: "لم تُرصد قوانين أو مسائل حسابية (احسب / أوجد / وحدات) في الصفحات المحددة", w: 2, cap: P + L },
  };
  // size of one copy: grows with the pages, but never more than the text can support
  const total = clamp(Math.round(Math.min(pages * 1.6, S * 0.5)), 6, 36);
  const active = (Object.keys(raw) as Array<keyof typeof raw>).filter((k) => raw[k].ok);
  const sumW = active.reduce((n, k) => n + raw[k].w, 0) || 1;
  const out: Avail = {};
  for (const k of Object.keys(raw) as Array<keyof typeof raw>) {
    const r = raw[k];
    const suggest = r.ok ? clamp(Math.round((total * r.w) / sumW), 1, Math.max(1, r.cap)) : 0;
    out[k] = { ok: r.ok, n: r.n, suggest, why: r.ok ? undefined : r.why };
  }
  return out;
}

// Key sentences for the AI, only for the types it is asked to write in this batch.
export function hintsFor(text: string, kinds: string[]): string {
  const sig = extractSignals(text);
  const parts: string[] = [];
  const list = (title: string, arr: string[], max: number) => { if (arr.length) parts.push(`${title}\n${arr.slice(0, max).map((x) => `- ${x}`).join("\n")}`); };
  if (kinds.includes("term") || kinds.includes("define")) list("DEFINITIONS / NAMED TERMS stated in the text (best material for term and define questions):", [...sig.term, ...sig.define], 8);
  if (kinds.includes("compare")) list("COMPARISONS stated in the text (best material for compare questions):", sig.compare, 5);
  if (kinds.includes("reason")) list("CAUSE-AND-EFFECT statements in the text (best material for reason questions):", sig.reason, 6);
  if (kinds.includes("balance") || kinds.includes("write")) list("CHEMICAL EQUATIONS in the text:", sig.equations, 6);
  if (kinds.includes("problem")) list("LAWS (formulas) and CALCULATION EXAMPLES in the text (best material for problem questions; use these laws and similar numbers):", [...sig.laws, ...sig.problems], 8);
  return parts.length ? `KEY SENTENCES found in the text (build the matching question types from these first; they are real statements of the book):\n${parts.join("\n")}\n` : "";
}
