// Server-side shared state: how many requests the current API key used today, and whether it hit its daily limit.
// A browser can only count what IT sent, so two devices (computer + phone) showed different numbers.
// With a small free Redis database (Upstash) every device reads the same numbers.
// Not configured -> hasStore is false and the app falls back to the per-device counter.
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const hasStore = !!(URL_ && TOKEN);

async function pipeline(cmds: (string | number)[][]): Promise<any[]> {
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmds), signal: AbortSignal.timeout(4000), cache: "no-store",
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("store unavailable"); // e.g. monthly command limit reached -> callers fall back to the per-device counter
  return j.map((x: any) => x?.result);
}

// Google's daily quota resets at midnight Pacific time: the counter's name contains that day.
export function pacificDay(): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}

export async function addUsage(keyId: string): Promise<void> {
  if (!hasStore) return;
  try { const k = `usage:${keyId}:${pacificDay()}`; await pipeline([["INCR", k], ["EXPIRE", k, 172800]]); } catch {}
}
export async function readState(keyId: string): Promise<{ usage: number; dayLeftMs: number } | null> {
  if (!hasStore) return null;
  try {
    const [u, ttl] = await pipeline([["GET", `usage:${keyId}:${pacificDay()}`], ["PTTL", `limit:${keyId}`]]);
    return { usage: Number(u) || 0, dayLeftMs: Number(ttl) > 0 ? Number(ttl) : 0 };
  } catch { return null; }
}
export async function markDayLimit(keyId: string, ms: number): Promise<void> {
  if (!hasStore) return;
  try { await pipeline([["SET", `limit:${keyId}`, "1", "PX", Math.max(1000, Math.floor(ms))]]); } catch {}
}
export async function clearDayLimit(keyId: string): Promise<void> {
  if (!hasStore) return;
  try { await pipeline([["DEL", `limit:${keyId}`]]); } catch {}
}
