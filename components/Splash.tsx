"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Emblem from "@/components/Emblem";
import ThemePicker from "@/components/ThemePicker";

const SPLASH_KEY = "centerapp-splash-seen";
const SHOW_MS = 5600;      // how long the intro plays before the tool opens
const SHOW_MS_REDUCED = 1400;
const LEAVE_MS = 650;      // length of the fade-out (must match .splash.leaving in globals.css)

const STEPS = [
  { icon: "📄", title: "ارفع الكتاب", text: "ملف PDF (حتى الممسوح ضوئيًا) — يُقرأ على جهازك" },
  { icon: "🎯", title: "حدّد ما تريد", text: "الصفحات والموضوع ونوع الأسئلة والصعوبة" },
  { icon: "🗂️", title: "حمّل النسخ", text: "عدة نسخ A–F مع نموذج إجابة لكل نسخة" },
] as const;

const WORDS = ["سنتر", "النور", "التعليمي"];

// Full-screen intro. It is part of the server HTML (so the tool never flashes before it), and the inline
// script in layout.tsx marks <html data-splash="done"> when it was already played in this browser session.
export default function Splash() {
  const [phase, setPhase] = useState<"show" | "leaving" | "gone">("show");

  const leave = () => {
    setPhase((p) => (p === "show" ? "leaving" : p));
  };

  useEffect(() => {
    let seen = false;
    try { seen = !!sessionStorage.getItem(SPLASH_KEY); } catch {}
    if (seen) { setPhase("gone"); return; }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(leave, reduced ? SHOW_MS_REDUCED : SHOW_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase === "show") return;
    try { sessionStorage.setItem(SPLASH_KEY, "1"); } catch {}
    document.documentElement.setAttribute("data-splash", "done"); // unlocks page scrolling
    if (phase === "leaving") {
      const t = setTimeout(() => setPhase("gone"), LEAVE_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);

  if (phase === "gone") return null;

  return (
    <div className={`splash${phase === "leaving" ? " leaving" : ""}`} role="dialog" aria-modal="true" aria-label="سنتر النور التعليمي">
      <div className="splash-bg" aria-hidden="true">
        <span className="orb o1" /><span className="orb o2" /><span className="orb o3" />
        {Array.from({ length: 14 }, (_, i) => <span key={i} className="mote" style={{ "--i": i } as CSSProperties} />)}
      </div>

      <div className="splash-top">
        <ThemePicker />
        <button type="button" className="splash-skip" onClick={leave}>تخطّي ‹</button>
      </div>

      <div className="splash-center">
        <div className="splash-emblem"><Emblem animated size={132} /></div>

        <h1 className="splash-name" aria-label="سنتر النور التعليمي">
          {WORDS.map((w, i) => (
            <span key={w} className="word" style={{ "--d": `${0.9 + i * 0.18}s` } as CSSProperties} aria-hidden="true">{w}</span>
          ))}
        </h1>

        <p className="splash-sub">مولّد الاختبارات الذكي</p>
        <p className="splash-lead">حوّل أي كتاب إلى اختبار جاهز في دقائق — والأسئلة تظهر أمامك لحظة بلحظة.</p>

        <ol className="splash-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="step" style={{ "--d": `${2.1 + i * 0.5}s` } as CSSProperties}>
              <span className="step-ico" aria-hidden="true">{s.icon}</span>
              <span className="step-txt"><b>{s.title}</b><small>{s.text}</small></span>
              <span className="step-n mono" aria-hidden="true">{i + 1}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="splash-foot" aria-hidden="true">
        <div className="splash-bar"><span /></div>
        <p>جاري تجهيز الأداة…</p>
      </div>
    </div>
  );
}
