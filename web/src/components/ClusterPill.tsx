"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Laptop } from "lucide-react";
import { api } from "@/lib/api";
import type { ClusterStatus } from "@/lib/types";
import { Dot } from "./ui";
import { useMeta } from "./PlatformContext";

export default function ClusterPill() {
  const { lab_mode, loaded } = useMeta();
  const hosted = loaded && lab_mode === "hosted";
  const [st, setSt] = useState<ClusterStatus | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!loaded || hosted) return; // no cluster on a hosted platform: nothing to poll
    let stop = false;
    const tick = async () => {
      try { const s = await api.clusterStatus(); if (!stop) { setSt(s); setErr(false); } } catch { if (!stop) setErr(true); }
      if (!stop) setTimeout(tick, 15000);
    };
    tick();
    return () => { stop = true; };
  }, [loaded, hosted]);
  if (hosted) {
    return (
      <Link href="/account#runner" title="Labs run in your local KubeAdvisor runner" className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">
        <Laptop className="h-3.5 w-3.5 text-sky-300" /><span className="hidden sm:inline">labs run on your machine</span><span className="sm:hidden">local runner</span>
      </Link>
    );
  }
  const ready = st?.nodes.filter((n) => n.ready).length ?? 0;
  const label = err ? "API offline" : !st ? "…" : !st.docker ? "Docker down" : !st.exists ? "No cluster" : !st.api_reachable ? "API unreachable" : `${ready}/${st.nodes.length} nodes`;
  const ok = err ? false : !st ? null : st.api_reachable && ready === st.nodes.length && ready > 0;
  const busy = (st?.running_jobs.length ?? 0) > 0;
  return (
    <Link href="/cluster" className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">
      <Dot ok={ok} pulse={busy} />
      <span className="font-mono">{st?.cluster_name || "sre-labs"}</span>
      <span className="text-slate-400">{busy ? "working…" : label}</span>
    </Link>
  );
}
