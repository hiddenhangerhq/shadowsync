"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/overview", label: "Overview" },
  { href: "/", label: "Mission Control" },
  { href: "/items", label: "Items" },
];

export default function Nav({ jobsAttention = 0 }: { jobsAttention?: number }) {
  const path = usePathname();
  const on = (href: string) => (href === "/" ? path === "/" || path === "/ship" || path.startsWith("/ship/") || path === "/jobs" || path.startsWith("/jobs/") : path === href || path.startsWith(href + "/"));
  return (
    <header className="nav">
      <div className="nav-in">
        <span className="brand">Shadow<b>Sync</b></span>
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={"navlink" + (on(l.href) ? " on" : "")}>{l.label}</Link>
        ))}
        {jobsAttention > 0 && (
          <Link href="/jobs" className="navlink alert" aria-label={`${jobsAttention} jobs need attention`}>⚠<span className="badge-count">{jobsAttention}</span></Link>
        )}
        <Link href="/settings" aria-label="Settings" className={"navlink" + (on("/settings") ? " on" : "")}>⚙</Link>
      </div>
    </header>
  );
}
