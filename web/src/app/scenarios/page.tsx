"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Hammer, Puzzle, TerminalSquare, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import type { Category, ScenarioSummary } from "@/lib/types";
import { Badge, Card } from "@/components/ui";
import { DIFF_COLOR, cn } from "@/lib/utils";

export default function ScenarioCatalog() {
  const [items, setItems] = useState<ScenarioSummary[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [cat, setCat] = useState("all");
  const [diff, setDiff] = useState("all");
  const [kind, setKind] = useState("all");
  useEffect(() => { api.scenarios().then((r) => { setItems(r.scenarios); setCats(r.categories); }); }, []);
  const shown = useMemo(() => items.filter((s) => (cat === "all" || s.category === cat) && (diff === "all" || s.difficulty === diff) && (kind === "all" || s.type === kind)), [items, cat, diff, kind]);
  const count = (c: string) => items.filter((s) => s.category === c).length;
  return (
    <div className="mx-auto max-w-6xl realm-amber">
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest rc-text"><TerminalSquare className="h-4 w-4" /> Realm 4 · Loaded Scenarios</p>
        <h1 className="mt-2 text-2xl font-bold text-white md:text-3xl">A broken cluster, a terminal, k9s, and a checker</h1>
        <p className="mt-2 max-w-3xl text-slate-300">Each scenario loads a real fault into your kind cluster. You get an on-call style brief, a web terminal with kubectl, helm, flux and k9s, progressive hints, automated checks that also verify you fixed the <em>right</em> thing, and a full solution with a prevention section.</p>
      </header>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {[{ id: "all", title: "All" }, ...cats].map((c) => (
          <button key={c.id} onClick={() => setCat(c.id)} className={cn("rounded-full border px-3 py-1 text-xs", cat === c.id ? "border-amber-400/60 bg-amber-500/15 text-amber-100" : "border-slate-700 text-slate-300 hover:bg-slate-800")}>{c.title}{c.id !== "all" && <span className="ml-1 text-slate-500">{count(c.id)}</span>}</button>
        ))}
        <span className="mx-2 h-4 w-px bg-slate-700" />
        {["all", "beginner", "intermediate", "advanced"].map((d) => <button key={d} onClick={() => setDiff(d)} className={cn("rounded-full border px-2.5 py-1 text-xs capitalize", diff === d ? "border-slate-400 bg-slate-700 text-white" : "border-slate-700 text-slate-400 hover:bg-slate-800")}>{d}</button>)}
        <span className="mx-2 h-4 w-px bg-slate-700" />
        {[["all", "any"], ["troubleshoot", "fix it"], ["build", "build it"]].map(([k, l]) => <button key={k} onClick={() => setKind(k)} className={cn("rounded-full border px-2.5 py-1 text-xs", kind === k ? "border-slate-400 bg-slate-700 text-white" : "border-slate-700 text-slate-400 hover:bg-slate-800")}>{l}</button>)}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((s) => (
          <Link key={s.id} href={`/scenarios/${s.id}`}>
            <Card className={cn("h-full p-4 transition-colors hover:border-amber-400/50", s.state === "loaded" && "border-amber-400/40")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">{cats.find((c) => c.id === s.category)?.title || s.category}</p>
                  <h3 className="font-semibold text-white">{s.title}</h3>
                </div>
                {s.passed_at ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /> : s.state === "loaded" ? <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">loaded</span> : null}
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-slate-400">{s.summary}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <Badge className={DIFF_COLOR[s.difficulty]}>{s.difficulty}</Badge>
                <Badge className="border-slate-600 text-slate-300">{s.type === "build" ? <><Hammer className="mr-1 h-3 w-3" />build</> : <><Wrench className="mr-1 h-3 w-3" />fix</>}</Badge>
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {s.estimated_minutes} min</span>
                <span className="inline-flex items-center gap-1"><Puzzle className="h-3 w-3" /> {s.check_count} checks</span>
                {s.requires_addons && s.requires_addons.length > 0 && <span className="text-slate-500">needs {s.requires_addons.join(", ")}</span>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
      {items.length === 0 && <p className="text-slate-400">Loading scenarios…</p>}
    </div>
  );
}
