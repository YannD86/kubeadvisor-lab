"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { githubDark } from "@uiw/codemirror-theme-github";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, CircleDashed, Eye, Lightbulb, Play, RotateCcw, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import type { Builder, EvalResult, StepResult } from "@/lib/types";
import { api } from "@/lib/api";
import { matchStep, pathAtLine } from "@/lib/yamlPath";
import Markdown from "./Markdown";
import Quiz from "./Quiz";
import { Button, Spinner } from "./ui";
import { cn } from "@/lib/utils";
import { useMeta } from "./PlatformContext";
import RunnerBanner from "./RunnerBanner";
import Paywall from "./Paywall";
import { ApiError } from "@/lib/api";

// ---- line decorations: mark lines for pass/fail/current step
const setMarks = StateEffect.define<{ line: number; cls: string }[]>();
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) {
      const marks = e.value.filter((m) => m.line >= 1 && m.line <= tr.state.doc.lines).sort((a, b) => a.line - b.line)
        .map((m) => Decoration.line({ class: m.cls }).range(tr.state.doc.line(m.line).from));
      deco = Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function lineOfPath(text: string, path: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (pathAtLine(text, i) === path) return i + 1;
  return null;
}

function storageKey(id: string) { return `sre-labs:builder:${id}`; }

export default function ManifestBuilder({ builder }: { builder: Builder }) {
  const steps = builder.steps;
  const paths = useMemo(() => steps.map((s) => s.path), [steps]);
  const [text, setText] = useState(() => { try { return localStorage.getItem(storageKey(builder.id)) || ""; } catch { return ""; } });
  const [result, setResult] = useState<EvalResult | null>(null);

  const [hover, setHover] = useState<number | null>(null);   // step highlighted by hover/cursor → hint visible
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [lint, setLint] = useState<{ ok: boolean | null; output: string } | null>(null);
  const [applied, setApplied] = useState<{ ok: boolean; output: string } | null>(null);
  const [showIntro, setShowIntro] = useState(() => { try { return !localStorage.getItem(storageKey(builder.id)); } catch { return true; } });
  const [showQuiz, setShowQuiz] = useState(false);
  const [showFinal, setShowFinal] = useState(false);
  const [paywall, setPaywall] = useState<string | null>(null);
  const { lab_mode, loaded: metaLoaded } = useMeta();
  const hosted = metaLoaded && lab_mode === "hosted";
  const cm = useRef<ReactCodeMirrorRef>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // evaluate a restored draft once on mount
  useEffect(() => { if (text.trim()) { api.evaluate(builder.id, text).then(setResult).catch(() => null); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = useCallback(async (t: string) => {
    if (!t.trim()) { setResult(null); return; }
    try { const r = await api.evaluate(builder.id, t); setResult(r); } catch { /* API down */ }
  }, [builder.id]);

  const onChange = (v: string) => {
    setText(v);
    try { localStorage.setItem(storageKey(builder.id), v); } catch { /* ignore */ }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => evaluate(v), 450);
  };

  // current step = first not passed
  const stepStatus = (i: number): StepResult["status"] => result?.steps[i]?.status ?? "missing";
  const current = useMemo(() => { const i = steps.findIndex((_, k) => stepStatus(k) !== "pass"); return i < 0 ? steps.length - 1 : i; }, [result, steps]); // eslint-disable-line react-hooks/exhaustive-deps
  // follow the current step unless the learner explicitly selected another one
  const [pinned, setPinned] = useState<number | null>(null);
  const selectedEff = pinned ?? current;

  // decorations
  useEffect(() => {
    const view = cm.current?.view;
    if (!view) return;
    const marks: { line: number; cls: string }[] = [];
    if (result?.parse_ok) {
      result.steps.forEach((s) => {
        const ln = lineOfPath(text, s.path);
        if (ln) marks.push({ line: ln, cls: s.status === "pass" ? "cm-line-pass" : s.status === "fail" ? "cm-line-fail" : "" });
      });
    }
    view.dispatch({ effects: setMarks.of(marks.filter((m) => m.cls)) });
  }, [result, text]);

  // cursor → path → highlighted step (hint on highlight)
  const onUpdate = useCallback((vu: { view: EditorView; selectionSet: boolean; docChanged: boolean }) => {
    if (!vu.selectionSet && !vu.docChanged) return;
    const pos = vu.view.state.selection.main.head;
    const line = vu.view.state.doc.lineAt(pos).number - 1;
    const p = pathAtLine(vu.view.state.doc.toString(), line);
    setCursorPath(p);
    const idx = matchStep(paths, p);
    setHover(idx >= 0 ? idx : null);
  }, [paths]);

  const insertReveal = (i: number) => {
    const s = steps[i];
    setRevealed((r) => new Set(r).add(i));
    const view = cm.current?.view;
    if (!view) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const indent = line.text.match(/^\s*/)?.[0] ?? "";
    const snippet = s.reveal.replace(/\n$/, "").split("\n").map((l, k) => (k === 0 && line.text.trim() === "" ? indent : indent) + l).join("\n");
    const insertAt = line.text.trim() === "" ? line.from : line.to;
    const prefix = line.text.trim() === "" ? "" : "\n";
    view.dispatch({ changes: { from: insertAt, to: line.text.trim() === "" ? line.to : insertAt, insert: prefix + snippet }, selection: { anchor: insertAt + prefix.length + snippet.length } });
    view.focus();
  };

  const onLabError = (e: unknown, label: string) => {
    if (e instanceof ApiError && e.status === 402) { setPaywall(e.field<string>("product") || "pro"); return; }
    setApplied({ ok: false, output: `${label}: ${(e as Error).message}` });
  };
  const runLint = async () => { setBusy("lint"); setPaywall(null); try { setLint(await api.lint(builder.id, text)); } catch (e) { onLabError(e, "lint"); } finally { setBusy(null); } };
  const runApply = async () => { setBusy("apply"); setPaywall(null); try { setApplied(await api.applyManifest(builder.id, text)); } catch (e) { onLabError(e, "apply"); } finally { setBusy(null); } };
  const reset = () => { if (!confirm("Clear the editor and start from scratch?")) return; setText(""); setResult(null); setRevealed(new Set()); setLint(null); setApplied(null); try { localStorage.removeItem(storageKey(builder.id)); } catch { /* ignore */ } };
  const loadFinal = () => { if (!confirm("Replace your work with the reference manifest?")) return; onChange(builder.final_manifest); };

  const shown = hover ?? selectedEff;
  const step = steps[shown];
  const passed = result?.passed ?? 0;
  const complete = !!result?.complete;
  const applyMode = builder.apply?.mode || "dry-run";

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[280px_1fr_360px]">
      {/* ---- step rail */}
      <aside className="flex min-h-0 flex-col border-r border-line bg-[#0b0f1a]">
        <div className="border-b border-line px-3 py-2">
          <div className="flex items-center justify-between text-xs text-slate-400"><span>Progress</span><span className="font-mono">{passed}/{steps.length}</span></div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-violet-400 transition-all" style={{ width: `${(passed / steps.length) * 100}%` }} /></div>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto p-2">
          {steps.map((s, i) => {
            const st = stepStatus(i);
            const isCur = i === current && !complete;
            return (
              <li key={s.path}>
                <button onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => { setPinned(i); const ln = lineOfPath(text, s.path); const v = cm.current?.view; if (ln && v) { v.dispatch({ selection: { anchor: v.state.doc.line(ln).from }, scrollIntoView: true }); v.focus(); } }}
                  className={cn("group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-slate-800/70", shown === i && "bg-slate-800", isCur && "ring-1 ring-violet-400/50")}>
                  <span className="mt-0.5 shrink-0">
                    {st === "pass" ? <Check className="h-4 w-4 text-emerald-400" /> : st === "fail" ? <XCircle className="h-4 w-4 text-rose-400" /> : <CircleDashed className={cn("h-4 w-4", isCur ? "text-violet-300" : "text-slate-600")} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", st === "pass" ? "text-slate-300" : "text-slate-100")}>{i + 1}. {s.title}</span>
                    <span className="block truncate font-mono text-[10.5px] text-slate-500">{s.path}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="border-t border-line p-2 text-[11px] text-slate-500">Hover a step or place the cursor on a line to see its hint.</div>
      </aside>

      {/* ---- editor */}
      <section className="flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <span className="text-slate-400">manifest.yaml</span>
          {cursorPath && <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{cursorPath}</span>}
          {result && !result.parse_ok && <span className="inline-flex items-center gap-1 text-rose-300"><AlertTriangle className="h-3.5 w-3.5" /> {result.error}</span>}
          {complete && <span className="inline-flex items-center gap-1 text-emerald-300"><Sparkles className="h-3.5 w-3.5" /> All steps satisfied</span>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShowIntro((v) => !v)} title="Intro"><BookOpen className="h-3.5 w-3.5" /> intro</Button>
            {!hosted && <Button size="sm" variant="ghost" onClick={runLint} disabled={!text.trim() || busy !== null} title="Schema validation with kubeconform">{busy === "lint" ? <Spinner /> : <ShieldCheck className="h-3.5 w-3.5" />} lint</Button>}
            {!hosted && <Button size="sm" variant={complete ? "primary" : "ghost"} onClick={runApply} disabled={!text.trim() || busy !== null} title={applyMode === "create" ? "kubectl apply to the lab cluster" : "kubectl apply --dry-run=server"}>{busy === "apply" ? <Spinner /> : <Play className="h-3.5 w-3.5" />} {applyMode === "create" ? "apply" : "dry-run"}</Button>}
            <Button size="sm" variant="ghost" onClick={loadFinal} title="Load reference manifest"><Eye className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={reset} title="Start over"><RotateCcw className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        {hosted && <RunnerBanner compact />}
        {paywall && <div className="border-b border-line p-3"><Paywall product={paywall} message="Applying to a lab cluster in this realm needs Pro." /></div>}
        {showIntro && (
          <div className="border-b border-line bg-violet-500/5 px-4 py-3">
            <Markdown className="lesson text-[15px] [&_p]:mb-2">{builder.intro}</Markdown>
            <button onClick={() => setShowIntro(false)} className="text-xs text-violet-300 hover:underline">Got it, start building →</button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <CodeMirror ref={cm} value={text} height="100%" theme={githubDark} extensions={[yamlLang(), markField, EditorView.lineWrapping]} onChange={onChange} onUpdate={onUpdate}
            basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false, indentOnInput: true, tabSize: 2 }} placeholder={`# Start from scratch.\n# Step 1: ${steps[0]?.prompt ?? ""}`} className="h-full" />
        </div>
        {(lint || applied) && (
          <div className="max-h-44 overflow-auto border-t border-line bg-[#0a0f1c] px-3 py-2 font-mono text-[12px]">
            {lint && <div className={cn("mb-2", lint.ok ? "text-emerald-300" : lint.ok === null ? "text-slate-400" : "text-rose-300")}><span className="font-semibold">kubeconform:</span> {lint.output || (lint.ok ? "valid" : "")}</div>}
            {applied && <div className={applied.ok ? "text-emerald-300" : "text-rose-300"}><span className="font-semibold">kubectl:</span> <pre className="whitespace-pre-wrap">{applied.output}</pre></div>}
          </div>
        )}
      </section>

      {/* ---- why / hint panel */}
      <aside className="flex min-h-0 flex-col border-l border-line bg-[#0b0f1a]">
        {step && !showQuiz && !showFinal && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">Step {shown + 1} of {steps.length}{hover !== null && hover !== selectedEff ? " · preview" : ""}</p>
            <h2 className="mt-1 text-lg font-semibold text-white">{step.title}</h2>
            <p className="mt-1 font-mono text-[12px] text-slate-400">{step.path}</p>
            <p className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-100">{step.prompt}</p>
            {hover !== null && hover === shown && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"><Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><span>{step.hint}</span></div>
            )}
            {hover === null && (
              <p className="mt-3 text-xs text-slate-500">Hover this step in the rail, or put the cursor on its line, to see a hint.</p>
            )}
            {result?.steps[shown]?.status === "fail" && <p className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{result.steps[shown].message}</p>}
            {result?.steps[shown]?.status === "pass" && <p className="mt-3 inline-flex items-center gap-1 text-sm text-emerald-300"><Check className="h-4 w-4" /> satisfied</p>}
            <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Why this field, and why now</h3>
            <Markdown className="lesson mt-1 text-[14.5px] [&_p]:mb-2">{step.why}</Markdown>
            {step.gotchas && step.gotchas.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">Gotchas</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-300">{step.gotchas.map((g, i) => <li key={i}>{g}</li>)}</ul>
              </div>
            )}
            <div className="mt-5">
              {revealed.has(shown) || stepStatus(shown) === "pass" ? (
                <pre className="rounded-md border border-line bg-[#0a0f1c] p-3 font-mono text-[12px] text-slate-200">{step.reveal}</pre>
              ) : (
                <Button size="sm" variant="outline" onClick={() => insertReveal(shown)}><Eye className="h-3.5 w-3.5" /> Reveal and insert this step</Button>
              )}
            </div>
          </div>
        )}
        {showFinal && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Reference manifest</p>
            <pre className="mt-2 rounded-md border border-line bg-[#0a0f1c] p-3 font-mono text-[12px] text-slate-200">{builder.final_manifest}</pre>
          </div>
        )}
        {showQuiz && builder.quiz && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Check your understanding</p>
            <div className="mt-3"><Quiz questions={builder.quiz} onComplete={(s, t) => api.setProgress("builder", builder.id, complete ? "completed" : "in_progress", { quiz: `${s}/${t}` }).catch(() => null)} /></div>
          </div>
        )}
        <div className="flex items-center gap-1 border-t border-line p-2">
          <Button size="sm" variant="ghost" onClick={() => { setShowQuiz(false); setShowFinal(false); }} className={cn(!showQuiz && !showFinal && "bg-slate-800")}>Step</Button>
          {builder.quiz && builder.quiz.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setShowQuiz(true); setShowFinal(false); }} className={cn(showQuiz && "bg-slate-800")}>Quiz</Button>}
          <Button size="sm" variant="ghost" onClick={() => { setShowFinal(true); setShowQuiz(false); }} className={cn(showFinal && "bg-slate-800")}>Reference</Button>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-500">
            <button onClick={() => setPinned(Math.max(0, selectedEff - 1))} className="rounded p-1 hover:bg-slate-800"><ChevronDown className="h-3.5 w-3.5 rotate-90" /></button>
            <button onClick={() => setPinned(Math.min(steps.length - 1, selectedEff + 1))} className="rounded p-1 hover:bg-slate-800"><ChevronRight className="h-3.5 w-3.5" /></button>
          </span>
        </div>
      </aside>
    </div>
  );
}
