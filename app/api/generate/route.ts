import { NextResponse } from "next/server";
import type { Q } from "@/exam";
import { classify } from "@/lib/geminiErrors";
import { addUsage, clearDayLimit, markDayLimit } from "@/lib/store";
import { createHash } from "crypto";
import { msUntilPacificMidnight } from "@/lib/limits";
import { ALL_KINDS, BRANCH_LABEL, GRADE_ORD, STAGE_SHORT, type Branch, type Stage } from "@/lib/subjects";
import { balanceCheck } from "@/lib/chem";
import { hintsFor, norm } from "@/lib/analyze";

export const runtime = "nodejs";
export const maxDuration = 60;
const DEADLINE_MS = 50_000; // stop talking to Gemini before Vercel kills the function (maxDuration) so we never return an opaque 504

// "gemini-flash-latest" always points to the current free Flash model. Override with GEMINI_MODEL if needed.
// Model names change over time (old ones get retired -> 404). So we ask Google which Flash models this key can use,
// and try them in order. Each model has its own free quota, so if one is busy / slow / over its limit the next one is used.
const FIRST_OUTPUT_MS = 22_000; // a model that writes nothing for this long is skipped
let modelCache: { at: number; list: string[] } | null = null;
async function pickModels(apiKey: string): Promise<string[]> {
  const pinned = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  let found: string[] = [];
  if (modelCache && Date.now() - modelCache.at < 3_600_000) found = modelCache.list;
  else {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(5000) });
      const j: any = await r.json();
      const names: string[] = (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .filter((n: string) => /^gemini-.*flash/.test(n) && !/(tts|image|live|audio|exp|robotics|computer|native|customtools|thinking)/.test(n));
      const rank = (n: string) => (n === "gemini-flash-latest" ? 0 : n === "gemini-flash-lite-latest" ? 1 : /preview/.test(n) ? 3 : 2);
      found = names.sort((x, y) => rank(x) - rank(y) || (y > x ? 1 : -1));
      if (found.length) modelCache = { at: Date.now(), list: found };
    } catch {}
  }
  const fallback = ["gemini-flash-latest", "gemini-flash-lite-latest"];
  const prefer = ["gemini-2.5-flash", "gemini-2.5-flash-lite"].filter((m) => !found.length || found.includes(m));
  return [...new Set([...pinned, ...prefer, ...(found.length ? found : fallback)])].slice(0, 4);
}
const KINDS = ALL_KINDS;
const LEVELS: Record<string, string> = {
  easy: "easy: direct recall of definitions and facts stated in the text",
  medium: "medium: understanding and applying ideas from the text",
  hard: "hard: analysis, comparison, cause and effect, multi-step reasoning based on the text",
  mixed: "a mix of easy, medium and hard",
};

const SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: [...KINDS] },
          text: { type: "STRING", description: "The question. Must make sense on its own." },
          choices: { type: "ARRAY", items: { type: "STRING" }, description: "mcq: exactly 4 options, no letter labels. every other type: empty array." },
          answer: { type: "STRING", description: "mcq: the exact text of the correct choice. tf: 'true' or 'false'. reason/define/compare/essay: a short model answer. term: the term only. fill: the missing word(s) in order, separated by ' - '. problem/solve: the full worked solution ending with the final answer. balance/write: the final balanced equation." },
          explanation: { type: "STRING", description: "One sentence showing where the text supports the answer." },
        },
        required: ["type", "text", "choices", "answer", "explanation"],
      },
    },
  },
  required: ["questions"],
};

const SYSTEM = `You are a senior exam writer for school teachers. Your questions go straight onto a printed exam, so they must be correct, clear and fair.

GROUNDING
- Use ONLY the text the user gives you. Never add facts, numbers or examples from outside it. If the text does not support a question, skip it: fewer good questions are better than invented ones.
- The text comes from a school book and was often read by OCR, so some Arabic letters may be missing or wrong (for example "يدا" instead of "يبدأ"). Understand the intended word from the context and write every word correctly. Never copy an OCR mistake.
- Write in the same language as the text (Arabic text -> Arabic questions). Use the book's own scientific terms.
- If a KEY SENTENCES list is given, build the matching question types from those sentences first.

COMPLETE, SELF-CONTAINED QUESTIONS
- Every question is a full sentence a student can answer without the book. Always name the exact subject (the element, substance, law, organ, term...). Never write vague wording such as "هذه المجموعة", "هذه العناصر", "ما سبق", "السابق", "it", "this group": use the real name from the nearest heading or sentence.
- A question ends with a question mark or a clear instruction. Never stop in the middle of a sentence.
- NO REFERENCES TO THE BOOK: the student will NOT have the book, a picture, a figure, a table or a graph. Never write "في النص", "المذكورة", "الواردة", "الموضح", "الشكل", "الجدول", "الصورة", "الرسم", "أعلاه", "أدناه", "according to the text", and never mention page numbers. If the idea needs a list (elements, substances, steps), write the names inside the question.
  Bad: "ما نظائر العناصر المذكورة في النص؟"   Good: "ما نظائر عنصر الهيدروجين؟"
- If the text contains the book's own exercise questions you may use them, written in full with the missing subject added.

QUALITY
- One idea per question. Never ask two things in one question, never ask the same idea twice, and spread the questions over different parts of the text (not all from the first paragraph).
- Difficulty must match the level asked for. Easy = recall of a stated fact. Medium = understanding / applying. Hard = cause and effect, comparison, multi-step reasoning, all still answerable from the text.
- mcq: exactly 4 choices, exactly one correct. The 3 wrong choices must be plausible and of the same kind as the right one (same category, similar length and wording): names of real things from the same topic, not silly options. Never "all of the above" / "none of the above". No letters (A/B/C/D, أ/ب/ج/د) inside the choices. The answer is copied exactly from one choice. The correct choice must not be systematically the longest.
- tf: one clear statement that is fully true or fully false, naming its subject. A false statement is a real fact with ONE key word changed to a wrong but believable one (not nonsense, not a negation with "لا"). Do not hide the answer in words like "دائمًا / أبدًا / فقط" unless the text says so. Mix true and false about evenly. answer is "true" or "false".
- explanation: one short sentence with the fact from the text that proves the answer.
- Skip tables of contents, indexes, references, headers and filler.

SELF-CHECK before you answer: every question is complete, answerable from the text alone, has one correct answer, has no outside reference, and is not a repeat. Remove any that fail.`;


// ---------- subject-specific instructions (science first; other subjects will add their own later) ----------
const STAGE_RULES: Record<Stage, string> = {
  primary: "STAGE = primary school. Use very simple words and short sentences. Only concrete ideas from the text (living things, materials, the senses, simple machines, weather...). NO formulas, NO calculations, NO chemical equations. Reason questions must have an obvious one-sentence cause.",
  prep: "STAGE = preparatory (middle) school. Use the book's own terms. Calculations only with the simple laws printed in the text (speed, density, Ohm's law...). Chemical equations only if the text shows them, and keep them short (2-4 formulas).",
  secondary: "STAGE = secondary school. Questions may require analysis, multi-step reasoning, laws with units, and balanced chemical equations with correct formulas. Use precise scientific terminology.",
};
const BRANCH_RULES: Record<Branch, string> = {
  general: "", physics: "BRANCH = physics: prefer laws, units, quantities and measurements.",
  chemistry: "BRANCH = chemistry: prefer elements, compounds, reactions, the periodic table, equations.",
  biology: "BRANCH = biology: prefer structures, functions, processes and classifications.", geology: "BRANCH = geology: prefer rocks, minerals, earth processes.",
};
const KIND_RULES: Record<string, string> = {
  essay: `- essay (theoretical question): a direct science question (ما / اذكر / فسّر / ماذا يحدث عند). answer = a short complete model answer (1-3 sentences).`,
  reason: `- reason (علّل): the text MUST begin with "علل:" followed by the COMPLETE true statement to be explained, written inside the question itself (e.g. "علل: تُستخدم الأسلاك النحاسية في التوصيلات الكهربية."). The statement must have a cause that the text gives. answer = the scientific cause in 1-2 sentences. Never ask to explain something that is not a real fact from the text.`,
  term: `- term (اكتب المصطلح): the text starts with "اكتب المصطلح العلمي:" followed by ONE complete description or definition taken from the text, WITHOUT the term itself or any word of it. answer = the term only (1-3 words) exactly as the book writes it. The description must fit one term only.`,
  define: `- define (عرّف): the text is short: "عرّف: <term>." where the term is a defined concept of the text (a law, a process, a substance, a structure...). answer = the book's definition in 1-2 sentences. Never ask to define something the text does not define.`,
  compare: `- compare (قارن): the text is "قارن بين <A> و <B> من حيث <aspect 1> و <aspect 2>." Both items and every aspect must be covered by the text. answer = one line per aspect, written "<aspect>: <A> ... / <B> ...". Only compare things the text really contrasts.`,
  fill: `- fill (أكمل): ONE complete statement from the text in which one key word or number (at most two) is replaced by "______". The blank must be a scientific term, a name or a number (never a linking word), and the rest of the sentence must make the answer unique. answer = the missing word(s) in the order of the blanks, separated by " - ".`,
  problem: `- problem (مسألة — احسب): a numeric problem solved with a law or relation that is stated in the text (or in the LAWS list). Start with "احسب" or "أوجد". Write it as plain text only (no tables or diagrams): one short paragraph that gives EVERY value WITH its unit and asks for ONE quantity. Use clean numbers that give a tidy result, consistent units, and realistic values. choices = []. answer = the worked solution, one step per line: the law, the substitution, the final value with its unit. Check the arithmetic twice. Never use a law that is not in the text.`,
  balance: `- balance (وزن المعادلة): the text MUST be "زن المعادلة الآتية:" followed by ONE UNBALANCED chemical equation written with formulas, Unicode subscripts and an arrow, e.g. "زن المعادلة الآتية: H₂ + O₂ → H₂O". The given equation must really be unbalanced. answer = the same equation, correctly BALANCED (same atoms on both sides, smallest whole-number coefficients), e.g. "2H₂ + O₂ → 2H₂O". choices = []. Use only reactions that appear in the text or follow directly from it.`,
  write: `- write (كتابة المعادلة): the text names the reactants and products IN WORDS and asks for the balanced symbolic equation, e.g. "اكتب المعادلة الكيميائية الرمزية الموزونة لتفاعل غاز الهيدروجين مع غاز الأكسجين لتكوين بخار الماء." Do NOT put any formula or arrow in the question text. answer = the balanced symbolic equation only, with Unicode subscripts and an arrow. choices = []. Use only reactions that appear in the text or follow directly from it.`,
};
const MATH_STAGE: Record<Stage, string> = {
  primary: "STAGE = primary school. Short sentences, small whole numbers, simple fractions/decimals only as the text shows them. Word problems use everyday situations (money, sweets, school, measurements).",
  prep: "STAGE = preparatory (middle) school. Use the book's own methods: algebra, fractions, ratios, equations, geometry and statistics exactly as the text teaches them.",
  secondary: "STAGE = secondary school. Questions may need multi-step algebra, functions, trigonometry, calculus or statistics as the text teaches them. Use precise mathematical notation.",
};
const MATH_RULES = `- MATH EXCEPTION TO GROUNDING: you MAY (and should) invent NEW numbers, values, names and situations, but ONLY for the topics, rules and question styles that appear in the text. Copy the style and difficulty of the book's examples and exercises. Never use a topic the text does not teach.
- The student has NO book, figure or graph. Describe any shape in words with all its measures (e.g. "مستطيل طوله ٨ سم وعرضه ٥ سم"). Plain text only, in EXACTLY this notation (the sheet draws it as real stacked fractions and roots): fraction 3/4, and with parentheses when the top or bottom has more than one term: (2x + 1)/(x - 3); square root √25 or √(x + 4); cube root ³√27; powers x², x³ (superscript digits) or x^n; multiplication ×, division ÷. The book text uses English digits 0-9 (and Latin letters x, y for unknowns): write every number with English digits 0-9, never Arabic-Indic ٠-٩, unless the text itself clearly uses ٠-٩. Keep the digit style the same inside one question. If a text line shows a fraction as a/b or (a)/(b) or a root as √..., keep that notation.
- ACCURACY IS EVERYTHING: calculate every answer twice. If you are not sure the answer is exactly right, do not write the question. Prefer clean numbers that give tidy results.
- mcq (اختر): a complete math question with exactly 4 choices and exactly one correct. Wrong choices are the results of common student mistakes (wrong sign, forgot a step, wrong operation, wrong unit) and look like the right one (same form and type). No two choices may be equal in value. answer = the exact text of the correct choice.
- fill (أكمل): ONE short complete math statement or exercise in which the result or one missing number / expression (at most two blanks) is replaced by "______", e.g. "3/4 + 1/4 = ______", "إذا كان 2x + 3 = 11 فإن x = ______", "مساحة مستطيل طوله 8 سم وعرضه 5 سم = ______ سم²". The blank is a number, an expression or a unit-less result the student can find by a short calculation, never a linking word. The statement must have exactly one correct answer. choices = []. answer = the missing value(s) in the order of the blanks, separated by " - " (just the value, with its unit only if the blank asks for it).
- solve (أجب عن الأسئلة): a question the student solves on paper. Start with a verb such as احسب / أوجد / حل / بسّط / اختصر / أوجد ناتج / جد. One short problem that asks for ONE final result (a word problem is allowed and may be 2-3 sentences). It must contain the given numbers. choices = []. answer = the worked solution, one step per line (the rule, the substitution, the result), ending with the final answer and its unit if any.`;
function subjectRules(subject: string, stage: Stage | null, level: number | null, branch: Branch | null, types: string[]): string {
  if (subject === "math") {
    const m = ["SUBJECT = Mathematics (رياضيات). Questions must test mathematical skill, not memorising page layout."];
    if (stage) m.push(MATH_STAGE[stage]);
    if (stage && level) m.push(`GRADE = ${GRADE_ORD[level - 1]} ${STAGE_SHORT[stage]}. Match exactly the level of this grade's curriculum; do not use topics or difficulty from higher grades.`);
    else m.push("The school stage is unknown: infer it from the vocabulary and difficulty of the text and write questions at that level.");
    m.push(MATH_RULES);
    return "\n\nSUBJECT RULES:\n" + m.join("\n");
  }
  if (subject !== "science") return "";
  const parts = ["SUBJECT = Science (علوم). Questions must test scientific understanding, not memorising page layout."];
  if (stage) parts.push(STAGE_RULES[stage]);
  if (stage && level) parts.push(`GRADE = ${GRADE_ORD[level - 1]} ${STAGE_SHORT[stage]}. Match exactly the level of this grade's curriculum; do not use topics or difficulty from higher grades.`);
  else parts.push("The school stage is unknown: infer it from the vocabulary and difficulty of the text and write questions at that level.");
  if (branch && BRANCH_RULES[branch]) parts.push(BRANCH_RULES[branch]);
  for (const k of types) if (KIND_RULES[k]) parts.push(KIND_RULES[k]);
  return "\n\nSUBJECT RULES:\n" + parts.join("\n");
}

// OCR output can contain control characters, private-use symbols and lines of pure noise ("|||", "~ _ .").
// Strip them so Gemini only sees real text.
function cleanText(t: string, math = false): string {
  return t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uE000-\uF8FF\uFFFD\uFFF0-\uFFFF]/g, " ")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => {
      if (!l) return true;
      const letters = (l.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (math) return letters >= 2 && letters / l.length >= 0.3; // math lines are full of symbols: "٣ + ٥ = ٨", "(س + ٢)² = ٩"
      return letters >= 3 && letters / l.length >= 0.5;
    })
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Raw = { type?: string; text?: string; choices?: unknown; answer?: string; explanation?: string };

// A question that is too short, or ends in the middle of a sentence ("... في" / "... من"), is dropped.
const DANGLING = /(?:^|\s)(?:في|من|إلى|الى|على|عن|مع|و|أو|او|ثم|التي|الذي|الذين|هل|ما|ماذا|كيف|لماذا|and|or|of|the|to|in|is|are|that|which)\s*$/i;
// Questions that point at a text / picture / table the student does not have cannot be solved -> dropped.
const AB = "(?<![\\u0621-\\u064A\\u0671-\\u06D3])", AE = "(?![\\u0621-\\u064A\\u0671-\\u06D3])"; // Arabic word start / end (so "نصف" is not mistaken for "نص")
const REFERS_PARTS = [
  `${AB}(?:في|من|بحسب|حسب|وفق|ب|ل)?\\s*(?:ال)?(?:نص|فقرة|درس|مقطع)${AE}`,
  `${AB}(?:ال)?(?:مذكور|مذكورة|مذكورات|مذكورين|وارد|واردة|موضح|موضحة|مبين|مبينة|مرفق|مرفقة)${AE}`,
  `${AB}(?:ال)?(?:شكل|جدول|صورة|رسم|مخطط|منحنى|خريطة)\\s*(?:ال)?(?:مقابل|سابق|اعلاه|أعلاه|ادناه|أدناه|التالي|الآتي|الاتي|بالأعلى|بالاسفل|بالأسفل)${AE}`,
  `${AB}(?:أعلاه|اعلاه|أدناه|ادناه)${AE}`,
  `${AB}(?:الشكل|الجدول|الصورة|الرسم)\\s*\\(?\\d`,
  `${AB}(?:صفحة|ص)\\s*\\d+`,
  "according to|\\bthe (?:text|passage|author|figure|table|diagram)\\b|\\bin the (?:text|book|passage|figure)\\b|\\bshown (?:above|below)\\b",
];
const REFERS_OUTSIDE = new RegExp(REFERS_PARTS.join("|"), "i");
// math: "ص" is a variable (س، ص), so the page-number rule "ص 12" is left out
const REFERS_MATH = new RegExp(REFERS_PARTS.filter((x) => !x.includes("(?:صفحة|ص)")).join("|"), "i");
function looksIncomplete(t: string, short = false, math = false): boolean {
  if ((math ? REFERS_MATH : REFERS_OUTSIDE).test(t)) return true;
  const s = t.replace(/[\s؟?.:،,!]+$/u, "");
  if ((s.match(/[\p{L}\p{N}]/gu) ?? []).length < (short ? 6 : 12)) return true;
  if (s.split(/\s+/).length < (short ? 2 : 3)) return true;
  return DANGLING.test(s);
}

function cleanOne(r: Raw, allowed: string[], math = false): Q | null {
  const kind = r.type as Q["kind"];
  let text = (r.text ?? "").trim();
  if (!text || !allowed.includes(kind)) return null;
  if (looksIncomplete(text, kind === "define" || math, math)) return null; // cut-off or too short to stand alone: better no question than a broken one
  const explanation = (r.explanation ?? "").trim();
  const answer = (r.answer ?? "").trim();
  if (kind === "mcq") {
    const choices = [...new Set((Array.isArray(r.choices) ? r.choices : []).map((c) => String(c).trim()).filter(Boolean))];
    if (choices.length < 3 || !choices.includes(answer)) return null;
    return { kind, text, choices, answer, explanation };
  }
  if (kind === "tf") {
    const a = answer.toLowerCase();
    if (a !== "true" && a !== "false") return null;
    return { kind, text, choices: [], answer: a, explanation };
  }
  if (kind === "solve") {
    if (!/[0-9٠-٩]/.test(text) || !/[0-9٠-٩]/.test(answer)) return null; // a math question needs given numbers and a numeric final answer
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "reason") {
    if (answer.length < 8) return null;
    if (!/^\s*علل/.test(text)) text = "علل: " + text;
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "problem") {
    if (!/\d/.test(text) || answer.length < 6 || !/\d/.test(answer)) return null; // a problem needs given numbers and a worked numeric answer
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "balance") {
    const given = text.split(/[:：]/).slice(1).join(":");
    if (!/[→⟶]|->/.test(given) || !/[→⟶]|->/.test(answer)) return null;
    if (balanceCheck(given) === true) return null;   // the equation given to the student is already balanced: no question
    if (balanceCheck(answer) === false) return null; // the AI's answer is checked atom by atom: unbalanced -> dropped
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "write") {
    if (/[→⟶]|->/.test(text)) return null;          // the question must not give the equation away
    if (!/[→⟶]|->/.test(answer) || balanceCheck(answer) === false) return null;
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "term") {
    if (answer.length < 2 || answer.split(/\s+/).length > 6) return null;
    if (norm(text).includes(norm(answer))) return null;        // the question gives the term away
    if (!/^\s*اكتب المصطلح/.test(text)) text = "اكتب المصطلح العلمي: " + text;
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "define") {
    if (answer.length < 10) return null;
    if (!/^\s*(?:عرف|عرّف|ما المقصود|ما تعريف)/.test(text)) text = "عرّف: " + text;
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "compare") {
    if (answer.length < 15 || !/قارن|الفرق|ما الفرق/.test(text)) return null;
    return { kind, text, choices: [], answer, explanation };
  }
  if (kind === "fill") {
    text = text.replace(/(?:_\s*){3,}|\.{4,}|…{2,}|\(\s{2,}\)|\[\s*\]/g, "______");
    const blanks = (text.match(/______/g) ?? []).length;
    if (blanks < 1 || blanks > 3 || answer.length < 1) return null;
    if (math && (!/[0-9٠-٩]/.test(text) || !/[0-9٠-٩a-zA-Zسصعمنلك√π]/.test(answer) || answer.length > 40)) return null; // a math blank needs given numbers and a short value as its answer
    if (answer.split(/\s+-\s+/).length < blanks && blanks > 1) return null;
    return { kind, text, choices: [], answer, explanation };
  }
  return { kind: "essay", text, choices: [], answer, explanation };
}

// Pulls complete {...} question objects out of a JSON text that arrives in small pieces.
// Depth 1 is the outer { "questions": [...] }, depth 2 is one question.
class ObjectExtractor {
  private depth = 0; private inStr = false; private esc = false; private start = -1; private buf = "";
  push(chunk: string): string[] {
    const out: string[] = [];
    for (const ch of chunk) {
      const i = this.buf.length;
      this.buf += ch;
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === "\\") this.esc = true;
        else if (ch === '"') this.inStr = false;
        continue;
      }
      if (ch === '"') this.inStr = true;
      else if (ch === "{") { this.depth++; if (this.depth === 2) this.start = i; }
      else if (ch === "}") {
        if (this.depth === 2 && this.start >= 0) { out.push(this.buf.slice(this.start, i + 1)); this.start = -1; }
        this.depth = Math.max(0, this.depth - 1);
      }
    }
    return out;
  }
}

// Ways to turn "thinking" off, tried in order. Older Flash models use thinkingBudget, Gemini 3 models use thinkingLevel.
const THINKING: Array<Record<string, unknown> | null> = [
  { thinkingBudget: 0 },
  { thinkingLevel: "minimal" },
  { thinkingLevel: "low" },
  null,
];
const thinkingByModel: Record<string, number> = {}; // learned at runtime

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ code: "no_key", error: "مفتاح GEMINI_API_KEY غير موجود. أضفه في إعدادات Vercel (Environment Variables) ثم أعد النشر." }, { status: 500 });

  let body: { context?: string; want?: Record<string, number>; avoid?: string[]; difficulty?: string; topic?: string; subject?: string; stage?: string; level?: number; branch?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ code: "bad_request", error: "طلب غير صالح" }, { status: 400 }); }

  const isMath = body.subject === "math";
  const context = cleanText(body.context ?? "", isMath).slice(0, 12000);
  // how many questions of each type to write in this batch (small batches finish well inside the time limit)
  const want: Record<string, number> = {};
  let n = 0;
  for (const k of KINDS) {
    const c = Math.max(0, Math.floor(Number(body.want?.[k]) || 0));
    if (c && n < 8) { want[k] = Math.min(c, 8 - n); n += want[k]; }
  }
  const types = Object.keys(want);
  if (context.trim().length < 200 || !types.length) return NextResponse.json({ code: "bad_request", error: "النص قصير جدًا أو لم تُحدَّد أنواع الأسئلة" }, { status: 400 });
  const level = LEVELS[body.difficulty ?? "mixed"] ?? LEVELS.mixed;
  const topic = (body.topic ?? "").trim().slice(0, 200);
  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 110)).filter(Boolean).slice(-40);
  const NAMES: Record<string, string> = { term: "term (write the scientific term)", define: "define (عرّف)", compare: "compare (قارن)", fill: "fill (complete the blank)", mcq: "mcq (multiple choice)", tf: "tf (true/false)", essay: "essay (theoretical question)", reason: "reason (علل)", problem: "problem (numeric science problem)", solve: "solve (math question the student answers with a worked solution)", balance: "balance (balance a given chemical equation)", write: "write (write a balanced chemical equation from words)" };
  const stage = (["primary", "prep", "secondary"] as const).find((x) => x === body.stage) ?? null;
  const gradeNo = Number.isInteger(body.level) && body.level! >= 1 && body.level! <= 6 ? body.level! : null;
  const branch = (Object.keys(BRANCH_LABEL) as Branch[]).find((x) => x === body.branch) ?? null;
  const rules = subjectRules(String(body.subject ?? ""), stage, gradeNo, branch, types);

  const hints = hintsFor(context, types, isMath ? "math" : undefined);
  const prompt = `${rules ? rules.trim() + "\n\n" : ""}${hints ? hints + "\n" : ""}Write exactly ${n} questions, with exactly this many of each type:
${types.map((k) => `- ${NAMES[k]}: ${want[k]}`).join("\n")}
Difficulty: ${level}.
${topic ? `Focus on this topic: ${topic}\n` : ""}${avoid.length ? `These questions were ALREADY written for other copies of the exam. Do NOT repeat them or ask the same thing in other words; write completely different questions about other facts in the text:\n${avoid.map((s) => `- ${s}`).join("\n")}\n` : ""}
TEXT:
"""
${context}
"""`;

  const keyId = createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  await addUsage(keyId); // shared counter (all devices) - only when a database is configured

  const ctrl = new AbortController();
  req.signal.addEventListener("abort", () => ctrl.abort());
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; ctrl.abort(); }, DEADLINE_MS);

  const call = (model: string, thinking: Record<string, unknown> | null, signal: AbortSignal) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: 6144,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      }),
    });

  // We answer the browser IMMEDIATELY with a stream, then talk to Gemini inside it.
  // Any problem (slow model, rate limit, timeout) is reported as a normal {"t":"err"} line instead of a 504 page.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: object) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      send({ t: "hello" }); // first byte right away
      const ext = new ObjectExtractor();
      let count = 0, buf = "";
      try {
        const models = await pickModels(apiKey);
        let lastErr: { code: string; error: string; retryAfter?: number } | null = null;
        let finished = false, dayHits = 0;
        for (let mi = 0; mi < models.length && !finished; mi++) {
          const model = models[mi], last = mi === models.length - 1;
          const mctrl = new AbortController();
          const onAbort = () => mctrl.abort();
          ctrl.signal.addEventListener("abort", onAbort);
          let stalled = false;
          const stallTimer = setTimeout(() => { stalled = true; mctrl.abort(); }, FIRST_OUTPUT_MS);
          try {
            let res: Response;
            let tIdx = thinkingByModel[model] ?? 0;
            for (;;) {
              res = await call(model, THINKING[tIdx], mctrl.signal);
              if (res.status === 400 && THINKING[tIdx] && !/api key/i.test(await res.clone().text())) { tIdx++; continue; } // this model rejects that "thinking off" setting -> try the next way
              break;
            }
            thinkingByModel[model] = tIdx;

            if (!res.ok) {
              let j: unknown = {};
              try { j = await res.json(); } catch {}
              console.error("gemini error", model, res.status, JSON.stringify(j).slice(0, 500));
              const e = classify(res.status, j);
              if (e.code === "rate_day") dayHits++; // each model has its own daily quota: only when EVERY model is out is the key really out
              if (!lastErr || lastErr.code === "error" || e.code !== "error") lastErr = e; // keep the most useful error
              // a bad key will fail on every model; anything else (busy, quota, retired model) -> try the next one
              if (lastErr.code === "bad_key" || last) break;
              continue;
            }

            const reader = res.body!.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                let j: any;
                try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
                const piece = (j.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
                if (piece) clearTimeout(stallTimer);
                for (const obj of ext.push(piece)) {
                  let raw: Raw;
                  try { raw = JSON.parse(obj); } catch { continue; }
                  const q = cleanOne(raw, types, isMath);
                  if (q) { count++; send({ t: "q", q }); }
                }
              }
            }
            finished = true;
            if (!count) {
              if (last) break;
              finished = false; lastErr = { code: "empty", error: "لم ينجح النموذج في كتابة أسئلة من هذا الجزء من النص" };
              continue;
            }
          } catch (e) {
            if (ctrl.signal.aborted) throw e; // the whole request was stopped or ran out of time
            if (count) { finished = true; break; } // keep what was written
            console.error("gemini stalled/failed", model, stalled ? "no output in time" : String(e));
            lastErr = { code: stalled ? "timeout" : "network", error: stalled ? "استغرق النموذج وقتًا طويلًا" : "تعذّر الاتصال بخدمة الذكاء الاصطناعي", retryAfter: 2 };
            if (last) break;
          } finally {
            clearTimeout(stallTimer);
            ctrl.signal.removeEventListener("abort", onAbort);
          }
        }
        if (count) { send({ t: "done", count }); await clearDayLimit(keyId); } // a model worked -> the key is usable, drop any stale "limit" flag
        else if (lastErr) {
          if (dayHits >= models.length) await markDayLimit(keyId, msUntilPacificMidnight()); // every model is out for today -> every device shows the limit
          send({ t: "err", code: lastErr.code, message: lastErr.error, retryAfter: lastErr.retryAfter });
        } else send({ t: "err", code: "empty", message: "لم ينجح النموذج في كتابة أسئلة من هذا الجزء من النص" });
      } catch {
        if (timedOut) {
          // Keep whatever was already written; only report an error if nothing arrived.
          if (count) send({ t: "done", count });
          else send({ t: "err", code: "timeout", message: "استغرق النموذج وقتًا طويلًا", retryAfter: 2 });
        } else if (!ctrl.signal.aborted) {
          send({ t: "err", code: count ? "stream" : "network", message: count ? "انقطع الاتصال بالنموذج أثناء الكتابة" : "تعذّر الاتصال بخدمة الذكاء الاصطناعي" });
        }
      } finally {
        clearTimeout(deadline);
        try { controller.close(); } catch {}
      }
    },
    cancel() { clearTimeout(deadline); ctrl.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
