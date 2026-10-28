"use client";
import { useEffect, useState } from "react";
import type { Q } from "@/exam";
import { KIND_LABEL } from "@/lib/subjects";

// One place in the exam. While the AI writes a replacement the slot is "loading".
export type Slot = { id: string; kind: Q["kind"]; q?: Q; state: "ok" | "loading" | "failed"; err?: string };

// The questions the AI wrote, waiting for the teacher's review. Nothing is saved (and no PDF exists) until she confirms.
export type Draft = {
  sets: Slot[][];            // one list per version (A, B, C...)
  versions: string[];
  title: string; sources: string[]; grade?: string; info: string;
  message?: string; phase: "done" | "partial" | "stopped";
  groups: string[];          // source text pieces, reused to write replacement questions
  difficulty: string; topic: string;
  subject?: string; stage?: string | null; level?: number | null; branch?: string; // from the subject picker / file analysis (used again for replacement questions)
  removed: string[];         // texts of deleted questions, so the replacement is never the same question again
  target: number;
};

const KIND = KIND_LABEL;
const isAr = (s: string) => /[\u0600-\u06FF]/.test(s);

export default function ReviewPanel({ draft, onRemove, onRetry, onDrop, onConfirm, onDiscard }: {
  draft: Draft;
  onRemove: (id: string) => void;  // delete a question -> the AI writes another one of the same type
  onRetry: (id: string) => void;   // the replacement failed -> try again
  onDrop: (id: string) => void;    // give up on a slot (no replacement)
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const [vi, setVi] = useState(0);
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(t); }, [armed]);

  const cur = Math.max(0, Math.min(vi, draft.sets.length - 1));
  const slots = draft.sets[cur] ?? [];
  const all = draft.sets.flat();
  const ready = all.filter((s) => s.state === "ok").length;
  const busy = all.filter((s) => s.state === "loading").length;
  const failed = all.filter((s) => s.state === "failed").length;

  return (
    <section className="card gen review" aria-live="polite">
      <div className="card-header"><span className="qch-dot" /> راجع الأسئلة قبل إنشاء الاختبار</div>
      <div className="gen-body">
        <div className="gen-top">
          <div className="gen-count"><b className="mono">{ready}</b> سؤال جاهز</div>
          {draft.versions.length > 1 && <div className="gen-batch">{slots.filter((s) => s.state === "ok").length} في النسخة {draft.versions[cur]}</div>}
        </div>
        <p className="hint">«حذف واستبدال» يكتب الذكاء الاصطناعي سؤالًا بديلًا من نفس النوع (عدة أسئلة تُحذف بسرعة تُجمع في طلب واحد)، و«حذف فقط» يزيل السؤال بدون استخدام الذكاء الاصطناعي. لن يُحفظ الاختبار ولن يُنشأ ملف PDF إلا بعد أن تضغط «إنشاء الاختبار».</p>

        {draft.message && <p className={`gen-msg ${draft.phase}`}>{draft.message}</p>}

        {draft.versions.length > 1 && (
          <div className="rv-tabs" role="tablist" aria-label="النسخ">
            {draft.versions.map((v, k) => (
              <button key={v} type="button" role="tab" aria-selected={k === cur} className="chip mono" aria-pressed={k === cur} onClick={() => setVi(k)}>النسخة {v}</button>
            ))}
          </div>
        )}

        <ol className="lq-list rv-list">
          {slots.map((s, i) => (
            <li key={s.id} className={`lq${s.state === "ok" ? "" : ` ${s.state}`}`}>
              <span className="lq-n mono">{i + 1}</span>
              <div className="lq-main" dir="auto">
                {s.state === "ok" && s.q && (
                  <>
                    <p>{s.q.text}</p>
                    {s.q.kind === "mcq" && <ul>{s.q.choices.map((c, k) => <li key={k} className={c === s.q!.answer ? "ok" : ""}>{c}</li>)}</ul>}
                    {s.q.kind === "tf" && s.q.answer && <span className="lq-ans">✓ {s.q.answer === "true" ? (isAr(s.q.text) ? "صح" : "True") : isAr(s.q.text) ? "خطأ" : "False"}</span>}
                    {s.q.kind !== "mcq" && s.q.kind !== "tf" && s.q.answer && <p className="pv-ans" style={{ whiteSpace: "pre-wrap" }}>✓ {s.q.answer}</p>}
                  </>
                )}
                {s.state === "loading" && <div className="gen-empty"><span className="spinner" /> يكتب الذكاء الاصطناعي سؤالًا بديلًا ({KIND[s.kind]})…</div>}
                {s.state === "failed" && <p className="rv-err">{s.err || "تعذّر كتابة سؤال بديل."}</p>}
              </div>
              <div className="lq-side">
                <span className="pill">{KIND[s.kind]}</span>
                {s.state === "ok" && (
                  <>
                    <button type="button" className="pv-del" onClick={() => onRemove(s.id)}>🗑 حذف واستبدال</button>
                    <button type="button" className="pv-del" onClick={() => onDrop(s.id)}>✕ حذف فقط</button>
                  </>
                )}
                {s.state === "failed" && (
                  <>
                    <button type="button" className="act-btn" onClick={() => onRetry(s.id)}>↻ إعادة المحاولة</button>
                    <button type="button" className="pv-del" onClick={() => onDrop(s.id)}>إزالة</button>
                  </>
                )}
              </div>
            </li>
          ))}
          {!slots.length && <li className="pv-empty">لا توجد أسئلة في هذه النسخة.</li>}
        </ol>

        {failed > 0 && <p className="gen-msg partial">تعذّرت كتابة {failed} {failed === 1 ? "سؤال بديل" : "أسئلة بديلة"} — أعد المحاولة أو أزلها، وإلا لن تدخل في الاختبار.</p>}

        <div className="rv-actions">
          <button type="button" className={`btn-ghost${armed ? " armed" : ""}`} onClick={() => { if (armed) onDiscard(); else setArmed(true); }}>
            {armed ? "تأكيد الإلغاء؟" : "إلغاء الأسئلة"}
          </button>
          <button type="button" className="btn-primary" disabled={busy > 0 || ready === 0} onClick={onConfirm}>
            {busy > 0 ? "جارٍ كتابة البدائل…" : `✅ إنشاء الاختبار (${ready} سؤال)`}
          </button>
        </div>
      </div>
    </section>
  );
}
