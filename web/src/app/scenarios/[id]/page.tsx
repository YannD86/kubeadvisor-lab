"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Eraser, FlaskConical, Lightbulb, ListChecks, Play, RotateCcw, ScrollText, Server, TerminalSquare, XCircle } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import type { CheckResponse, Job, Scenario } from "@/lib/types";
import { Badge, Button, Spinner } from "@/components/ui";
import Markdown from "@/components/Markdown";
import JobLog, { useJob } from "@/components/JobLog";
import { useTerminal } from "@/components/TerminalContext";
import { useMeta } from "@/components/PlatformContext";
import RunnerBanner from "@/components/RunnerBanner";
import Paywall from "@/components/Paywall";
import { DIFF_COLOR, cn } from "@/lib/utils";

const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

type Tab = "brief" | "hints" | "checks" | "solution" | "log";

function TabBtn({ t, tab, setTab, icon: Icon, label }: { t: Tab; tab: Tab; setTab: (t: Tab) => void; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button onClick={() => setTab(t)} className={cn("inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium", tab === t ? "border-amber-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200")}><Icon className="h-3.5 w-3.5" />{label}</button>
  );
}

export default function ScenarioPage() {
  const { id } = useParams<{ id: string }>();
  const { lab_mode, loaded: metaLoaded } = useMeta();
  const hosted = metaLoaded && lab_mode === "hosted";
  const [s, setS] = useState<Scenario | null>(null);
  const [tab, setTab] = useState<Tab>("brief");
  const [term, setTerm] = useState<"shell" | "k9s">("shell");
  const [termKey, setTermKey] = useState(0);
  const [k9sKey, setK9sKey] = useState(0);
  const [k9sOpened, setK9sOpened] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [solution, setSolution] = useState<string | null>(null);
  const [err, setErr] = useState<{ title: string; detail?: string; missing?: string[] } | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null); // product id from a 402 (normally "pro")
  const { setContext, setOpen } = useTerminal();
  const shellWriter = useRef<((d: string) => void) | null>(null);

  const refresh = useCallback(() => api.scenario(id).then(setS).catch((e) => setErr({ title: e.message })), [id]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setContext(id, s?.namespace ?? null); setOpen(false); return () => setContext(null, null); }, [id, s?.namespace, setContext, setOpen]);

  const job = useJob(jobId, () => { refresh(); });
  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError) {
      if (e.status === 402) { setPaywall(e.field<string>("product") || "pro"); return; }
      if (typeof e.detail === "object" && e.detail) {
        const d = e.detail as { error?: string; message?: string; missing?: string[] };
        setErr({ title: d.message || fallback, missing: d.missing, detail: d.error });
        return;
      }
    }
    setErr({ title: (e as Error).message });
  };
  const run = async (fn: () => Promise<Job>) => {
    setErr(null); setCheck(null); setPaywall(null);
    try { const j = await fn(); setJobId(j.id); setTab("log"); }
    catch (e) { fail(e, "Cannot load scenario"); }
  };
  const doCheck = async () => { setChecking(true); setTab("checks"); try { const r = await api.checkScenario(id); setCheck(r); refresh(); } catch (e) { fail(e, "Check failed"); } finally { setChecking(false); } };
  const nextHint = async () => { if (!s) return; const idx = s.state.hints_revealed; if (idx >= s.hint_count) return; try { await api.hint(id, idx); refresh(); setTab("hints"); } catch (e) { fail(e, "Cannot reveal hint"); } };
  const loadSolution = async () => { try { const r = await api.solution(id); setSolution(r.markdown); setTab("solution"); refresh(); } catch (e) { fail(e, "Cannot load solution"); } };

  if (!s) return <p className="text-slate-400">{err ? err.title : "Loading…"}</p>;
  const loaded = s.state.status === "loaded" || s.state.status === "error";
  const working = s.state.status === "loading" || s.state.status === "cleaning" || job?.status === "running";

  return (
    <div className="realm-amber -mx-4 -my-6 flex h-[calc(100vh-3rem)] flex-col md:-mx-8">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 md:px-6">
        <Link href="/scenarios" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> scenarios</Link>
        <span className="text-slate-700">|</span>
        <h1 className="text-sm font-semibold text-white">{s.title}</h1>
        <Badge className={DIFF_COLOR[s.difficulty]}>{s.difficulty}</Badge>
        <Badge className="border-slate-600 text-slate-300">{s.category}</Badge>
        <span className="font-mono text-[11px] text-slate-500">ns {s.namespace}</span>
        {s.state.passed_at && <Badge className="border-emerald-500/50 bg-emerald-500/10 text-emerald-200"><CheckCircle2 className="mr-1 h-3 w-3" /> solved</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {hosted ? (
            <Link href="/account#runner" className="text-xs text-sky-300 hover:underline">Runs in your local runner →</Link>
          ) : !loaded ? (
            <Button size="sm" onClick={() => run(() => api.loadScenario(id))} disabled={working}>{working ? <Spinner /> : <Play className="h-3.5 w-3.5" />} Load scenario</Button>
          ) : (
            <>
              <Button size="sm" onClick={doCheck} disabled={checking}>{checking ? <Spinner /> : <ListChecks className="h-3.5 w-3.5" />} Check</Button>
              <Button size="sm" variant="secondary" onClick={nextHint} disabled={s.state.hints_revealed >= s.hint_count}><Lightbulb className="h-3.5 w-3.5" /> Hint {Math.min(s.state.hints_revealed + 1, s.hint_count)}/{s.hint_count}</Button>
              <Button size="sm" variant="ghost" onClick={() => run(() => api.resetScenario(id))} disabled={working} title="cleanup + setup"><RotateCcw className="h-3.5 w-3.5" /> Reset</Button>
              <Button size="sm" variant="ghost" onClick={() => run(() => api.cleanupScenario(id))} disabled={working} title="remove the scenario from the cluster"><Eraser className="h-3.5 w-3.5" /> Clean up</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(380px,42%)_1fr]">
        {/* ---- left: brief / hints / checks / solution / log */}
        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="flex items-center border-b border-line px-2">
            <TabBtn t="brief" tab={tab} setTab={setTab} icon={ScrollText} label="Brief" />
            <TabBtn t="hints" tab={tab} setTab={setTab} icon={Lightbulb} label={`Hints ${s.state.hints_revealed}/${s.hint_count}`} />
            <TabBtn t="checks" tab={tab} setTab={setTab} icon={ListChecks} label="Checks" />
            <TabBtn t="solution" tab={tab} setTab={setTab} icon={BookOpen} label="Solution" />
            {!hosted && <TabBtn t="log" tab={tab} setTab={setTab} icon={Server} label="Log" />}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {paywall && <Paywall product={paywall} className="mb-4" message="Loaded scenarios are part of KubeAdvisor Pro. Builders and realm lessons stay free." />}
            {err && (
              <div className="mb-4 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> {err.title}</p>
                {err.missing && <p className="mt-1 text-rose-200/80">Install from the <Link href="/cluster" className="underline">Cluster page</Link>: {err.missing.join(", ")}</p>}
                {err.detail === "cluster_unavailable" && <p className="mt-1 text-rose-200/80">Create the cluster from the <Link href="/cluster" className="underline">Cluster page</Link> first.</p>}
                {err.detail === "lab_mode_hosted" && <p className="mt-1 text-rose-200/80">Open <Link href="/account#runner" className="underline">Account → Lab runner</Link> to run this scenario on your machine.</p>}
              </div>
            )}
            {s.state.status === "error" && !err && !hosted && (
              <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"><AlertTriangle className="mr-1 inline h-4 w-4" /> {s.state.error ? <>{s.state.error.replace(/; see the Log tab\.$/, "")} (see the <button className="underline" onClick={() => setTab("log")}>Log</button> tab).</> : <>The last setup or cleanup job reported an error (see the <button className="underline" onClick={() => setTab("log")}>Log</button> tab). Resources may still be in place: you can investigate and run the checks, or Reset to reload cleanly.</>}</p>
            )}
            {tab === "brief" && (
              <div>
                {hosted ? <RunnerBanner compact className="mb-4 rounded-md border" /> : !loaded && !working && <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"><FlaskConical className="mr-1 inline h-4 w-4" /> Click <strong>Load scenario</strong> to inject the fault into your cluster, then investigate in the terminal on the right.</p>}
                <Markdown className="lesson text-[15px]">{s.brief}</Markdown>
                {s.requires_addons && s.requires_addons.length > 0 && <p className="mt-4 text-xs text-slate-500">Requires addons: {s.requires_addons.join(", ")}</p>}
                {s.lesson_items.length > 0 && (
                  <div className="mt-6"><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Read before or after</p>
                    <ul className="mt-1 space-y-1 text-sm">{s.lesson_items.map((l) => <li key={l.slug}><Link href={`/learn/${l.realm}/${l.slug}`} className="text-sky-300 hover:underline">{l.title}</Link></li>)}</ul></div>
                )}
              </div>
            )}
            {tab === "hints" && (
              <div className="space-y-3">
                {s.revealed_hints.length === 0 && <p className="text-sm text-slate-400">{hosted ? `${s.hint_count} progressive hints are revealed from the local runner while the scenario is loaded.` : "No hint revealed yet. Try the method first: observe, pick the layer, test. Hints get more specific each time."}</p>}
                {s.revealed_hints.map((h, i) => <div key={i} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-50"><span className="mr-2 font-semibold text-amber-300">Hint {i + 1}</span><Markdown className="inline [&_p]:inline [&_code]:bg-slate-800">{h}</Markdown></div>)}
                {!hosted && loaded && s.state.hints_revealed < s.hint_count && <Button size="sm" variant="secondary" onClick={nextHint}><Lightbulb className="h-3.5 w-3.5" /> Reveal hint {s.state.hints_revealed + 1}</Button>}
              </div>
            )}
            {tab === "checks" && (
              <div>
                <p className="mb-3 text-sm text-slate-400">The checker verifies the symptom is gone <em>and</em> that you fixed the right object.{hosted ? " Checks run in your local runner." : ""}</p>
                <ul className="space-y-2">
                  {s.checks.map((c, i) => {
                    const r = check?.results[i];
                    return (
                      <li key={i} className={cn("rounded-md border p-3 text-sm", r ? (r.passed ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/5") : "border-line")}>
                        <div className="flex items-start gap-2">
                          {r ? (r.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />) : checking ? <Spinner className="mt-0.5 shrink-0 text-slate-400" /> : <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-slate-600" />}
                          <div className="min-w-0 flex-1"><p className="text-slate-100">{c.name}</p>{r && !r.passed && r.output && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-slate-300">{r.output}</pre>}</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {check && (
                  <div className={cn("mt-4 rounded-md border p-3", check.passed ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-700")}>
                    <p className="font-semibold text-white">{check.passed ? "All checks passed. Scenario solved." : `Not yet — attempt ${check.attempts}.`}</p>
                    {check.passed && check.concepts && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">{check.concepts.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                    {check.passed && <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={loadSolution}>Compare with the solution</Button><Link href="/scenarios"><Button size="sm" variant="ghost">Next scenario</Button></Link></div>}
                  </div>
                )}
                {!hosted && loaded && !check && <Button className="mt-4" size="sm" onClick={doCheck} disabled={checking}>{checking ? <Spinner /> : <ListChecks className="h-3.5 w-3.5" />} Run checks</Button>}
              </div>
            )}
            {tab === "solution" && (
              solution ? <Markdown className="lesson text-[15px]">{solution}</Markdown> : (
                <div className="rounded-md border border-line p-4 text-sm text-slate-300">
                  <p>The solution shows the diagnosis path, root cause, fix and prevention. Viewing it is recorded in your progress; try the hints first.</p>
                  <Button className="mt-3" size="sm" variant="secondary" onClick={loadSolution}><BookOpen className="h-3.5 w-3.5" /> Show solution</Button>
                </div>
              )
            )}
            {tab === "log" && (job ? <JobLog job={job} /> : <p className="text-sm text-slate-400">No job yet. Load the scenario to see setup output here.</p>)}
          </div>
        </section>

        {/* ---- right: terminal tabs (local lab mode) or runner banner (hosted) */}
        {hosted ? (
          <section className="flex min-h-0 flex-col overflow-y-auto bg-[#0a0f1c] p-6">
            <RunnerBanner title="This scenario runs in your local runner" />
            <div className="mt-4 rounded-xl border border-line p-4 text-sm text-slate-300">
              <p className="font-medium text-white">What the runner gives you for this scenario</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>A real fault injected into namespace <span className="font-mono text-slate-200">{s.namespace}</span> of your kind cluster</li>
                <li>Web terminal with kubectl, helm, flux and a k9s tab; <code className="text-slate-200">lab check</code>, <code className="text-slate-200">lab hint</code>, <code className="text-slate-200">lab reset</code></li>
                <li>{s.check_count} automated checks and {s.hint_count} progressive hints; the solve is synced back to this account</li>
              </ul>
            </div>
          </section>
        ) : (
          <section className="flex min-h-0 flex-col bg-[#0a0f1c]">
            <div className="flex items-center gap-1 border-b border-line px-2 py-1 text-xs">
              <button onClick={() => setTerm("shell")} className={cn("inline-flex items-center gap-1.5 rounded px-2.5 py-1", term === "shell" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200")}><TerminalSquare className="h-3.5 w-3.5" /> shell</button>
              <button onClick={() => { setTerm("k9s"); setK9sOpened(true); }} className={cn("inline-flex items-center gap-1.5 rounded px-2.5 py-1", term === "k9s" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200")}><span className="font-mono font-bold">k9s</span> {s.namespace}</button>
              <span className="ml-2 hidden text-slate-500 xl:inline">in shell: <code className="text-slate-300">lab check</code> · <code className="text-slate-300">lab hint</code> · <code className="text-slate-300">kn get pods</code></span>
              <div className="ml-auto flex items-center gap-1">
                {term === "shell" && <Button size="sm" variant="ghost" onClick={() => shellWriter.current?.("kubectl get pods -n " + s.namespace + " -o wide\n")}>get pods</Button>}
                {term === "shell" && <Button size="sm" variant="ghost" onClick={() => shellWriter.current?.("kubectl get events -n " + s.namespace + " --sort-by=.lastTimestamp | tail -20\n")}>events</Button>}
                <Button size="sm" variant="ghost" title="new session" onClick={() => (term === "shell" ? setTermKey((k) => k + 1) : setK9sKey((k) => k + 1))}><RotateCcw className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {metaLoaded && <div className={cn("absolute inset-0", term !== "shell" && "invisible")}><Terminal mode="shell" scenario={id} namespace={s.namespace} sessionKey={termKey} onReady={(w) => { shellWriter.current = w; }} /></div>}
              {metaLoaded && k9sOpened && <div className={cn("absolute inset-0", term !== "k9s" && "invisible")}><Terminal mode="k9s" scenario={id} namespace={s.namespace} sessionKey={k9sKey} /></div>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
