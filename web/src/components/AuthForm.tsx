"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { LogIn, Server, UserPlus } from "lucide-react";
import { errorCode, errorMessage, errorStatus } from "@/lib/api";
import { safeNext } from "@/lib/utils";
import { useAuth, useMeta } from "./PlatformContext";
import { Button, Card, Spinner } from "./ui";

const INPUT = "mt-1 w-full rounded-md border border-slate-700 bg-[#0a0f1c] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none";

/** Shared centred form for /login and /signup. Redirects to `?next=` (same-site paths only) or `/`. */
export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { auth_mode, signup_enabled, loaded } = useMeta();
  const { user, loading, login, signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // local runner: no accounts → straight back home; already signed in → continue
  useEffect(() => {
    if (!loaded) return;
    if (auth_mode === "local") { router.replace("/"); return; }
    if (!loading && user && !busy) router.replace(next);
  }, [loaded, auth_mode, loading, user, next, router, busy]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (mode === "signup" && password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      if (mode === "login") await login(email.trim(), password); else await signup(email.trim(), password, name.trim() || undefined);
      router.replace(next);
    } catch (ex) {
      const code = errorCode(ex), status = errorStatus(ex);
      if (code === "invalid_credentials" || (mode === "login" && status === 401)) setErr("Invalid email or password.");
      else if (code === "email_taken") setErr("An account with this email already exists. Sign in instead.");
      else if (status === 404 && mode === "signup") setErr("Sign-up is not available on this instance.");
      else if (status === 422) setErr("Please check the email address and password (8 characters minimum).");
      else setErr(errorMessage(ex));
      setBusy(false);
    }
  };

  const isLogin = mode === "login";
  const signupClosed = !isLogin && loaded && !signup_enabled;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <div className="mb-6 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sky-300"><Server className="h-4 w-4" /></span>
        <div><p className="text-sm font-semibold text-white">KubeAdvisor</p><p className="text-[11px] text-slate-500">{isLogin ? "Welcome back" : "Create your account"}</p></div>
      </div>
      <Card className="p-5">
        <h1 className="text-lg font-semibold text-white">{isLogin ? "Sign in" : "Sign up"}</h1>
        <p className="mt-1 text-xs text-slate-400">{isLogin ? "Your courses, Pro access and lab progress follow your account." : "Free account: builders, realm lessons and course previews. Upgrade any time."}</p>
        {signupClosed && <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm text-amber-100">Sign-ups are closed on this instance. Ask the administrator for an account.</p>}
        <form onSubmit={submit} className="mt-4 space-y-3">
          {!isLogin && <label className="block text-xs text-slate-300">Name <span className="text-slate-500">(optional)</span><input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada" /></label>}
          <label className="block text-xs text-slate-300">Email<input className={INPUT} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" /></label>
          <label className="block text-xs text-slate-300">Password<input className={INPUT} type="password" required minLength={isLogin ? undefined : 8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isLogin ? "current-password" : "new-password"} placeholder={isLogin ? "••••••••" : "8+ characters"} /></label>
          {err && <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-sm text-rose-200">{err}</p>}
          <Button type="submit" className="w-full" disabled={busy || signupClosed || !loaded}>{busy ? <Spinner /> : isLogin ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />} {isLogin ? "Sign in" : "Create account"}</Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-400">
          {isLogin ? <>No account yet? <Link href={`/signup?next=${encodeURIComponent(next)}`} className="text-sky-300 hover:underline">Sign up</Link></> : <>Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-sky-300 hover:underline">Sign in</Link></>}
        </p>
      </Card>
      <p className="mt-4 text-center text-[11px] text-slate-500">You will be sent back to <span className="font-mono">{next}</span>.</p>
    </div>
  );
}
