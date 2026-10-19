"use server";
import { revalidatePath } from "next/cache";
import { getServices } from "@/lib/data";
import { normalizePhone } from "@/lib/alerts";

export async function saveAlertsAction(_prev: { message: string } | null, form: FormData): Promise<{ message: string }> {
  const smsEnabled = form.get("sms") === "on";
  const raw = String(form.get("phone") ?? "");
  const phone = raw.trim() ? normalizePhone(raw) : null;
  if (raw.trim() && !phone) return { message: "That phone number doesn't look right. Use the full number, like +1 555 123 4567." };
  if (smsEnabled && !phone) return { message: "Add a phone number to turn text alerts on." };
  const { store } = await getServices();
  await store.alerts.update({ smsEnabled, phone });
  revalidatePath("/settings/alerts");
  return { message: "Saved." };
}
