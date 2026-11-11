"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, BookOpen, Braces, CheckCircle2, FlaskConical, GraduationCap, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { Progress, ProductSummary } from "@/lib/types";
import { Button, Card } from "@/components/ui";
import { ErrorCard } from "@/components/Gate";
import { useAuth } from "@/components/PlatformContext";
import { fmtAgo, progressHref } from "@/lib/utils";

function Ring({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16"><circle cx="32" cy="32" r={r} stroke="#1f2937" strokeWidth="6" fill="none" /><circle cx="32" cy="32" r={r} stroke={color} strokeWidth="6" fill="none" strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 32 32)" /><text x="32" y="36" textAnchor="middle" fontSize="13" fill="#e5e7eb" fontWeight={600}>{pct}%</text></svg>
  );
}

const RINGS = [
  { k: "builders", label: "Manifests built", icon: Braces, color: "#a78bfa", href: "/build" },
  { k: "scenarios", label: "Scenarios solved", icon: FlaskConical, color: "#fbbf24", href: "/scenarios" },
  { k: "lessons", label: "Realm lessons", icon: GraduationCap, color: "#34d399", href: "/learn/gitops" },
  { k: "course_lessons", label: "Course lessons", icon: BookOpen, color: "#38bdf8", href: "/courses" },
];

export default function ProgressPage() {
  const { user } = useAuth();
  const [p, setP] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const load = () => api.progress().then((d) => { setP(d); setErr(null); }).catch((e) => setErr(errorMessage(e)));
  useEffect(() => { load(); api.products.list().then((r) => setProducts(r.products)).catch(() => null); }, [user?.id]);
  if (err && !p) return <div className="mx-auto max-w-5xl"><ErrorCard message={err} /></div>;
  if (!p) return <p className="text-slate-400">Loading…</p>;

  const rings = RINGS.filter((c) => p.totals[c.k] != null);
  const courses = Object.entries(p.courses || {}).sort((a, b) => b[1].percent - a[1].percent || a[0].localeCompare(b[0]));
  const titleOf = (id: string) => products.find((x) => x.id === id)?.title || id;
  const label = (i: { kind: string; item_id: string }) => i.kind === "course_lesson" ? i.item_id.replace("/", " › ") : i.item_id;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-end justify-between">
        <div><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><Activity className="h-4 w-4" /> Progress</p><h1 className="mt-1 text-2xl font-bold text-white">Your lab log</h1></div>
        <Button variant="ghost" size="sm" onClick={() => { if (confirm("Reset all progress?")) api.resetProgress().then(load).catch((e) => setErr(errorMessage(e))); }}><Trash2 className="h-3.5 w-3.5" /> reset</Button>
      </header>
      {err && <ErrorCard message={err} className="mb-4" />}

      {courses.length > 0 && (
        <Card className="mb-6 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><BookOpen className="h-4 w-4 text-sky-300" /> Courses</h2>
          <ul className="mt-3 space-y-3">
            {courses.map(([id, c]) => (
              <li key={id}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/courses/${id}`} className="min-w-0 truncate text-slate-100 hover:underline">{titleOf(id)}</Link>
                  <span className="shrink-0 font-mono text-xs text-slate-400">{c.completed}/{c.total} · {Math.round(c.percent)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800"><div className={c.percent >= 100 ? "h-full bg-emerald-400" : "h-full bg-sky-400"} style={{ width: `${Math.min(100, Math.max(0, c.percent))}%` }} /></div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className={`grid gap-4 sm:grid-cols-2 ${rings.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {rings.map((c) => (
          <Link key={c.k} href={c.href}><Card className="flex items-center gap-4 p-4 hover:border-slate-500"><Ring value={p.done[c.k] || 0} total={p.totals[c.k] || 0} color={c.color} /><div><p className="text-sm text-slate-400">{c.label}</p><p className="text-xl font-semibold text-white">{p.done[c.k] || 0} <span className="text-sm font-normal text-slate-500">/ {p.totals[c.k] || 0}</span></p></div></Card></Link>
        ))}
      </div>
      <Card className="mt-6 p-4">
        <h2 className="text-sm font-semibold text-white">Recent activity</h2>
        {p.items.length === 0 ? <p className="mt-2 text-sm text-slate-400">Nothing yet. Build a manifest, read a lesson, start a course or load a scenario.</p> : (
          <ul className="mt-3 divide-y divide-line">
            {p.items.slice(0, 50).map((i) => (
              <li key={`${i.kind}:${i.item_id}`} className="flex items-center gap-3 py-2 text-sm">
                {i.status === "completed" || i.status === "passed" || i.status === "applied" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <span className="h-4 w-4 rounded-full border border-slate-600" />}
                <span className="w-24 shrink-0 truncate text-xs uppercase tracking-wider text-slate-500" title={i.kind}>{i.kind.replace("_", " ")}</span>
                <Link href={progressHref(i)} className="min-w-0 flex-1 truncate text-slate-100 hover:underline">{label(i)}</Link>
                <span className="text-xs text-slate-400">{i.status}{i.data.quiz ? ` · quiz ${String(i.data.quiz)}` : ""}{i.data.percent != null ? ` · ${Math.round(Number(i.data.percent))}%` : ""}{i.data.attempts ? ` · ${String(i.data.attempts)} attempt(s)` : ""}</span>
                <span className="w-16 text-right text-xs text-slate-500">{fmtAgo(i.updated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
