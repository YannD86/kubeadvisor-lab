"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, ListChecks, Play, RotateCcw, Send, Trophy, XCircle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { Assessment, AssessmentResult, ProductDetail } from "@/lib/types";
import Markdown from "@/components/Markdown";
import Gate from "@/components/Gate";
import { useAuth } from "@/components/PlatformContext";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { cn, fmtClock } from "@/lib/utils";

type Phase = "intro" | "exam" | "result";

export default function AssessmentPage() {
  const { product, id } = useParams<{ product: string; id: string }>();
  const { user } = useAuth();
  const [a, setA] = useState<Assessment | null>(null);
  const [prod, setProd] = useState<ProductDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [left, setLeft] = useState<number | null>(null);
  const [result, setResult] = useState<AssessmentResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const submitRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stale = false;
    api.courses.assessment(product, id).then((d) => { if (!stale) { setA(d); setErr(null); } }).catch((e) => { if (!stale) setErr(e); });
    api.products.get(product).then((p) => { if (!stale) setProd(p); }).catch(() => null);
    return () => { stale = true; };
  }, [product, id, user?.id]);

  const total = a?.questions.length ?? 0;
  const answered = Object.keys(answers).length;

  const submit = useCallback(async () => {
    if (!a || submitting) return;
    setSubmitting(true); setSubmitErr(null);
    try {
      const body: Record<string, number> = {};
      for (const [k, v] of Object.entries(answers)) body[String(k)] = v;
      const r = await api.courses.submitAssessment(product, id, body);
      setResult(r); setPhase("result"); setLeft(null);
      api.setProgress("assessment", `${product}/${id}`, r.passed ? "passed" : "attempted", { percent: r.percent, score: r.score, total: r.total }).catch(() => null);
      api.courses.assessment(product, id).then(setA).catch(() => null);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setSubmitErr(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }, [a, submitting, answers, product, id]);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  // countdown: one tick per second; auto-submit when it reaches zero
  useEffect(() => {
    if (phase !== "exam" || left === null) return;
    const t = setTimeout(() => {
      if (left <= 1) { setLeft(0); submitRef.current(); } else setLeft(left - 1);
    }, 1000);
    return () => clearTimeout(t);
  }, [phase, left]);

  // warn before leaving mid-exam
  useEffect(() => {
    if (phase !== "exam") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase]);

  const start = () => {
    if (!a) return;
    setAnswers({}); setResult(null); setSubmitErr(null);
    setLeft(a.time_limit_minutes > 0 ? a.time_limit_minutes * 60 : null);
    setPhase("exam");
    window.scrollTo({ top: 0 });
  };
  const confirmSubmit = () => {
    if (answered < total && !confirm(`${total - answered} question(s) unanswered. Submit anyway?`)) return;
    submit();
  };
  const domainTitle = (d: string) => prod?.exam_domains?.find((x) => x.id === d)?.title || d;
  const byDomain = useMemo(() => Object.entries(result?.by_domain || {}).sort((x, y) => y[1].total - x[1].total), [result]);

  if (err) return <div className="mx-auto max-w-3xl"><Link href={`/courses/${product}`} className="mb-4 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> back to course</Link><Gate error={err} product={product} /></div>;
  if (!a || a.id !== id) return <p className="text-slate-400">Loading…</p>;

  const best = a.best_percent;
  const low = left !== null && left <= 60;

  // ------------------------------------------------------------------ intro
  if (phase === "intro") {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> {prod?.title || product}</Link>
        <p className="mt-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><ListChecks className="h-4 w-4" /> Assessment · {a.kind}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white md:text-3xl">{a.title}</h1>
        {a.description && <div className="mt-3"><Markdown className="lesson text-[15px]">{a.description}</Markdown></div>}
        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          {[{ k: "Questions", v: String(total) }, { k: "Time limit", v: a.time_limit_minutes > 0 ? `${a.time_limit_minutes} min` : "untimed" }, { k: "Pass mark", v: `${a.pass_percent}%` }, { k: "Attempts", v: String(a.attempts) }].map((s) => (
            <Card key={s.k} className="p-3"><p className="text-[11px] uppercase tracking-wider text-slate-500">{s.k}</p><p className="mt-1 text-lg font-semibold text-white">{s.v}</p></Card>
          ))}
        </div>
        {best != null && (
          <p className={cn("mt-4 flex items-center gap-2 rounded-md border p-3 text-sm", best >= a.pass_percent ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100" : "border-amber-500/40 bg-amber-500/10 text-amber-100")}>
            {best >= a.pass_percent ? <Trophy className="h-4 w-4" /> : <Clock className="h-4 w-4" />} Best score so far: <strong>{Math.round(best)}%</strong> {best >= a.pass_percent ? "— passed." : `— pass mark is ${a.pass_percent}%.`}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={start} disabled={total === 0}><Play className="h-4 w-4" /> {a.attempts > 0 ? "Retake assessment" : "Start assessment"}</Button>
          {a.time_limit_minutes > 0 && <span className="text-xs text-slate-400">The timer starts now and submits automatically at zero.</span>}
        </div>
        {total === 0 && <p className="mt-3 text-sm text-slate-400">This assessment has no questions yet.</p>}
      </div>
    );
  }

  // ------------------------------------------------------------------ exam
  if (phase === "exam") {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="sticky top-12 z-20 -mx-4 mb-4 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur md:-mx-8 md:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-white">{a.title}</span>
            <span className="text-xs text-slate-400">{answered}/{total} answered</span>
            <div className="h-1.5 w-32 overflow-hidden rounded bg-slate-800"><div className="h-full bg-sky-400 transition-all" style={{ width: `${total ? (answered / total) * 100 : 0}%` }} /></div>
            <div className="ml-auto flex items-center gap-2">
              {left !== null && <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-sm", low ? "border-rose-500/60 bg-rose-500/10 text-rose-200" : "border-slate-700 text-slate-200")}><Clock className="h-3.5 w-3.5" /> {fmtClock(left)}</span>}
              <Button size="sm" onClick={confirmSubmit} disabled={submitting}>{submitting ? <Spinner /> : <Send className="h-3.5 w-3.5" />} Submit</Button>
            </div>
          </div>
        </div>
        {submitErr && <p className="mb-4 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"><AlertTriangle className="h-4 w-4" /> {submitErr}</p>}
        <ol className="space-y-4">
          {a.questions.map((q, i) => (
            <li key={i} className="rounded-lg border border-line bg-elev p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium text-slate-100">{i + 1}. {q.q}</p>
                <span className="flex shrink-0 items-center gap-1">{q.domain && <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400" title={domainTitle(q.domain)}>{q.domain}</span>}{q.difficulty && <span className="text-[10px] uppercase tracking-wider text-slate-500">{q.difficulty}</span>}</span>
              </div>
              <div className="mt-3 grid gap-2">
                {q.options.map((o, j) => {
                  const chosen = answers[i] === j;
                  return (
                    <button key={j} onClick={() => setAnswers((s) => ({ ...s, [i]: j }))} className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors", chosen ? "border-sky-500/60 bg-sky-500/10" : "border-slate-700 hover:bg-slate-800")}>
                      <span className={cn("mt-0.5 h-4 w-4 shrink-0 rounded-full border", chosen ? "border-sky-400 bg-sky-400" : "border-slate-500")} /><span>{o}</span>
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
          <span className="text-xs text-slate-400">{answered}/{total} answered{answered < total ? " — unanswered questions count as wrong." : ""}</span>
          <Button onClick={confirmSubmit} disabled={submitting}>{submitting ? <Spinner /> : <Send className="h-4 w-4" />} Submit answers</Button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ result
  const r = result!;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/courses/${product}`} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> {prod?.title || product}</Link>
      <Card className={cn("mt-3 p-5", r.passed ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
        <div className="flex flex-wrap items-center gap-4">
          <div className={cn("grid h-20 w-20 place-items-center rounded-full border-4 text-xl font-bold", r.passed ? "border-emerald-400 text-emerald-200" : "border-amber-400 text-amber-200")}>{Math.round(r.percent)}%</div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-lg font-semibold text-white">{r.passed ? <><Trophy className="h-5 w-5 text-emerald-300" /> Passed</> : <><XCircle className="h-5 w-5 text-amber-300" /> Not passed yet</>}</p>
            <p className="text-sm text-slate-300">{r.score} of {r.total} correct · pass mark {a.pass_percent}%{best != null ? ` · best ${Math.round(Math.max(best, r.percent))}%` : ""}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={start}><RotateCcw className="h-4 w-4" /> Retake</Button>
            <Link href={`/courses/${product}`}><Button variant="ghost">Back to course</Button></Link>
          </div>
        </div>
      </Card>
      {byDomain.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">By domain</h2>
          <ul className="mt-2 space-y-2">
            {byDomain.map(([d, v]) => {
              const pct = v.total ? Math.round((v.correct / v.total) * 100) : 0;
              return (
                <li key={d} className="text-sm">
                  <div className="flex items-center justify-between text-slate-200"><span>{domainTitle(d)}</span><span className="font-mono text-xs text-slate-400">{v.correct}/{v.total} · {pct}%</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-slate-800"><div className={cn("h-full transition-all", pct >= a.pass_percent ? "bg-emerald-400" : pct >= 50 ? "bg-amber-400" : "bg-rose-400")} style={{ width: `${pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Review</h2>
        <ol className="mt-2 space-y-4">
          {a.questions.map((q, i) => {
            const res = r.results.find((x) => x.index === i);
            const chosen = res?.chosen ?? answers[i] ?? null;
            const correct = res?.answer;
            return (
              <li key={i} className={cn("rounded-lg border p-4", res?.correct ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5")}>
                <p className="flex items-start gap-2 font-medium text-slate-100">{res?.correct ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}<span>{i + 1}. {q.q}</span></p>
                <div className="mt-3 grid gap-1.5">
                  {q.options.map((o, j) => (
                    <div key={j} className={cn("flex items-start gap-2 rounded-md border px-3 py-1.5 text-sm", j === correct ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-50" : j === chosen ? "border-rose-500/60 bg-rose-500/10 text-rose-50" : "border-slate-800 text-slate-400")}>
                      {j === correct ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : j === chosen ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" /> : <span className="mt-0.5 h-4 w-4 shrink-0" />}
                      <span>{o}</span>{j === chosen && j !== correct && <span className="ml-auto text-[10px] uppercase tracking-wider text-rose-300">your answer</span>}
                    </div>
                  ))}
                  {chosen === null && <p className="text-xs text-slate-500">Not answered.</p>}
                </div>
                {res?.explain && <p className="mt-3 rounded-md bg-slate-900/70 p-3 text-sm text-slate-300"><span className="font-semibold text-slate-100">Explanation: </span>{res.explain}</p>}
                {q.domain && <p className="mt-2 text-[11px] text-slate-500">Domain: {domainTitle(q.domain)}</p>}
              </li>
            );
          })}
        </ol>
      </section>
      {prod?.exam_domains && prod.exam_domains.length > 0 && <p className="mt-8 text-xs text-slate-500">Badge: <Badge className="border-slate-600 text-slate-300">{a.kind}</Badge> assessment · independent exam preparation, not affiliated with the Linux Foundation or CNCF.</p>}
    </div>
  );
}
