"use client";
// Live job alerts: while the page is open and visible, look at the job list every few seconds; when a job finishes, refresh the page
// (its green check / red X appears) and play our tone: one chime per finished job, at most one per 0.5 s. Sounds: Settings > Job sounds.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { chimeSchedule, finishedSince, soundsOn, statusMap } from "@/lib/jobs/alerts";
import { playTone } from "./chime";

export default function JobLive({ itemId, everyMs = 4000 }: { itemId?: string; everyMs?: number }) {
  const router = useRouter();
  const prev = useRef<Map<string, string> | null>(null);
  const lastChime = useRef(0);
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const look = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(`/api/v1/jobs?limit=100${itemId ? `&itemId=${encodeURIComponent(itemId)}` : ""}`, { cache: "no-store" });
        if (!r.ok || !alive) return;
        const jobs = ((await r.json()) as { jobs?: { id: string; status: string }[] }).jobs ?? [];
        const done = finishedSince(prev.current, jobs as never);
        const changed = prev.current !== null && jobs.some((j) => prev.current!.get(j.id) !== j.status);
        prev.current = statusMap(jobs as never);
        if (changed) router.refresh();
        if (!done.length || !soundsOn(window.localStorage)) return;
        const now = Date.now();
        // Successes chime; failures get the soft tone. Same throttle for both, in the order they finished.
        chimeSchedule(done.length, now, lastChime.current).forEach((ms, i) => {
          lastChime.current = now + ms;
          timers.push(setTimeout(() => playTone(done[i].kind), ms));
        });
      } catch { /* offline: try again next time */ }
    };
    void look();
    const t = setInterval(() => void look(), everyMs);
    return () => { alive = false; clearInterval(t); timers.forEach(clearTimeout); };
  }, [itemId, everyMs, router]);
  return null;
}
