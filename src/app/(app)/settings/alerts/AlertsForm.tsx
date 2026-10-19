"use client";
import { useActionState } from "react";
import { saveAlertsAction } from "./actions";

export default function AlertsForm({ smsEnabled, phone }: { smsEnabled: boolean; phone: string | null }) {
  const [state, action, pending] = useActionState(saveAlertsAction, null);
  return (
    <form action={action}>
      <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" name="sms" defaultChecked={smsEnabled} /> Text me when something needs me (a failed delist, a security check, signed out)</label>
      <label className="f small">Mobile number<input className="input" name="phone" type="tel" autoComplete="tel" defaultValue={phone ?? ""} placeholder="+1 555 123 4567" /></label>
      <button className="btn primary" disabled={pending} style={{ marginTop: 10 }}>Save</button>
      {state?.message && <p className="small">{state.message}</p>}
    </form>
  );
}
