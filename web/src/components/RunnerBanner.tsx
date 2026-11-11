"use client";
import Link from "next/link";
import { ArrowRight, Laptop } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

export const RUNNER_TEXT = "Labs run in your local KubeAdvisor runner. Create a lab token in Account → Lab runner and start the runner on your machine; your progress syncs back here.";

/** Shown on lab pages when `lab_mode=hosted`: this host has no cluster, the learner runs the labs locally. */
export default function RunnerBanner({ compact, className, title = "Labs run on your machine" }: { compact?: boolean; className?: string; title?: string }) {
  if (compact) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-100", className)}>
        <Laptop className="h-3.5 w-3.5 shrink-0 text-sky-300" />
        <span className="min-w-0 flex-1">{RUNNER_TEXT}</span>
        <Link href="/account#runner" className="inline-flex items-center gap-1 font-medium text-sky-200 hover:underline">Set up the runner <ArrowRight className="h-3 w-3" /></Link>
      </div>
    );
  }
  return (
    <div className={cn("rounded-xl border border-sky-500/30 bg-sky-500/10 p-5", className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-white"><Laptop className="h-4 w-4 text-sky-300" /> {title}</p>
      <p className="mt-2 max-w-2xl text-sm text-sky-100/90">{RUNNER_TEXT}</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-300">
        <li>Create a lab token under <Link href="/account#runner" className="text-sky-300 underline underline-offset-2">Account → Lab runner</Link>.</li>
        <li>Clone the repository and start it with <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[12px] text-slate-200">KA_PLATFORM_URL=… KA_LAB_TOKEN=kal_… ./start.sh</code>.</li>
        <li>Open the runner on your machine: it drives a kind cluster, the terminal and k9s, and pushes your progress here.</li>
      </ol>
      <Link href="/account#runner" className="mt-4 inline-block"><Button size="sm"><Laptop className="h-3.5 w-3.5" /> Set up the local runner</Button></Link>
    </div>
  );
}
