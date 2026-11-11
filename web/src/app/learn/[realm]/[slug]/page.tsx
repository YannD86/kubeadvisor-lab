"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Braces, CheckCircle2, Clock, FlaskConical, GraduationCap } from "lucide-react";
import { api } from "@/lib/api";
import type { Lesson } from "@/lib/types";
import Markdown from "@/components/Markdown";
import Quiz from "@/components/Quiz";
import { Badge, Button } from "@/components/ui";
import Diagram from "@/components/diagrams/Diagram";
import { DIFF_COLOR } from "@/lib/utils";

export default function LessonPage() {
  const { realm, slug } = useParams<{ realm: string; slug: string }>();
  const [l, setL] = useState<Lesson | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    Promise.all([api.lesson(realm, slug), api.progress().catch(() => null)])
      .then(([lesson, prog]) => {
        if (stale) return;
        setL(lesson);
        setDone(!!prog?.items.some((i) => i.kind === "lesson" && i.item_id === `${realm}/${slug}` && i.status === "completed"));
      })
      .catch((e) => !stale && setErr(e.message));
    window.scrollTo({ top: 0 });
    return () => { stale = true; };
  }, [realm, slug]);
  const mark = () => api.setProgress("lesson", `${realm}/${slug}`, "completed").then(() => setDone(true));
  if (err) return <p className="text-rose-300">{err}</p>;
  if (!l || l.slug !== slug) return <p className="text-slate-400">Loading…</p>;
  return (
    <div key={`${realm}/${slug}`} className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_260px]">
      <article>
        <Link href={`/learn/${realm}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> {realm}</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <Badge className={DIFF_COLOR[l.level] || "border-slate-600"}>{l.level}</Badge>
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {l.estimated_minutes} min</span>
          {l.tags?.map((t) => <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px]">{t}</span>)}
        </div>
        {l.diagram && <div className="my-6"><Diagram name={l.diagram} /></div>}
        <Markdown>{l.body}</Markdown>
        {l.quiz && l.quiz.length > 0 && (
          <section className="mt-10 rounded-xl border border-line bg-panel p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><GraduationCap className="h-5 w-5 text-sky-300" /> Check your understanding</h2>
            <div className="mt-4"><Quiz questions={l.quiz} onComplete={(s, t) => api.setProgress("lesson", `${realm}/${slug}`, s === t ? "completed" : "quiz", { quiz: `${s}/${t}` }).then(() => s === t && setDone(true))} /></div>
          </section>
        )}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          {l.prev ? <Link href={`/learn/${realm}/${l.prev.slug}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> {l.prev.title}</Link> : <span />}
          <Button variant={done ? "secondary" : "primary"} onClick={mark} disabled={done}>{done ? <><CheckCircle2 className="h-4 w-4" /> Completed</> : "Mark as complete"}</Button>
          {l.next ? <Link href={`/learn/${realm}/${l.next.slug}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white">{l.next.title} <ArrowRight className="h-4 w-4" /></Link> : <span />}
        </div>
      </article>
      <aside className="space-y-5 lg:sticky lg:top-16 lg:self-start">
        {l.scenario_items.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300"><FlaskConical className="h-3.5 w-3.5" /> Practice scenarios</p>
            <ul className="mt-2 space-y-1.5">{l.scenario_items.map((s) => <li key={s.id}><Link href={`/scenarios/${s.id}`} className="block rounded-lg border border-line bg-panel p-2.5 text-sm hover:border-amber-400/50"><span className="block text-slate-100">{s.title}</span><span className="text-[11px] text-slate-500">{s.difficulty} · {s.estimated_minutes} min</span></Link></li>)}</ul>
          </div>
        )}
        {l.builder_items.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-300"><Braces className="h-3.5 w-3.5" /> Build the manifests</p>
            <ul className="mt-2 space-y-1.5">{l.builder_items.map((b) => <li key={b.id}><Link href={`/build/${b.id}`} className="block rounded-lg border border-line bg-panel p-2.5 text-sm hover:border-violet-400/50"><span className="block text-slate-100">{b.title}</span><span className="font-mono text-[11px] text-slate-500">{b.kind}</span></Link></li>)}</ul>
          </div>
        )}
        <p className="text-[11px] text-slate-500">Code blocks marked bash have a <strong>Run</strong> button that sends them to the lab terminal.</p>
      </aside>
    </div>
  );
}
