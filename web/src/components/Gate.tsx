"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, LogIn } from "lucide-react";
import { errorMessage, errorStatus, isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import Paywall from "./Paywall";
import { Button, Card } from "./ui";

export function ErrorCard({ message, className, children }: { message: string; className?: string; children?: React.ReactNode }) {
  const unreachable = /cannot reach the api/i.test(message);
  return (
    <div className={cn("rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200", className)}>
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 shrink-0" /> {message}</p>
      {unreachable && <p className="mt-1 text-rose-200/80">The API is not answering. On a local runner start it with <code>./start.sh</code>; on the platform try again in a moment.</p>}
      {children}
    </div>
  );
}

/** 401 on gated content: ask to sign in and come back. */
export function SignInPrompt({ message, className }: { message?: string; className?: string }) {
  const path = usePathname();
  const next = encodeURIComponent(path || "/");
  return (
    <Card className={cn("p-5", className)}>
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300"><LogIn className="h-4 w-4" /> Sign in required</p>
      <p className="mt-2 text-sm text-slate-300">{message || "Sign in to open this content. Your progress is saved to your account."}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/login?next=${next}`}><Button><LogIn className="h-4 w-4" /> Sign in</Button></Link>
        <Link href={`/signup?next=${next}`}><Button variant="outline">Create account</Button></Link>
      </div>
    </Card>
  );
}

/** Maps a failed course/lesson/assessment/exercise load to the right card: 402 → Paywall, 401 → SignInPrompt, else error. */
export default function Gate({ error, product, className }: { error: unknown; product: string; className?: string }) {
  const status = errorStatus(error);
  if (status === 402) return <Paywall product={(isApiError(error) && error.field<string>("product")) || product} className={className} />;
  if (status === 401) return <SignInPrompt className={className} />;
  if (status === 404) return <ErrorCard message="Not found. This content may have been moved or is still a draft." className={className} />;
  return <ErrorCard message={errorMessage(error)} className={className} />;
}
