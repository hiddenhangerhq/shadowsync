import { MARK, outcomeOf } from "@/lib/jobs/alerts";
/** Green check for a succeeded job, red X for failed / needs you. */
export default function JobMark({ status }: { status: string }) {
  const k = outcomeOf(status);
  if (!k) return null;
  return <span className={`jobmark ${k}`} role="img" aria-label={MARK[k].label} title={MARK[k].label}>{MARK[k].icon}</span>;
}
