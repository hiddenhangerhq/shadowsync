"use server";
import { redirect } from "next/navigation";
import { getServices } from "@/lib/data";

export type AuthState = { error?: string; notice?: string } | undefined;

export async function loginAction(_: AuthState, fd: FormData): Promise<AuthState> {
  const { auth } = await getServices();
  const r = await auth.signIn(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  if (!r.user) return { error: r.error ?? "Could not sign in." };
  redirect("/");
}

export async function signupAction(_: AuthState, fd: FormData): Promise<AuthState> {
  const { auth } = await getServices();
  const r = await auth.signUp(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  if (r.needsConfirmation) return { notice: "Check your email and click the confirmation link, then sign in." };
  if (!r.user) return { error: r.error ?? "Could not create the account." };
  redirect("/");
}

export async function logoutAction() {
  const { auth } = await getServices();
  await auth.signOut();
  redirect("/login");
}
