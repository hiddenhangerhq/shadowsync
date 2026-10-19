/** Phone number -> E.164 ("+15551234567"), or null if it can't be one. US/Canada numbers may be typed without +1. */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const digits = s.replace(/[\s().-]/g, "");
  let e164: string;
  if (digits.startsWith("+")) e164 = digits;
  else if (/^\d{10}$/.test(digits)) e164 = `+1${digits}`;
  else if (/^1\d{10}$/.test(digits)) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}
