import { CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";

// SEO Phase 2c — a small, visible freshness line for the evergreen content pages
// (/about, /registries + spokes, /resources + the guide). Server component; renders a
// real <time datetime> so the date is both human-readable and machine-parseable. The
// date is a STATIC maintained constant, not a build-time timestamp — see @/lib/seo.
export function LastUpdated({ className }: { className?: string }) {
  return (
    <p
      data-testid="last-updated"
      className={className ?? "mt-2 text-xs text-slate-500"}
    >
      Last updated:{" "}
      <time dateTime={CONTENT_LAST_UPDATED_ISO}>{CONTENT_LAST_UPDATED_LABEL}</time>
    </p>
  );
}
