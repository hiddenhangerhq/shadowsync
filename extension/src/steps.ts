// What one step of an action reports back to the runner. A step looks at the CURRENT page only. It never gets or returns a URL:
// it names a page ("edit", "sales", ...) and the runner builds the URL from the host table.
import type { Action, ExtMarketplace, ResultCode } from "../../src/lib/ext/protocol";
import type { ExtScanSale } from "../../src/lib/data/types";

export type PageName = "home" | "listing" | "edit" | "create" | "sales" | "closet";
export interface StepInput { action: Action; marketplace: ExtMarketplace; payload: Record<string, unknown>; phase: string; url: string }
export interface DoneResult { externalId?: string; url?: string; alreadyDone?: boolean; note?: string; deleted?: boolean; fallback?: string }
export type StepResult =
  | { kind: "done"; result?: DoneResult; loggedIn?: boolean; sales?: ExtScanSale[]; nextCursor?: string | null; listingIds?: string[] }
  | { kind: "goto"; page: PageName; phase: string; user?: string }
  | { kind: "wait"; phase: string; ms: number }
  | { kind: "stop"; code: ResultCode; message: string; keepTab?: boolean };
export const stop = (code: ResultCode, message: string, keepTab = false): StepResult => ({ kind: "stop", code, message, keepTab });
