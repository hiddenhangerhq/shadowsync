"use client";
import { useState, useTransition } from "react";
import { THEMES, type ThemeId } from "@/lib/data/types";
import { applyTheme } from "@/lib/theme";
import { saveTheme } from "@/app/(app)/settings/actions";

export default function ThemePicker({ initial }: { initial: ThemeId }) {
  const [sel, setSel] = useState<ThemeId>(initial);
  const [, start] = useTransition();
  const pick = (id: ThemeId) => {
    setSel(id);
    applyTheme(id);               // instant + localStorage
    start(() => { saveTheme(id); }); // persist on the profile
  };
  return (
    <div className="swatch-grid" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={sel === t.id} className="theme-opt" onClick={() => pick(t.id)}>
          {t.id === "system" ? (
            <div style={{ display: "flex" }}>
              <div className="theme-prev" data-theme="light" style={{ flex: 1 }}><span className="a" /><span className="s" /></div>
              <div className="theme-prev" data-theme="dark" style={{ flex: 1 }}><span className="a" /><span className="s" /></div>
            </div>
          ) : (
            <div className="theme-prev" data-theme={t.id}><span className="a" /><span className="b" /><span className="s" /></div>
          )}
          <div className="theme-cap"><b>{t.label}</b><span className="muted small">{t.blurb}</span></div>
        </button>
      ))}
    </div>
  );
}
