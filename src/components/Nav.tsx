"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/overview", label: "Overview" },
  { href: "/", label: "Mission Control" },
  { href: "/items", label: "Items" },
];

export default function Nav() {
  const path = usePathname();
  const on = (href: string) => (href === "/" ? path === "/" || path === "/ship" || path.startsWith("/ship/") : path === href || path.startsWith(href + "/"));
  return (
    <header className="nav">
      <div className="nav-in">
        <span className="brand">Shadow<b>Sync</b></span>
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={"navlink" + (on(l.href) ? " on" : "")}>{l.label}</Link>
        ))}
        <Link href="/settings" aria-label="Settings" className={"navlink" + (on("/settings") ? " on" : "")}>⚙</Link>
      </div>
    </header>
  );
}
