"use server";
import { revalidatePath } from "next/cache";
import { getServices } from "@/lib/data";

export async function markShippedAction(id: string, on: boolean) {
  const { store } = await getServices();
  await store.sales.markShipped(id, on);
  revalidatePath("/ship"); revalidatePath("/");
}
