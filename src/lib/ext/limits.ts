// Server-side limits for the device API. The same numbers are in migration 0006 (_ext_rate calls); keep them in step.
export const EXT_RATE = {
  /** Pairing-code guesses, for everyone together: 8-character codes (about 40 bits) live 5 minutes, so this makes guessing hopeless. */
  pair: { max: 30, windowMs: 60_000 },
  /** Calls per device. A normal extension makes a few per job and one poll every 5 minutes. */
  device: { max: 300, windowMs: 10 * 60_000 },
} as const;
/** Open (unused, unexpired) pairing codes per user. */
export const PAIRING_MAX_ACTIVE = 5;
export const AUTO_PAUSE_REASON = "Paused automatically after 2 security checks in a row. Solve it in your browser, then resume.";
