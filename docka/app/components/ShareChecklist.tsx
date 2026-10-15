"use client";

// Client wrapper so the OPEN public share page (a server component) can offer
// per-item uploads. The share page cannot hand a client `onUploaded` callback or
// call `router.refresh()` itself, so this thin client boundary owns the refresh:
// after an upload lands, re-fetch the server component so the checklist and the
// document list reflect the newly-received item.
//
// Enabled ONLY in open mode by the caller — in open mode the visitor's URL token
// already equals `seafarer.shareToken`, so embedding it leaks nothing. In
// email/alias mode the page keeps the read-only `DocRequestChecklist` instead.

import { useRouter } from "next/navigation";
import { DocRequestChecklist } from "@/components/DocRequestChecklist";
import type { DocRequest } from "@/lib/db";

export function ShareChecklist({
  requests,
  seafarerId,
  shareToken,
}: {
  requests: DocRequest[];
  seafarerId: string;
  shareToken: string;
}) {
  const router = useRouter();
  return (
    <DocRequestChecklist
      requests={requests}
      seafarerId={seafarerId}
      shareToken={shareToken}
      onUploaded={() => router.refresh()}
    />
  );
}
