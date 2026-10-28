"use client";
import { useEffect, useState } from "react";
import { examSets, type Exam, type Q } from "@/exam";
import { KIND_LABEL } from "@/lib/subjects";

const KIND = KIND_LABEL;
const isAr = (s: string) => /[\u0600-\u06FF]/.test(s);


// For every version: one button for the student copy (no answers) and one with the answers marked.
function Downloads({ e, onPrint }: { e: Exam; onPrint: (e: Exam, v: string, key: boolean) => void }) {
  const hasKey = e.questions.some((q) => q.answer);
  return (
    <div className="ver-list">
      {e.versions.map((v) => (
        <div key={v} className="ver-row">
          <b className="ver-badge mono">{v}</b>
          <button type="button" className="act-btn" onClick={() => onPrint(e, v, false)} aria-label={`تنزيل النسخة ${v} بدون حل`}>📄 بدون حل</button>
          {hasKey
            ? <button type="button" className="act-btn solved" onClick={() => onPrint(e, v, true)} aria-label={`تنزيل النسخة ${v} مع الحل`}>✅ مع الحل</button>
            : <span className="sub">لا يوجد حل</span>}
        </div>
      ))}
    </div>
  );
}

function Preview({ exam, onClose, onChange, onPrint }: { exam: Exam; onClose: () => void; onChange: (e: Exam) => void; onPrint: (e: Exam, v: string, key: boolean) => void }) {
  const [vi, setVi] = useState(0);
  const sets = examSets(exam);
  const cur = Math.min(vi, sets.length - 1);
  const qs = sets[cur] ?? [];
  // delete one question from the version being shown (older exams share one list between all versions)
  const removeAt = (i: number) => {
    if (exam.sets) {
      const next = exam.sets.map((s, k) => (k === cur ? s.filter((_, j) => j !== i) : s));
      onChange({ ...exam, sets: next, questions: next.flat() });
    } else onChange({ ...exam, questions: exam.questions.filter((_, k) => k !== i) });
  };
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={exam.title}>
        <div className="modal-head">
          <div>
            <h3>{exam.title}</h3>
            <p>{exam.questions.length} سؤال{exam.sets && exam.versions.length > 1 ? ` (${qs.length} في النسخة ${exam.versions[cur]})` : ""}{exam.info ? ` · ${exam.info}` : ""}</p>
          </div>
          <button type="button" className="del-row-btn" aria-label="إغلاق" onClick={onClose}>✕</button>
        </div>
        <div className="modal-dl"><Downloads e={exam} onPrint={onPrint} /></div>
        {exam.versions.length > 1 && (
          <div className="vtabs" role="tablist" aria-label="النسخ">
            {exam.versions.map((v, k) => (
              <button key={v} type="button" role="tab" aria-selected={k === cur} className="chip mono" aria-pressed={k === cur} onClick={() => setVi(k)}>النسخة {v}</button>
            ))}
          </div>
        )}
        <ol className="modal-body">
          {qs.map((q, i) => (
            <li key={i} className="pv">
              <div className="pv-top">
                <b className="mono">{i + 1}</b><span className="pill">{KIND[q.kind]}</span>
                <button type="button" className="pv-del" onClick={() => removeAt(i)}>حذف السؤال</button>
              </div>
              <p dir="auto">{q.text}</p>
              {q.kind === "mcq" && <ul dir="auto">{q.choices.map((c, k) => <li key={k} className={c === q.answer ? "ok" : ""}>{c}</li>)}</ul>}
              {q.kind === "tf" && q.answer && <span className="lq-ans">✓ {q.answer === "true" ? (isAr(q.text) ? "صح" : "True") : isAr(q.text) ? "خطأ" : "False"}</span>}
              {q.kind !== "mcq" && q.kind !== "tf" && q.answer && <p className="pv-ans" dir="auto" style={{ whiteSpace: "pre-wrap" }}>✓ {q.answer}</p>}
              {q.explanation && <p className="pv-why" dir="auto">{q.explanation}</p>}
            </li>
          ))}
          {!qs.length && <li className="pv-empty">لا توجد أسئلة في هذا الاختبار.</li>}
        </ol>
      </div>
    </div>
  );
}

export default function Library({ exams, loading, onPrint, onDelete, onUpdate }: {
  exams: Exam[]; loading: boolean;
  onPrint: (e: Exam, v: string, key: boolean) => void;
  onDelete: (id: string) => void;
  onUpdate: (e: Exam) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(null), 3500); return () => clearTimeout(t); }, [confirm]);

  return (
    <section className="card">
      <div className="card-header"><span className="qch-dot" /> مكتبة الاختبارات المحفوظة <span className="gen-time">{exams.length ? `${exams.length} اختبار` : ""}</span></div>
      <div className="table-wrap">
        <table className="etable">
          <thead><tr><th>الاختبار</th><th>الأسئلة</th><th>تنزيل PDF (بدون حل / مع الحل)</th><th>التاريخ</th><th>إجراءات</th></tr></thead>
          <tbody>
            {exams.length === 0 ? (
              <tr><td colSpan={5} className="empty"><strong>{loading ? "جارٍ تحميل الاختبارات…" : "لا توجد اختبارات بعد"}</strong>{loading ? "" : "كل اختبار تنشئه يُحفظ هنا تلقائيًا ويمكنك تنزيله في أي وقت."}</td></tr>
            ) : exams.map((e) => (
              <tr key={e.id}>
                <td className="strong" data-label="الاختبار">
                  <div>{e.title}</div>
                  {e.info && <div className="sub">{e.info}</div>}
                </td>
                <td className="mono" data-label="الأسئلة">{e.questions.length}{e.sets && e.versions.length > 1 ? <div className="sub">{Math.round(e.questions.length / e.versions.length)} لكل نسخة</div> : null}</td>
                <td className="dl-cell" data-label="تنزيل PDF">
                  <Downloads e={e} onPrint={onPrint} />
                </td>
                <td className="mono" data-label="التاريخ">{e.date}</td>
                <td className="dl-cell" data-label="إجراءات">
                  <div className="dl-group">
                    <button type="button" className={`act-btn danger${confirm === e.id ? " armed" : ""}`}
                      onClick={() => { if (confirm === e.id) { onDelete(e.id); setConfirm(null); } else setConfirm(e.id); }}>
                      {confirm === e.id ? "تأكيد الحذف؟" : "🗑 حذف"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
