"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Braces, CheckCircle2, Clock, FlaskConical, GraduationCap, Target } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { CourseLesson } from "@/lib/types";
import Markdown from "@/components/Markdown";
import Quiz from "@/components/Quiz";
import Gate from "@/components/Gate";
import { useAuth } from "@/components/PlatformContext";
import { Badge, Button } from "@/components/ui";
import { DIFF_COLOR } from "@/lib/utils";

export default function CourseLessonPage() {
  const { product, lesson: slug } = useParams<{ product: string; lesson: string }>();
  const { user } = useAuth();
  const [l, setL] = useState<CourseLesson | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const started = useRef(0); // set on mount / lesson change

  useEffect(() => {
    let stale = false;
    started.current = Date.now();
    api.courses.lesson(product, slug)
      .then((lesson) => { if (stale) return; setL(lesson); setDone(!!lesson.completed); setErr(null); })
      .catch((e) => { if (!stale) setErr(e); });
    window.scrollTo({ top: 0 });
    return () => { stale = true; };
  }, [product, slug, user?.id]);

  const itemId = `${product}/${slug}`;
  const spent = () => Math.max(1, Math.round((Date.now() - started.current) / 1000));
  const mark = async () => {
    setSaving(true); setSaveErr(null);
    try { await api.setProgress("course_lesson", itemId, "completed", { time_spent_s: spent() }); setDone(true); }
    catch (e) { setSaveErr(errorMessage(e)); }
    finally { setSaving(false); }
  };
  const onQuiz = (s: number, t: number) => {
    api.setProgress("course_lesson", itemId, s === t ? "completed" : "quiz", { quiz: `${s}/${t}`, time_spent_s: spent() })
      .then(() => { if (s === t) setDone(true); })
      .catch((e) => setSaveErr(errorMessage(e)));
  };

  if (err) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href={`/courses/${product}`} className="mb-4 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> back to course</Link>
        <Gate error={err} product={product} />
      </div>
    );
  }
  if (!l || l.slug !== slug) return <p className="text-slate-400">Loading…</p>;

  return (
    <div key={itemId} className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_260px]">
      <article>
        <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> {l.product || product}</Link>
        <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-sky-300">Module {l.module}{l.module_title ? ` · ${l.module_title}` : ""}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white md:text-3xl">{l.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {l.level && <Badge className={DIFF_COLOR[l.level] || "border-slate-600"}>{l.level}</Badge>}
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {l.estimated_minutes} min</span>
          {l.preview && <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-200">free preview</Badge>}
          {done && <Badge className="border-emerald-500/50 bg-emerald-500/10 text-emerald-200"><CheckCircle2 className="mr-1 h-3 w-3" /> completed</Badge>}
          {l.tags?.map((t) => <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px]">{t}</span>)}
        </div>
        {l.objectives && l.objectives.length > 0 && (
          <div className="mt-5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-sky-300"><Target className="h-3.5 w-3.5" /> In this lesson you will</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">{l.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>
          </div>
        )}
        {l.prerequisites && l.prerequisites.length > 0 && <p className="mt-3 text-xs text-slate-500">Prerequisites: {l.prerequisites.join(" · ")}</p>}
        <div className="mt-6"><Markdown runPolicy="marked">{l.body}</Markdown></div>
        {l.quiz && l.quiz.length > 0 && (
          <section className="mt-10 rounded-xl border border-line bg-panel p-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><GraduationCap className="h-5 w-5 text-sky-300" /> Check your understanding</h2>
            <div className="mt-4"><Quiz questions={l.quiz} onComplete={onQuiz} /></div>
          </section>
        )}
        {saveErr && <p className="mt-4 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-sm text-rose-200">Could not save progress: {saveErr}</p>}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          {l.prev ? <Link href={`/courses/${product}/${l.prev.slug}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> {l.prev.title}</Link> : <span />}
          <Button variant={done ? "secondary" : "primary"} onClick={mark} disabled={done || saving}>{done ? <><CheckCircle2 className="h-4 w-4" /> Completed</> : saving ? "Saving…" : "Mark complete"}</Button>
          {l.next ? <Link href={`/courses/${product}/${l.next.slug}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white">{l.next.title} <ArrowRight className="h-4 w-4" /></Link> : <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white">Back to course <ArrowRight className="h-4 w-4" /></Link>}
        </div>
      </article>
      <aside className="space-y-5 lg:sticky lg:top-16 lg:self-start">
        {l.scenario_items?.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300"><FlaskConical className="h-3.5 w-3.5" /> Practice scenarios</p>
            <ul className="mt-2 space-y-1.5">{l.scenario_items.map((s) => <li key={s.id}><Link href={`/scenarios/${s.id}`} className="block rounded-lg border border-line bg-panel p-2.5 text-sm hover:border-amber-400/50"><span className="block text-slate-100">{s.title}</span><span className="text-[11px] text-slate-500">{s.difficulty} · {s.estimated_minutes} min</span></Link></li>)}</ul>
          </div>
        )}
        {l.builder_items?.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-300"><Braces className="h-3.5 w-3.5" /> Build the manifests</p>
            <ul className="mt-2 space-y-1.5">{l.builder_items.map((b) => <li key={b.id}><Link href={`/build/${b.id}`} className="block rounded-lg border border-line bg-panel p-2.5 text-sm hover:border-violet-400/50"><span className="block text-slate-100">{b.title}</span><span className="font-mono text-[11px] text-slate-500">{b.kind}</span></Link></li>)}</ul>
          </div>
        )}
        {l.domain && <p className="text-[11px] text-slate-500">Exam domain: <span className="font-mono text-slate-400">{l.domain}</span></p>}
        <p className="text-[11px] text-slate-500">Time on this lesson is recorded when you mark it complete.</p>
      </aside>
    </div>
  );
}
