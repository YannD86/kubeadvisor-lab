"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock, FlaskConical, Braces } from "lucide-react";
import { api } from "@/lib/api";
import type { LessonSummary, Progress, Realm } from "@/lib/types";
import { REALM_CLASS, cn } from "@/lib/utils";
import { REALM_ICONS } from "@/components/icons";

export default function RealmPage() {
  const { realm } = useParams<{ realm: string }>();
  const [r, setR] = useState<Realm | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [prog, setProg] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.lessons(realm).then((d) => { setR(d.realm); setLessons(d.lessons); }).catch((e) => setErr(e.message)); api.progress().then(setProg).catch(() => null); }, [realm]);
  if (err) return <p className="text-rose-300">{err}</p>;
  if (!r) return <p className="text-slate-400">Loading…</p>;
  const Icon = REALM_ICONS[r.icon] || Braces;
  const done = (slug: string) => prog?.items.some((i) => i.kind === "lesson" && i.item_id === `${realm}/${slug}` && i.status === "completed");
  return (
    <div className={cn("mx-auto max-w-5xl", REALM_CLASS[r.color])}>
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest rc-text"><Icon className="h-4 w-4" /> Realm {r.order} · {r.title}</p>
        <h1 className="mt-2 text-2xl font-bold text-white md:text-3xl">{r.tagline}</h1>
        <p className="mt-2 max-w-3xl whitespace-pre-line text-slate-300">{r.description.trim()}</p>
      </header>
      {lessons.length === 0 && <p className="text-slate-400">No lessons yet in this realm.</p>}
      <ol className="space-y-2">
        {lessons.map((l) => (
          <li key={l.slug}>
            <Link href={`/learn/${realm}/${l.slug}`} className="group flex items-start gap-4 rounded-xl border border-line bg-panel p-4 transition-colors rc-ring">
              <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-semibold", done(l.slug) ? "bg-emerald-500/15 text-emerald-300" : "rc-bg rc-text")}>{done(l.slug) ? <CheckCircle2 className="h-4 w-4" /> : l.order}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-white group-hover:underline">{l.title}</span>
                <span className="mt-0.5 block text-sm text-slate-400">{l.summary}</span>
                <span className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {l.estimated_minutes} min</span>
                  <span className="capitalize">{l.level}</span>
                  {l.scenarios && l.scenarios.length > 0 && <span className="inline-flex items-center gap-1"><FlaskConical className="h-3 w-3" /> {l.scenarios.length} scenario{l.scenarios.length > 1 ? "s" : ""}</span>}
                  {l.builders && l.builders.length > 0 && <span className="inline-flex items-center gap-1"><Braces className="h-3 w-3" /> {l.builders.length} builder{l.builders.length > 1 ? "s" : ""}</span>}
                  {l.quiz_count > 0 && <span>{l.quiz_count} quiz</span>}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
