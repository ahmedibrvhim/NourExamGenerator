"use client";
import { Limit, fmtDuration } from "@/lib/limits";
import { useNow } from "@/components/useNow";

// One line that always tells the user whether the free AI can be used right now.
export default function AiStatus({ limit, usage, shared }: { limit: Limit; usage: number; shared?: boolean }) {
  const now = useNow(1000);
  const left = limit ? limit.until - now : 0;
  if (limit && left > 0) {
    if (limit.kind === "day") {
      return (
        <div className="ai-status bad" role="status">
          <span className="dot" />
          <div>
            <strong>انتهى الحد اليومي المجاني</strong>
            <small>يتجدد بعد {fmtDuration(left)} تقريبًا (منتصف الليل بتوقيت المحيط الهادئ). الاختبارات المحفوظة ما زالت متاحة للطباعة.</small>
          </div>
        </div>
      );
    }
    return (
      <div className="ai-status warn" role="status">
        <span className="dot" />
        <div>
          <strong>{limit.kind === "busy" ? "الخدمة مزدحمة" : "وصلنا حد الطلبات في الدقيقة"}</strong>
          <small>سيستأنف التوليد تلقائيًا خلال {fmtDuration(left)}</small>
        </div>
      </div>
    );
  }
  return (
    <div className="ai-status ok" role="status">
      <span className="dot" />
      <div>
        <strong>الذكاء الاصطناعي جاهز</strong>
        <small title={shared ? "العدّاد مشترك بين كل الأجهزة" : "العدّاد يحسب الطلبات من هذا المتصفح فقط"}>{shared ? `طلبات اليوم بهذا المفتاح (كل الأجهزة): ${usage}` : `طلبات اليوم بهذا المفتاح من هذا الجهاز فقط: ${usage}`} · الحد المجاني محدود ويظهر هنا فور الوصول إليه</small>
      </div>
    </div>
  );
}
