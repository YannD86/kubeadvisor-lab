"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "@/lib/api";

export interface TerminalProps {
  mode?: "shell" | "k9s";
  scenario?: string | null;
  namespace?: string | null;
  /** receives a writer function to inject input programmatically */
  onReady?: (write: ((data: string) => void) | null) => void;
  className?: string;
  /** increment to force a brand-new session */
  sessionKey?: number;
}

export default function Terminal({ mode = "shell", scenario, namespace, onReady, className, sessionKey = 0 }: TerminalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");


  function mount(el: HTMLDivElement): () => void {
    const term = new XTerm({
      cursorBlink: true, fontSize: 13, lineHeight: 1.2, fontFamily: "var(--font-mono), ui-monospace, Menlo, monospace",
      theme: { background: "#0a0f1c", foreground: "#e5e7eb", cursor: "#38bdf8", selectionBackground: "#334155", black: "#0f172a", brightBlack: "#475569" },
      scrollback: 5000, allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(el);
    try { fit.fit(); } catch { /* not visible yet */ }
    const params = new URLSearchParams({ mode, cols: String(term.cols), rows: String(term.rows) });
    if (scenario) params.set("scenario", scenario);
    if (namespace) params.set("namespace", namespace);
    const ws = new WebSocket(wsUrl(`/ws/terminal?${params}`));
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    let disposed = false;
    let refused = false;
    // Queued "Run" input must not reach the pty before the shell has sourced its rc file, or the echo lands above the
    // banner. The rc file ends with an invisible OSC marker; the writer is handed out when it arrives (or on a timeout).
    const READY = "\x1b]777;lab-ready\x07";
    let ready = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const markReady = () => { if (ready || disposed) return; ready = true; if (readyTimer) clearTimeout(readyTimer); onReady?.((d) => ws.readyState === 1 && ws.send(d)); };
    ws.onopen = () => { setStatus("open"); term.focus(); if (mode === "shell") readyTimer = setTimeout(markReady, 8000); else markReady(); };
    ws.onmessage = (ev) => {
      if (disposed) return;
      if (typeof ev.data === "string" && ev.data.startsWith("{")) {
        // the API refuses a session with one JSON frame before closing (hosted mode, non-admin on a shared instance)
        try {
          const j = JSON.parse(ev.data) as { error?: string; message?: string };
          if (j.error) { refused = true; term.write(`\r\n\x1b[33m${j.message || j.error}\x1b[0m\r\n`); setStatus("closed"); return; }
        } catch { /* not a control frame: fall through and print it */ }
      }
      let text = typeof ev.data === "string" ? ev.data : dec.decode(ev.data);
      if (!ready && text.includes(READY)) { text = text.replace(READY, ""); markReady(); }
      term.write(text);
    };
    ws.onclose = () => { if (disposed) return; setStatus("closed"); onReady?.(null); if (!refused) term.write("\r\n\x1b[2m[session closed]\x1b[0m\r\n"); };
    ws.onerror = () => { if (!disposed) setStatus("error"); };
    const sub = term.onData((d) => ws.readyState === 1 && ws.send(d));
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { return; }
      if (ws.readyState === 1) ws.send("\x01" + JSON.stringify({ resize: [term.cols, term.rows] }));
    });
    ro.observe(el);
    return () => {
      // detach handlers first: a late close/message event must never write into a disposed terminal
      disposed = true;
      if (readyTimer) clearTimeout(readyTimer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      sub.dispose(); ro.disconnect(); ws.close(); term.dispose(); onReady?.(null);
    };
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Defer the mount by a tick: React StrictMode (dev) mounts, unmounts and remounts effects synchronously,
    // and xterm's first viewport sync would then run against a terminal disposed in the same tick.
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (cancelled) return;
      cleanup = mount(el);
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); cleanup?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scenario, namespace, sessionKey]);


  return (
    <div className={`relative h-full w-full bg-[#0a0f1c] ${className || ""}`}>
      <div ref={ref} className="h-full w-full" />
      {status !== "open" && (
        <div className="pointer-events-none absolute right-2 top-1 rounded bg-slate-800/80 px-2 py-0.5 text-[11px] text-slate-300">
          {status === "connecting" ? "connecting…" : status === "closed" ? "closed" : "connection error — is the API running on :10201?"}
        </div>
      )}
    </div>
  );
}
