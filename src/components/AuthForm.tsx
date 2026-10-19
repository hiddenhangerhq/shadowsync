"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction, signupAction, type AuthState } from "@/app/auth-actions";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(mode === "login" ? loginAction : signupAction, undefined);
  return (
    <div className="auth">
      <div className="brand" style={{ fontSize: "1.6rem", marginBottom: 16 }}>Shadow<b>Sync</b></div>
      <form action={action} className="card glow">
        <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
        {state?.notice && <p className="muted" role="status">{state.notice}</p>}
        {state?.error && <p className="err" role="alert">{state.error}</p>}
        <label className="f">Email<input className="input" name="email" type="email" autoComplete="email" required /></label>
        <label className="f">Password
          <input className="input" name="password" type="password" minLength={8} required
            autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        <button className="btn primary" style={{ width: "100%" }} disabled={pending}>{pending ? "Please wait…" : mode === "login" ? "Sign in" : "Sign up"}</button>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {mode === "login" ? <>No account? <Link href="/signup">Create one</Link></> : <>Have an account? <Link href="/login">Sign in</Link></>}
        </p>
      </form>
    </div>
  );
}
