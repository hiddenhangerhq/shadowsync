"use client";
import { useEffect, useState } from "react";
import { SOUND_KEY, soundsOn } from "@/lib/jobs/alerts";
import { playTone } from "./chime";

/** Settings > Job sounds (this browser; default on). Turning it on plays the chime once so you hear it. */
export default function JobSoundsToggle() {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(soundsOn(window.localStorage)); }, []);
  const set = (v: boolean) => { window.localStorage.setItem(SOUND_KEY, v ? "on" : "off"); setOn(v); if (v) playTone("success"); };
  return (
    <label className="row small" style={{ gap: 8 }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} aria-label="Job sounds" />
      <span>Job sounds: a short chime when a job succeeds, a soft low tone when one fails{on ? "" : " (off)"}</span>
    </label>
  );
}
