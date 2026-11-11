"use client";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { api, errorCode, errorMessage, errorStatus } from "@/lib/api";
import { useAuth, useMeta } from "./PlatformContext";

export const BILLING_DISABLED_TEXT = "Purchases are not enabled on this instance yet.";
export const BILLING_DISABLED_NOTE = "The administrator of this instance can grant access manually; nothing is charged here.";
export const BILLING_TOOLTIP = "Billing is not configured on this instance";

export interface CheckoutNotice { kind: "info" | "error"; text: string; note?: string }

/** Shared Stripe checkout flow: anonymous → /login?next=, 409 billing_disabled → neutral note, 409 already_owned → refresh entitlements. */
export function useCheckout() {
  const router = useRouter();
  const path = usePathname();
  const { user, refresh } = useAuth();
  const { billing_enabled, auth_mode } = useMeta();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<CheckoutNotice | null>(null);

  const loginHref = `/login?next=${encodeURIComponent(path || "/")}`;
  const signupHref = `/signup?next=${encodeURIComponent(path || "/")}`;

  const checkout = useCallback(async (product: string) => {
    if (auth_mode === "accounts" && !user) { router.push(`/login?next=${encodeURIComponent(path || "/")}`); return; }
    setBusy(product); setNotice(null);
    try {
      const { url } = await api.billing.checkout(product);
      if (url) window.location.assign(url);
      else setNotice({ kind: "error", text: "Checkout did not return a payment URL." });
    } catch (e) {
      const code = errorCode(e);
      if (code === "billing_disabled") setNotice({ kind: "info", text: BILLING_DISABLED_TEXT, note: BILLING_DISABLED_NOTE });
      else if (code === "already_owned") { setNotice({ kind: "info", text: "You already have access to this." }); await refresh(); }
      else if (errorStatus(e) === 401) router.push(`/login?next=${encodeURIComponent(path || "/")}`);
      else setNotice({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }, [auth_mode, user, router, path, refresh]);

  return { checkout, busy, notice, clearNotice: () => setNotice(null), billingEnabled: billing_enabled, anonymous: auth_mode === "accounts" && !user, loginHref, signupHref };
}
