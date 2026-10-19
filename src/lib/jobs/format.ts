/** Short, readable timestamps for the job pages. Uses the server locale and time zone (UTC on Vercel). */
export function when(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export const words = (s: string) => s.replace(/_/g, " ");
