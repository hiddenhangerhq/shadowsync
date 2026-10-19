import type { Health } from "@/lib/jobs/health";

const ICON = { green: "●", yellow: "▲", red: "■" } as const;

/**
 * Extension / worker health (spec section 6). Green, yellow or red per item, straight from computeHealth().
 * `compact` (Mission Control) hides the green lines unless everything is green, so problems are what you see first.
 */
export default function StatusBanner({ health, compact = false }: { health: Health; compact?: boolean }) {
  const shown = compact && health.level !== "green" ? health.items.filter((i) => i.level !== "green") : health.items;
  if (!shown.length) return null;
  return (
    <div className={`sb ${health.level}`} role={health.level === "red" ? "alert" : "status"} aria-label="Sync health">
      {shown.map((i) => (
        <div key={i.key} className={`sb-row ${i.level}`}>
          <span className="sb-ic" aria-hidden>{ICON[i.level]}</span>
          <div><b>{i.title}</b>{i.detail && <div className="small muted">{i.detail}</div>}</div>
        </div>
      ))}
    </div>
  );
}
