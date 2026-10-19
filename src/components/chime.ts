// Our own job tones, synthesized with the Web Audio API (no audio files, nothing copied).
// success: two quick rising sine notes (E5 -> B5) with a soft attack and decay. failure: one short, quiet, low triangle tone.
import type { AlertKind } from "@/lib/jobs/alerts";

type Ctx = AudioContext;
let ctx: Ctx | null = null;
function audio(): Ctx | null {
  if (typeof window === "undefined") return null;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  ctx ??= new C();
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}
function note(c: Ctx, freq: number, start: number, dur: number, type: OscillatorType, peak: number) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start); o.stop(start + dur + 0.02);
}
export const TONES: Record<AlertKind, { freq: number; at: number; dur: number; type: OscillatorType; peak: number }[]> = {
  success: [{ freq: 659.25, at: 0, dur: 0.12, type: "sine", peak: 0.18 }, { freq: 987.77, at: 0.09, dur: 0.22, type: "sine", peak: 0.16 }],
  failure: [{ freq: 196, at: 0, dur: 0.22, type: "triangle", peak: 0.07 }],
};
/** Play one alert tone now. Silently does nothing where audio is unavailable (or not yet allowed by the browser). */
export function playTone(kind: AlertKind) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  for (const n of TONES[kind]) note(c, n.freq, t + n.at, n.dur, n.type, n.peak);
}
