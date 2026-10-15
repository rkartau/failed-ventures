// app/signup/page.tsx — outreach signup CTA landing (Increment 5).
//
// PUBLIC page. The cold-mail CTA links here as /signup?t=<hmac-token> (token
// payload pinned: {send_key, message_id:"cta-signup", touch:0, event:"signup"},
// deterministically re-minted by the pipeline [R3-A3]). This page:
//   1. verifies the token SERVER-side (expectEvent:"signup") and resolves the
//      leadKey via the shared ^LD\d{1,15}$ contract (lib/booking.sanitizeLeadKey);
//   2. on a VALID token appends ONE `signup_started` event (server-side
//      tokened-page-visit — the simple fallback the plan allows instead of a
//      client beacon; event_key dedups repeat visits at fold time), fail-soft;
//   3. renders the EXISTING agent create-account form (reuse: AgentPasswordAuth
//      → PasswordAuthCore) with the token threaded into the signup POST.
// FAILED verify (tampered / foreign-secret / absent / unconfigured / bad
// send_key) NEVER blocks the page: the form renders without attribution — a
// paying signup always proceeds.

import { AgentPasswordAuth } from "@/components/AgentPasswordAuth";
import { verifyTrackingToken } from "@/lib/tracking-token";
import { sanitizeLeadKey } from "@/lib/booking";
import { appendEvent } from "@/lib/outreach-events";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create account — Docka",
  description: "Create your Docka account.",
};

/** First scalar out of a Next searchParams value (array form tolerated). */
function firstParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.find((x) => typeof x === "string" && x.length > 0);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: { t?: string | string[] };
}): Promise<JSX.Element> {
  const token = firstParam(searchParams?.t);

  // Server-side verify — a UX gate only; /api/signup RE-verifies the token it
  // receives back. Never throws, never blocks.
  let verifiedToken: string | null = null;
  if (token) {
    try {
      const v = verifyTrackingToken(token, "signup");
      if (v.ok && sanitizeLeadKey(v.payload.send_key)) {
        verifiedToken = token;
        // Tokened-page-visit signal for the abandoned-signup nudge. Fail-soft.
        try {
          await appendEvent({
            event: "signup_started",
            send_key: v.payload.send_key,
            message_id: v.payload.message_id,
            touch: v.payload.touch,
          });
        } catch {
          /* the sink must never block the landing */
        }
      }
    } catch {
      /* attribution dropped — the form below still renders */
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16">
      <h1 className="text-2xl font-bold text-slate-900">Create your Docka account</h1>
      <p className="mt-2 text-sm text-slate-500">
        Crew credential tracking for agencies — set up your account below. Already have
        one? Use the Sign in tab.
      </p>
      <div className="mt-8">
        <AgentPasswordAuth defaultTab="create" leadToken={verifiedToken} />
      </div>
    </div>
  );
}
