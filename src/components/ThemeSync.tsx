"use client";
import { useEffect } from "react";
import { applyTheme } from "@/lib/theme";
import type { ThemeId } from "@/lib/data/types";

/** Makes the signed-in user's saved theme (profile.theme) win over a stale localStorage value. */
export default function ThemeSync({ theme }: { theme: ThemeId }) {
  useEffect(() => {
    if (document.documentElement.getAttribute("data-theme-pref") !== theme) applyTheme(theme);
  }, [theme]);
  return null;
}
