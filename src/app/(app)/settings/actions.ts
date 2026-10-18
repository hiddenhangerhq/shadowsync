"use server";
import { getServices } from "@/lib/data";
import { isThemeId } from "@/lib/theme";

export async function saveTheme(theme: string) {
  if (!isThemeId(theme)) return;
  const { store } = await getServices();
  await store.profile.update({ theme });
}
