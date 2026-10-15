"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { REQUIRED_DOC_TYPES, type RequiredDocType } from "@/lib/doctypes";
import type { CandidateScore } from "@/lib/vacancy";
import type { Vacancy } from "@/lib/db";

// #52 — vacancy board. Shows per-candidate cert coverage (through the voyage),
// sea-time gate, held-but-expiring flag [C1], verification badge, sea-ready pill,
// availability / at-sea [R52.17], and a one-click "Qualified only" filter [R52.16].

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function CandidateRow({ c }: { c: CandidateScore }) {
  return (
    <li
      data-testid="candidate-row"
      data-ref={c.ref}
      data-qualified={c.qualified ? "true" : "false"}
      data-sea-ready={c.seaReady ? "true" : "false"}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">
            {c.row.name}
            {/* Plan §D5 #52 (cosmetic, decision: badge, not exclude): the granted
                flagship may surface in agent-side vacancy matches — mark it. */}
            {c.row.isSample === true && (
              <span
                data-testid="match-sample-chip"
                title="Fictional sample profile — demo data"
                className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300"
              >
                Sample
              </span>
            )}
          </p>
          <p className="mt-0.5 text-sm text-slate-500">
            {c.row.rank || "Rank not set"}
            {c.row.vesselType ? ` · ${c.row.vesselType}` : ""}
            {c.row.flagState ? ` · ${c.row.flagState}` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {c.qualified ? (
            <span
              data-testid="candidate-qualified"
              className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
            >
              Qualified
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
              Not qualified
            </span>
          )}
          <VerificationLevelBadge level={c.verificationFloor} size="sm" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span
          data-testid="candidate-coverage"
          className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-700"
        >
          Cert coverage {pct(c.certCoverage)}
        </span>
        <span
          data-testid="candidate-sea-time"
          className={`rounded-md px-2 py-0.5 font-semibold ${
            c.seaTimeQualifies ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {/* Show the actual gap, not a bare "short" [C1]. */}
          {c.seaTimeQualifies
            ? `Sea time ${c.seaDaysInWindow}d OK`
            : `Needs ${c.minSeaDaysRequired}d · has ${c.seaDaysInWindow}d`}
        </span>
        {/* Sea-ready pill: colour-coded green-FILLED (go) vs amber/red-FILLED (stop) [D];
            but a NOT-qualified card never shows a green go-signal — it is greyed so it
            can't be misread next to "Not qualified" [C2]. */}
        <span
          data-testid="candidate-sea-ready"
          data-muted={c.seaReady && !c.qualified ? "true" : "false"}
          className={`rounded-md px-2 py-0.5 font-semibold ${
            !c.seaReady
              ? "bg-rose-600 text-white"
              : c.qualified
                ? "bg-emerald-600 text-white"
                : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"
          }`}
        >
          {c.seaReady ? "Sea-ready" : "Not sea-ready"}
        </span>
        <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
          {c.atSea ? "At sea" : c.availability === "open" ? "Open now" : c.availability === "open_from" ? `Open from ${c.availableFrom ?? "?"}` : c.availability === "occupied" ? "Occupied" : "Availability not set"}
        </span>
        {c.possibleForgery && (
          <span className="rounded-md bg-rose-50 px-2 py-0.5 font-semibold text-rose-700">
            Possible forgery
          </span>
        )}
      </div>

      {c.missingCerts.length > 0 && (
        <p className="mt-2 text-xs text-rose-600">Missing: {c.missingCerts.join(", ")}</p>
      )}
      {c.heldButExpiring.length > 0 && (
        <p className="mt-1 text-xs text-amber-700" data-testid="candidate-held-expiring">
          Held but lapses before the voyage ends: {c.heldButExpiring.join(", ")}
        </p>
      )}
    </li>
  );
}

export function VacancyMatch({
  vacancies,
  matches,
}: {
  vacancies: Vacancy[];
  matches: Record<string, CandidateScore[]>;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(vacancies[0]?.id ?? "");
  const [qualifiedOnly, setQualifiedOnly] = useState(false);

  // Create form.
  const [title, setTitle] = useState("");
  const [rank, setRank] = useState("");
  const [certs, setCerts] = useState<Set<RequiredDocType>>(new Set());
  const [minSeaDays, setMinSeaDays] = useState("");
  const [seaWindowMonths, setSeaWindowMonths] = useState("");
  const [rotationEnd, setRotationEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const createKey = useMemo(() => `vk-${Math.random().toString(36).slice(2)}-${Date.now()}`, []);

  const list = matches[selectedId] ?? [];
  const shown = qualifiedOnly ? list.filter((c) => c.qualified) : list;
  const qualifiedCount = list.filter((c) => c.qualified).length;

  function toggleCert(t: RequiredDocType) {
    setCerts((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function createVacancy() {
    if (!title.trim() || !rank.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/vacancies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          rank,
          requiredCerts: Array.from(certs),
          minSeaDays: minSeaDays ? Number(minSeaDays) : null,
          seaWindowMonths: seaWindowMonths ? Number(seaWindowMonths) : null,
          rotationEnd,
          createKey,
        }),
      });
      const data = await res.json();
      if (data.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="vacancy-match" className="space-y-8">
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">New vacancy</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-slate-600">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              data-testid="vacancy-title-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Rank</span>
            <input
              value={rank}
              onChange={(e) => setRank(e.target.value)}
              maxLength={120}
              data-testid="vacancy-rank-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Min sea days</span>
            <input
              type="number"
              value={minSeaDays}
              onChange={(e) => setMinSeaDays(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Sea-time window (months)</span>
            <input
              type="number"
              value={seaWindowMonths}
              onChange={(e) => setSeaWindowMonths(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-slate-600">Rotation end (voyage window)</span>
            <input
              type="date"
              value={rotationEnd}
              onChange={(e) => setRotationEnd(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <p className="mt-3 text-sm font-medium text-slate-700">Required certificates</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {REQUIRED_DOC_TYPES.map((t) => (
            <label
              key={t}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                certs.has(t)
                  ? "bg-brand-600 text-white ring-brand-600"
                  : "bg-white text-slate-600 ring-slate-300"
              }`}
            >
              <input type="checkbox" className="sr-only" checked={certs.has(t)} onChange={() => toggleCert(t)} />
              {t}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={busy || !title.trim() || !rank.trim()}
          onClick={() => void createVacancy()}
          data-testid="vacancy-create-submit"
          className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Create vacancy
        </button>
      </section>

      {vacancies.length === 0 ? (
        <p className="text-sm text-slate-400">No vacancies yet — create one above.</p>
      ) : (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="text-sm">
              <span className="text-slate-600">Vacancy</span>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                data-testid="vacancy-select"
                className="ml-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              >
                {vacancies.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title} · {v.rank}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-3">
              <span
                data-testid="qualified-count"
                className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600"
              >
                {qualifiedCount} qualified of {list.length}
              </span>
              <label
                data-testid="qualified-only-toggle"
                data-on={qualifiedOnly ? "true" : "false"}
                className="flex cursor-pointer items-center gap-2 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={qualifiedOnly}
                  onChange={(e) => setQualifiedOnly(e.target.checked)}
                />
                Qualified only
              </label>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No candidates match.</p>
          ) : (
            <ul className="mt-4 space-y-3" data-testid="candidate-list">
              {shown.map((c) => (
                <CandidateRow key={c.ref} c={c} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
