"use client";
import { useEffect, useId, useState } from "react";

type MermaidApi = typeof import("mermaid")["default"];
let loader: Promise<MermaidApi> | null = null;
/** Load and initialise mermaid once per page (client only). */
function getMermaid(): Promise<MermaidApi> {
  if (!loader) {
    loader = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif" });
      return mermaid;
    });
  }
  return loader;
}
let seq = 0;

interface State { code: string; svg?: string; error?: string }

/** Renders a ```mermaid fence. Memoised on `code`: re-renders only when the source changes. */
export default function Mermaid({ code }: { code: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [state, setState] = useState<State>({ code: "" });

  useEffect(() => {
    let cancelled = false;
    const renderId = `mmd-${uid}-${++seq}`;
    getMermaid()
      .then(async (mermaid) => {
        try {
          const { svg } = await mermaid.render(renderId, code);
          if (!cancelled) setState({ code, svg });
        } catch (e) {
          document.getElementById("d" + renderId)?.remove(); // mermaid leaves a scratch element behind on parse errors
          if (!cancelled) setState({ code, error: e instanceof Error ? e.message : String(e) });
        }
      })
      .catch((e) => { if (!cancelled) setState({ code, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [code, uid]);

  const current = state.code === code ? state : null;
  if (!current) return <div className="mermaid-box"><p className="text-xs text-slate-500">rendering diagram…</p></div>;
  if (current.error || !current.svg) {
    return (
      <div className="mermaid-box mermaid-fallback">
        <pre className="whitespace-pre-wrap font-mono text-[12px] text-slate-300">{code}</pre>
        <p className="mt-2 text-[11px] text-amber-300/80">diagram failed to render{current.error ? `: ${current.error.split("\n")[0]}` : ""}</p>
      </div>
    );
  }
  return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: current.svg }} />;
}
