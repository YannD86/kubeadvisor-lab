"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, Braces, Check, Crown, GraduationCap, Laptop, Lock, Server, TerminalSquare, UserPlus } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { ClusterStatus, Progress, ProductsResponse, Realm } from "@/lib/types";
import { REALM_CLASS, fmtPrice, realmHref } from "@/lib/utils";
import { REALM_ICONS } from "@/components/icons";
import ProductCard from "@/components/ProductCard";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { Button, Card, Dot } from "@/components/ui";

export default function HomePage() {
  const { auth_mode, lab_mode, loaded } = useMeta();
  const { user, entitled, loading } = useAuth();
  const [realms, setRealms] = useState<Realm[]>([]);
  const [prog, setProg] = useState<Progress | null>(null);
  const [st, setSt] = useState<ClusterStatus | null>(null);
  const [catalog, setCatalog] = useState<ProductsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hosted = loaded && lab_mode === "hosted";
  const accounts = loaded && auth_mode === "accounts";

  useEffect(() => {
    api.realms().then((r) => { setRealms(r.realms); setErr(null); }).catch((e) => setErr(errorMessage(e)));
    api.progress().then(setProg).catch(() => null);
    api.products.list().then(setCatalog).catch(() => null);
  }, [user?.id]);
  useEffect(() => { if (loaded && !hosted) api.clusterStatus().then(setSt).catch(() => null); }, [loaded, hosted]);

  const doneFor = (r: Realm) => {
    if (!prog) return null;
    if (r.kind === "builders") return prog.done.builders;
    if (r.kind === "scenarios") return prog.done.scenarios;
    return prog.items.filter((i) => i.kind === "lesson" && i.status === "completed" && String(i.item_id).startsWith(r.id + "/")).length;
  };
  const hasPro = entitled("pro");
  const products = (catalog?.products || []).filter((p) => p.status !== "draft").sort((a, b) => a.order - b.order);
  const featured = products.filter((p) => p.featured);
  const shown = (featured.length ? featured : products).slice(0, 3);
  const pro = catalog?.pro;
  const proPrice = pro ? `${fmtPrice(pro.price_cents, pro.currency)}/${pro.interval}` : null;

  return (
    <div className="mx-auto max-w-6xl">
      {/* ---- hero */}
      <section className="mb-8 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-sky-400">KubeAdvisor</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white md:text-4xl">Learn Kubernetes the way SREs do: real clusters, real faults, real manifests.</h1>
          <p className="mt-3 max-w-2xl text-slate-300">Five realms on a real kind cluster: write manifests and CRDs from a blank editor, run a GitOps flow with Flux and Helm, open up the control plane, fix loaded failure scenarios with a terminal and k9s. Then take it further with exam-preparation and production courses built on the same labs.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/build"><Button><Braces className="h-4 w-4" /> Start with manifests</Button></Link>
            <Link href="/courses"><Button variant="secondary"><GraduationCap className="h-4 w-4" /> Browse courses</Button></Link>
            <Link href="/scenarios"><Button variant="ghost"><TerminalSquare className="h-4 w-4" /> Jump into a scenario</Button></Link>
          </div>
        </div>
        {hosted || (accounts && !user && !loading) ? (
          <Card className="p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-white"><Crown className="h-4 w-4 text-amber-300" /> {user ? (hasPro ? "You are on Pro" : "Your plan: Free") : "Start free"}</p>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
              <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /> Builders and realm lessons</li>
              <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-400" /> First lesson of every course</li>
              <li className="flex items-center gap-2">{hasPro ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Lock className="h-3.5 w-3.5 text-amber-300" />} Loaded scenarios</li>
              <li className="flex items-center gap-2">{hasPro ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Lock className="h-3.5 w-3.5 text-amber-300" />} All courses and assessments</li>
            </ul>
            {!user && accounts ? <Link href="/signup" className="mt-3 block"><Button size="sm" className="w-full"><UserPlus className="h-4 w-4" /> Create a free account</Button></Link> : !hasPro && accounts ? <Link href="/pricing" className="mt-3 block"><Button size="sm" className="w-full"><Crown className="h-4 w-4" /> Get Pro{proPrice ? ` · ${proPrice}` : ""}</Button></Link> : <Link href="/progress" className="mt-3 block"><Button size="sm" variant="secondary" className="w-full">See your progress</Button></Link>}
          </Card>
        ) : (
          <Card className="p-4">
            <div className="flex items-center justify-between"><p className="flex items-center gap-2 text-sm font-semibold text-white"><Server className="h-4 w-4 text-sky-300" /> Lab cluster</p><Link href="/cluster" className="text-xs text-sky-300 hover:underline">manage</Link></div>
            {!st ? <p className="mt-3 text-sm text-slate-400">Checking…</p> : (
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex items-center gap-2"><Dot ok={st.docker} /> Docker {st.docker ? "running" : "not running"}</li>
                <li className="flex items-center gap-2"><Dot ok={st.exists} /> kind cluster <span className="font-mono text-xs">{st.cluster_name}</span> {st.exists ? "present" : "absent"}</li>
                <li className="flex items-center gap-2"><Dot ok={st.api_reachable ? st.nodes.every((n) => n.ready) : false} /> {st.nodes.length ? `${st.nodes.filter((n) => n.ready).length}/${st.nodes.length} nodes Ready` : "no nodes"}</li>
                <li className="flex items-center gap-2"><Dot ok={Object.values(st.addons || {}).some(Boolean) ? true : null} /> addons: {Object.entries(st.addons || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</li>
              </ul>
            )}
            {st && !st.exists && <Link href="/cluster" className="mt-3 block"><Button size="sm" className="w-full">Create the cluster</Button></Link>}
          </Card>
        )}
      </section>
      {err && <p className="mb-4 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">Cannot reach the API ({err}). {hosted ? "Try again in a moment." : <>Start it with <code>./start.sh</code>.</>}</p>}

      {/* ---- realms */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {realms.map((r) => {
          const Icon = REALM_ICONS[r.icon] || Braces;
          const done = doneFor(r);
          const locked = accounts && !hasPro && (r.access === "pro" || r.locked === true);
          return (
            <Link key={r.id} href={realmHref(r)} className={`${REALM_CLASS[r.color]} group rounded-xl border border-line bg-panel p-5 transition-all rc-ring`}>
              <div className="flex items-start justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-lg rc-bg rc-text"><Icon className="h-5 w-5" /></span>
                <span className="flex items-center gap-2 text-[11px] text-slate-500">{locked && <span className="inline-flex items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-200"><Lock className="h-2.5 w-2.5" /> Pro</span>}realm {r.order}</span>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-white">{r.title}</h2>
              <p className="mt-1 text-sm text-slate-400">{r.tagline}</p>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                <span>{r.item_count} {r.kind === "builders" ? "activities" : r.kind === "scenarios" ? "scenarios" : "lessons"}{done != null && done > 0 ? ` · ${done} done` : ""}</span>
                <span className="inline-flex items-center gap-1 rc-text opacity-0 transition-opacity group-hover:opacity-100">open <ArrowRight className="h-3 w-3" /></span>
              </div>
            </Link>
          );
        })}
      </section>

      {/* ---- featured courses */}
      {shown.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <div><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><GraduationCap className="h-4 w-4" /> Featured courses</p><h2 className="mt-1 text-xl font-bold text-white">Structured paths on top of the realms</h2></div>
            <Link href="/courses" className="inline-flex items-center gap-1 text-sm text-sky-300 hover:underline">All courses <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}

      {/* ---- pro pitch + runner explainer */}
      <section className="mt-10 grid gap-4 lg:grid-cols-2">
        <Card className="border-amber-500/30 bg-amber-500/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-white"><Crown className="h-4 w-4 text-amber-300" /> KubeAdvisor Pro</p>
          <p className="mt-2 text-sm text-slate-300">Everything in Free, plus the 28 loaded troubleshooting scenarios with checks and solutions, and every course, assessment and exercise.{proPrice ? ` ${proPrice}, cancel any time.` : ""}</p>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-200">
            {["Fix real faults in a real cluster, checked automatically", "CKA / CKAD exam preparation with per-domain scoring", "Interview drills and the production playbook"].map((t) => <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {t}</li>)}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/pricing"><Button size="sm">{hasPro ? "See plans" : "Compare Free and Pro"} <ArrowRight className="h-3.5 w-3.5" /></Button></Link>
            <Link href="/learn/troubleshooting/method"><Button size="sm" variant="ghost"><BookOpen className="h-3.5 w-3.5" /> Read the method (free)</Button></Link>
          </div>
        </Card>
        <Card className="border-sky-500/30 bg-sky-500/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-white"><Laptop className="h-4 w-4 text-sky-300" /> Labs run on your machine</p>
          <p className="mt-2 text-sm text-slate-300">Nothing is simulated. The KubeAdvisor runner starts a 3-node kind cluster with Calico on your laptop, gives you a web terminal with kubectl, helm, flux and k9s, injects the scenario faults and runs the checks. Lessons, courses and your progress live here{hosted ? "" : " or on the platform"}; the runner syncs them with a lab token.</p>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-200">
            {["Docker + kind, no cloud account, no cost per hour", "Break it as hard as you like: reset in one click", "Progress mirrored to your account automatically"].map((t) => <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {t}</li>)}
          </ul>
          <Link href="/account#runner" className="mt-4 inline-block"><Button size="sm" variant="secondary"><Laptop className="h-3.5 w-3.5" /> Set up the local runner</Button></Link>
        </Card>
      </section>
    </div>
  );
}
