import ThemePicker from "@/components/ThemePicker";
import Emblem from "@/components/Emblem";
import { getSubject, type SubjectId } from "@/lib/subjects";

export default function Header({ subject, onChangeSubject }: { subject?: SubjectId | null; onChangeSubject?: () => void }) {
  const s = getSubject(subject);
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a href="/" className="brand" aria-label="سنتر النور التعليمي">
          <Emblem size={34} />
          <span className="brand-name">سنتر النور التعليمي</span>
          <span className="brand-sub">مولّد الاختبارات</span>
        </a>
        <p className="site-tagline">حوّل ملفات PDF إلى اختبارات بعدة نسخ</p>
        {s && onChangeSubject && (
          <button type="button" className="subject-chip" onClick={onChangeSubject} aria-label={`المادة الحالية ${s.name} — اضغط للتغيير`}>
            <span aria-hidden="true">{s.icon}</span><b>{s.name}</b><small>تغيير ‹</small>
          </button>
        )}
        <ThemePicker />
      </div>
    </header>
  );
}
