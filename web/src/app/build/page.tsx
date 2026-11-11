"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Braces, CheckCircle2, Clock, Layers } from "lucide-react";
import { api } from "@/lib/api";
import type { BuilderSummary, Progress, Track } from "@/lib/types";
import { Badge, Card } from "@/components/ui";
import { DIFF_COLOR, cn } from "@/lib/utils";

export default function BuildCatalog() {
  const [builders, setBuilders] = useState<BuilderSummary[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [track, setTrack] = useState<string>("all");
  const [prog, setProg] = useState<Progress | null>(null);
  useEffect(() => { api.builders().then((r) => { setBuilders(r.builders); setTracks(r.tracks); }); api.progress().then(setProg).catch(() => null); }, []);
  const status = (id: string) => prog?.items.find((i) => i.kind === "builder" && i.item_id === id);
  const shown = useMemo(() => builders.filter((b) => track === "all" || b.track === track), [builders, track]);
  const counts = useMemo(() => Object.fromEntries(tracks.map((t) => [t.id, builders.filter((b) => b.track === t.id).length])), [tracks, builders]);
  return (
    <div className="mx-auto max-w-6xl realm-violet">
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest rc-text"><Braces className="h-4 w-4" /> Realm 1 · Manifest Nomenclature & CRDs</p>
        <h1 className="mt-2 text-2xl font-bold text-white md:text-3xl">Build every manifest from a blank editor</h1>
        <p className="mt-2 max-w-3xl text-slate-300">Each activity walks you through one object, field by field, in the order a practitioner writes it. The editor starts empty. Highlight a step or put your cursor on a line to get a small hint; every step explains <em>why</em> the field exists. Core objects first, then the CRD grammar, then the CRDs you meet daily.</p>
      </header>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {[{ id: "all", title: "All" }, ...tracks].map((t) => (
          <button key={t.id} onClick={() => setTrack(t.id)} className={cn("rounded-full border px-3 py-1 text-xs", track === t.id ? "border-violet-400/60 bg-violet-500/15 text-violet-200" : "border-slate-700 text-slate-300 hover:bg-slate-800")}>
            {t.title}{t.id !== "all" && <span className="ml-1 text-slate-500">{counts[t.id] || 0}</span>}
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((b) => {
          const st = status(b.id);
          return (
            <Link key={b.id} href={`/build/${b.id}`}>
              <Card className="h-full p-4 transition-colors hover:border-violet-400/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] text-slate-500">{b.apiVersion}</p>
                    <h3 className="truncate font-semibold text-white">{b.title}</h3>
                  </div>
                  {st?.status === "completed" || st?.status === "applied" ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /> : st ? <span className="shrink-0 text-[11px] text-amber-300">{String(st.data.passed ?? 0)}/{String(st.data.total ?? b.step_count)}</span> : null}
                </div>
                <p className="mt-2 line-clamp-3 text-sm text-slate-400">{b.summary}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  <Badge className={DIFF_COLOR[b.difficulty]}>{b.difficulty}</Badge>
                  {b.crd && <Badge className="border-violet-500/40 bg-violet-500/10 text-violet-200">CRD</Badge>}
                  <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" /> {b.step_count} steps</span>
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {b.estimated_minutes} min</span>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
      {builders.length === 0 && <p className="text-slate-400">Loading activities…</p>}
    </div>
  );
}
