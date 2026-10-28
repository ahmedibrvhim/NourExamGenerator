"use client";
import { useEffect, useRef } from "react";
import type { Q } from "@/exam";
import { KIND_LABEL } from "@/lib/subjects";
import { Limit, fmtClock, fmtDuration } from "@/lib/limits";
import { useNow } from "@/components/useNow";

export type Gen = {
  phase: "writing" | "done" | "partial" | "stopped" | "failed";
  batch: number; batches: number; target: number; qs: Q[];
  startedAt: number; endedAt?: number; message?: string;
};

const KIND = KIND_LABEL;
const TITLE: Record<Gen["phase"], string> = {
  writing: "جارٍ كتابة الأسئلة", done: "اكتمل الاختبار", partial: "اكتمل جزئيًا", stopped: "تم الإيقاف", failed: "تعذّر الإنشاء",
};
const isAr = (s: string) => /[\u0600-\u06FF]/.test(s);

export default function GenerationPanel({ gen, limit, onStop, onClose }: { gen: Gen; limit: Limit; onStop: () => void; onClose: () => void }) {
  const now = useNow(1000);
  const listRef = useRef<HTMLOListElement>(null);
  const running = gen.phase === "writing";
  const pct = Math.min(100, Math.round((gen.qs.length / Math.max(1, gen.target)) * 100));
  const waiting = running && limit && limit.until > now ? limit : null;

  useEffect(() => { if (running) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [gen.qs.length, running]);

  return (
    <section className={`card gen ${gen.phase}`} aria-live="polite">
      <div className="card-header">
        <span className="qch-dot" /> {TITLE[gen.phase]}
        <span className="gen-time mono">⏱ {fmtClock((gen.endedAt ?? now) - gen.startedAt)}</span>
      </div>
      <div className="gen-body">
        <div className="gen-top">
          <div className="gen-count"><b className="mono">{gen.qs.length}</b> / {gen.target} سؤال</div>
          {running && gen.batch > 0 && <div className="gen-batch">الدفعة {gen.batch} من {gen.batches}</div>}
        </div>
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>

        {waiting && (
          <div className="gen-wait">
            ⏳ {waiting.kind === "busy" ? "الخدمة مزدحمة" : "وصلنا حد الطلبات في الدقيقة"} — سنكمل تلقائيًا خلال <b className="mono">{fmtDuration(waiting.until - now)}</b>
            {waiting.why && <div dir="ltr" style={{ fontSize: 12, opacity: 0.8, marginTop: 4, wordBreak: "break-word" }}>{waiting.why}</div>}
          </div>
        )}

        {gen.qs.length === 0 && running && !waiting && <div className="gen-empty"><span className="spinner" /> الذكاء الاصطناعي يقرأ النص ويبدأ الكتابة…</div>}

        {gen.qs.length > 0 && (
          <ol className="lq-list" ref={listRef}>
            {gen.qs.map((q, i) => (
              <li key={i} className="lq">
                <span className="lq-n mono">{i + 1}</span>
                <div className="lq-main" dir="auto">
                  <p>{q.text}</p>
                  {q.kind === "mcq" && <ul>{q.choices.map((c, k) => <li key={k} className={c === q.answer ? "ok" : ""}>{c}</li>)}</ul>}
                  {q.kind === "tf" && <span className="lq-ans">✓ {q.answer === "true" ? (isAr(q.text) ? "صح" : "True") : isAr(q.text) ? "خطأ" : "False"}</span>}
                </div>
                <span className="pill">{KIND[q.kind]}</span>
              </li>
            ))}
          </ol>
        )}

        {gen.message && <p className={`gen-msg ${gen.phase}`}>{gen.message}</p>}

        <div className="gen-actions">
          {running
            ? <button type="button" className="btn-ghost" onClick={onStop}>⏹ إيقاف ومراجعة ما تم</button>
            : <button type="button" className="btn-ghost" onClick={onClose}>إغلاق</button>}
        </div>
      </div>
    </section>
  );
}
