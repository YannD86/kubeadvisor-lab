"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Job } from "@/lib/types";
import { Spinner } from "./ui";
import { CheckCircle2, XCircle } from "lucide-react";

export function useJob(jobId: string | null, onDone?: (j: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const cb = useRef(onDone);
  useEffect(() => { cb.current = onDone; }, [onDone]);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (stop) return;
        setJob(j);
        if (j.status === "running") setTimeout(tick, 1000); else cb.current?.(j);
      } catch { if (!stop) setTimeout(tick, 2000); }
    };
    tick();
    return () => { stop = true; };
  }, [jobId]);
  return job && jobId && job.id === jobId ? job : null;
}

export default function JobLog({ job, title, compact }: { job: Job | null; title?: string; compact?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [job?.line_count]);
  if (!job) return null;
  const clean = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
  return (
    <div className="rounded-lg border border-line bg-[#0a0f1c]">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-1.5 text-xs text-slate-300">
        {job.status === "running" ? <Spinner className="text-sky-400" /> : job.status === "succeeded" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-rose-400" />}
        <span className="font-medium">{title || job.label}</span>
        <span className="text-slate-500">· {job.status} · {job.duration}s</span>
      </div>
      <pre ref={ref} className={`overflow-auto px-3 py-2 font-mono text-[12px] leading-5 text-slate-300 ${compact ? "max-h-40" : "max-h-72"}`}>{job.output.map(clean).join("\n") || "…"}</pre>
    </div>
  );
}
