"use client";
import { SUBJECTS, type SubjectId } from "@/lib/subjects";

// Shown before the tool opens: the teacher picks the subject, and the tool then adapts its inputs (question types, counts, AI rules).
export default function SubjectGate({ onPick }: { onPick: (id: SubjectId) => void }) {
  return (
    <section className="gate" aria-labelledby="gate-title">
      <div className="gate-head">
        <h2 id="gate-title">اختر المادة</h2>
        <p>تتغيّر إعدادات الأداة وأنواع الأسئلة حسب المادة، ليكتب الذكاء الاصطناعي أسئلة أدقّ.</p>
      </div>
      <div className="gate-grid">
        {SUBJECTS.map((s, i) => (
          <button key={s.id} type="button" className={`gate-card${s.ready ? " ready" : ""}`} style={{ animationDelay: `${i * 70}ms` }} onClick={() => onPick(s.id)}>
            <span className="gate-ico" aria-hidden="true">{s.icon}</span>
            <span className="gate-name">{s.name}</span>
            <span className="gate-tag">{s.tagline}</span>
            {s.ready ? <span className="gate-badge ok">أنواع أسئلة مخصّصة</span> : <span className="gate-badge">أنواع عامة · التخصيص قريبًا</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
