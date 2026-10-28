// Subject configuration: each subject decides which question types the tool offers,
// their default counts, and the extra instructions the AI receives.
// Science is fully configured. The other subjects use the general types for now (custom types come later).

export type Kind = "mcq" | "tf" | "reason" | "essay" | "problem" | "balance" | "write" | "term" | "define" | "compare" | "fill" | "solve";
// also the order of the sections on the exam sheet. "essay" and "problem" are no longer offered for science, but exams saved earlier still use them.
export const ALL_KINDS: Kind[] = ["mcq", "tf", "reason", "balance", "write", "term", "define", "compare", "fill", "essay", "problem", "solve"];
export const zeroCounts = (): Record<Kind, number> => Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<Kind, number>;
export const zeroTexts = (): Record<Kind, string> => Object.fromEntries(ALL_KINDS.map((k) => [k, "0"])) as Record<Kind, string>;

export type Stage = "primary" | "prep" | "secondary";
export type Branch = "general" | "physics" | "chemistry" | "biology" | "geology";

export type KindDef = {
  id: Kind;
  label: string;         // shown in the tool
  hint: string;          // one line under the field
  section: string;       // heading printed on the exam sheet
  // grades (1..6) where the type is used, per stage. A stage that is missing = the type is not used there. "all" = every grade.
  grades: Partial<Record<Stage, number[] | "all">>;
};

export type SubjectId = "science" | "arabic" | "social" | "english" | "math";

export type Subject = {
  id: SubjectId;
  name: string;
  icon: string;
  ready: boolean;        // false = general types only, custom types coming later
  tagline: string;
  kinds: KindDef[];
};

const ALL: KindDef["grades"] = { primary: "all", prep: "all", secondary: "all" };

const GENERIC: KindDef[] = [
  { id: "mcq", label: "اختيار من متعدد", hint: "", section: "اختر الإجابة الصحيحة من بين الإجابات المعطاة", grades: ALL },
  { id: "tf", label: "صح وخطأ", hint: "", section: "ضع علامة ( ✓ ) أمام العبارة الصحيحة وعلامة ( ✗ ) أمام العبارة الخاطئة", grades: ALL },
  { id: "essay", label: "مقالي", hint: "", section: "أجب عن الأسئلة التالية", grades: ALL },
];

export const SUBJECTS: Subject[] = [
  {
    id: "science", name: "العلوم", icon: "🔬", ready: true,
    tagline: "اختر · صح وخطأ · علّل · معادلات · اكتب المصطلح · عرّف · قارن · أكمل",
    kinds: [
      { id: "mcq", label: "اختر", hint: "", section: "اختر الإجابة الصحيحة من بين الإجابات المعطاة", grades: ALL },
      { id: "tf", label: "صح وخطأ", hint: "", section: "ضع علامة ( ✓ ) أمام العبارة الصحيحة وعلامة ( ✗ ) أمام العبارة الخاطئة", grades: ALL },
      { id: "reason", label: "علّل", hint: "", section: "علّل لما يأتي", grades: ALL },
      { id: "balance", label: "وزن المعادلة", hint: "", section: "زن المعادلات الكيميائية الآتية", grades: { prep: [2], secondary: "all" } },
      { id: "write", label: "كتابة المعادلة", hint: "", section: "اكتب المعادلات الكيميائية الرمزية الموزونة لكل مما يأتي", grades: { prep: [3], secondary: "all" } },
      { id: "term", label: "اكتب المصطلح", hint: "", section: "اكتب المصطلح العلمي الدال على كل عبارة مما يأتي", grades: ALL },
      { id: "define", label: "عرّف", hint: "", section: "عرّف كلًّا مما يأتي", grades: ALL },
      { id: "compare", label: "قارن", hint: "", section: "قارن بين كل مما يأتي", grades: ALL },
      { id: "fill", label: "أكمل", hint: "", section: "أكمل الفراغات الآتية بما يناسبها", grades: ALL },
      { id: "problem", label: "مسائل (احسب)", hint: "", section: "احسب ما يأتي", grades: { prep: "all", secondary: "all" } },
    ],
  },
  { id: "arabic", name: "العربي", icon: "📖", ready: false, tagline: "أنواع الأسئلة الخاصة بالعربي تُضاف قريبًا", kinds: GENERIC },
  { id: "social", name: "الدراسات", icon: "🌍", ready: false, tagline: "أنواع الأسئلة الخاصة بالدراسات تُضاف قريبًا", kinds: GENERIC },
  { id: "english", name: "الانجليزي", icon: "🔤", ready: false, tagline: "أنواع الأسئلة الخاصة بالإنجليزي تُضاف قريبًا", kinds: GENERIC },
  {
    id: "math", name: "الرياضيات", icon: "➗", ready: true,
    tagline: "اختر · أجب عن الأسئلة",
    kinds: [
      { id: "mcq", label: "اختر", hint: "", section: "اختر الإجابة الصحيحة من بين الإجابات المعطاة", grades: ALL },
      { id: "solve", label: "أجب عن الأسئلة", hint: "", section: "أجب عن الأسئلة الآتية", grades: ALL },
    ],
  },
];

export const getSubject = (id: string | null | undefined): Subject | undefined => SUBJECTS.find((s) => s.id === id);

// Sheet headings for every kind (first definition wins).
export const SECTION_TITLE: Record<Kind, string> = (() => {
  const m = {} as Record<Kind, string>;
  for (const s of SUBJECTS) for (const k of s.kinds) if (!m[k.id]) m[k.id] = k.section;
  return m;
})();
export const KIND_LABEL: Record<Kind, string> = {
  mcq: "اختر", tf: "صح وخطأ", essay: "نظري", reason: "علّل", problem: "مسألة", balance: "وزن معادلة", write: "كتابة معادلة",
  term: "اكتب المصطلح", define: "عرّف", compare: "قارن", fill: "أكمل", solve: "أجب",
};

export const STAGE_LABEL: Record<Stage, string> = { primary: "المرحلة الابتدائية", prep: "المرحلة الإعدادية", secondary: "المرحلة الثانوية" };
export const STAGE_SHORT: Record<Stage, string> = { primary: "الابتدائي", prep: "الإعدادي", secondary: "الثانوي" };
export const BRANCH_LABEL: Record<Branch, string> = { general: "علوم عامة", physics: "فيزياء", chemistry: "كيمياء", biology: "أحياء", geology: "جيولوجيا" };
export const GRADE_ORD = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
export const gradesOf = (st: Stage) => (st === "primary" ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]);
export const gradeName = (st: Stage | null, lv: number | null) => (st && lv ? `الصف ${GRADE_ORD[lv - 1]} ${STAGE_SHORT[st]}` : null);

// What the file analysis found for each question type in the chosen pages.
//  n = how much material supports the type, suggest = how many questions of it one copy could sensibly have.
export type KindAvail = { ok: boolean; n: number; suggest: number; why?: string };
export type Avail = Partial<Record<Kind, KindAvail>>;

// null = nothing analysed yet (the analysis runs only after the teacher typed the page numbers)
export function kindStatus(k: KindDef, stage: Stage | null, level: number | null, avail: Avail | null): { ok: boolean; why?: string } {
  if (stage) {
    const g = k.grades[stage];
    if (!g) return { ok: false, why: `لا يُستخدم في ${STAGE_LABEL[stage]}` };
    if (g !== "all" && level && !g.includes(level)) return { ok: false, why: `لا يُستخدم في ${gradeName(stage, level)}` };
  }
  const a = avail?.[k.id];
  if (a && !a.ok) return { ok: false, why: a.why || "لا تدعمه الصفحات المحددة" };
  return { ok: true };
}

// Default counts for ONE copy of the exam.
// Science: every box starts at 0 - the teacher chooses (or presses "apply the suggestion" after the file analysis).
// The other subjects (general types only for now) keep their simple defaults.
export function defaultCounts(subject: Subject): Record<Kind, number> {
  const out = zeroCounts();
  if (!subject.ready) { out.mcq = 10; out.tf = 5; out.essay = 5; }
  return out;
}
