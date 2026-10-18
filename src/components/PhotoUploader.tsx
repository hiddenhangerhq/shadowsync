"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { resizeImage } from "@/lib/client/resize";

type Job = { name: string; state: "resizing" | "uploading" | "done" | "error"; msg?: string };

/**
 * Two inputs on purpose: phones ignore `multiple` when `capture` is set, so "Take photo" uses the camera
 * (one shot at a time) and "Choose photos" opens the library with multi-select.
 */
export default function PhotoUploader({ itemId }: { itemId: string }) {
  const cam = useRef<HTMLInputElement>(null);
  const lib = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const router = useRouter();

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    setJobs(list.map((f) => ({ name: f.name, state: "resizing" })));
    const set = (i: number, j: Partial<Job>) => setJobs((p) => p.map((x, k) => (k === i ? { ...x, ...j } : x)));
    for (let i = 0; i < list.length; i++) {
      try {
        const r = await resizeImage(list[i]);
        set(i, { state: "uploading" });
        const fd = new FormData();
        fd.set("file", new File([r.blob], `photo-${Date.now()}-${i}.jpg`, { type: "image/jpeg" }));
        fd.set("width", String(r.width));
        fd.set("height", String(r.height));
        const res = await fetch(`/api/items/${itemId}/photos`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
        set(i, { state: "done" });
      } catch (e) {
        set(i, { state: "error", msg: e instanceof Error ? e.message : "Failed" });
      }
    }
    router.refresh();
    if (cam.current) cam.current.value = "";
    if (lib.current) lib.current.value = "";
  }

  return (
    <div className="drop">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn primary" onClick={() => cam.current?.click()}>📷 Take photo</button>
        <button type="button" className="btn" onClick={() => lib.current?.click()}>Choose photos</button>
      </div>
      <input ref={cam} className="hidden-input" type="file" accept="image/*" capture="environment" onChange={(e) => handle(e.target.files)} />
      <input ref={lib} className="hidden-input" type="file" accept="image/*" multiple onChange={(e) => handle(e.target.files)} />
      <p className="muted small" style={{ margin: "8px 0 0" }}>Photos are resized to 1600px and compressed on your device before upload.</p>
      {jobs.map((j, i) => (
        <div key={i} className="small" style={{ marginTop: 4 }}>
          {j.name}: {j.state === "error" ? <span className="err">{j.msg}</span> : j.state}
        </div>
      ))}
    </div>
  );
}
