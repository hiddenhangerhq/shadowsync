// Injected (chrome.scripting.executeScript, isolated world) into a marketplace tab we opened. It only registers one function the
// runner calls with a fixed action + data; it reads location itself and never receives code, selectors or URLs.
import type { StepInput, StepResult } from "../steps";
import { stop } from "../steps";
import { poshmarkStep } from "./poshmark";

export function runStep(doc: Document, input: StepInput): StepResult {
  try {
    if (input.marketplace === "poshmark") return poshmarkStep(doc, input);
    return stop("not_supported", "This marketplace is not supported by the extension yet");
  } catch (e) {
    return stop("action_failed", `Unexpected error on the page: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
  }
}
(globalThis as unknown as { __shadowsync?: { step: (i: Omit<StepInput, "url">) => StepResult } }).__shadowsync = {
  step: (i) => runStep(document, { ...i, url: location.href }),
};
