// Reads the chosen pages (locally, no AI request) to find the school stage + grade (from the cover), the science branch,
// and which question types the pages can support (see lib/analyze.ts). Nothing is asked from the teacher.
import type { Avail, Branch, Stage } from "@/lib/subjects";
import { evidenceFor, extractSignals, norm } from "@/lib/analyze";

export type Detected = {
  stage: Stage | null; level: number | null; grade: string | null; branch: Branch;
  avail: Avail; pages: number; facts: number;
};

const ORD: Array<[RegExp, string]> = [
  [/^(?:الاول|الاولي)/, "الأول"], [/^(?:الثاني|الثانيه)/, "الثاني"], [/^(?:الثالث|الثالثه)/, "الثالث"],
  [/^(?:الرابع|الرابعه)/, "الرابع"], [/^(?:الخامس|الخامسه)/, "الخامس"], [/^(?:السادس|السادسه)/, "السادس"],
];
const ordinal = (s: string) => ORD.find(([r]) => r.test(s))?.[1] ?? "";
const levelOf = (s: string) => { const i = ORD.findIndex(([r]) => r.test(s)); return i >= 0 ? i + 1 : null; };

export type Source = { pages: string[]; from: number; to: number };

// One entry per chosen file: its pages and the page range the teacher typed (1-based, inclusive).
export function detectFromRanges(sources: Source[]): Detected {
  const slice = sources.flatMap((s) => s.pages.slice(Math.max(0, s.from - 1), Math.min(s.pages.length, s.to)));
  const head = norm(sources.map((s) => s.pages.slice(0, 8).join("\n")).join("\n")).replace(/\s+/g, " ").slice(0, 12000); // cover + first pages carry the grade
  const body = norm(slice.join("\n"));
  let stage: Stage | null = null, grade: string | null = null, level: number | null = null;

  const hit = head.match(/(الاول|الثاني|الثالث|الرابع|الخامس|السادس)\s+(الابتدايي|الاعدادي|الثانوي)/);
  if (hit) {
    const lv = hit[2];
    stage = lv === "الابتدايي" ? "primary" : lv === "الاعدادي" ? "prep" : "secondary";
    level = levelOf(hit[1]);
    grade = `الصف ${ordinal(hit[1])} ${lv === "الابتدايي" ? "الابتدائي" : lv === "الاعدادي" ? "الإعدادي" : "الثانوي"}`;
  }
  if (!stage) {
    const sec = (body.match(/(?:الصف|المرحله)\s+الثانوي|ثانويه عامه|الثانويه العامه/g) ?? []).length;
    const prep = (body.match(/(?:الصف|المرحله)\s+الاعدادي|المرحله الاعداديه/g) ?? []).length;
    const pri = (body.match(/(?:الصف|المرحله)\s+الابتدايي|المرحله الابتدايه/g) ?? []).length;
    const best = Math.max(sec, prep, pri);
    if (best > 0) stage = best === sec ? "secondary" : best === prep ? "prep" : "primary";
  }

  const count = (re: RegExp) => (body.match(re) ?? []).length;
  const sc = {
    physics: count(/(?:القوه|السرعه|العجله|الكهربي|المقاومه|التيار|فولت|اوم|نيوتن|الشغل|القدره|الضوء|العدسه|الحرارة)/g),
    chemistry: count(/(?:ذره|عنصر|مركب|تفاعل|حمض|قاعده|محلول|الكترون|الجدول الدوري|مول|تاكسد|عامل مختزل|فلز)/g),
    biology: count(/(?:خليه|كائن|نبات|انسان|جهاز|هرمون|وراثه|الجين|كروموسوم|التمثيل الضوئي|الدم|القلب)/g),
    geology: count(/(?:صخور|معدن|زلزال|بركان|الارض|الغلاف الصخري|التجويه|الحفريات)/g),
  };
  const top = (Object.entries(sc) as Array<[Branch, number]>).sort((a, b) => b[1] - a[1]);
  const branch: Branch = top[0][1] >= 6 && top[0][1] >= (top[1][1] || 0) * 1.4 ? top[0][0] : "general";

  const text = slice.join("\n");
  const sig = extractSignals(text);
  const avail = evidenceFor(sig, slice.length);
  return { stage, level, grade, branch, avail, pages: slice.length, facts: sig.facts };
}
