import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import type { Feature, Tone } from "./overviewData";

// Tone -> pill classes. Emerald appears ONLY where it denotes government-verified
// trust (never decorative). Mirrors the shipped pill idiom (rounded-full, ring-1).
const PILL_TONE: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  emerald: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-100 text-amber-800 ring-amber-200",
  rose: "bg-rose-100 text-rose-700 ring-rose-200",
  sky: "bg-sky-100 text-sky-700 ring-sky-200",
  teal: "bg-teal-100 text-teal-800 ring-teal-200",
  brand: "bg-brand-100 text-brand-700 ring-brand-200",
};

export function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <span
        className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${
          PILL_TONE[feature.pillTone]
        }`}
      >
        {feature.pill}
      </span>
      <h3 className="mt-3 font-semibold text-slate-900">{feature.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">{feature.value}</p>

      {feature.badges ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <VerificationLevelBadge level={0} size="sm" />
          <VerificationLevelBadge level={1} size="sm" />
          <VerificationLevelBadge level={2} size="sm" />
          <VerificationLevelBadge level={3} size="sm" />
        </div>
      ) : null}

      {feature.note ? (
        <p className="mt-3 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700">
          {feature.note}
        </p>
      ) : null}
    </div>
  );
}

export function FeatureGrid({
  features,
}: {
  features: Feature[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {features.map((f) => (
        <FeatureCard key={f.title} feature={f} />
      ))}
    </div>
  );
}
