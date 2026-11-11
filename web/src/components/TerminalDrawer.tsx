"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, TerminalSquare, X } from "lucide-react";
import { useTerminal } from "./TerminalContext";
import { useMeta } from "./PlatformContext";
import { Button } from "./ui";

const Terminal = dynamic(() => import("./Terminal"), { ssr: false });

export default function TerminalDrawer() {
  const { open, setOpen, register, scenario, namespace } = useTerminal();
  const [tall, setTall] = useState(false);
  const [key, setKey] = useState(0);
  const { lab_mode } = useMeta();
  if (lab_mode === "hosted") return null; // no cluster on this host: never show a dead terminal
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg backdrop-blur hover:bg-slate-800">
          <TerminalSquare className="h-4 w-4 text-sky-400" /> Terminal
        </button>
      )}
      {open && (
        <div className={`fixed inset-x-0 bottom-0 z-40 flex flex-col border-t border-slate-700 bg-[#0a0f1c] shadow-2xl ${tall ? "h-[70vh]" : "h-[38vh]"}`}>
          <div className="flex h-9 items-center justify-between border-b border-slate-800 px-3 text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <TerminalSquare className="h-4 w-4 text-sky-400" />
              <span className="font-medium">Lab terminal</span>
              {scenario && <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{scenario}{namespace ? ` · ${namespace}` : ""}</span>}
              <span className="text-slate-500">kubectl · helm · flux · k9s · lab</span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" title="New session" onClick={() => setKey((k) => k + 1)}><RotateCcw className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" onClick={() => setTall((t) => !t)}>{tall ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}><X className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Terminal sessionKey={key} scenario={scenario} namespace={namespace} onReady={register} />
          </div>
        </div>
      )}
    </>
  );
}
