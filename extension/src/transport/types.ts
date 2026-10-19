// Pluggable per-marketplace transports. "dom" drives a background tab (runner.ts, the fallback); "request" talks to the marketplace
// from the service worker with your own signed-in browser session (fetch with credentials: "include"; we never read cookies and hold
// no "cookies" permission). The worker asks the request transport first and falls back to the tab when it does not support an action.
import type { ActionRequest } from "../../../src/lib/ext/protocol";
import type { RunOutcome } from "../runner";

export interface Transport {
  readonly name: "dom" | "request";
  /** True only when this transport has a verified plan for the action (request: endpoints filled in from a recording). */
  supports(a: ActionRequest): boolean;
  /** Never throws: every failure is a RunOutcome with a code. */
  run(a: ActionRequest, opts?: { onProgress?: (m: string) => void }): Promise<RunOutcome>;
}
export const SHAPE_CHANGED_MESSAGE = (label: string) => `${label} changed something, sync paused, update coming`;
