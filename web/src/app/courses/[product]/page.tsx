"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Circle, Clock, Crown, Dumbbell, Eye, FlaskConical, ListChecks, Lock, LogIn, Package, ShoppingCart, Trophy } from "lucide-react";
import { api } from "@/lib/api";
import type { CourseLessonSummary, ProductDetail, ProPlan } from "@/lib/types";
import { DIFF_COLOR, EXAM_DISCLAIMER, cn, fmtPrice } from "@/lib/utils";
import Markdown from "@/components/Markdown";
import ProductCard, { OwnershipLabel } from "@/components/ProductCard";
import Gate from "@/components/Gate";
import { useAuth, useMeta } from "@/components/PlatformContext";
import { BILLING_DISABLED_NOTE, BILLING_DISABLED_TEXT, useCheckout } from "@/components/useCheckout";
import { Badge, Button, Card, Spinner } from "@/components/ui";

function LessonRow({ product, l }: { product: string; l: CourseLessonSummary }) {
  return (
    <li>
      <Link href={`/courses/${product}/${l.slug}`} className={cn("group flex items-start gap-3 rounded-lg border border-line bg-panel p-3 transition-colors hover:border-sky-400/50", l.locked && "opacity-80")}>
        <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs font-semibold", l.completed ? "bg-emerald-500/15 text-emerald-300" : l.locked ? "bg-slate-800 text-slate-500" : "bg-sky-500/15 text-sky-200")}>
          {l.completed ? <CheckCircle2 className="h-4 w-4" /> : l.locked ? <Lock className="h-3.5 w-3.5" /> : l.order}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2"><span className="font-medium text-white group-hover:underline">{l.title}</span>{l.preview && !l.completed && <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-200"><Eye className="mr-1 h-3 w-3" /> preview</Badge>}</span>
          {l.summary && <span className="mt-0.5 block text-sm text-slate-400">{l.summary}</span>}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-500"><Clock className="h-3 w-3" /> {l.estimated_minutes} min</span>
      </Link>
    </li>
  );
}

export default function ProductPage() {
  const { product } = useParams<{ product: string }>();
  const { user, entitled } = useAuth();
  const { auth_mode, billing_enabled } = useMeta();
  const { checkout, busy, notice, anonymous, loginHref } = useCheckout();
  const [p, setP] = useState<ProductDetail | null>(null);
  const [pro, setPro] = useState<ProPlan | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    let stale = false;
    api.products.get(product).then((d) => { if (!stale) { setP(d); setErr(null); } }).catch((e) => { if (!stale) setErr(e); });
    api.products.list().then((r) => { if (!stale) setPro(r.pro); }).catch(() => null);
    return () => { stale = true; };
  }, [product, user?.id]);

  const modules = useMemo(() => {
    const map = new Map<number, { title: string; lessons: CourseLessonSummary[] }>();
    for (const l of p?.lessons || []) {
      const m = map.get(l.module) || { title: l.module_title || `Module ${l.module}`, lessons: [] };
      m.lessons.push(l); map.set(l.module, m);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([n, m]) => ({ n, ...m, lessons: m.lessons.sort((a, b) => a.order - b.order), minutes: m.lessons.reduce((s, l) => s + (l.estimated_minutes || 0), 0) }));
  }, [p]);

  if (err) return <div className="mx-auto max-w-3xl"><Link href="/courses" className="mb-4 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> courses</Link><Gate error={err} product={product} /></div>;
  if (!p || p.id !== product) return <p className="text-slate-400">Loading…</p>;

  const firstOpen = p.lessons.find((l) => !l.completed && !l.locked) || p.lessons.find((l) => !l.locked) || p.lessons[0];
  const hasPro = entitled("pro");
  const price = fmtPrice(p.price_cents, p.currency);
  const proPrice = pro ? `${fmtPrice(pro.price_cents, pro.currency)}/${pro.interval}` : null;
  const totalMinutes = p.lessons.reduce((s, l) => s + (l.estimated_minutes || 0), 0);

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/courses" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> courses</Link>
      <div className="mt-3 grid gap-8 lg:grid-cols-[1fr_320px]">
        <div>
          <header>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <Badge className="border-slate-600 text-slate-300">{p.kind === "bundle" ? <><Package className="mr-1 h-3 w-3" /> bundle</> : "course"}</Badge>
              {p.difficulty && <Badge className={DIFF_COLOR[p.difficulty] || "border-slate-600"}>{p.difficulty}</Badge>}
              {p.status === "draft" && <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-200">draft</Badge>}
              {p.duration_hours > 0 && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> ~{p.duration_hours} h</span>}
              <span>{p.lesson_count} lessons · {p.assessment_count} assessments · {p.exercise_count} exercises</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-white md:text-3xl">{p.title}</h1>
            {p.tagline && <p className="mt-2 text-slate-300">{p.tagline}</p>}
          </header>
          {p.description && <section className="mt-6"><Markdown className="lesson text-[15px]">{p.description}</Markdown></section>}
          {p.features?.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">What you get</h2>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">{p.features.map((f, i) => <li key={i} className="flex items-start gap-2 text-sm text-slate-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {f}</li>)}</ul>
            </section>
          )}
          {p.exam_domains && p.exam_domains.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Exam domains</h2>
              <ul className="mt-2 space-y-1.5">{p.exam_domains.map((d) => (
                <li key={d.id} className="text-sm">
                  <div className="flex items-center justify-between text-slate-200"><span>{d.title}</span>{d.weight != null && <span className="font-mono text-xs text-slate-400">{d.weight}%</span>}</div>
                  {d.weight != null && <div className="mt-1 h-1 overflow-hidden rounded bg-slate-800"><div className="h-full bg-sky-400/70" style={{ width: `${Math.min(100, d.weight)}%` }} /></div>}
                </li>
              ))}</ul>
            </section>
          )}
          {p.kind === "bundle" && p.included_products && p.included_products.length > 0 && (
            <section className="mt-8">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Package className="h-5 w-5 text-sky-300" /> Included courses <span className="text-sm font-normal text-slate-400">({p.included_products.length})</span></h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">{p.included_products.map((ip) => <ProductCard key={ip.id} p={ip} />)}</div>
            </section>
          )}
          {modules.length > 0 && (
            <section className="mt-8">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><BookOpen className="h-5 w-5 text-sky-300" /> Curriculum <span className="text-sm font-normal text-slate-400">({p.lessons.length} lessons · ~{totalMinutes} min)</span></h2>
              <div className="mt-3 space-y-5">
                {modules.map((m) => (
                  <div key={m.n}>
                    <div className="mb-2 flex items-baseline justify-between"><h3 className="text-sm font-semibold text-slate-200"><span className="mr-2 font-mono text-xs text-slate-500">M{m.n}</span>{m.title}</h3><span className="text-[11px] text-slate-500">{m.lessons.length} lessons · {m.minutes} min</span></div>
                    <ol className="space-y-1.5">{m.lessons.map((l) => <LessonRow key={l.slug} product={p.id} l={l} />)}</ol>
                  </div>
                ))}
              </div>
            </section>
          )}
          {p.assessments.length > 0 && (
            <section className="mt-8">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><ListChecks className="h-5 w-5 text-sky-300" /> Assessments</h2>
              <ul className="mt-3 space-y-1.5">
                {p.assessments.map((a) => (
                  <li key={a.id}>
                    <Link href={`/courses/${p.id}/assessments/${a.id}`} className="group flex items-center gap-3 rounded-lg border border-line bg-panel p-3 hover:border-sky-400/50">
                      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md", a.best_percent != null && a.best_percent >= a.pass_percent ? "bg-emerald-500/15 text-emerald-300" : a.locked ? "bg-slate-800 text-slate-500" : "bg-sky-500/15 text-sky-200")}>{a.locked ? <Lock className="h-3.5 w-3.5" /> : a.best_percent != null && a.best_percent >= a.pass_percent ? <Trophy className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2"><span className="font-medium text-white group-hover:underline">{a.title}</span><Badge className="border-slate-600 text-slate-300">{a.kind}</Badge></span>
                        <span className="mt-0.5 block text-xs text-slate-400">{a.question_count} questions · {a.time_limit_minutes > 0 ? `${a.time_limit_minutes} min` : "untimed"} · pass {a.pass_percent}%</span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-slate-400">{a.best_percent != null ? <><span className={cn("font-semibold", a.best_percent >= a.pass_percent ? "text-emerald-300" : "text-amber-300")}>{Math.round(a.best_percent)}%</span> best<br /></> : null}{a.attempts} attempt{a.attempts === 1 ? "" : "s"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {p.exercises.length > 0 && (
            <section className="mt-8">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Dumbbell className="h-5 w-5 text-sky-300" /> Exercises</h2>
              <ul className="mt-3 space-y-1.5">
                {p.exercises.sort((a, b) => a.order - b.order).map((x) => (
                  <li key={x.id}>
                    <Link href={`/courses/${p.id}/exercises/${x.id}`} className="group flex items-center gap-3 rounded-lg border border-line bg-panel p-3 hover:border-sky-400/50">
                      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs font-semibold", x.status === "done" ? "bg-emerald-500/15 text-emerald-300" : x.locked ? "bg-slate-800 text-slate-500" : "bg-sky-500/15 text-sky-200")}>{x.status === "done" ? <CheckCircle2 className="h-4 w-4" /> : x.locked ? <Lock className="h-3.5 w-3.5" /> : x.order}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-white group-hover:underline">{x.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">{x.difficulty && <Badge className={DIFF_COLOR[x.difficulty] || "border-slate-600"}>{x.difficulty}</Badge>}{x.domain && <span className="font-mono text-[11px]">{x.domain}</span>}</span>
                      </span>
                      <Badge className={x.mode === "scenario" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-slate-600 text-slate-300"}>{x.mode === "scenario" ? <><FlaskConical className="mr-1 h-3 w-3" /> live scenario</> : "task"}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {p.exam_domains && p.exam_domains.length > 0 && <footer className="mt-10 border-t border-line pt-4 text-xs text-slate-500">{p.disclaimer || EXAM_DISCLAIMER}</footer>}
        </div>

        {/* ---- action area */}
        <aside className="lg:sticky lg:top-16 lg:self-start">
          <Card className="p-5">
            <div className="flex items-start justify-between gap-3">
              <OwnershipLabel p={p} className="text-base" />
              {p.owned && <span className="text-xs text-slate-400">{Math.round(p.progress_percent || 0)}% done</span>}
            </div>
            {p.owned && <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-emerald-400" style={{ width: `${Math.min(100, p.progress_percent || 0)}%` }} /></div>}
            <div className="mt-4 flex flex-col gap-2">
              {p.owned || auth_mode === "local" ? (
                firstOpen ? <Link href={`/courses/${p.id}/${firstOpen.slug}`}><Button className="w-full">{p.progress_percent > 0 ? "Continue" : "Open"} <ArrowRight className="h-4 w-4" /></Button></Link> : p.kind === "bundle" && p.included_products?.[0] ? <Link href={`/courses/${p.included_products[0].id}`}><Button className="w-full">Open first course <ArrowRight className="h-4 w-4" /></Button></Link> : <p className="text-xs text-slate-500">No lessons published yet.</p>
              ) : anonymous ? (
                <>
                  <Link href={loginHref}><Button className="w-full"><LogIn className="h-4 w-4" /> Sign in to buy</Button></Link>
                  {firstOpen?.preview && <Link href={`/courses/${p.id}/${firstOpen.slug}`}><Button variant="outline" className="w-full"><Eye className="h-4 w-4" /> Read the free preview</Button></Link>}
                </>
              ) : (
                <>
                  <Button className="w-full" onClick={() => checkout(p.id)} disabled={busy !== null}>{busy === p.id ? <Spinner /> : <ShoppingCart className="h-4 w-4" />} Buy for {price}</Button>
                  {!hasPro && <Button variant="secondary" className="w-full" onClick={() => checkout("pro")} disabled={busy !== null}>{busy === "pro" ? <Spinner /> : <Crown className="h-4 w-4 text-amber-300" />} Get Pro{proPrice ? ` · ${proPrice}` : ""}</Button>}
                  {firstOpen?.preview && <Link href={`/courses/${p.id}/${firstOpen.slug}`}><Button variant="ghost" className="w-full"><Eye className="h-4 w-4" /> Read the free preview</Button></Link>}
                  {!billing_enabled && <p className="text-xs text-slate-500">{BILLING_DISABLED_TEXT} {BILLING_DISABLED_NOTE}</p>}
                </>
              )}
            </div>
            {notice && <p className={cn("mt-3 rounded-md border p-2.5 text-sm", notice.kind === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-100" : "border-slate-600 bg-slate-800/60 text-slate-200")}>{notice.text}{notice.note && <span className="block text-xs text-slate-400">{notice.note}</span>}</p>}
            <ul className="mt-4 space-y-1.5 border-t border-line pt-4 text-xs text-slate-400">
              <li className="flex items-center gap-2"><Circle className="h-2 w-2 fill-sky-400 text-sky-400" /> {p.lesson_count} lessons{totalMinutes ? ` · ~${totalMinutes} min` : ""}</li>
              {p.assessment_count > 0 && <li className="flex items-center gap-2"><Circle className="h-2 w-2 fill-sky-400 text-sky-400" /> {p.assessment_count} assessment{p.assessment_count === 1 ? "" : "s"} with per-domain scores</li>}
              {p.exercise_count > 0 && <li className="flex items-center gap-2"><Circle className="h-2 w-2 fill-sky-400 text-sky-400" /> {p.exercise_count} hands-on exercise{p.exercise_count === 1 ? "" : "s"}</li>}
              {p.kind === "bundle" && <li className="flex items-center gap-2"><Circle className="h-2 w-2 fill-sky-400 text-sky-400" /> Includes {p.includes?.length || 0} courses</li>}
              <li className="flex items-center gap-2"><Circle className="h-2 w-2 fill-sky-400 text-sky-400" /> Progress synced to your account</li>
            </ul>
            {!p.owned && auth_mode === "accounts" && <p className="mt-3 text-[11px] text-slate-500">Included in <Link href="/pricing" className="text-sky-300 hover:underline">KubeAdvisor Pro</Link> with every other course and all lab realms.</p>}
          </Card>
        </aside>
      </div>
    </div>
  );
}
