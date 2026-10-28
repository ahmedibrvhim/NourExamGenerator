import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { classify } from "@/lib/geminiErrors";
import { markDayLimit, readState } from "@/lib/store";
import { msUntilPacificMidnight } from "@/lib/limits";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Tells the browser WHICH api key the server is using (a short one-way fingerprint - never the key itself),
// so the request counter and the "limit reached" state can be kept separately for every key.
// With ?probe=1 it also sends ONE tiny request per model to Google to learn whether this key has already hit its limit (e.g. used on another device).
export async function GET(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ hasKey: false, id: "none" });
  const id = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const shared = await readState(id); // null when no shared database is configured
  const extra = shared ? { shared: true, usage: shared.usage, dayLeftMs: shared.dayLeftMs } : { shared: false };
  if (new URL(req.url).searchParams.get("probe") !== "1") return NextResponse.json({ hasKey: true, id, ...extra });

  // each model has its own free quota: the key counts as "out" only when every model we try says so
  const models = ["gemini-flash-latest", "gemini-flash-lite-latest"];
  let ok = false, bad = false, blocked = 0, day = false, retryAfter: number | undefined;
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 16 } }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) { ok = true; break; }
      const c = classify(r.status, await r.json().catch(() => ({}))) as { code: string; retryAfter?: number };
      if (c.code === "bad_key") { bad = true; break; }
      if (c.code === "rate_day" || c.code === "rate_minute") { blocked++; if (c.code === "rate_day") day = true; retryAfter = c.retryAfter; }
    } catch {}
  }
  const status = ok ? "ok" : bad ? "bad_key" : blocked === models.length ? (day ? "rate_day" : "rate_minute") : "unknown";
  if (status === "rate_day") await markDayLimit(id, msUntilPacificMidnight()); // so every device shows it
  return NextResponse.json({ hasKey: true, id, ...extra, status, retryAfter });
}
