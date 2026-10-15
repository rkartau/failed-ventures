"use client";

import { useMemo, useState } from "react";
import type { Doc, SeaServiceEntry } from "@/lib/db";
import {
  entryDays,
  formatDuration,
  isOnboard,
  sortForDisplay,
  summarizeSeaService,
  REVALIDATION_QUALIFYING_DAYS,
} from "@/lib/sea-service";
import { revalidationForDoc, type RevalidationAssessment } from "@/lib/cert-rules";

// The sea-service ledger — the digital discharge book (T2.2). ONE interactive
// component used on BOTH the seaman dashboard (/seafarer) and the agent review
// panel (/agent/[id]). Auth mode is decided by whether a `token` is passed:
//   - token present  -> SEAMAN self-service: the owner share token authorises writes.
//   - token absent    -> AGENT: the signed-in agent's grant authorises writes (cookie).
// Both hit /api/sea-service, which returns the fresh entry list + summary after every
// change, so accumulated sea-time re-computes server-side and can never drift.

function fmtDate(day: string | null): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

type FormState = {
  vessel: string;
  rank: string;
  signOn: string;
  signOff: string;
  imo: string;
  vesselType: string;
  flagState: string;
  note: string;
};

const EMPTY_FORM: FormState = {
  vessel: "",
  rank: "",
  signOn: "",
  signOff: "",
  imo: "",
  vesselType: "",
  flagState: "",
  note: "",
};

function formFromEntry(e: SeaServiceEntry): FormState {
  return {
    vessel: e.vessel,
    rank: e.rank,
    signOn: e.signOn?.slice(0, 10) ?? "",
    signOff: e.signOff?.slice(0, 10) ?? "",
    imo: e.imo ?? "",
    vesselType: e.vesselType ?? "",
    flagState: e.flagState ?? "",
    note: e.note ?? "",
  };
}

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

export function SeaServiceLedger({
  seafarerId,
  initialEntries,
  token,
  documents = [],
  holderDOB = null,
}: {
  seafarerId: string;
  initialEntries: SeaServiceEntry[];
  /** Seaman owner share token — its presence selects seaman self-service mode. */
  token?: string;
  /**
   * The holder's certificate documents (T2.3). When supplied, sea-time-gated
   * certificates (a CoC) are classified against the live ledger and any on the
   * costly refresher path are listed under the revalidation counter. Omitted =
   * only the aggregate path summary is shown (unchanged behaviour).
   */
  documents?: Doc[];
  /** Holder DOB, so an age-shortened medical's LEGAL expiry drives "approaching". */
  holderDOB?: string | null;
}) {
  const [entries, setEntries] = useState<SeaServiceEntry[]>(initialEntries ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = closed; "new" = add form; otherwise the id of the entry being edited.
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const ordered = useMemo(() => sortForDisplay(entries), [entries]);
  const summary = useMemo(() => summarizeSeaService(entries), [entries]);

  // Sea-time-gated certificates (a CoC) that the live ledger puts on the costly
  // refresher path, split so an APPROACHING one (inside the renewal lead window)
  // is called out sharply. Re-computes as the agent/seaman edits the ledger, so a
  // freshly-added voyage that crosses the 360-day floor clears the warning at once.
  const refresherCerts = useMemo(() => {
    const out: { doc: Doc; a: RevalidationAssessment }[] = [];
    const seen = new Set<string>();
    for (const d of documents) {
      const a = revalidationForDoc(d, entries, holderDOB);
      if (!a || a.path !== "refresher") continue;
      const key = `${a.ruleType}::${d.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ doc: d, a });
    }
    // Approaching (or already-expired) ones first — those are the actionable ones.
    return out.sort((x, y) => Number(y.a.approaching) - Number(x.a.approaching));
  }, [documents, entries, holderDOB]);

  // Every write includes the owner token in seaman mode; the agent relies on the
  // cookie session, so `token` is simply omitted there.
  function withAuth(body: Record<string, unknown>): Record<string, unknown> {
    return token ? { ...body, token } : body;
  }

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
    setError(null);
  }
  function openEdit(e: SeaServiceEntry) {
    setForm(formFromEntry(e));
    setEditing(e.id);
    setError(null);
  }
  function closeForm() {
    setEditing(null);
    setError(null);
  }

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    if (!form.vessel.trim() || !form.rank.trim()) {
      setError("Vessel and rank are required.");
      return;
    }
    if (!form.signOn) {
      setError("Enter a sign-on date.");
      return;
    }
    if (form.signOff && form.signOff < form.signOn) {
      setError("Sign-off cannot be before sign-on.");
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      vessel: form.vessel.trim(),
      rank: form.rank.trim(),
      signOn: form.signOn,
      signOff: form.signOff || null,
      imo: form.imo.trim() || null,
      vesselType: form.vesselType.trim() || null,
      flagState: form.flagState.trim() || null,
      note: form.note.trim() || null,
    };
    try {
      const isNew = editing === "new";
      const res = await fetch("/api/sea-service", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withAuth(isNew ? { seafarerId, ...payload } : { id: editing, ...payload })),
      });
      const data = await res.json();
      if (data.ok) {
        setEntries(data.entries as SeaServiceEntry[]);
        closeForm();
      } else {
        setError(data.error ?? "Could not save this entry.");
      }
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // One-tap "sign off today" for a currently-onboard engagement.
  async function signOffToday(entry: SeaServiceEntry) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sea-service", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withAuth({ id: entry.id, signOff: new Date().toISOString().slice(0, 10) })),
      });
      const data = await res.json();
      if (data.ok) setEntries(data.entries as SeaServiceEntry[]);
      else setError(data.error ?? "Could not update this entry.");
    } catch {
      setError("Could not update. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entryId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sea-service", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withAuth({ id: entryId })),
      });
      const data = await res.json();
      if (data.ok) {
        setEntries(data.entries as SeaServiceEntry[]);
        setConfirmDelete(null);
      } else {
        setError(data.error ?? "Could not delete this entry.");
      }
    } catch {
      setError("Could not delete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="sea-service-ledger"
      className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            Sea service
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Your discharge book — sign-on / sign-off records build your sea time.
          </p>
        </div>
        {summary.onboard && (
          <span
            data-testid="sea-service-onboard"
            className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-200"
          >
            Currently onboard
          </span>
        )}
      </div>

      {/* Sea-time counters — the headline the CV, revalidation gate + endorsements read. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" data-testid="sea-time-total">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Total sea time</p>
          <p className="mt-0.5 text-lg font-bold text-slate-800">{formatDuration(summary.totalDays)}</p>
          <p className="text-[11px] text-slate-400">{summary.totalDays} days · {summary.entryCount} voyage(s)</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3" data-testid="sea-time-5y">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last 5 years</p>
          <p className="mt-0.5 text-lg font-bold text-slate-800">{summary.last5yDays} days</p>
          <p className="text-[11px] text-slate-400">qualifying window</p>
        </div>
        <div
          className={`rounded-xl border px-4 py-3 ${
            summary.meetsRevalidation
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-200 bg-amber-50"
          }`}
          data-testid="sea-time-revalidation"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Revalidation path</p>
          <p className={`mt-0.5 text-sm font-bold ${summary.meetsRevalidation ? "text-emerald-700" : "text-amber-700"}`}>
            {summary.meetsRevalidation ? "Short revalidation" : "May need refresher"}
          </p>
          <p className="text-[11px] text-slate-500">
            for the lower-cost renewal (≥{REVALIDATION_QUALIFYING_DAYS} days in 5 years)
          </p>
        </div>
      </div>

      {/* Per-certificate revalidation-path gate (T2.3). Names the specific
          sea-time-gated certificates that fall on the costly refresher path given
          the current ledger, so the cost/lead-time consequence is concrete rather
          than an abstract "may need refresher". */}
      {refresherCerts.length > 0 && (
        <div
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
          data-testid="revalidation-gate"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            Certificates on the refresher path
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {refresherCerts.map(({ doc, a }) => (
              <li
                key={doc.id}
                data-testid="revalidation-cert"
                data-approaching={a.approaching ? "true" : "false"}
                className="text-xs text-amber-900"
              >
                <span className="font-semibold">{doc.title}</span>
                {a.approaching && (
                  <span className="ml-1.5 inline-block rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                    {a.daysToExpiry != null && a.daysToExpiry < 0 ? "expired" : "expiry approaching"}
                  </span>
                )}
                <span className="block text-[11px] text-amber-700">
                  short {a.shortfallDays} day(s) of the ≥{a.requiredDays}-day sea-time floor — likely a costly refresher, not a short revalidation
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="sea-service-error">
          {error}
        </p>
      )}

      {/* Ledger table */}
      {ordered.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-xs" data-testid="sea-service-table">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1 pr-3 font-semibold">Vessel</th>
                <th className="py-1 pr-3 font-semibold">Rank</th>
                <th className="py-1 pr-3 font-semibold">Sign-on</th>
                <th className="py-1 pr-3 font-semibold">Sign-off</th>
                <th className="py-1 pr-3 font-semibold">Days</th>
                <th className="py-1 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((e) => {
                const onboard = isOnboard(e);
                return (
                  <tr
                    key={e.id}
                    data-testid="sea-service-row"
                    data-onboard={onboard ? "true" : "false"}
                    className="border-t border-slate-100 align-top"
                  >
                    <td className="py-2 pr-3">
                      <span className="font-medium text-slate-800">{e.vessel}</span>
                      {(e.imo || e.flagState || e.vesselType) && (
                        <span className="block text-[11px] text-slate-400">
                          {[e.imo ? `IMO ${e.imo}` : null, e.vesselType, e.flagState]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                      {e.note && <span className="block text-[11px] text-slate-400">{e.note}</span>}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">{e.rank}</td>
                    <td className="py-2 pr-3 font-mono text-slate-700">{fmtDate(e.signOn)}</td>
                    <td className="py-2 pr-3">
                      {onboard ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                          Onboard
                        </span>
                      ) : (
                        <span className="font-mono text-slate-700">{fmtDate(e.signOff)}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-semibold text-slate-700">{entryDays(e)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {onboard && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => signOffToday(e)}
                            data-testid="sea-service-signoff"
                            className="rounded-md bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            Sign off today
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openEdit(e)}
                          data-testid="sea-service-edit"
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          Edit
                        </button>
                        {confirmDelete === e.id ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => remove(e.id)}
                              data-testid="sea-service-delete-confirm"
                              className="rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(null)}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-600"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDelete(e.id)}
                            data-testid="sea-service-delete"
                            className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / edit form */}
      {editing ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="sea-service-form">
          <p className="text-xs font-semibold text-slate-600">
            {editing === "new" ? "Add a sea-service entry" : "Edit sea-service entry"}
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">
              Vessel *
              <input
                value={form.vessel}
                onChange={(e) => set("vessel", e.target.value)}
                data-testid="sea-service-vessel"
                placeholder="e.g. MV Baltic Trader"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Rank / capacity *
              <input
                value={form.rank}
                onChange={(e) => set("rank", e.target.value)}
                data-testid="sea-service-rank"
                placeholder="e.g. Third Officer"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Sign-on date *
              <input
                type="date"
                value={form.signOn}
                onChange={(e) => set("signOn", e.target.value)}
                data-testid="sea-service-signon-input"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Sign-off date (leave blank if still onboard)
              <input
                type="date"
                value={form.signOff}
                onChange={(e) => set("signOff", e.target.value)}
                data-testid="sea-service-signoff-input"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              IMO number (optional)
              <input
                value={form.imo}
                onChange={(e) => set("imo", e.target.value)}
                data-testid="sea-service-imo"
                placeholder="e.g. 9074729"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Vessel type (optional)
              <input
                value={form.vesselType}
                onChange={(e) => set("vesselType", e.target.value)}
                data-testid="sea-service-vesseltype"
                placeholder="e.g. chemical tanker"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Flag state (optional)
              <input
                value={form.flagState}
                onChange={(e) => set("flagState", e.target.value)}
                data-testid="sea-service-flag"
                placeholder="e.g. Panama"
                className={inputCls}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Remark (optional)
              <input
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                data-testid="sea-service-note"
                placeholder="e.g. worldwide trade"
                className={inputCls}
              />
            </label>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="rounded-lg px-3 py-2 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              data-testid="sea-service-save"
              className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {busy ? "Saving…" : editing === "new" ? "Add entry" : "Save changes"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openNew}
          data-testid="sea-service-add"
          className="mt-4 rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100"
        >
          Add sea-service entry
        </button>
      )}
    </section>
  );
}
