import { BADGE_LABELS, type BadgeStatus } from "@/lib/cert";

const TONES: Record<BadgeStatus, string> = {
  valid: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  // Perpetual (no-expiry) — a valid/compliant state, styled like "valid" (emerald).
  none: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  expiring: "bg-amber-100 text-amber-800 ring-amber-200",
  expired: "bg-rose-100 text-rose-800 ring-rose-200",
  unknown: "bg-slate-100 text-slate-500 ring-slate-200",
  // Arrived, not registry-verified — a calm neutral, deliberately NOT emerald.
  unverified: "bg-slate-100 text-slate-600 ring-slate-300",
  // An expiry we can't trust yet (OCR-guessed) — amber "please confirm".
  unread: "bg-amber-100 text-amber-800 ring-amber-200",
  // Reviewer-checked (not government-verified) — a distinct blue, never emerald.
  checked: "bg-blue-100 text-blue-800 ring-blue-200",
  // Manual verification requested — an OUTCOME in flight, violet (never an error).
  requested: "bg-violet-100 text-violet-800 ring-violet-200",
  // Registry-confirmed DOCUMENT, holder not verified — teal, deliberately NOT
  // the emerald reserved for holder-bound government verification.
  "registry-doc": "bg-teal-100 text-teal-800 ring-teal-200",
};

const DOTS: Record<BadgeStatus, string> = {
  valid: "bg-emerald-500",
  none: "bg-emerald-500",
  expiring: "bg-amber-500",
  expired: "bg-rose-500",
  unknown: "bg-slate-400",
  unverified: "bg-slate-400",
  unread: "bg-amber-500",
  checked: "bg-blue-500",
  requested: "bg-violet-500",
  "registry-doc": "bg-teal-500",
};

// Small pill showing valid / expiring soon / expired / not-verified — the
// at-a-glance chip the agent triages on and the seafarer sees on each document.
export function StatusBadge({
  status,
  label,
  className = "",
}: {
  status: BadgeStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${TONES[status]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} />
      {label ?? BADGE_LABELS[status]}
    </span>
  );
}
