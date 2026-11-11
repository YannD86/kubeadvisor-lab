"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Clock, Dumbbell, FlaskConical, Lightbulb, Target, Trophy } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { Exercise } from "@/lib/types";
import Markdown from "@/components/Markdown";
import Gate from "@/components/Gate";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { Badge, Button } from "@/components/ui";
import { DIFF_COLOR, cn } from "@/lib/utils";

export default function ExercisePage() {
  const { product, id } = useParams<{ product: string; id: string }>();
  const { user } = useAuth();
  const { lab_mode } = useMeta();
  const [x, setX] = useState<Exercise | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [hints, setHints] = useState(0);
  const [showSolution, setShowSolution] = useState(false);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all([api.courses.exercise(product, id), api.progress().catch(() => null)])
      .then(([ex, prog]) => {
        if (stale) return;
        setX(ex); setErr(null); setHints(0); setShowSolution(false);
        setDone(!!prog?.items.some((i) => i.kind === "exercise" && i.item_id === `${product}/${id}` && i.status === "completed"));
      })
      .catch((e) => { if (!stale) setErr(e); });
    window.scrollTo({ top: 0 });
    return () => { stale = true; };
  }, [product, id, user?.id]);

  const markDone = async () => {
    setSaving(true); setSaveErr(null);
    try { await api.setProgress("exercise", `${product}/${id}`, "completed", { hints_used: hints, solution_viewed: showSolution }); setDone(true); }
    catch (e) { setSaveErr(errorMessage(e)); }
    finally { setSaving(false); }
  };

  if (err) return <div className="mx-auto max-w-3xl"><Link href={`/courses/${product}`} className="mb-4 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> back to course</Link><Gate error={err} product={product} /></div>;
  if (!x || x.id !== id) return <p className="text-slate-400">Loading…</p>;

  const solutionMd = x.solution_commands?.length ? "```bash\n" + x.solution_commands.join("\n") + "\n```" : "";
  const setupMd = x.setup_commands?.length ? "```bash\n" + x.setup_commands.join("\n") + "\n```" : "";
  const scenarioId = x.scenario || x.scenario_item?.id || null;

  return (
    <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_280px]">
      <article>
        <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> {x.product || product}</Link>
        <p className="mt-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><Dumbbell className="h-4 w-4" /> Exercise {x.order}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white md:text-3xl">{x.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {x.difficulty && <Badge className={DIFF_COLOR[x.difficulty] || "border-slate-600"}>{x.difficulty}</Badge>}
          <Badge className={x.mode === "scenario" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-600 text-slate-300"}>{x.mode === "scenario" ? <><FlaskConical className="mr-1 h-3 w-3" /> live scenario</> : "task"}</Badge>
          {x.domain && <span className="font-mono text-[11px]">{x.domain}</span>}
          {x.time_limit_minutes > 0 && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {x.time_limit_minutes} min</span>}
          {x.points > 0 && <span className="inline-flex items-center gap-1"><Trophy className="h-3 w-3" /> {x.points} pts</span>}
          {done && <Badge className="border-emerald-500/50 bg-emerald-500/10 text-emerald-200"><CheckCircle2 className="mr-1 h-3 w-3" /> done</Badge>}
        </div>
        {x.objective && (
          <div className="mt-5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-sky-300"><Target className="h-3.5 w-3.5" /> Objective</p>
            <p className="mt-1 text-sm text-slate-100">{x.objective}</p>
          </div>
        )}
        {setupMd && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Set up</h2>
            <p className="mt-1 text-xs text-slate-500">The task assumes these objects already exist in your cluster. Create them first{lab_mode === "local" ? "; Run sends the block to the lab terminal" : ""}.</p>
            <div className="mt-2"><Markdown className="lesson text-[14px]">{setupMd}</Markdown></div>
          </section>
        )}
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Task</h2>
          <div className="mt-2"><Markdown className="lesson text-[15px]">{x.task}</Markdown></div>
          {x.mode === "legacy" && <p className="mt-2 text-xs text-slate-500">This is a task definition: work through it in the lab terminal (or on your own cluster), then mark it done.</p>}
        </section>
        {x.hints?.length > 0 && (
          <section className="mt-8">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400"><Lightbulb className="h-4 w-4 text-amber-300" /> Hints <span className="font-normal normal-case tracking-normal text-slate-500">{hints}/{x.hints.length} revealed</span></h2>
            <div className="mt-2 space-y-2">
              {x.hints.slice(0, hints).map((h, i) => <div key={i} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-50"><span className="mr-2 font-semibold text-amber-300">Hint {i + 1}</span><Markdown className="inline [&_p]:inline [&_code]:bg-slate-800">{h}</Markdown></div>)}
              {hints < x.hints.length ? <Button size="sm" variant="secondary" onClick={() => setHints((h) => h + 1)}><Lightbulb className="h-3.5 w-3.5" /> Reveal hint {hints + 1}</Button> : <p className="text-xs text-slate-500">All hints revealed.</p>}
            </div>
          </section>
        )}
        {solutionMd && (
          <section className="mt-8 rounded-xl border border-line bg-panel">
            <button onClick={() => setShowSolution((s) => !s)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-slate-800/50">
              {showSolution ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}<BookOpen className="h-4 w-4 text-sky-300" /> {showSolution ? "Hide solution" : "Show solution"}<span className="ml-auto text-xs font-normal text-slate-500">{x.solution_commands.length} command{x.solution_commands.length === 1 ? "" : "s"}</span>
            </button>
            {showSolution && (
              <div className="border-t border-line px-4 py-3">
                <p className="mb-2 text-xs text-slate-400">Reference commands. Compare with your own path before copying them.{lab_mode === "local" ? " Use Run to send them to the lab terminal." : ""}</p>
                <Markdown className="lesson text-[14px]">{solutionMd}</Markdown>
              </div>
            )}
          </section>
        )}
        {saveErr && <p className="mt-4 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-sm text-rose-200">Could not save progress: {saveErr}</p>}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> Back to course</Link>
          <Button variant={done ? "secondary" : "primary"} onClick={markDone} disabled={done || saving}>{done ? <><CheckCircle2 className="h-4 w-4" /> Done</> : saving ? "Saving…" : "Mark done"}</Button>
        </div>
      </article>
      <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
        {x.mode === "scenario" && scenarioId && (
          <div className={cn("rounded-xl border p-4", "border-amber-500/40 bg-amber-500/5")}>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300"><FlaskConical className="h-3.5 w-3.5" /> Live scenario</p>
            {x.scenario_item ? <p className="mt-1.5 text-sm text-slate-100">{x.scenario_item.title}</p> : <p className="mt-1.5 font-mono text-sm text-slate-100">{scenarioId}</p>}
            {x.scenario_item && <p className="text-[11px] text-slate-500">{x.scenario_item.difficulty} · {x.scenario_item.estimated_minutes} min · {x.scenario_item.check_count} checks</p>}
            <Link href={`/scenarios/${scenarioId}`} className="mt-3 block"><Button size="sm" className="w-full"><FlaskConical className="h-3.5 w-3.5" /> Open scenario</Button></Link>
            <p className="mt-2 text-[11px] text-slate-500">{lab_mode === "hosted" ? "The scenario loads in your local runner." : "Loads the fault into your lab cluster."}</p>
          </div>
        )}
        {x.mode === "legacy" && x.scenario_item && (
          <div className="rounded-xl border border-line bg-panel p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Related scenario</p>
            <Link href={`/scenarios/${x.scenario_item.id}`} className="mt-1.5 block text-sm text-sky-300 hover:underline">{x.scenario_item.title}</Link>
          </div>
        )}
        <p className="text-[11px] text-slate-500">Hints are revealed one at a time and never cost you anything; the solution is there to compare, not to copy.</p>
      </aside>
    </div>
  );
}
