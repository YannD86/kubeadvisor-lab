"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface Ctx {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Send a command to the global drawer terminal (opens it first). */
  run: (cmd: string) => void;
  register: (fn: ((data: string) => void) | null) => void;
  scenario: string | null;
  namespace: string | null;
  setContext: (scenario: string | null, namespace: string | null) => void;
}
const TerminalCtx = createContext<Ctx | null>(null);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<string | null>(null);
  const [namespace, setNamespace] = useState<string | null>(null);
  const writer = useRef<((data: string) => void) | null>(null);
  const pending = useRef<string[]>([]);

  const register = useCallback((fn: ((data: string) => void) | null) => {
    writer.current = fn;
    if (fn && pending.current.length) { const q = pending.current; pending.current = []; setTimeout(() => q.forEach(fn), 300); }
  }, []);
  const run = useCallback((cmd: string) => {
    setOpen(true);
    const data = cmd.endsWith("\n") ? cmd : cmd + "\n";
    if (writer.current) writer.current(data); else pending.current.push(data);
  }, []);
  const setContext = useCallback((s: string | null, n: string | null) => { setScenario(s); setNamespace(n); }, []);
  const value = useMemo(() => ({ open, setOpen, run, register, scenario, namespace, setContext }), [open, run, register, scenario, namespace, setContext]);
  return <TerminalCtx.Provider value={value}>{children}</TerminalCtx.Provider>;
}

export function useTerminal() {
  const c = useContext(TerminalCtx);
  if (!c) throw new Error("useTerminal outside provider");
  return c;
}
