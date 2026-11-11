"use client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy, Play } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTerminal } from "./TerminalContext";
import { useMeta } from "./PlatformContext";
import Mermaid from "./Mermaid";

export type RunPolicy = "all" | "marked";

function CodeBlock({ lang, code, meta, runPolicy }: { lang: string; code: string; meta: string; runPolicy: RunPolicy }) {
  const { run } = useTerminal();
  const { lab_mode } = useMeta();
  const [copied, setCopied] = useState(false);
  // "Run" sends the block to the lab terminal: only meaningful when the cluster runs on this host, and only for
  // commands that can run as written. Lines with <placeholders> are reference notation and are left out (bash would
  // read the angle brackets as redirections); whole script files and crontab lines are never sent.
  const PLACEHOLDER = /<[a-z][\w-]*>/i;
  const lines = code.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => l.replace(/^\$\s+/, ""));
  const runLines = lines.filter((l) => !PLACEHOLDER.test(l));
  const script = /^#!/.test(code) || /^\s*[\d*]+(\s+[\d*\/,-]+){4}\s/m.test(code);
  // Hand-written realm lessons are runnable as a whole ("all"). Imported course lessons are full of worked examples
  // for fictional clusters (etcd-node1, 10.0.0.10, /opt/etcd-backup.db) that look runnable and are not, so there only
  // blocks fenced as ```bash lab offer Run ("marked").
  const marked = /(^|\s)lab(\s|$)/.test(meta);
  const runnable = lab_mode === "local" && ["bash", "sh", "shell", "console", "zsh"].includes(lang) && !script && runLines.length > 0
    && (runPolicy === "all" || marked);
  const skipped = lines.length - runLines.length;
  const copy = () => { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  const runIt = () => run(runLines.join("\n"));
  return (
    <div className="codeblock">
      <div className="tools">
        {runnable && <button onClick={runIt} title={skipped ? `Run in lab terminal (${skipped} line${skipped === 1 ? "" : "s"} with <placeholders> left out)` : "Run in lab terminal"} className="inline-flex items-center gap-1 rounded bg-emerald-600/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"><Play className="h-3 w-3" /> Run</button>}
        <button onClick={copy} title="Copy" className="inline-flex items-center gap-1 rounded bg-slate-700 px-2 py-0.5 text-[11px] text-slate-100 hover:bg-slate-600">{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}</button>
      </div>
      <SyntaxHighlighter language={lang || "text"} style={oneDark} customStyle={{ margin: 0, background: "transparent" }} wrapLongLines>{code}</SyntaxHighlighter>
    </div>
  );
}

const CALLOUTS: [RegExp, string, string][] = [
  [/^why it matters:?/i, "callout-why", "Why it matters"],
  [/^gotcha:?/i, "callout-gotcha", "Gotcha"],
  [/^try it:?/i, "callout-try", "Try it"],
];

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const makeComponents = (runPolicy: RunPolicy): Components => ({
  code({ className, children, node, ...props }) {
    const m = /language-(\w+)/.exec(className || "");
    const code = String(children).replace(/\n$/, "");
    const meta = String((node?.data as { meta?: string } | undefined)?.meta || "");
    if (m?.[1] === "mermaid") return <Mermaid code={code} />;
    if (m || code.includes("\n")) return <CodeBlock lang={m?.[1] || ""} code={code} meta={meta} runPolicy={runPolicy} />;
    return <code className={className} {...props}>{children}</code>;
  },
  pre({ children }) { return <>{children}</>; },
  p({ children }) {
    const kids = Array.isArray(children) ? children : [children];
    const first = kids[0];
    const label = first && typeof first === "object" && "type" in first && (first as { type: string }).type === "strong" ? textOf(first) : "";
    for (const [re, cls, title] of CALLOUTS) {
      if (re.test(label)) {
        return <div className={`callout ${cls}`}><span className="label">{title}</span><p className="!mb-0">{kids.slice(1)}</p></div>;
      }
    }
    return <p>{children}</p>;
  },
  a({ href, children }) { return <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{children}</a>; },
});

const COMPONENTS: Record<RunPolicy, Components> = { all: makeComponents("all"), marked: makeComponents("marked") };

export default function Markdown({ children, className, runPolicy = "all" }: { children: string; className?: string; runPolicy?: RunPolicy }) {
  return <div className={className || "lesson"}><ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS[runPolicy]}>{children}</ReactMarkdown></div>;
}
