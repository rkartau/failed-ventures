import type { VerifiedCert } from "@/lib/cert";
import { classifyCertRule, computeLegalExpiry } from "@/lib/cert-rules";
import { countryEntry } from "@/lib/registry/countries";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { LEVEL_META, type VerificationLevel } from "@/lib/verification-level";

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-800">{value || "—"}</dd>
    </div>
  );
}

export function CertCard({ cert }: { cert: VerifiedCert }) {
  const good = cert.isValid && cert.status.toLowerCase() === "valid";
  const amber = !good && cert.status.toLowerCase() !== "invalid" && cert.isValid;

  // True legal expiry from the certificate-type rule library. For an age-restricted
  // medical (55+/under-18) the legal window is shorter than the printed one, so a
  // cert that PRINTS "valid 2028" may be legally expired earlier — surface that.
  const legal = computeLegalExpiry({
    ruleType: classifyCertRule({
      title: cert.title,
      docType: cert.documentType,
      docCategory: cert.docCategory,
      certificateType: cert.certificateType,
    }),
    printedValidUntil: cert.validUntil,
    issuedOn: cert.issuedOn,
    holderDOB: cert.birthDate,
  });

  const tone = good
    ? {
        ring: "ring-emerald-200",
        head: "bg-emerald-50",
        badge: "bg-emerald-100 text-emerald-800",
        dot: "bg-emerald-500",
        // #S5 — just the EXPIRY status word; the "Government-verified" trust claim
        // is carried once, by the level badge beside it (was "Verified · Valid").
        label: "In date",
      }
    : amber
      ? {
          ring: "ring-amber-200",
          head: "bg-amber-50",
          badge: "bg-amber-100 text-amber-800",
          dot: "bg-amber-500",
          label: "Check status",
        }
      : {
          ring: "ring-rose-200",
          head: "bg-rose-50",
          badge: "bg-rose-100 text-rose-800",
          dot: "bg-rose-500",
          label: "Not valid",
        };

  return (
    <div className={`overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ${tone.ring}`}>
      <div className={`flex items-center justify-between gap-3 px-5 py-3 ${tone.head}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone.badge}`}>
            {tone.label}
          </span>
          {/* #30.6 — verification level derived from the verified source. A fresh
              government verification is L3; a registry-confirmed one is L2. */}
          {(() => {
            const level: VerificationLevel = cert.verifiedSource === "government" ? 3 : 2;
            const tooltip =
              level === 3
                ? cert.keyTrust === "capability-token"
                  ? "Government-verified — identity-bound (secure registry token)."
                  : "Government-verified — holder-bound (printed identifier)."
                : LEVEL_META[2].tip;
            return <VerificationLevelBadge level={level} tooltip={tooltip} size="sm" />;
          })()}
        </div>
        <span className="text-xs font-medium text-slate-500" data-testid="cert-card-authority">
          {/* Persona B1 — name the ACTUAL answering registry, per country. */}
          {countryEntry(cert.registryCountry)?.authority ?? "Government registry"}
        </span>
      </div>

      <div className="flex items-start gap-4 px-5 pt-5">
        {cert.hasName && cert.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cert.photoUrl}
            alt={cert.fullName}
            className="h-16 w-16 flex-shrink-0 rounded-xl object-cover ring-1 ring-slate-200"
          />
        ) : cert.hasName ? (
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-lg font-bold text-brand-700 ring-1 ring-brand-100">
            {cert.fullName.slice(0, 1) || "?"}
          </div>
        ) : (
          // Medical / minimal model: no holder name or photo is returned.
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-100">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l7 3v6c0 4-3 6.5-7 9-4-2.5-7-5-7-9V6z" />
              <path d="M12 9v4M10 11h4" />
            </svg>
          </div>
        )}
        <div className="min-w-0">
          {cert.hasName ? (
            <>
              <h3 className="truncate text-lg font-bold text-slate-900">{cert.fullName}</h3>
              <p className="mt-0.5 text-sm text-slate-500">{cert.certificateType}</p>
            </>
          ) : (
            <>
              <h3 className="truncate text-lg font-bold text-slate-900">
                Medical certificate
              </h3>
              <p className="mt-0.5 text-sm text-slate-500">
                Valid until {fmtDate(cert.validUntil)}
              </p>
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 px-5 py-5 sm:grid-cols-3">
        <Field label="Status" value={cert.status} />
        <Field label="Valid until" value={fmtDate(cert.validUntil)} />
        <Field label="Issued on" value={fmtDate(cert.issuedOn)} />
        {cert.hasName && (
          <>
            <Field label="Issuer" value={cert.issuerCountry} />
            <Field label="Institution" value={cert.institution} />
            <Field label="Document type" value={cert.documentType} />
            <Field label="Personal code" value={cert.personalCode} />
          </>
        )}
        <Field label="Verification code" value={<span className="font-mono">{cert.code}</span>} />
      </dl>

      {legal.differs && legal.legalValidUntil && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 flex-shrink-0 text-amber-600">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          <p className="text-xs font-medium text-amber-800">
            Legal expiry {fmtDate(legal.legalValidUntil)} — earlier than the printed{" "}
            {fmtDate(legal.printedValidUntil ?? cert.validUntil)}.
            {legal.ageRestricted && " Age-based medical rule (shorter validity) applies."}
          </p>
        </div>
      )}

      <div className="border-t border-slate-100 px-5 py-3">
        <a
          href={cert.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-800"
        >
          View on the official registry
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 17L17 7M17 7H8M17 7v9" />
          </svg>
        </a>
      </div>
    </div>
  );
}
