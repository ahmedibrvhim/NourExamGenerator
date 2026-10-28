import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Open  https://YOUR-SITE.vercel.app/api/health  in the browser to see whether Vercel can reach Gemini, and how fast.
// It never shows the key itself.
export async function GET() {
  const key = process.env.GEMINI_API_KEY;
  const out: Record<string, unknown> = {
    hasKey: !!key,
    keyLength: key?.length ?? 0,
    keyHasSpaceOrQuote: key ? /[\s"']/.test(key) : null,
    keyStart: key ? key.slice(0, 4) + "…" : null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
    pinnedModel: process.env.GEMINI_MODEL ?? null,
  };
  if (!key) return NextResponse.json(out);

  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    out.listModelsStatus = r.status;
    out.listModelsError = j?.error?.message ?? null;
    out.flashModels = (j.models ?? []).map((m: any) => String(m.name).replace(/^models\//, "")).filter((n: string) => /flash/.test(n));
  } catch (e) { out.listModelsError = String(e); }

  const tests: Record<string, unknown>[] = [];
  for (const model of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }], generationConfig: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } } }),
        signal: AbortSignal.timeout(25000),
      });
      const j: any = await r.json().catch(() => ({}));
      tests.push({ model, status: r.status, ms: Date.now() - t0, reply: j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null, error: j?.error?.message?.slice(0, 200) ?? null });
    } catch (e) { tests.push({ model, ms: Date.now() - t0, error: String(e) }); }
  }
  out.tests = tests;
  return NextResponse.json(out);
}
