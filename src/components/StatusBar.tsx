import type { ItemStatus } from "@/lib/data/types";

const COLORS: Record<ItemStatus, string> = { draft: "var(--c3)", listed: "var(--c1)", sold: "var(--c2)", delisted: "var(--c6)" };

/** Stacked bar of items by status. Uses chart tokens so it reads in every theme. */
export default function StatusBar({ counts }: { counts: Record<ItemStatus, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="bar" role="img" aria-label="Items by status">
        {total > 0 && (Object.keys(COLORS) as ItemStatus[]).map((s) => counts[s] > 0 && (
          <i key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: COLORS[s] }} />
        ))}
      </div>
      <div className="legend">
        {(Object.keys(COLORS) as ItemStatus[]).map((s) => (
          <span key={s}><span className="sw" style={{ background: COLORS[s] }} />{s} {counts[s]}</span>
        ))}
      </div>
    </div>
  );
}
