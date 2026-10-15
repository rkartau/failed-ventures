import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OAUTH_ROLE_COOKIE, OAUTH_ADOPT_COOKIE } from "@/auth";

export const dynamic = "force-dynamic";

// POST /api/seaman/login-intent  { adoptToken? }
//
// Records that the NEXT Google sign-in is happening in the SEAMAN context (so the
// auth.ts jwt callback establishes a role:"seaman" session bound to a found-or-
// created seafarer), plus — optionally — the anonymous share token of a profile
// already started on THIS device, so it is ADOPTED (linked to the Google identity)
// rather than orphaned. Cookies are short-lived, httpOnly, lax so they ride the
// top-level OAuth redirect back to /api/auth/callback/google.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { adoptToken?: string };
  const jar = cookies();
  const opts = { httpOnly: true as const, sameSite: "lax" as const, path: "/", maxAge: 300 };
  jar.set(OAUTH_ROLE_COOKIE, "seaman", opts);
  const adopt = (body.adoptToken ?? "").trim();
  if (adopt) jar.set(OAUTH_ADOPT_COOKIE, adopt, opts);
  else jar.delete(OAUTH_ADOPT_COOKIE);
  return NextResponse.json({ ok: true });
}
