"use client";

import { useState } from "react";
import Link from "next/link";
import type { BillingProfile, BillingUsageRow } from "@/lib/db";
import { eur, reportedCell } from "@/components/billing-ui";
import type { CheckoutView } from "@/components/billing-ui";
import { COUNTRY_WHITELIST, supportedCountryOptions } from "@/lib/billing-countries";

// The agency-facing billing form + status card. Same shape as
// components/RequiredDocsSettings.tsx: local state, an async save() that PUTs JSON to
// the API route and reads `data.ok`, and a banner. No server actions anywhere —
// API routes + fetch is the house style.
//
// Card / IBAN details are NEVER collected here: "Set up payment" redirects to Stripe's
// hosted Checkout, and "Manage payment & invoices" to Stripe's hosted Portal.

type Props = {
  profile: BillingProfile | null;
  tosVersion: string;
  billingLive: boolean;
  stripeReady: boolean;
  currentPeriod: { period: string; quantity: number };
  usage: BillingUsageRow[];
  /** The post-checkout thank-you descriptor, derived server-side (deriveCheckoutView). */
  checkoutView?: CheckoutView | null;
};

const STATUS_LABEL: Record<string, string> = {
  none: "Not set up",
  incomplete: "Incomplete — payment not finished",
  active: "Active",
  past_due: "Payment failed",
  canceled: "Cancelled",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function BillingSettings({
  profile,
  tosVersion,
  billingLive,
  stripeReady,
  currentPeriod,
  usage,
  checkoutView = null,
}: Props) {
  const [legalName, setLegalName] = useState(profile?.legalName ?? "");
  const [regCode, setRegCode] = useState(profile?.regCode ?? "");
  const [vatNumber, setVatNumber] = useState(profile?.vatNumber ?? "");
  const [billingEmail, setBillingEmail] = useState(profile?.billingEmail ?? "");
  const [line1, setLine1] = useState(profile?.address?.line1 ?? "");
  const [line2, setLine2] = useState(profile?.address?.line2 ?? "");
  const [city, setCity] = useState(profile?.address?.city ?? "");
  const [postal, setPostal] = useState(profile?.address?.postal ?? "");
  const [country, setCountry] = useState(profile?.address?.country ?? "");
  const [tosAcceptedAt, setTosAcceptedAt] = useState(profile?.tosAcceptedAt ?? null);
  const [tosChecked, setTosChecked] = useState(Boolean(profile?.tosAcceptedAt));
  const [status, setStatus] = useState(profile?.subscriptionStatus ?? "none");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const baseRate = profile?.baseEurMonthly ?? 300;
  const perSeafarer = profile?.perSeafarerEur ?? 2;
  const exempt = profile?.exemptFromBilling ?? false;
  const subscribed = status === "active" || status === "past_due";

  async function save() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/billing/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legalName,
          regCode,
          vatNumber,
          billingEmail,
          address: { line1, line2, city, postal, country },
          acceptTos: tosChecked,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTosAcceptedAt(data.profile?.tosAcceptedAt ?? null);
        setBanner("Saved.");
      } else {
        setBanner(data.error ?? "Could not save your billing details.");
      }
    } catch {
      setBanner("Could not save your billing details.");
    } finally {
      setBusy(false);
    }
  }

  async function go(endpoint: "checkout" | "portal") {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/billing/${endpoint}`, { method: "POST" });
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setBanner(data.error ?? "Could not open the payment page.");
    } catch {
      setBanner("Could not open the payment page.");
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { hint?: string; placeholder?: string; wide?: boolean } = {}
  ) => (
    <label className={opts.wide ? "sm:col-span-2" : undefined}>
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      <input
        type="text"
        value={value}
        maxLength={200}
        placeholder={opts.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
      />
      {opts.hint ? <span className="mt-1 block text-xs text-slate-500">{opts.hint}</span> : null}
    </label>
  );

  return (
    <div className="space-y-6">
      {checkoutView && checkoutView.kind === "confirmed" ? (
        <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-6">
          <h2 className="text-xl font-bold text-emerald-900">{checkoutView.heading}</h2>
          <p className="mt-2 text-sm text-emerald-900">{checkoutView.body}</p>
          <dl className="mt-4 space-y-2 text-sm text-emerald-900">
            <div>
              <dt className="font-medium">Your plan</dt>
              <dd>
                {eur(baseRate)} / month + {eur(perSeafarer)} per seafarer on your board.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Billing</dt>
              <dd>
                Your first charge is prorated to the 1st, then the full monthly subscription
                is billed on the 1st of each month.
              </dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !stripeReady || !profile?.stripeCustomerId}
              onClick={() => go("portal")}
              className="rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? "Opening…" : "Manage billing & invoices"}
            </button>
            <Link
              href="/agent"
              className="rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-50"
            >
              Go to dashboard
            </Link>
          </div>
        </section>
      ) : null}

      {checkoutView && checkoutView.kind === "confirming" ? (
        <section className="rounded-xl border border-sky-300 bg-sky-50 p-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-sky-300 border-t-sky-700"
            />
            <h2 className="text-xl font-bold text-sky-900">{checkoutView.heading}</h2>
          </div>
          <p className="mt-2 text-sm text-sky-900">{checkoutView.body}</p>
        </section>
      ) : null}

      {checkoutView && checkoutView.kind === "cancelled" ? (
        <section className="rounded-xl border border-slate-300 bg-slate-50 p-6">
          <h2 className="text-xl font-bold text-slate-900">{checkoutView.heading}</h2>
          <p className="mt-2 text-sm text-slate-700">{checkoutView.body}</p>
          <div className="mt-5">
            <button
              type="button"
              disabled={busy || !stripeReady || !tosAcceptedAt}
              onClick={() => go("checkout")}
              className="rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Opening…" : "Try again"}
            </button>
          </div>
        </section>
      ) : null}

      {banner ? (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {banner}
        </div>
      ) : null}

      {!billingLive ? (
        <div className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          Billing is not switched on yet. You can fill in your business details now; nothing
          is charged until docka enables billing for your agency.
        </div>
      ) : null}

      {exempt ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Your agency is currently not billed.
        </div>
      ) : null}

      {/* ---- Status ---------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Subscription</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Status</dt>
            <dd className="font-medium text-slate-900">{STATUS_LABEL[status] ?? status}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Your plan</dt>
            <dd className="font-medium text-slate-900">
              {eur(baseRate)} / month + {eur(perSeafarer)} per billable seafarer
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Billable seafarers this month ({currentPeriod.period})</dt>
            <dd className="font-medium text-slate-900">{currentPeriod.quantity}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Payment method</dt>
            <dd className="font-medium text-slate-900">
              {profile?.paymentMethodAttached ? "On file at Stripe" : "Not set up"}
            </dd>
          </div>
          {profile?.pastDueSince ? (
            <div>
              <dt className="text-slate-500">Payment overdue since</dt>
              <dd className="font-medium text-amber-700">{fmtDate(profile.pastDueSince)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          A seafarer is billable when they are on your board for 24 hours or more in total
          during a calendar month (Europe/Tallinn). Hiding a seafarer does not pause
          billing — withdrawing, revoking, expiry or deleting does. Invoices are issued on
          the 1st of each month.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {!subscribed ? (
            <button
              type="button"
              disabled={busy || !stripeReady || !tosAcceptedAt}
              onClick={() => go("checkout")}
              className="rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Set up payment
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || !stripeReady || !profile?.stripeCustomerId}
            onClick={() => go("portal")}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Manage payment &amp; invoices
          </button>
        </div>
        {!stripeReady ? (
          <p className="mt-2 text-xs text-slate-500">
            Payments are not configured on this deployment yet.
          </p>
        ) : null}
        {stripeReady && !tosAcceptedAt ? (
          <p className="mt-2 text-xs text-slate-500">
            Accept the terms below to enable payment setup.
          </p>
        ) : null}
      </section>

      {/* ---- Business details ------------------------------------------------ */}
      <section className="rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-900">Business details</h2>
        <p className="mt-1 text-sm text-slate-500">
          These appear on your invoices. Your VAT number is validated by Stripe against
          VIES — with a valid EU VAT number, invoices are issued under the reverse charge.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {field("Legal name", legalName, setLegalName, { placeholder: "Acme Crewing OÜ" })}
          {field("Registration code", regCode, setRegCode)}
          {field("VAT number", vatNumber, setVatNumber, { hint: "Validated by Stripe / VIES" })}
          {field("Billing e-mail", billingEmail, setBillingEmail, {
            placeholder: "billing@example.com",
          })}
          {field("Address", line1, setLine1, { wide: true })}
          {field("Address line 2", line2, setLine2, { wide: true })}
          {field("City", city, setCity)}
          {field("Postal code", postal, setPostal)}
          {/* Country picker — options come from the SAME whitelist the API validates
              against (@/lib/billing-countries), so a rejected country can never be
              chosen. Label/container markup mirrors the field() helper above. */}
          <label>
            <span className="block text-sm font-medium text-slate-700">Country</span>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="">Select country…</option>
              {supportedCountryOptions().map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
              {country && !COUNTRY_WHITELIST.has(country) ? (
                <option value={country}>{country}</option>
              ) : null}
            </select>
          </label>
        </div>

        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={tosChecked}
            disabled={Boolean(tosAcceptedAt)}
            onChange={(e) => setTosChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I accept the{" "}
            <Link href="/terms" className="underline" target="_blank">
              terms of service
            </Link>{" "}
            ({tosVersion}).
            {tosAcceptedAt ? (
              <span className="text-slate-500"> Accepted {fmtDate(tosAcceptedAt)}.</span>
            ) : null}
          </span>
        </label>

        <div className="mt-4">
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* ---- Usage history --------------------------------------------------- */}
      {usage.length > 0 ? (
        <section className="rounded-lg border border-slate-300 bg-white p-4">
          <h2 className="text-lg font-semibold text-slate-900">Recent months</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-1">Month</th>
                <th className="py-1">Billable seafarers</th>
                <th className="py-1">Reported to Stripe</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((row) => {
                // R3-7 (D-7): a closed month is a first-class ledger state; showing only
                // pushedToStripeAt rendered every closed month as "—". reportedCell is a
                // pure helper (R3-FR1-1) so it is unit-tested directly, not via this
                // client component.
                const cell = reportedCell(row, fmtDate);
                return (
                  <tr key={row.id} className="border-t border-slate-200">
                    <td className="py-1.5 text-slate-900">{row.period}</td>
                    <td className="py-1.5 text-slate-900">{row.quantity}</td>
                    <td className="py-1.5 text-slate-600">
                      <span>{cell.text}</span>
                      {cell.subtext ? (
                        <span className="block text-xs text-slate-400">{cell.subtext}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
