import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readDB, updateDB, id as newId, type Seafarer } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { auth } from "@/auth";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";
import {
  UPLOAD_DIR,
  MAX_PHOTO_BYTES,
  activeProfilePhotoFile,
  extForImageType,
  extFromImageName,
} from "@/lib/profile-photo";

export const dynamic = "force-dynamic";

// billing-guard: session-branch — R2-9. This route serves TWO trust models. The
// billing tier binds ONLY to the resolved agent-session path; the possession-token
// path is deliberately untouched, so a blocked agency never costs its seafarers
// access to their own data via /share, /portal or a share link (decision 6).
// (requireBillingReadable / requireBillingWritable both fail open on a session-less
// caller, which is what makes the token branch structurally exempt.)
export const maxDuration = 30;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// A seafarer id is an OPAQUE uuid-shaped id. Anything with a path/traversal/null-byte
// shape can never be a real id and is rejected BEFORE any db or disk access.
function isSafeId(ref: string): boolean {
  if (!ref || ref.length === 0 || ref.length > 200) return false;
  return /^[A-Za-z0-9-]+$/.test(ref);
}

// OWNER possession-secret WRITE authorisation via the CHOKEPOINT, pinned to
// TODAY'S acceptance: open + email token, ungated (PHASE0-CENSUS row 10 audit —
// plan R15, behavior preserved). Returns true (owner), "sample" (sample subject:
// the route answers 403 read-only), or false.
function ownerTokenWrite(sf: Seafarer, token: string): boolean | "sample" {
  if (!token) return false;
  const subject = resolveTokenSubject(readDB(), token, "write", ["open", "email"]);
  if (subject === SAMPLE_WRITE_DENIED) return "sample";
  return !!subject && subject.seafarer.id === sf.id;
}

// GET /api/profile-photo/<seafarerId>[?token=<shareToken>]
//
// Serves the LOCAL profile photo (custom override -> verified download -> 404). The
// access rules mirror the person's documents (/api/files): a ?token authorises the
// owner + legitimate share viewers (open link, or email link with an allow-listed /
// owner Google session); otherwise a signed-in agent needs a LIVE grant. Anything
// else => 404. The raw expiring registry URL is never exposed here.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sid = params.id;
  if (!isSafeId(sid)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const db = readDB();
  const sf = db.seafarers.find((s) => s.id === sid) ?? null;

  let allowed = false;
  const token = req.nextUrl.searchParams.get("token");
  if (sf) {
    if (token) {
      // CHOKEPOINT: open + gated email (PHASE0-CENSUS row 10). Sample verdict:
      // GET **ALLOW** — the curated profile photo is public demo content.
      const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
      const matches =
        subject !== null && subject !== SAMPLE_WRITE_DENIED && subject.seafarer.id === sf.id;
      if (matches && subject.mode === "open") {
        allowed = true; // OPEN link — token alone opens the profile (same as docs).
      } else if (matches && subject.mode === "email") {
        // PRIVATE (email) link: the token alone is NOT enough — same rule as /api/files.
        const gate = await evaluateShareAccess(sf, "email");
        allowed = gate.allowed;
        if (!allowed) {
          const session = await auth();
          if (session?.role === "seaman" && session.seafarerId === sf.id) allowed = true;
        }
      }
    } else {
      // Agent context: fail-closed, grant-scoped.
      const session = await agentSession();
      const billingGate = requireBillingReadable(session);
      if (!billingGate.ok) return billingGate.response;
      if (session?.user) allowed = checkAccess(session.agentId, sf.id).allowed;
    }
  }

  if (!sf || !allowed) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const fileName = activeProfilePhotoFile(sf);
  if (!fileName) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const name = path.basename(fileName);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const buf = fs.readFileSync(filePath);
  const ext = path.extname(name).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

// POST /api/profile-photo/<seafarerId>  (multipart/form-data: file, token)
//
// OWNER-ONLY: the caller must present an OWNER share token (possession secret) for
// THIS seafarer. A token for another seafarer, or none, => 404 with no write — a user
// can only change THEIR OWN photo. Stores the uploaded image under uploads/ as the
// CUSTOM profile photo (overrides the verified one). Validates image type + 5 MB cap.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sid = params.id;
  if (!isSafeId(sid)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: "Invalid form data." }, { status: 400 });
  }
  const token = String(form.get("token") ?? "").trim();

  const sf = readDB().seafarers.find((s) => s.id === sid) ?? null;
  const postAuth = sf ? ownerTokenWrite(sf, token) : false;
  if (postAuth === "sample") return sampleReadOnlyResponse();
  if (!sf || postAuth !== true) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const file = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || (file as File).size === 0) {
    return NextResponse.json({ ok: false, error: "Attach an image." }, { status: 400 });
  }
  const f = file as File;
  const ext = extForImageType(f.type) ?? extFromImageName(f.name);
  if (!ext) {
    return NextResponse.json(
      { ok: false, error: "Unsupported image type. Use JPG, PNG, WebP or GIF." },
      { status: 400 }
    );
  }
  const buf = Buffer.from(await f.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, error: "Image too large (max 5 MB)." }, { status: 413 });
  }

  // A unique name so the served URL changes when the photo changes (cache-safe).
  const fileName = `profile-${sid}-custom-${newId()}${ext}`;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
  } catch {
    return NextResponse.json({ ok: false, error: "Could not save the image." }, { status: 500 });
  }

  const prev = sf.customPhotoFile ?? null;
  const result = await updateDB((db) => {
    const s = db.seafarers.find((x) => x.id === sid);
    if (!s) return null;
    s.customPhotoFile = fileName;
    return s;
  });
  if (!result) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Remove the previous custom file so a replaced photo never leaves an orphan on disk.
  if (prev && prev !== fileName) {
    try {
      const p = path.join(UPLOAD_DIR, path.basename(prev));
      if (p.startsWith(UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore — the record already points at the new file */
    }
  }

  return NextResponse.json({ ok: true, seafarer: result });
}

// DELETE /api/profile-photo/<seafarerId>  { token }
//
// OWNER-ONLY reset: clears the CUSTOM photo and reverts the displayed avatar to the
// government-verified photo (if one is stored). Same owner-token authorisation as POST.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sid = params.id;
  if (!isSafeId(sid)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();

  const sf = readDB().seafarers.find((s) => s.id === sid) ?? null;
  const delAuth = sf ? ownerTokenWrite(sf, token) : false;
  if (delAuth === "sample") return sampleReadOnlyResponse();
  if (!sf || delAuth !== true) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const prev = sf.customPhotoFile ?? null;
  const result = await updateDB((db) => {
    const s = db.seafarers.find((x) => x.id === sid);
    if (!s) return null;
    s.customPhotoFile = null;
    return s;
  });
  if (!result) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Remove the custom file from disk (storage is tight on the box).
  if (prev) {
    try {
      const p = path.join(UPLOAD_DIR, path.basename(prev));
      if (p.startsWith(UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  return NextResponse.json({ ok: true, seafarer: result });
}
