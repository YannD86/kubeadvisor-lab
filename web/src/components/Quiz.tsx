"use client";
import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import type { QuizQ } from "@/lib/types";
import { Button } from "./ui";
import { cn } from "@/lib/utils";

export default function Quiz({ questions, onComplete }: { questions: QuizQ[]; onComplete?: (score: number, total: number) => void }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const score = questions.reduce((s, q, i) => s + (answers[i] === q.answer ? 1 : 0), 0);
  return (
    <div className="space-y-5">
      {questions.map((q, i) => (
        <div key={i} className="rounded-lg border border-line bg-elev p-4">
          <p className="font-medium text-slate-100">{i + 1}. {q.q}</p>
          <div className="mt-3 grid gap-2">
            {q.options.map((o, j) => {
              const chosen = answers[i] === j;
              const correct = submitted && j === q.answer;
              const wrong = submitted && chosen && j !== q.answer;
              return (
                <button key={j} disabled={submitted} onClick={() => setAnswers((a) => ({ ...a, [i]: j }))}
                  className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors", chosen ? "border-sky-500/60 bg-sky-500/10" : "border-slate-700 hover:bg-slate-800", correct && "border-emerald-500/70 bg-emerald-500/10", wrong && "border-rose-500/70 bg-rose-500/10")}>
                  {submitted ? (correct ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : wrong ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" /> : <span className="mt-0.5 h-4 w-4 shrink-0" />) : <span className={cn("mt-0.5 h-4 w-4 shrink-0 rounded-full border", chosen ? "border-sky-400 bg-sky-400" : "border-slate-500")} />}
                  <span>{o}</span>
                </button>
              );
            })}
          </div>
          {submitted && <p className="mt-3 rounded-md bg-slate-900/70 p-3 text-sm text-slate-300"><span className="font-semibold text-slate-100">Explanation: </span>{q.explain}</p>}
        </div>
      ))}
      {!submitted ? (
        <Button disabled={Object.keys(answers).length < questions.length} onClick={() => { setSubmitted(true); onComplete?.(score, questions.length); }}>Submit answers</Button>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-sm text-slate-200">Score: <span className="font-semibold">{score}/{questions.length}</span></p>
          <Button variant="outline" size="sm" onClick={() => { setSubmitted(false); setAnswers({}); }}>Retry</Button>
        </div>
      )}
    </div>
  );
}
