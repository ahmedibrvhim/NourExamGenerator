"use client";
import { useEffect, useState } from "react";

// Re-renders every `ms` so countdowns and timers stay live.
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
