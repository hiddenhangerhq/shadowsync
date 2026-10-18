// Shared sales logic ported from the Apps Script dashboard (Dashboard.gs). Pure, no I/O, no framework imports,
// so Overview/Summary (step 2), API sync jobs and the extension endpoints can all reuse it.
export * from "./money";
export * from "./dates";
export * from "./metrics";
export * from "./platforms";
export * from "./titles";
export * from "./dedupe";
export * from "./legacy-email";
