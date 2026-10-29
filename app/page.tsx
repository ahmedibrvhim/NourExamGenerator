"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import SubjectGate from "@/components/SubjectGate";
import AiStatus from "@/components/AiStatus";
import GenerationPanel, { Gen } from "@/components/GenerationPanel";
import Library from "@/components/Library";
import ReviewPanel, { Draft, Slot } from "@/components/ReviewPanel";
import { Chunk, Exam, OcrError, Q, chunkPages, dealSets, exportExam, extractPages, isBlankPage, ocrPages, pickChunks, shuffle } from "@/exam";
import { listExams, removeExam, saveExam } from "@/lib/db";
import { Fail, streamBatch } from "@/lib/ai";
import { detectFromRanges } from "@/lib/detect";
import { extractSignals, type Signals } from "@/lib/analyze";
import { ALL_KINDS, BRANCH_LABEL, STAGE_LABEL, defaultCounts, getSubject, gradeName, kindStatus, zeroCounts, zeroTexts, type Avail, type Branch, type Kind, type Stage, type SubjectId } from "@/lib/subjects";
import { Limit, fmtDuration, getKeyId, getLimit, getUsage, isKeySeen, markKeySeen, msUntilPacificMidnight, recordRequest, saveLimit, setKeyId } from "@/lib/limits";

type SrcFile = { id: string; name: string; size: number; file: File; pages?: string[]; progress?: [number, number] };
type ToastState = { msg: string; kind: "success" | "error" | "info" } | null;

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const SUBJECT_KEY = "centerapp-subject";
const zero = zeroCounts, zeroText = zeroTexts;
const HEAD_PAGES = 3;      // cover pages read too when the book is scanned (they carry the grade)
// how much material of each type a group of text has: the questions of a type are written mostly from the groups that support it
const EVIDENCE: Partial<Record<Kind, (s: Signals) => number>> = {
  reason: (s) => s.reason.length, compare: (s) => s.compare.length,
  term: (s) => s.term.length + s.define.length, define: (s) => s.term.length + s.define.length,
  balance: (s) => s.equations.length, write: (s) => s.equations.length,
  problem: (s) => s.problems.length + s.laws.length,
};
const MAX_PER_TYPE = 100;
const DIFFS = [["mixed", "متنوع"], ["easy", "سهل"], ["medium", "متوسط"], ["hard", "صعب"]] as const;
const MAX_OCR_PAGES = 400; // scanned pages read per exam (local OCR: no quota, only time)

const fmtSize = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const stripPdf = (n: string) => n.replace(/\.pdf$/i, "");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
// Arabic-Indic (٠-٩) and Persian (۰-۹) digits -> 0-9, so typing ٢١ works like 21
const toLatin = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
const digitsOnly = (s: string) => toLatin(s).replace(/\D/g, "").slice(0, 4);
const normQ = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Wait `ms`, but stop immediately (and throw) if the user presses Stop.
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

// The AI tends to put the right answer first. Put it where it has been used least so far (posCount), shuffle the other choices.
const placeAnswer = (q: Q, posCount: number[]): Q => {
  if (q.kind !== "mcq" || !q.answer || q.choices.length < 2) return q;
  const n = q.choices.length, others = shuffle(q.choices.filter((c) => c !== q.answer), Math.random as () => number);
  const min = Math.min(...posCount.slice(0, n));
  const cands = [...Array(n).keys()].filter((i) => posCount[i] === min);
  const pos = cands[Math.floor(Math.random() * cands.length)];
  posCount[pos]++;
  const choices = [...others]; choices.splice(pos, 0, q.answer);
  return { ...q, choices };
};

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Draft | null>(null);            // always the latest draft (async replacement code reads it)
  const draftAbort = useRef<AbortController | null>(null); // cancels pending replacement requests when the draft is closed
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<SrcFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [loadingDb, setLoadingDb] = useState(true);
  const [running, setRunning] = useState(false);
  const [gen, setGen] = useState<Gen | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null); // questions waiting for review (not saved yet)
  const [limit, setLimit] = useState<Limit>(null);
  const [usage, setUsage] = useState(0);
  const [shared, setShared] = useState(false); // the counter comes from the server (same number on every device)
  const [toast, setToast] = useState<ToastState>(null);
  const [title, setTitle] = useState("");
  const [grade, setGrade] = useState(""); // total mark printed on the exam sheet (optional)
  // how many questions of each type ONE copy of the exam has (text, so typing "30" is not interrupted; clamped only when used)
  const [subjectId, setSubjectId] = useState<SubjectId | null | undefined>(undefined); // undefined = still reading the saved choice
  const subject = getSubject(subjectId);
  const [forced, setForced] = useState<Kind[]>([]);      // question types the teacher switched on although the pages do not seem to fit
  const touchedCounts = useRef(false);                   // true once the teacher typed a count: then the smart defaults stop overwriting it
  const [countText, setCountText] = useState<Record<Kind, string>>(zeroText());
  const activeKinds: Kind[] = subject ? subject.kinds.map((k) => k.id) : [];
  const [versions, setVersions] = useState(1);
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState("mixed");
  // page range of every chosen file (typed text). The file analysis of the science tool needs it and waits until typing pauses.
  const [ranges, setRanges] = useState<Record<string, { from: string; to: string }>>({});
  const [dRanges, setDRanges] = useState(ranges);
  useEffect(() => { const t = setTimeout(() => setDRanges(ranges), 700); return () => clearTimeout(t); }, [ranges]);
  const settled = ranges === dRanges;

  const notify = (msg: string, kind: "success" | "error" | "info" = "info") => {
    setToast({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3800);
  };

  // the subject picked earlier in this browser session (the picker shows once per session; "تغيير" in the header reopens it)
  useEffect(() => {
    let id: string | null = null;
    try { id = sessionStorage.getItem(SUBJECT_KEY); } catch {}
    setSubjectId(getSubject(id) ? (id as SubjectId) : null);
  }, []);

  // load saved exams + remembered daily limit when the page opens
  useEffect(() => {
    syncKey();
    const onFocus = () => syncKey();
    window.addEventListener("focus", onFocus);
    listExams().then(setExams).catch(() => notify("تعذّر فتح قاعدة البيانات المحلية (قد يكون المتصفح في وضع التصفح الخفي)", "error")).finally(() => setLoadingDb(false));
    try { navigator.storage?.persist?.(); } catch {} // ask the browser not to delete our data when disk space is low
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Which API key does the server use now? The request counter and the "limit reached" state belong to ONE key:
  // a different key starts from 0, and a key that already hit its limit (even from another device) shows it right away.
  const syncKey = async () => {
    try {
      const r = await fetch("/api/key", { cache: "no-store" });
      const k = await r.json();
      const id: string = k.id || "none";
      if (id !== getKeyId()) { setKeyId(id); setLimit(getLimit()); setUsage(getUsage()); }
      setShared(!!k.shared);
      if (k.shared) {
        setUsage(k.usage ?? 0);
        if (k.dayLeftMs > 0) { const l: Limit = { kind: "day", until: Date.now() + k.dayLeftMs }; saveLimit(l); setLimit(l); }
        else if (getLimit()?.kind === "day") { saveLimit(null); setLimit(null); } // the server says this key is fine again
      }
      if (k.hasKey && !isKeySeen(id)) {
        markKeySeen(id);
        const p = await (await fetch("/api/key?probe=1", { cache: "no-store" })).json();
        if (getKeyId() !== id) return; // the key changed again while we were asking
        if (p.status === "rate_day") { const l: Limit = { kind: "day", until: Date.now() + msUntilPacificMidnight() }; saveLimit(l); setLimit(l); }
        else if (p.status === "rate_minute") setLimit({ kind: "minute", until: Date.now() + clamp(p.retryAfter ?? 30, 5, 90) * 1000 });
        else if (p.status === "bad_key") notify("مفتاح API غير صالح أو غير مفعّل", "error");
      }
    } catch { setLimit(getLimit()); setUsage(getUsage()); }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const ok: SrcFile[] = [];
    for (const f of Array.from(list)) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) { notify(`«${f.name}» ليس ملف PDF`, "error"); continue; }
      ok.push({ id: crypto.randomUUID(), name: f.name, size: f.size, file: f });
    }
    if (!ok.length) return;
    setFiles((p) => [...p, ...ok]);
    setSelected((s) => [...s, ...ok.map((f) => f.id)]);
    for (const f of ok) {
      extractPages(f.file, (d, t) => setFiles((p) => p.map((x) => (x.id === f.id ? { ...x, progress: [d, t] } : x))))
        .then((pages) => setFiles((p) => p.map((x) => (x.id === f.id ? { ...x, pages } : x))))
        .catch(() => { notify(`تعذّرت قراءة «${f.name}» — قد يكون الملف تالفًا أو أكبر من ذاكرة المتصفح`, "error"); setFiles((p) => p.filter((x) => x.id !== f.id)); setSelected((s) => s.filter((x) => x !== f.id)); });
    }
    if (!title) setTitle(stripPdf(ok[0].name));
    notify(`تم رفع ${ok.length} ملف`, "success");
  };

  const removeFile = (id: string) => {
    setFiles((p) => p.filter((f) => f.id !== id));
    setSelected((s) => s.filter((x) => x !== id));
  };
  const toggleFile = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const chosen = files.filter((f) => selected.includes(f.id));
  const ready = chosen.length > 0 && chosen.every((f) => f.pages);
  const dayLimited = !!limit && limit.kind === "day" && limit.until > Date.now();
  // Keep the screen on while the app is working (OCR / writing questions / replacements): a locked phone freezes the page.
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null); // reading scanned pages right after upload (needed for the file analysis)
  const working = running || !!scan || files.some((f) => !f.pages) || !!draft?.sets.flat().some((x) => x.state === "loading");
  useEffect(() => {
    if (!working) return;
    let lock: { release: () => Promise<void> } | null = null, dead = false;
    const get = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch {} };
    const onVis = () => { if (document.visibilityState === "visible" && !dead) void get(); }; // the lock is dropped when the page is hidden: take it again
    void get();
    document.addEventListener("visibilitychange", onVis);
    return () => { dead = true; document.removeEventListener("visibilitychange", onVis); try { void lock?.release(); } catch {} };
  }, [working]);
  const rangeOf = (f: SrcFile, src = ranges) => {
    const n = f.pages?.length ?? 0, max = Math.max(1, n);
    const a = parseInt(toLatin(src[f.id]?.from ?? "")) || 0, b = parseInt(toLatin(src[f.id]?.to ?? "")) || 0;
    const x = clamp(a || 1, 1, max), y = clamp(b || n, 1, max);
    return { n, typed: a > 0 && b > 0, any: a > 0 || b > 0, from: Math.min(x, y), to: Math.max(x, y) };
  };
  const setRange = (id: string, k: "from" | "to", v: string) => setRanges((p) => ({ ...p, [id]: { from: p[id]?.from ?? "", to: p[id]?.to ?? "", [k]: v } }));
  const commitRange = (f: SrcFile) => {
    const a = parseInt(toLatin(ranges[f.id]?.from ?? "")), b = parseInt(toLatin(ranges[f.id]?.to ?? ""));
    const n = f.pages?.length ?? 0, max = Math.max(1, n);
    if (!a && !b) return;
    const x = clamp(a || 1, 1, max), y = clamp(b || n, 1, max);
    if (a && b && a > b) notify(`الرقمان معكوسان — تم التبديل: من ${y} إلى ${x}`, "info");
    else if ((a && a > max) || (b && b > max)) notify(`الكتاب فيه ${n} صفحة فقط — تم التعديل`, "info");
    setRanges((p) => ({ ...p, [f.id]: { from: a ? String(Math.min(x, y)) : "", to: b ? String(Math.max(x, y)) : "" } }));
  };
  const needRange = !!subject?.ready;   // science: the analysis and the question types wait for the page numbers
  const rangesOk = !needRange || (chosen.length > 0 && chosen.every((f) => f.pages && rangeOf(f, dRanges).typed));
  const rangeLabel = chosen.map((f) => { const r = rangeOf(f); return r.any ? `ص ${r.from}–${r.to}` : "كل الصفحات"; }).join(" + ");

  // ---------- scanned books: read the pages the analysis needs (cover pages + the chosen pages) as soon as the file is uploaded ----------
  const filesRef = useRef<SrcFile[]>([]); filesRef.current = files;
  const attempted = useRef<Set<string>>(new Set()); // pages already sent to OCR (a page that stays empty must not be retried forever)
  // MATH: the text layer of a PDF can never be trusted (a book exported from Word loses fractions, roots and digits: "2,000" becomes "20222").
  // So for math EVERY page of the chosen range is read by the local OCR once, and the text layer is ignored. Other subjects only OCR pages without text.
  const isMath = subject?.id === "math";
  const mathRead = useRef<Set<string>>(new Set()); // "fileId:page" already read by the math OCR
  const needsOcr = (f: SrcFile, p: number) => (isMath ? !mathRead.current.has(`${f.id}:${p}`) : isBlankPage(f.pages![p - 1]));
  // 1-based page numbers the analysis needs for one file: ONLY the typed page range (+ the cover pages to find the grade)
  const needPages = (f: SrcFile): number[] => {
    if (!f.pages || !needRange) return [];
    const r = rangeOf(f, dRanges);
    if (!r.typed) return [];
    const set = new Set<number>();
    for (let p = 1; p <= Math.min(HEAD_PAGES, r.n); p++) set.add(p);
    for (let p = r.from; p <= r.to; p++) set.add(p);
    return [...set].sort((a, b) => a - b).slice(0, MAX_OCR_PAGES);
  };
  const pendingScan = (f: SrcFile) => needPages(f).filter((p) => needsOcr(f, p) && !attempted.current.has(`${f.id}:${p}`));
  const needKey = chosen.map((f) => `${f.id}:${needPages(f).join(",")}`).join("|");
  useEffect(() => {
    if (!subject?.ready) return;
    const cur = filesRef.current.filter((f) => selected.includes(f.id) && f.pages);
    if (!cur.length) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const jobs = cur.map((f) => ({ f, nums: pendingScan(f) })).filter((j) => j.nums.length);
      if (!jobs.length) return;
      const total = jobs.reduce((n, j) => n + j.nums.length, 0);
      let done = 0;
      setScan({ done: 0, total });
      try {
        for (const j of jobs) {
          const base = done;
          try {
            await ocrPages(j.f.file, j.nums, ctrl.signal, {
              math: isMath,
              onProgress: (d) => setScan({ done: base + d, total }),
              onPage: (n, txt) => { if (isMath) mathRead.current.add(`${j.f.id}:${n}`); setFiles((p) => p.map((x) => (x.id === j.f.id && x.pages ? { ...x, pages: x.pages.map((pg, i) => (i === n - 1 ? txt : pg)) } : x))); },
            });
          } catch (e) { if (ctrl.signal.aborted) return; }
          for (const n of j.nums) attempted.current.add(`${j.f.id}:${n}`);
          done += j.nums.length;
        }
      } finally { if (!ctrl.signal.aborted) setScan(null); }
    }, 900);
    return () => { clearTimeout(t); ctrl.abort(); setScan(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, subject?.id]);

  // ---------- smart analysis: grade (from the cover) + science branch + which question types the typed pages can support ----------
  // It starts only after the page numbers are typed, and shows once every text page it needs has been read (scanned pages go through OCR first).
  const analysisReady = !needRange || (rangesOk && settled && ready && chosen.every((f) => f.pages && pendingScan(f).length === 0));
  const readyKey = chosen.map((f) => { const r = rangeOf(f, dRanges); return `${f.id}:${f.pages ? f.pages.filter((t) => !isBlankPage(t)).length : 0}:${r.from}-${r.to}`; }).join("|");
  const detected = useMemo(() => {
    if (!needRange || !analysisReady || !chosen.length) return null;
    return detectFromRanges(chosen.map((f) => { const r = rangeOf(f, dRanges); return { pages: f.pages!, from: r.from, to: r.to }; }), subject?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey, subject?.id, analysisReady]);
  const stage: Stage | null = detected?.stage ?? null;
  const level: number | null = detected?.level ?? null;
  const branch: Branch = detected?.branch ?? "general";
  const avail: Avail | null = detected?.avail ?? null;
  const fileKey = selected.join(",");
  useEffect(() => { touchedCounts.current = false; setForced([]); attempted.current = new Set(); }, [fileKey, subject?.id]); // new files or subject -> start again
  useEffect(() => { if (subject) { const d = defaultCounts(subject), t = zeroText(); for (const k of subject.kinds) t[k.id] = String(d[k.id]); setCountText(t); } }, [subject?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = needRange && !analysisReady;           // the question boxes stay closed (0) until the analysis is done
  const isOn = (id: Kind) => { const kd = subject?.kinds.find((k) => k.id === id); return !!kd && !locked && (kindStatus(kd, stage, level, avail).ok || forced.includes(id)); };
  const perType = zero();
  for (const k of activeKinds) perType[k] = isOn(k) ? clamp(parseInt(toLatin(countText[k])) || 0, 0, MAX_PER_TYPE) : 0;
  const perVersion = ALL_KINDS.reduce((n, k) => n + perType[k], 0); // questions on one copy
  const count = perVersion * versions;                        // questions the AI must write in total: every copy has its own questions
  const canGenerate = ready && perVersion > 0 && !running && !draft && !scan && analysisReady;
  const suggestion = (() => { const o = zero(); if (subject && avail) for (const kd of subject.kinds) if (kindStatus(kd, stage, level, avail).ok) o[kd.id] = avail[kd.id]?.suggest ?? 0; return o; })();
  const suggestTotal = ALL_KINDS.reduce((n, k) => n + suggestion[k], 0);
  const applySuggestion = () => { touchedCounts.current = true; const t = zeroText(); for (const k of activeKinds) t[k] = String(suggestion[k]); setCountText(t); };

  const chooseSubject = (id: SubjectId) => {
    try { sessionStorage.setItem(SUBJECT_KEY, id); } catch {}
    touchedCounts.current = false; setForced([]);
    setSubjectId(id);
  };
  const changeSubject = () => {
    if (draft || running) { notify("أنهِ أو ألغِ الأسئلة الحالية قبل تغيير المادة", "info"); return; }
    try { sessionStorage.removeItem(SUBJECT_KEY); } catch {}
    setSubjectId(null);
  };

  // build the exam object, show it, and save it to the browser database
  const addExam = async (sets: Q[][], seed: number, info: string, meta: { title: string; sources: string[]; grade?: string; subject?: string; stage?: string }) => {
    const e: Exam = {
      id: crypto.randomUUID(), title: meta.title, sources: meta.sources,
      questions: sets.flat(), sets, versions: LETTERS.slice(0, sets.length), seed, shuffleQ: false, shuffleA: false,
      date: new Date().toLocaleDateString("ar-EG"), createdAt: Date.now(), info, grade: meta.grade, subject: meta.subject, stage: meta.stage,
    };
    setExams((p) => [e, ...p]);
    try { await saveExam(e); } catch { notify("تعذّر الحفظ الدائم — الاختبار متاح حتى إغلاق الصفحة فقط", "error"); }
  };

  // back to the state of a freshly opened tool (the saved exams in the library stay)
  const resetForm = () => {
    setFiles([]); setSelected([]);
    setTitle(""); setGrade("");
    touchedCounts.current = false; setForced([]); attempted.current = new Set();
    if (subject) { const d = defaultCounts(subject), t = zeroText(); for (const k of subject.kinds) t[k.id] = String(d[k.id]); setCountText(t); }
    setVersions(1); setTopic(""); setDifficulty("mixed");
    setRanges({}); setDRanges({});
  };

  // The AI writes new questions; they appear on screen one by one
  const generateAI = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = Date.now();

    // Step 0: scanned pages (pictures without text) are read by the AI first
    const pagesOf: Record<string, string[]> = {};
    for (const f of chosen) pagesOf[f.id] = [...f.pages!];
    let todo = chosen.flatMap((f) => {
      const { from: a, to: b } = rangeOf(f);
      const nums: number[] = [];
      for (let p = a; p <= b; p++) if (needsOcr(f, p)) nums.push(p);
      return nums.length ? [{ f, nums }] : [];
    });
    const blankTotal = todo.reduce((n, t) => n + t.nums.length, 0);
    const nonBlank = chosen.reduce((n, f) => {
      const { from: a, to: b } = rangeOf(f);
      return n + f.pages!.slice(a - 1, b).filter((t, i) => !needsOcr(f, a + i)).length;
    }, 0);
    if (blankTotal > 0 && (isMath || blankTotal >= nonBlank)) {
      // Every scanned page in the range is read (needed so the questions cover the whole range).
      let budget = MAX_OCR_PAGES;
      if (blankTotal > MAX_OCR_PAGES) notify(`عدد الصفحات الممسوحة ${blankTotal} — سيتم قراءة أول ${MAX_OCR_PAGES} صفحة فقط`, "info");
      todo = todo.map((t) => { const nums = t.nums.slice(0, Math.max(0, budget)); budget -= nums.length; return { f: t.f, nums }; }).filter((t) => t.nums.length);
      const total = todo.reduce((n, t) => n + t.nums.length, 0);
      let done = 0;
      const show = (message: string) => setGen({ phase: "writing", batch: 0, batches: 1, target: count, qs: [], startedAt, message });
      show(`الملف ممسوح ضوئيًا — جارٍ قراءة ${total} صفحة (OCR على جهازك)…`);
      setTimeout(() => genRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
      try {
        for (const t of todo) {
          const base = done;
          const res = await ocrPages(t.f.file, t.nums, ctrl.signal, {
            math: isMath,
            onProgress: (d) => show(`جارٍ قراءة الصفحات الممسوحة: ${base + d} من ${total}…`),
          });
          done += t.nums.length;
          for (const [n, txt] of Object.entries(res)) { pagesOf[t.f.id][Number(n) - 1] = txt; if (isMath) mathRead.current.add(`${t.f.id}:${n}`); }
          setFiles((p) => p.map((x) => (x.id === t.f.id ? { ...x, pages: pagesOf[t.f.id] } : x))); // remember, so a second exam doesn't re-read
        }
      } catch (err) {
        abortRef.current = null;
        const stopped = ctrl.signal.aborted;
        if (err instanceof OcrError && err.code === "rate_day") {
          const l: Limit = { kind: "day", until: Date.now() + msUntilPacificMidnight() };
          saveLimit(l); setLimit(l);
        }
        setGen({ phase: stopped ? "stopped" : "failed", batch: 0, batches: 1, target: count, qs: [], startedAt, endedAt: Date.now(), message: stopped ? "تم الإيقاف." : err instanceof OcrError ? err.message : "تعذّرت قراءة الصفحات الممسوحة. حاول مرة أخرى." });
        return;
      }
    }

    const all: Chunk[] = chosen.flatMap((f) => { const r = rangeOf(f); return chunkPages(pagesOf[f.id], r.from, r.to); });
    if (all.reduce((n, c) => n + c.text.length, 0) < 400) {
      abortRef.current = null; setGen(null);
      notify("لم أجد نصًا كافيًا في الصفحات المحددة", "error"); return;
    }
    const picked = pickChunks(all, topic, clamp(Math.ceil(count / 2), 2, 40));
    if (!picked.length) { notify(`لم أجد الموضوع «${topic}» في الصفحات المحددة`, "error"); return; }
    const groups: Chunk[][] = [];
    for (let i = 0; i < picked.length; i += 2) groups.push(picked.slice(i, i + 2));

    // Every copy of the exam gets its OWN questions, so the AI must write (questions per copy) x (number of copies) of each type.
    const quota = zero(), have = zero();
    for (const k of ALL_KINDS) quota[k] = perType[k] * versions;
    const missing = () => ALL_KINDS.reduce((n, k) => n + quota[k] - have[k], 0);
    // smart split: types that need special material (علل, قارن, مصطلح, تعريف, معادلات) are asked mostly from the text groups that contain it
    const sigs = groups.map((g) => extractSignals(g.map((c) => c.text).join("\n\n")));
    const weight = (k: Kind, j: number) => { const f = EVIDENCE[k]; return f ? f(sigs[j]) : 1; };
    const got: Q[] = [], seen = new Set<string>();
    setGen({ phase: "writing", batch: 1, batches: groups.length, target: count, qs: [], startedAt });
    setTimeout(() => genRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);

    const posCount = [0, 0, 0, 0, 0, 0];
    const balance = (q: Q): Q => placeAnswer(q, posCount);
    const push = (q: Q) => {
      const k = normQ(q.text);
      if (seen.has(k) || have[q.kind] >= quota[q.kind]) return;
      seen.add(k); have[q.kind]++; got.push(balance(q));
      setGen((g) => (g ? { ...g, qs: [...got] } : g));
    };

    let end: { phase: Gen["phase"]; message?: string } = { phase: "done" };
    let passStart = 0;
    let lastReq = 0; // free Gemini allows only ~5 requests/minute on 2.5-flash: keep ~12.5s between requests so we do not hit the per-minute limit
    outer: for (let i = 0; i < groups.length * 4 && missing() > 0; i++) {
      const gi = i % groups.length;
      if (gi === 0 && i > 0) { if (got.length === passStart) break; passStart = got.length; } // extra pass only if the last one added something
      // how many of each type to ask for in this batch: the remaining need spread over the remaining text groups (max 8 questions per batch)
      const wantNow: Record<string, number> = {};
      for (const k of activeKinds) {
        const need = quota[k] - have[k];
        if (need <= 0) continue;
        let tot = 0;
        for (let j = gi; j < groups.length; j++) tot += weight(k, j);
        const share = tot > 0 ? Math.ceil((need * weight(k, gi)) / tot) : Math.ceil(need / (groups.length - gi));
        if (share > 0) wantNow[k] = Math.min(need, share);
      }
      if (!Object.keys(wantNow).length) continue; // nothing in this group suits the types still missing
      const sumOf = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
      while (sumOf(wantNow) > 8) { const big = Object.keys(wantNow).sort((a, b) => wantNow[b] - wantNow[a])[0]; wantNow[big]--; }
      const avoid = got.slice(-40).map((q) => q.text); // so the next copies get questions that differ from the ones already written
      setGen((g) => (g ? { ...g, batch: gi + 1 } : g));
      for (let attempt = 0; ; attempt++) {
        { const wait = lastReq + 12500 - Date.now(); if (lastReq && wait > 0) { try { await sleep(wait, ctrl.signal); } catch { end = { phase: "stopped" }; break outer; } } lastReq = Date.now(); }
        { const n = recordRequest(); setUsage((u) => (shared ? u + 1 : n)); }
        const want: Record<string, number> = {}; // each retry asks for fewer questions so it finishes faster
        for (const k of Object.keys(wantNow)) want[k] = Math.max(1, Math.ceil(wantNow[k] / (attempt + 1)));
        let fail: Fail | null;
        try {
          fail = await streamBatch({ context: groups[gi].map((c) => c.text).join("\n\n"), want, avoid, difficulty, topic: topic.trim(), subject: subject?.id, stage, level, branch }, ctrl.signal, push);
        } catch {
          if (ctrl.signal.aborted) { end = { phase: "stopped" }; break outer; }
          fail = { code: "network", message: "تعذّر الاتصال بالخادم. تأكد أن التطبيق ما زال يعمل." };
        }
        if (!fail) break;

        if (fail.code === "rate_day") {
          const l: Limit = { kind: "day", until: Date.now() + msUntilPacificMidnight() };
          saveLimit(l); setLimit(l);
          end = { phase: "partial", message: `انتهى الحد اليومي المجاني للذكاء الاصطناعي. يتجدد بعد ${fmtDuration(l.until - Date.now())} تقريبًا.` };
          break outer;
        }
        if ((fail.code === "rate_minute" || fail.code === "busy" || fail.code === "timeout") && attempt < 3) {
          const secs = clamp(fail.retryAfter ?? 20, 5, 90);
          setLimit({ kind: fail.code === "busy" || fail.code === "timeout" ? "busy" : "minute", until: Date.now() + secs * 1000, why: `${fail.code}: ${fail.message}` });
          try { await sleep(secs * 1000, ctrl.signal); } catch { end = { phase: "stopped" }; setLimit(getLimit()); break outer; }
          setLimit(getLimit());
          continue;
        }
        end = { phase: "partial", message: fail.message };
        break outer;
      }
    }
    setLimit(getLimit());
    abortRef.current = null;

    // finish: save whatever we have
    const endedAt = Date.now();
    if (!got.length) {
      const stopped = end.phase === "stopped";
      setGen({ phase: stopped ? "stopped" : "failed", batch: 0, batches: groups.length, target: count, qs: [], startedAt, endedAt, message: stopped ? "تم الإيقاف قبل كتابة أي سؤال." : end.message || "لم يستطع الذكاء الاصطناعي كتابة أسئلة من هذا النص. جرّب صفحات أخرى أو موضوعًا مختلفًا." });
      return;
    }
    const info = `${subject?.name ?? "ذكاء اصطناعي"}${gradeName(stage, level) ? ` · ${gradeName(stage, level)}` : stage ? ` · ${STAGE_LABEL[stage]}` : ""} · ${rangeLabel}${topic.trim() ? ` · ${topic.trim()}` : ""} · ${DIFFS.find(([k]) => k === difficulty)?.[1]}`;
    const sets = dealSets(got, versions).filter((s) => s.length);
    const askReview = "راجع الأسئلة ثم اضغط «إنشاء الاختبار».";
    let message = "";
    if (end.phase === "stopped") message = `تم الإيقاف — كُتب ${got.length} سؤالًا. ${askReview}`;
    else if (end.phase === "partial") message = `${end.message} — كُتب ${got.length} سؤالًا من ${count}. ${askReview}`;
    else if (got.length < count) message = `كتب الذكاء الاصطناعي ${got.length} سؤالًا فقط من ${count} لأن النص لا يحتوي مادة كافية لأسئلة مختلفة لكل النسخ. ${askReview}`;
    // The exam is NOT saved yet: the teacher reviews the questions first (delete = the AI writes another one of the same type).
    const d: Draft = {
      sets: sets.map((st) => st.map((q) => ({ id: crypto.randomUUID(), kind: q.kind, q, state: "ok" as const }))),
      versions: LETTERS.slice(0, sets.length),
      title: title.trim() || stripPdf(chosen[0].name), sources: chosen.map((f) => f.name), grade: grade.trim() || undefined, info,
      message: message || undefined, phase: end.phase as Draft["phase"],
      groups: groups.map((g) => g.map((c) => c.text).join("\n\n")),
      difficulty, topic: topic.trim(), removed: [], target: count, subject: subject?.id, stage, level, branch,
    };
    draftAbort.current?.abort();
    draftAbort.current = new AbortController();
    draftRef.current = d;
    setDraft(d);
    setGen(null);
    setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
    notify("اكتملت كتابة الأسئلة — راجعها قبل إنشاء الاختبار", "success");
  };

  // ---------- review step ----------
  const patchDraft = (fn: (d: Draft) => Draft) => {
    if (!draftRef.current) return;
    const d = fn(draftRef.current);
    draftRef.current = d; setDraft(d);
  };
  const patchSlot = (id: string, patch: Partial<Slot>) =>
    patchDraft((d) => ({ ...d, sets: d.sets.map((st) => st.map((x) => (x.id === id ? { ...x, ...patch } : x))) }));

  // Replacements go through ONE queue. Deleting many questions quickly used to fire one Gemini request per question at the same time
  // and hit the free per-minute limit. Now every pending slot waits in the queue, slots are grouped into ONE request (up to 8 questions),
  // and requests are spaced ~12.5s apart.
  const pendingRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);
  const lastReplRef = useRef(0);

  const writeBatch = async (ids: string[], sig: AbortSignal) => {
    const d = draftRef.current;
    if (!d) return;
    const slots = ids.map((id) => d.sets.flat().find((x) => x.id === id)).filter((x): x is Slot => !!x);
    if (!slots.length) return;
    const need: Record<string, number> = {};
    for (const sl of slots) need[sl.kind] = (need[sl.kind] ?? 0) + 1;

    const texts = d.sets.flat().flatMap((x) => (x.q ? [x.q.text] : []));
    const avoid = [...texts, ...d.removed].slice(-40);
    const banned = new Set(d.removed.map(normQ));
    const collected: Record<string, Q[]> = Object.fromEntries(ALL_KINDS.map((k) => [k, [] as Q[]]));
    const taken = (t: string) => {
      const k = normQ(t);
      return banned.has(k) || Object.values(collected).some((arr) => arr.some((q) => normQ(q.text) === k)) || !!draftRef.current?.sets.flat().some((x) => x.q && normQ(x.q.text) === k);
    };
    const order = shuffle(d.groups.map((_, i) => i), Math.random as () => number);
    const remaining = () => { const w: Record<string, number> = {}; for (const k of Object.keys(need)) { const r = need[k] - collected[k].length; if (r > 0) w[k] = r; } return w; };
    let fail: Fail | null = null;
    try {
      for (let a = 0; a < 4 && Object.keys(remaining()).length; a++) {
        const want = remaining();
        { const n = recordRequest(); setUsage((u) => (shared ? u + 1 : n)); }
        lastReplRef.current = Date.now();
        fail = await streamBatch(
          { context: d.groups[order[a % order.length]], want, avoid, difficulty: d.difficulty, topic: d.topic, subject: d.subject, stage: d.stage, level: d.level, branch: d.branch },
          sig,
          (q) => { if (collected[q.kind] && collected[q.kind].length < (need[q.kind] ?? 0) && !taken(q.text)) collected[q.kind].push(q); },
        );
        if (!Object.keys(remaining()).length) { fail = null; break; }
        if (!fail) { fail = { code: "empty", message: "لم يكتب الذكاء الاصطناعي سؤالًا جديدًا مناسبًا." }; continue; } // try another part of the text
        if (fail.code === "rate_day") {
          const l: Limit = { kind: "day", until: Date.now() + msUntilPacificMidnight() };
          saveLimit(l); setLimit(l);
          fail = { ...fail, message: `انتهى الحد اليومي المجاني للذكاء الاصطناعي. يتجدد بعد ${fmtDuration(l.until - Date.now())} تقريبًا.` };
          break;
        }
        if ((fail.code === "rate_minute" || fail.code === "busy" || fail.code === "timeout") && a < 3) {
          const secs = clamp(fail.retryAfter ?? 20, 5, 60);
          setLimit({ kind: fail.code === "rate_minute" ? "minute" : "busy", until: Date.now() + secs * 1000, why: `${fail.code}: ${fail.message}` });
          try { await sleep(secs * 1000, sig); } finally { setLimit(getLimit()); }
          lastReplRef.current = Date.now();
          continue;
        }
        if (fail.code === "empty") continue;
        break;
      }
    } catch {
      if (sig.aborted) return; // the review was closed
      fail = { code: "network", message: "تعذّر الاتصال بالخادم. تأكد أن التطبيق ما زال يعمل." };
    }
    if (sig.aborted || !draftRef.current) return;
    const posCount = [0, 0, 0, 0, 0, 0];
    for (const x of draftRef.current.sets.flat()) if (x.q?.kind === "mcq") { const p = x.q.choices.indexOf(x.q.answer ?? ""); if (p >= 0 && p < 6) posCount[p]++; }
    for (const sl of slots) {
      const q = collected[sl.kind]?.shift();
      if (q) patchSlot(sl.id, { state: "ok", q: placeAnswer(q, posCount), err: undefined });
      else patchSlot(sl.id, { state: "failed", err: fail?.message || "تعذّر كتابة سؤال بديل." });
    }
  };

  const pump = async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (pendingRef.current.length) {
        const sig = draftAbort.current?.signal;
        if (!sig || sig.aborted || !draftRef.current) break;
        // short pause so several quick deletions are sent together, and never closer than ~12.5s to the previous request
        const wait = Math.max(2500, lastReplRef.current + 12500 - Date.now());
        try { await sleep(wait, sig); } catch { break; }
        const ids = pendingRef.current.splice(0, 8);
        await writeBatch(ids, sig);
      }
    } finally {
      pumpingRef.current = false;
      if (!draftRef.current) pendingRef.current = [];
    }
  };

  const writeReplacement = (id: string) => {
    patchSlot(id, { state: "loading", q: undefined, err: undefined });
    if (!pendingRef.current.includes(id)) pendingRef.current.push(id);
    void pump();
  };

  const removeQuestion = (id: string) => {
    const s = draftRef.current?.sets.flat().find((x) => x.id === id);
    if (!s || s.state !== "ok" || !s.q) return;
    const text = s.q.text;
    patchDraft((d) => ({ ...d, removed: [...d.removed, text] }));
    writeReplacement(id);
  };
  const retryQuestion = (id: string) => { writeReplacement(id); };
  const dropSlot = (id: string) => patchDraft((d) => ({ ...d, sets: d.sets.map((st) => st.filter((x) => x.id !== id)) }));

  const discardDraft = () => {
    draftAbort.current?.abort(); draftAbort.current = null;
    draftRef.current = null; setDraft(null); pendingRef.current = [];
    notify("تم إلغاء الأسئلة", "info");
  };
  // Only now is the exam saved to the library. PDF files are still built only when a download button is pressed.
  const confirmDraft = async () => {
    const d = draftRef.current;
    if (!d || d.sets.flat().some((x) => x.state === "loading")) return;
    const sets = d.sets.map((st) => st.flatMap((x) => (x.state === "ok" && x.q ? [x.q] : []))).filter((st) => st.length);
    if (!sets.length) { notify("لا توجد أسئلة لإنشاء الاختبار", "error"); return; }
    draftAbort.current?.abort(); draftAbort.current = null;
    await addExam(sets, Math.floor(Math.random() * 1e9), d.info, { title: d.title, sources: d.sources, grade: d.grade, subject: d.subject, stage: d.stage ?? undefined });
    draftRef.current = null; setDraft(null);
    resetForm(); // the exam is saved in the library: clear every input like a freshly opened tool
    const per = Math.round(sets.reduce((n, st) => n + st.length, 0) / sets.length);
    notify(sets.length > 1 ? `تم إنشاء ${sets.length} نسخ بأسئلة مختلفة (${per} سؤالًا في كل نسخة) وحفظها في المكتبة. يمكنك تنزيلها من الأسفل.` : "تم إنشاء الاختبار وحفظه في المكتبة. يمكنك تنزيله من الأسفل.", "success");
  };

  // leaving the page with unreviewed questions would lose them
  const hasDraft = !!draft;
  useEffect(() => {
    if (!hasDraft) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [hasDraft]);
  useEffect(() => () => draftAbort.current?.abort(), []);

  const generate = async () => {
    setRunning(true);
    try {
      await syncKey(); // make sure the counter/limit belong to the key the server uses right now
      // no hard block here: a saved "daily limit" can be stale (each model has its own quota) - the server tries every model and reports the truth
      await generateAI();
    } catch {
      notify("حدث خطأ أثناء إنشاء الاختبار", "error");
    } finally {
      setRunning(false);
      syncKey(); // take the real count / limit from the server
    }
  };

  const download = async (e: Exam, v: string, key: boolean) => {
    notify("جارٍ تجهيز ملف PDF…", "info");
    try {
      const how = await exportExam(e, v, key);
      notify(how === "sheet" ? "الملف جاهز — اضغط «مشاركة / حفظ الملف»" : "تم تنزيل ملف PDF", "success");
    } catch (err) { console.error("pdf failed", err); notify("تعذّر تجهيز ملف PDF", "error"); }
  };
  const del = async (id: string) => {
    setExams((p) => p.filter((e) => e.id !== id));
    try { await removeExam(id); notify("تم حذف الاختبار", "success"); } catch { notify("تعذّر الحذف من قاعدة البيانات", "error"); }
  };
  const update = async (e: Exam) => {
    setExams((p) => p.map((x) => (x.id === e.id ? e : x)));
    try { await saveExam(e); } catch { notify("تعذّر حفظ التعديل", "error"); }
  };

  const totalVersions = exams.reduce((n, e) => n + e.versions.length, 0);
  const totalQuestions = exams.reduce((n, e) => n + e.questions.length, 0);

  if (subjectId === undefined) return <Header />; // reading the saved choice (avoids a flash of the picker)
  if (subjectId === null || !subject) {
    return (
      <>
        <Header />
        <main className="main-content"><SubjectGate onPick={chooseSubject} /></main>
      </>
    );
  }

  return (
    <>
      <Header subject={subject.id} onChangeSubject={changeSubject} />
      <main className="main-content">
        <div className="page-title">
          <h2>مولّد اختبارات {subject.name}</h2>
          <p>ارفع كتابًا بصيغة PDF، اختر الصفحات والموضوع، ويكتب الذكاء الاصطناعي الأسئلة أمامك وتُحفظ تلقائيًا لتنزّلها في أي وقت.</p>
        </div>

        <section className="stats-grid" aria-label="ملخص">
          <div className="stat-tile"><div><div className="st-num">{files.length}</div><div className="st-label">ملفات PDF</div></div><div className="st-icon">📄</div></div>
          <div className="stat-tile green"><div><div className="st-num">{exams.length}</div><div className="st-label">اختبارات محفوظة</div></div><div className="st-icon">📝</div></div>
          <div className="stat-tile amber"><div><div className="st-num">{totalVersions}</div><div className="st-label">نسخ جاهزة</div></div><div className="st-icon">🗂️</div></div>
          <div className="stat-tile teal"><div><div className="st-num">{totalQuestions}</div><div className="st-label">أسئلة مولّدة</div></div><div className="st-icon">❓</div></div>
        </section>

        <div className="workspace">
          <div className="col">
            <section className="card">
              <div className="card-header"><span className="qch-dot" /> ملفات المصدر</div>
              <div className="card-body">
                <button type="button" className={`dropzone${dragging ? " over" : ""}`}
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
                  <span className="dz-icon">📄</span>
                  <strong>ارفع ملفات PDF</strong>
                  <span>اضغط للاختيار أو اسحب الملفات هنا — بلا حد لحجم الملف</span>
                </button>
                <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                {files.length > 0 && (
                  <ul className="file-list">
                    {files.map((f) => (
                      <li key={f.id} className="file-row">
                        <label>
                          <input type="checkbox" checked={selected.includes(f.id)} onChange={() => toggleFile(f.id)} />
                          <span className="fr-name" dir="auto">{f.name}</span>
                        </label>
                        <span className="fr-size">{f.pages ? `${f.pages.length} ص · ${f.pages.some(isBlankPage) && f.pages.filter(isBlankPage).length > f.pages.length / 2 ? "ممسوح ضوئيًا (يُقرأ بالذكاء الاصطناعي) · " : ""}` : `جارٍ القراءة… ${f.progress ? `${f.progress[0]}/${f.progress[1]}` : ""} · `}{fmtSize(f.size)}</span>
                        <button type="button" className="del-row-btn" aria-label={`حذف ${f.name}`} onClick={() => removeFile(f.id)}>✕</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            {gen && (
              <div ref={genRef}>
                <GenerationPanel gen={gen} limit={limit} onStop={() => abortRef.current?.abort()} onClose={() => setGen(null)} />
              </div>
            )}
            {draft && (
              <div ref={reviewRef}>
                <ReviewPanel draft={draft} onRemove={removeQuestion} onRetry={retryQuestion} onDrop={dropSlot} onConfirm={confirmDraft} onDiscard={discardDraft} />
              </div>
            )}
          </div>

          <section className="card">
            <div className="card-header"><span className="qch-dot" /> إعدادات الاختبار</div>
            <div className="form">
              <AiStatus limit={limit} usage={usage} shared={shared} />

              <div className="fgroup">
                <h3 className="fg-t"><i>1</i> بيانات الاختبار</h3>
                <div className="row2 wide">
                  <div className="field">
                    <label htmlFor="title">اسم الاختبار</label>
                    <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: امتحان الوحدة الثانية" />
                  </div>
                  <div className="field">
                    <label htmlFor="grade">الدرجة الكلية (اختياري)</label>
                    <input id="grade" type="text" inputMode="decimal" className="input mono" value={grade} maxLength={5}
                      onChange={(e) => setGrade(toLatin(e.target.value).replace(/[^0-9.]/g, ""))} placeholder="مثال: 20" />
                  </div>
                </div>
              </div>

              <div className="fgroup">
                <h3 className="fg-t"><i>2</i> المحتوى</h3>
                <div className="field">
                  <label htmlFor="topic">الموضوع أو الفصل (اختياري)</label>
                  <input id="topic" className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="اتركه فارغًا لتغطية كل الصفحات" />
                </div>
                {chosen.filter((f) => f.pages).map((f) => {
                  const r = rangeOf(f), scanned = f.pages!.slice(r.from - 1, r.to).filter((_, i) => needsOcr(f, r.from + i)).length;
                  return (
                    <div className="field" key={f.id}>
                      <label>{chosen.length > 1 ? `صفحات «${stripPdf(f.name)}»` : "الصفحات"} (من 1 إلى {r.n}){needRange && <b className="req"> — مطلوب</b>}</label>
                      <div className="row2">
                        <input className="input mono" type="text" inputMode="numeric" placeholder="من صفحة" aria-label="من صفحة" value={ranges[f.id]?.from ?? ""} onChange={(e) => setRange(f.id, "from", digitsOnly(e.target.value))} onBlur={() => commitRange(f)} />
                        <input className="input mono" type="text" inputMode="numeric" placeholder="إلى صفحة" aria-label="إلى صفحة" value={ranges[f.id]?.to ?? ""} onChange={(e) => setRange(f.id, "to", digitsOnly(e.target.value))} onBlur={() => commitRange(f)} />
                      </div>
                      <p className="hint">{needRange && !r.typed ? "اكتب رقم أول صفحة وآخر صفحة ليبدأ تحليل الملف" : `${r.to - r.from + 1} صفحة (${r.from} إلى ${r.to})${scanned > 0 ? ` — ${scanned} صفحة ممسوحة ضوئيًا ستُقرأ بـ OCR` : ""}`}</p>
                    </div>
                  );
                })}
                <fieldset className="field">
                  <legend>مستوى الصعوبة</legend>
                  <div className="chips">
                    {DIFFS.map(([k, l]) => (
                      <button key={k} type="button" className="chip" aria-pressed={difficulty === k} onClick={() => setDifficulty(k)}>{l}</button>
                    ))}
                  </div>
                </fieldset>
              </div>

              {subject.ready && chosen.length > 0 && (
                <div className="fgroup">
                  <h3 className="fg-t"><i>🧠</i> تحليل الملف</h3>
                  {!rangesOk ? (
                    <p className="smart-wait">✍️ اكتب رقم أول صفحة وآخر صفحة (من – إلى) لبدء تحليل الملف.</p>
                  ) : !analysisReady ? (
                    <p className="smart-wait"><span className="spinner" /> {scan ? `جارٍ قراءة الصفحات الممسوحة ${scan.done} / ${scan.total} — سيظهر التحليل بعد الانتهاء` : "جارٍ تحليل الصفحات…"}</p>
                  ) : detected ? (
                    <div className="smart">
                      <div className="smart-row">
                        <span>الملف</span>
                        <span className="tag">{gradeName(stage, level) ?? (stage ? STAGE_LABEL[stage] : "الصف غير معروف")}</span>
                        {subject.id === "science" && <span className="tag">{BRANCH_LABEL[branch]}</span>}
                        <span className="tag">{detected.pages} صفحة · {detected.facts} جملة معلومات</span>
                      </div>
                      <div className="smart-row">
                        <span>أسئلة مناسبة</span>
                        {subject.kinds.filter((kd) => kindStatus(kd, stage, level, avail).ok).map((kd) => <span key={kd.id} className="tag on">{kd.label}</span>)}
                      </div>
                      <div className="smart-row">
                        <span>غير مناسبة</span>
                        {subject.kinds.filter((kd) => !kindStatus(kd, stage, level, avail).ok).map((kd) => <span key={kd.id} className="tag">{kd.label}</span>)}
                        {subject.kinds.every((kd) => kindStatus(kd, stage, level, avail).ok) && <span className="hint" style={{ margin: 0 }}>لا يوجد</span>}
                      </div>
                      {suggestTotal > 0 && <button type="button" className="btn-ghost" onClick={applySuggestion}>⚡ تطبيق الأعداد المقترحة ({suggestTotal} سؤال في النسخة)</button>}
                    </div>
                  ) : null}
                </div>
              )}

              <div className="fgroup">
                <h3 className="fg-t"><i>3</i> أسئلة الاختبار <small>عدد كل نوع في النسخة الواحدة</small></h3>
                <div className="qcounts">
                  {subject.kinds.map((kd) => {
                    const st = needRange && analysisReady ? kindStatus(kd, stage, level, avail) : { ok: true } as { ok: boolean; why?: string };
                    const on = !locked && (st.ok || forced.includes(kd.id));
                    const sug = avail?.[kd.id]?.suggest ?? 0;
                    return (
                      <div key={kd.id} className={`qc${on ? "" : " off"}`}>
                        <label className="qc-l" htmlFor={`qc-${kd.id}`}>{kd.label}</label>
                        <input id={`qc-${kd.id}`} type="text" inputMode="numeric" className="input mono" disabled={!on} value={on ? countText[kd.id] : "0"}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => { touchedCounts.current = true; setCountText((p) => ({ ...p, [kd.id]: digitsOnly(e.target.value).slice(0, 3) })); }}
                          onBlur={() => setCountText((p) => ({ ...p, [kd.id]: String(perType[kd.id]) }))} />
                        {locked ? null : !on
                          ? <span className="qc-why">{st.why}<button type="button" onClick={() => { touchedCounts.current = true; setForced((f) => [...f, kd.id]); setCountText((p) => ({ ...p, [kd.id]: "2" })); }}>تفعيل</button></span>
                          : needRange && sug > 0 ? <span className="qc-hint">مقترح: {sug}</span> : kd.hint ? <span className="qc-hint">{kd.hint}</span> : null}
                      </div>
                    );
                  })}
                </div>
                <p className="hint qsum">
                  {locked
                    ? "حدّد الصفحات أولًا — بعد التحليل تُفتح أنواع الأسئلة التي يدعمها الملف."
                    : perVersion === 0
                    ? "اكتب عدد سؤال واحد على الأقل (اكتب 0 لحذف نوع)."
                    : versions === 1
                      ? `${perVersion} سؤال في الاختبار`
                      : `${perVersion} سؤال في كل نسخة × ${versions} نسخ = ${count} سؤال مختلف (كل نسخة بأسئلتها الخاصة)`}
                </p>
              </div>

              <div className="fgroup">
                <h3 className="fg-t"><i>4</i> النسخ <small>كل نسخة بأسئلة مختلفة</small></h3>
                <div className="chips six">
                  {LETTERS.map((l, i) => (
                    <button key={l} type="button" className="chip mono" aria-pressed={i < versions} aria-label={`${i + 1} نسخ`} onClick={() => setVersions(i + 1)}>{l}</button>
                  ))}
                </div>
              </div>

              <button type="button" className="btn-primary" disabled={!canGenerate} onClick={generate}>
                {running ? "جارٍ الإنشاء…" : "✨ اكتب الأسئلة" + ` (${versions} ${versions === 1 ? "نسخة" : "نسخ"})`}
              </button>
              {draft && <p className="hint">راجع الأسئلة أولًا ثم اضغط «إنشاء الاختبار» (أو ألغِها) قبل كتابة أسئلة جديدة.</p>}
              {dayLimited && <p className="hint">قد يكون الحد اليومي المجاني انتهى. يمكنك المحاولة مرة أخرى، أو تنزيل اختباراتك المحفوظة.</p>}
              {chosen.length > 0 && !ready && <p className="hint">جارٍ قراءة الملفات…</p>}
              {ready && needRange && !rangesOk && <p className="hint">اكتب أرقام الصفحات (من – إلى) لبدء التحليل.</p>}
              {ready && rangesOk && !analysisReady && <p className="hint">بانتظار انتهاء التحليل…</p>}
              {!chosen.length && <p className="hint">ارفع ملف PDF واحدًا على الأقل وحدّده ليبدأ الإنشاء.</p>}
              {chosen.length > 1 && <p className="hint">سيُسحب الاختبار من {chosen.length} ملفات معًا.</p>}
            </div>
          </section>
        </div>

        <Library exams={exams} loading={loadingDb} onPrint={download} onDelete={del} onUpdate={update} />
      </main>
      <div className="toast-wrap" role="status" aria-live="polite">{toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}</div>
    </>
  );
}
