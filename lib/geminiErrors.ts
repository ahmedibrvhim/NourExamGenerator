// Turn a Gemini error into something the app can act on: per-minute vs per-day limit, overload, bad key...
export function classify(status: number, body: any) {
  const err = body?.error ?? {};
  const msg: string = String(err.message ?? "");
  let retryAfter: number | undefined;
  let day = /per ?day/i.test(msg);
  for (const d of Array.isArray(err.details) ? err.details : []) {
    const type = String(d?.["@type"] ?? "");
    if (type.endsWith("RetryInfo") && d.retryDelay) retryAfter = Math.ceil(parseFloat(d.retryDelay)) || undefined;
    if (type.endsWith("QuotaFailure")) {
      for (const v of d.violations ?? []) if (/perday/i.test(`${v.quotaId ?? ""}${v.quotaMetric ?? ""}`.replace(/[^a-z]/gi, ""))) day = true;
    }
  }
  if (status === 429) {
    return day
      ? { http: 429, code: "rate_day", error: "انتهى الحد اليومي المجاني للذكاء الاصطناعي" }
      : { http: 429, code: "rate_minute", retryAfter: retryAfter ?? 30, error: "وصلنا حد الطلبات في الدقيقة" };
  }
  if (status === 503 || status === 500) return { http: 503, code: "busy", retryAfter: 8, error: `خدمة الذكاء الاصطناعي مزدحمة حاليًا (${status}${msg ? ": " + msg.slice(0, 120) : ""})` };
  if (status === 404) return { http: 502, code: "bad_model", error: "النموذج غير موجود. احذف متغير GEMINI_MODEL من إعدادات Vercel ثم أعد النشر" };
  if (status === 403 || /api key/i.test(msg)) return { http: 502, code: "bad_key", error: "مفتاح API غير صالح أو غير مفعّل" };
  return { http: 502, code: "error", error: `خطأ من خدمة الذكاء الاصطناعي (${status}${msg ? ": " + msg.slice(0, 160) : ""})` };
}
