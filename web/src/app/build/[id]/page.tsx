"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import type { Builder } from "@/lib/types";
import ManifestBuilder from "@/components/ManifestBuilder";
import { Badge } from "@/components/ui";
import { DIFF_COLOR } from "@/lib/utils";

export default function BuildPage() {
  const { id } = useParams<{ id: string }>();
  const [b, setB] = useState<Builder | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.builder(id).then(setB).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="text-rose-300">{err}</p>;
  if (!b) return <p className="text-slate-400">Loading…</p>;
  return (
    <div className="realm-violet -mx-4 -my-6 flex h-[calc(100vh-3rem)] flex-col md:-mx-8">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 md:px-6">
        <Link href="/build" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> activities</Link>
        <span className="text-slate-700">|</span>
        <h1 className="text-sm font-semibold text-white">{b.title}</h1>
        <span className="font-mono text-[11px] text-slate-500">{b.apiVersion} · {b.kind}</span>
        <Badge className={DIFF_COLOR[b.difficulty]}>{b.difficulty}</Badge>
        {b.crd && <Badge className="border-violet-500/40 bg-violet-500/10 text-violet-200">CRD</Badge>}
        {b.docs_url && <a href={b.docs_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-sky-300 hover:underline">docs <ExternalLink className="h-3 w-3" /></a>}
      </div>
      <div className="min-h-0 flex-1"><ManifestBuilder builder={b} /></div>
    </div>
  );
}
