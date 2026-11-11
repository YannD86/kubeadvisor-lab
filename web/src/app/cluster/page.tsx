"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Box, Download, Eraser, Power, PowerOff, RefreshCw, Server, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import type { AddonDef, ClusterStatus, Job } from "@/lib/types";
import { Badge, Button, Card, Dot, Spinner } from "@/components/ui";
import JobLog, { useJob } from "@/components/JobLog";
import { useTerminal } from "@/components/TerminalContext";
import { useMeta } from "@/components/PlatformContext";
import RunnerBanner from "@/components/RunnerBanner";

export default function ClusterPage() {
  const { lab_mode, loaded } = useMeta();
  const hosted = loaded && lab_mode === "hosted";
  const [st, setSt] = useState<ClusterStatus | null>(null);
  const [tools, setTools] = useState<Record<string, string | null> | null>(null);
  const [addons, setAddons] = useState<AddonDef[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run } = useTerminal();
  const refresh = useCallback(() => api.clusterStatus().then(setSt).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    if (!loaded || hosted) return; // no cluster routes on a hosted platform
    refresh(); api.tools().then(setTools).catch(() => null); api.realms().then((r) => setAddons(r.addons)).catch(() => null);
    const t = setInterval(refresh, 10000); return () => clearInterval(t);
  }, [refresh, loaded, hosted]);
  const job = useJob(jobId, () => refresh());
  const go = async (fn: () => Promise<Job>) => { setErr(null); try { const j = await fn(); setJobId(j.id); } catch (e) { setErr((e as Error).message); } };
  const busy = job?.status === "running" || (st?.running_jobs.length ?? 0) > 0;
  const downAction = () => { if (confirm("Delete the kind cluster and everything in it?")) go(api.clusterDown); };

  if (hosted) {
    return (
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><Server className="h-4 w-4" /> Lab cluster</p>
          <h1 className="mt-1 text-2xl font-bold text-white">No cluster on this host</h1>
          <p className="mt-1 text-sm text-slate-400">This is the hosted KubeAdvisor platform: it serves lessons, courses and your progress. The kind cluster, terminal and k9s live in the runner on your machine.</p>
        </header>
        <RunnerBanner />
        <Card className="mt-4 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Box className="h-4 w-4 text-sky-300" /> What the runner sets up</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-300">
            <li className="flex items-center gap-2"><Dot ok={null} /> 3-node kind cluster <span className="font-mono text-xs text-slate-400">sre-labs</span> with Calico (NetworkPolicy enforced)</li>
            <li className="flex items-center gap-2"><Dot ok={null} /> Addons on demand: Gitea, Flux, metrics-server, ingress-nginx, cert-manager</li>
            <li className="flex items-center gap-2"><Dot ok={null} /> Web terminal with kubectl, helm, flux, git and k9s; <code className="text-slate-200">lab check</code> / <code className="text-slate-200">lab hint</code> helpers</li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">Requirements on your machine: Docker, kind, kubectl, helm, flux, k9s (<code>brew install kind kubectl helm fluxcd/tap/flux k9s kubeconform</code>).</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><Server className="h-4 w-4" /> Lab cluster</p>
          <h1 className="mt-1 text-2xl font-bold text-white">kind · 3 nodes · Calico</h1>
          <p className="mt-1 text-sm text-slate-400">One local cluster backs every scenario and builder. Addons are installed on demand. Kubeconfig: <code className="text-slate-300">{st?.kubeconfig || "~/.kubeadvisor/kubeconfig"}</code></p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw className="h-3.5 w-3.5" /> refresh</Button>
          {st && !st.exists && <Button onClick={() => go(api.clusterUp)} disabled={busy || !st.docker}>{busy ? <Spinner /> : <Power className="h-4 w-4" />} Create cluster</Button>}
          {st?.exists && <Button variant="secondary" onClick={() => go(api.resetLabs)} disabled={busy}><Eraser className="h-4 w-4" /> Delete lab namespaces</Button>}
          {st?.exists && <Button variant="danger" onClick={downAction} disabled={busy}><PowerOff className="h-4 w-4" /> Delete cluster</Button>}
        </div>
      </header>
      {err && <p className="mb-4 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"><AlertTriangle className="h-4 w-4" /> {err}</p>}
      {st && !st.docker && <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">Docker is not reachable. Start Docker Desktop (with WSL integration enabled for this distro) and refresh.</p>}
      {st && !st.kind_installed && <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">kind is not installed: <code>brew install kind</code></p>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Box className="h-4 w-4 text-sky-300" /> Status</h2>
          {!st ? <p className="mt-3 text-sm text-slate-400">Loading…</p> : (
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-center gap-2"><Dot ok={st.docker} /> Docker daemon</li>
              <li className="flex items-center gap-2"><Dot ok={st.exists} /> kind cluster <span className="font-mono text-xs text-slate-400">{st.cluster_name}</span></li>
              <li className="flex items-center gap-2"><Dot ok={st.exists ? st.api_reachable : null} /> API server reachable</li>
            </ul>
          )}
          {st && st.nodes.length > 0 && (
            <table className="mt-4 w-full text-xs">
              <thead><tr className="text-left text-slate-500"><th className="py-1 font-medium">node</th><th className="font-medium">role</th><th className="font-medium">status</th><th className="font-medium">version</th></tr></thead>
              <tbody>{st.nodes.map((n) => <tr key={n.name} className="border-t border-line"><td className="py-1.5 font-mono">{n.name}</td><td>{n.role}</td><td><span className="inline-flex items-center gap-1.5"><Dot ok={n.ready} /> {n.ready ? "Ready" : "NotReady"}{n.unschedulable && <Badge className="border-amber-500/40 text-amber-200">cordoned</Badge>}{n.taints.filter((t) => !t.includes("control-plane")).map((t) => <Badge key={t} className="border-slate-600 text-slate-300">{t}</Badge>)}</span></td><td className="font-mono text-slate-400">{n.version}</td></tr>)}</tbody>
            </table>
          )}
          {st?.exists && <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => run("kubectl get nodes -o wide && kubectl get pods -A | grep -v Running")}>inspect in terminal</Button><Button size="sm" variant="ghost" onClick={() => run("k9s -A")}>open k9s</Button></div>}
        </Card>
        <Card className="p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Download className="h-4 w-4 text-sky-300" /> Addons</h2>
          <ul className="mt-3 space-y-2">
            {addons.map((a) => {
              const installed = st?.addons[a.id];
              const installing = st?.running_jobs.some((j) => j.meta?.addon === a.id) || (job?.status === "running" && job.meta?.addon === a.id);
              return (
                <li key={a.id} className="flex items-start justify-between gap-3 rounded-md border border-line p-2.5">
                  <div className="min-w-0"><p className="flex items-center gap-2 text-sm text-slate-100"><Dot ok={installed ? true : null} /> {a.title}</p><p className="mt-0.5 text-xs text-slate-400">{a.description}</p></div>
                  <Button size="sm" variant={installed ? "ghost" : "secondary"} disabled={!st?.api_reachable || busy || installed} onClick={() => go(() => api.installAddon(a.id))}>{installing ? <Spinner /> : installed ? "installed" : "install"}</Button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {job && <div className="mt-4"><JobLog job={job} /></div>}

      <Card className="mt-4 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Wrench className="h-4 w-4 text-sky-300" /> Tooling on this machine</h2>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {tools ? Object.entries(tools).map(([k, v]) => <div key={k} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5"><Dot ok={!!v} /><span className="font-mono text-slate-200">{k}</span><span className="ml-auto truncate text-slate-500" title={v || "missing"}>{v || "missing"}</span></div>) : <p className="text-slate-400">Loading…</p>}
        </div>
        <p className="mt-3 text-xs text-slate-500">Install missing tools with Homebrew: <code>brew install kind k9s kubectl helm fluxcd/tap/flux kubeconform</code>. Docker Desktop must have WSL integration enabled.</p>
      </Card>
    </div>
  );
}
