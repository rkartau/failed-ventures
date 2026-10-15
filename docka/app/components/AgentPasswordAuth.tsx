"use client";

// feat/password-signup Step 8 — agent-side password auth. Same form family as
// the seaman component (PasswordAuthCore carries every Step 7 amendment: codes
// ceremony incl. username + whole-account line, errTaken steering, ES5-safe
// validation, clipboard degrade, localStorage committed-marker, dual-role note,
// bindSide confirm, autocomplete/one-form-pair/44px) with side:"agent" and NO
// adopt token (claim links are a seafarer concept). After sign-in the server
// components re-render via router.refresh(), so the SignInGate at /agent (and
// the settings pages that fall back to it) flips to the signed-in view.

import { useRouter } from "next/navigation";
import { PasswordAuthCore } from "@/components/SeamanPasswordAuth";

export function AgentPasswordAuth({
  defaultTab = "signin",
  leadToken,
}: {
  defaultTab?: "create" | "signin";
  /** Outreach CTA attribution token (Increment 5) — see PasswordAuthCore. */
  leadToken?: string | null;
}) {
  const router = useRouter();
  return (
    <PasswordAuthCore
      side="agent"
      onSignedIn={() => {
        router.refresh();
      }}
      defaultTab={defaultTab}
      leadToken={leadToken}
    />
  );
}
