"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, CreditCard, Crown, ExternalLink, KeyRound, Laptop, Plus, RefreshCw, Trash2, UserCircle } from "lucide-react";
import { api, errorMessage, errorStatus } from "@/lib/api";
import type { LabToken, LabTokenCreated, Purchases, SyncStatus } from "@/lib/types";
import { cn, fmtAgo, fmtDate, fmtPrice } from "@/lib/utils";
import { ErrorCard, SignInPrompt } from "@/components/Gate";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { BILLING_TOOLTIP } from "@/components/useCheckout";
import { Badge, Button, Card, Spinner } from "@/components/ui";

const REPO = process.env.NEXT_PUBLIC_REPO_URL || "<repo>";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>
      {ok ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />} {ok ? "Copied" : label}
    </Button>
  );
}

function Snippet({ token }: { token: string | null }) {
  // only mounted client-side (after meta/auth load), so reading window here cannot mismatch SSR
  const [origin] = useState(() => (typeof window !== "undefined" ? window.location.origin : "https://<platform-url>"));
  const text = `git clone ${REPO} && cd kubeadvisor-platform\nKA_PLATFORM_URL=${origin} KA_LAB_TOKEN=${token || "kal_..."} ./start.sh`;
  return (
    <div className="relative rounded-lg border border-line bg-[#0a0f1c]">
      <div className="absolute right-2 top-2"><CopyButton text={text} /></div>
      <pre className="overflow-x-auto px-4 py-3 pr-24 font-mono text-[12.5px] leading-6 text-slate-200">{text}</pre>
    </div>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const { auth_mode, billing_enabled, lab_mode, loaded } = useMeta();
  const { user, entitlements, loading, refresh } = useAuth();
  const local = auth_mode === "local";

  // ---- billing
  const [purchases, setPurchases] = useState<Purchases | null>(null);
  const [purchasesErr, setPurchasesErr] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalErr, setPortalErr] = useState<string | null>(null);
  // ---- lab tokens
  const [tokens, setTokens] = useState<LabToken[] | null>(null);
  const [tokensErr, setTokensErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<LabTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // ---- runner side
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  // ---- danger zone
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const loadTokens = useCallback(() => api.labTokens.list().then((r) => { setTokens(r.tokens); setTokensErr(null); }).catch((e) => setTokensErr(errorMessage(e))), []);
  const loadSync = useCallback(() => api.sync.status().then((s) => { setSync(s); setSyncErr(null); }).catch((e) => setSyncErr(errorStatus(e) === 404 ? "This API has no sync status endpoint." : errorMessage(e))), []);

  useEffect(() => {
    if (!loaded || loading) return;
    if (local) { loadSync(); return; }
    if (!user) return;
    loadTokens();
    api.billing.purchases().then((p) => { setPurchases(p); setPurchasesErr(null); }).catch((e) => setPurchasesErr(errorStatus(e) === 404 ? null : errorMessage(e)));
  }, [loaded, loading, local, user, loadTokens, loadSync]);

  // scroll to #runner once the section exists
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#runner") return;
    const t = setTimeout(() => document.getElementById("runner")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    return () => clearTimeout(t);
  }, [user, loaded]);

  const createToken = async () => {
    if (!newName.trim()) return;
    setCreating(true); setTokensErr(null);
    try { const t = await api.labTokens.create(newName.trim()); setCreated(t); setNewName(""); await loadTokens(); }
    catch (e) { setTokensErr(errorMessage(e)); }
    finally { setCreating(false); }
  };
  const revoke = async (t: LabToken) => {
    if (!confirm(`Revoke token "${t.name}"? The runner using it will stop syncing.`)) return;
    setRevoking(t.id);
    try { await api.labTokens.remove(t.id); if (created?.id === t.id) setCreated(null); await loadTokens(); }
    catch (e) { setTokensErr(errorMessage(e)); }
    finally { setRevoking(null); }
  };
  const openPortal = async () => {
    setPortalBusy(true); setPortalErr(null);
    try { const { url } = await api.billing.portal(); if (url) window.location.assign(url); else setPortalErr("No portal URL returned."); }
    catch (e) { setPortalErr(errorMessage(e)); }
    finally { setPortalBusy(false); }
  };
  const resetProgress = async () => {
    if (!confirm("Reset ALL your progress (builders, scenarios, lessons, courses, assessments)? This cannot be undone.")) return;
    setResetBusy(true); setResetMsg(null);
    try { await api.resetProgress(); setResetMsg("Progress reset."); router.refresh(); }
    catch (e) { setResetMsg(`Failed: ${errorMessage(e)}`); }
    finally { setResetBusy(false); }
  };

  if (!loaded || loading) return <p className="text-slate-400">Loading…</p>;
  if (!local && !user) return <div className="mx-auto max-w-3xl"><SignInPrompt message="Sign in to manage your account, purchases and lab runner tokens." /></div>;

  const isPro = !!user && (user.tier === "pro" || entitlements.pro);
  const sub = purchases?.subscription;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><UserCircle className="h-4 w-4" /> Account</p>
        <h1 className="mt-1 text-2xl font-bold text-white">{local ? "Local runner" : user?.name || user?.email}</h1>
      </header>

      {/* ---- profile */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-white">Profile</h2>
        {local ? (
          <p className="mt-2 text-sm text-slate-300">This instance runs in <code className="rounded bg-slate-800 px-1">auth_mode=local</code>: a single implicit admin user (<span className="font-mono text-slate-200">{user?.email || "local@runner"}</span>). Accounts, sign-in and billing live on the KubeAdvisor platform; connect this runner to it below to sync your progress.</p>
        ) : user && (
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">Email</dt><dd className="text-slate-100">{user.email}</dd></div>
            <div><dt className="text-xs text-slate-500">Name</dt><dd className="text-slate-100">{user.name || <span className="text-slate-500">—</span>}</dd></div>
            <div><dt className="text-xs text-slate-500">Plan</dt><dd className="mt-0.5"><Badge className={isPro ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-600 text-slate-300"}>{isPro ? <><Crown className="mr-1 h-3 w-3" /> Pro</> : "Free"}</Badge>{!isPro && <Link href="/pricing" className="ml-2 text-xs text-sky-300 hover:underline">Get Pro</Link>}</dd></div>
            <div><dt className="text-xs text-slate-500">Role</dt><dd className="mt-0.5"><Badge className={user.role === "admin" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-slate-600 text-slate-300"}>{user.role}</Badge></dd></div>
            <div><dt className="text-xs text-slate-500">Member since</dt><dd className="text-slate-100">{fmtDate(user.created_at) || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Courses owned</dt><dd className="text-slate-100">{entitlements.pro || entitlements.admin ? "all (Pro)" : entitlements.products.length ? entitlements.products.join(", ") : "none yet"}</dd></div>
          </dl>
        )}
      </Card>

      {/* ---- purchases & billing (accounts mode only) */}
      {!local && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><CreditCard className="h-4 w-4 text-sky-300" /> Purchases & billing</h2>
            {billing_enabled ? <Button size="sm" variant="secondary" onClick={openPortal} disabled={portalBusy}>{portalBusy ? <Spinner /> : <ExternalLink className="h-3.5 w-3.5" />} Manage billing</Button> : <span className="text-xs text-slate-500" title={BILLING_TOOLTIP}>{BILLING_TOOLTIP}</span>}
          </div>
          {portalErr && <p className="mt-2 text-sm text-rose-300">{portalErr}</p>}
          {purchasesErr && <ErrorCard message={purchasesErr} className="mt-3" />}
          {sub && <p className="mt-3 text-sm text-slate-300">Pro subscription: <Badge className={sub.status === "active" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}>{sub.status}</Badge>{sub.current_period_end ? <span className="ml-2 text-xs text-slate-500">renews / ends {fmtDate(sub.current_period_end)}</span> : null}</p>}
          {purchases && purchases.purchases.length === 0 && !sub && <p className="mt-3 text-sm text-slate-400">No purchases yet. Browse the <Link href="/courses" className="text-sky-300 hover:underline">courses</Link> or <Link href="/pricing" className="text-sky-300 hover:underline">compare plans</Link>.</p>}
          {purchases && purchases.purchases.length > 0 && (
            <table className="table-plain mt-3">
              <thead><tr><th>Product</th><th>Amount</th><th>Granted</th><th>Expires</th></tr></thead>
              <tbody>{purchases.purchases.map((p, i) => <tr key={`${p.product}-${i}`}><td><Link href={`/courses/${p.product}`} className="text-sky-300 hover:underline">{p.product}</Link></td><td className="text-slate-200">{p.amount_cents ? fmtPrice(p.amount_cents, p.currency) : <span className="text-slate-500">granted</span>}</td><td className="text-slate-400">{fmtDate(p.granted_at)}</td><td className="text-slate-400">{p.expires_at ? fmtDate(p.expires_at) : "never"}</td></tr>)}</tbody>
            </table>
          )}
          {!purchases && !purchasesErr && <p className="mt-3 text-sm text-slate-500">Loading purchases…</p>}
        </Card>
      )}

      {/* ---- lab runner */}
      <Card id="runner" className="scroll-mt-16 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Laptop className="h-4 w-4 text-sky-300" /> Lab runner</h2>
        <p className="mt-2 text-sm text-slate-300">
          {lab_mode === "hosted"
            ? "This platform has no cluster. The hands-on parts (kind cluster, web terminal, k9s, loaded scenarios, builder apply) run in the KubeAdvisor runner on your own machine, and the runner pushes your progress back here with a lab token."
            : "This host runs the labs locally. Connect it to a KubeAdvisor platform account with a lab token so your progress is mirrored there."}
        </p>

        {local ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sync status</p><Button size="sm" variant="ghost" onClick={loadSync}><RefreshCw className="h-3.5 w-3.5" /> refresh</Button></div>
            {syncErr && <p className="text-sm text-slate-500">{syncErr}</p>}
            {sync && (
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-slate-500">Configured</dt><dd className="mt-0.5"><Badge className={sync.configured ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-slate-600 text-slate-300"}>{sync.configured ? "yes" : "no"}</Badge></dd></div>
                <div><dt className="text-xs text-slate-500">Platform</dt><dd className="font-mono text-xs text-slate-200">{sync.platform_url || "—"}</dd></div>
                <div><dt className="text-xs text-slate-500">Last sync</dt><dd className="text-slate-200">{sync.last_sync ? fmtAgo(sync.last_sync) : "never"}</dd></div>
                <div><dt className="text-xs text-slate-500">Last error</dt><dd className={cn("text-xs", sync.last_error ? "text-rose-300" : "text-slate-500")}>{sync.last_error || "none"}</dd></div>
              </dl>
            )}
            <p className="text-xs text-slate-400">To connect, create a lab token in your platform account (Account → Lab runner) and start this runner with:</p>
            <Snippet token={null} />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">1. Create a lab token</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createToken()} placeholder="token name, e.g. my laptop" className="h-9 w-64 rounded-md border border-slate-700 bg-[#0a0f1c] px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none" />
                <Button size="md" onClick={createToken} disabled={creating || !newName.trim()}>{creating ? <Spinner /> : <Plus className="h-4 w-4" />} Create token</Button>
              </div>
              {created && (
                <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-emerald-100"><KeyRound className="h-4 w-4" /> Token “{created.name}” created. Copy it now: it is shown only once.</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all rounded bg-black/40 px-2 py-1 font-mono text-sm text-emerald-50">{created.token}</code><CopyButton text={created.token} label="Copy token" /></div>
                </div>
              )}
              {tokensErr && <ErrorCard message={tokensErr} className="mt-3" />}
              {tokens && tokens.length > 0 ? (
                <table className="table-plain mt-3">
                  <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th className="text-right">Revoke</th></tr></thead>
                  <tbody>{tokens.map((t) => <tr key={t.id}><td className="text-slate-100">{t.name}</td><td className="text-slate-400">{fmtDate(t.created_at)}</td><td className="text-slate-400">{t.last_used_at ? fmtAgo(t.last_used_at) : "never"}</td><td className="text-right"><Button size="sm" variant="ghost" onClick={() => revoke(t)} disabled={revoking === t.id} title="Revoke">{revoking === t.id ? <Spinner /> : <Trash2 className="h-3.5 w-3.5 text-rose-300" />}</Button></td></tr>)}</tbody>
                </table>
              ) : tokens ? <p className="mt-3 text-sm text-slate-500">No tokens yet.</p> : !tokensErr && <p className="mt-3 text-sm text-slate-500">Loading tokens…</p>}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">2. Start the runner on your machine</p>
              <p className="mt-1 text-xs text-slate-400">Requires Docker, kind, kubectl, helm, flux and k9s (<code>brew install kind kubectl helm fluxcd/tap/flux k9s</code>). Then:</p>
              <div className="mt-2"><Snippet token={created?.token || null} /></div>
              <p className="mt-2 text-xs text-slate-500">The runner serves its own web UI on <span className="font-mono">localhost:10200</span>. Scenarios, the terminal and k9s run there; every progress write is mirrored to this account.</p>
            </div>
          </div>
        )}
      </Card>

      {/* ---- danger zone */}
      <Card className="border-rose-500/30 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-rose-200"><AlertTriangle className="h-4 w-4" /> Danger zone</h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-300">Reset my progress: removes every builder, scenario, lesson, course, exercise and assessment record{local ? " on this runner" : " for this account"}.</p>
          <Button variant="danger" size="sm" onClick={resetProgress} disabled={resetBusy}>{resetBusy ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} Reset my progress</Button>
        </div>
        {resetMsg && <p className="mt-2 text-xs text-slate-400">{resetMsg}</p>}
        {!local && <p className="mt-2 text-[11px] text-slate-500">Purchases and Pro are not affected. <button className="underline" onClick={() => refresh()}>Refresh entitlements</button> if something just changed.</p>}
      </Card>
    </div>
  );
}
