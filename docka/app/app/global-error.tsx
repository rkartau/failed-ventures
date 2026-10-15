"use client";

// Last-resort error boundary. `error.tsx` catches page errors but runs INSIDE the
// root layout; if the layout itself throws, only this boundary is left. It must
// therefore render its own <html>/<body>, and it uses inline styles so it stays
// friendly and readable even if the stylesheet never loaded. Localised so a
// non-English seafarer still gets a real message, a retry, and the privacy promise
// instead of the framework's bare "Internal Server Error".

import { useEffect } from "react";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";

function currentLang(): Lang {
  if (typeof document === "undefined") return DEFAULT_LANG;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([^;]+)`));
  const raw = m ? decodeURIComponent(m[1]) : undefined;
  return isLang(raw) ? raw : DEFAULT_LANG;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const lang = currentLang();

  return (
    <html lang={lang}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <div style={{ maxWidth: 480, width: "100%", textAlign: "center" }}>
          <div
            aria-hidden="true"
            style={{
              width: 56,
              height: 56,
              margin: "0 auto",
              borderRadius: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#fef3c7",
              color: "#b45309",
              fontSize: 28,
            }}
          >
            !
          </div>
          <h1 style={{ margin: "20px 0 0", fontSize: 24, fontWeight: 700 }}>
            {t(lang, "err.title")}
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: "#475569" }}>
            {t(lang, "err.body")}
          </p>
          <div
            style={{
              marginTop: 28,
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              data-testid="global-error-retry"
              style={{
                minHeight: 48,
                padding: "0 24px",
                borderRadius: 12,
                border: "none",
                background: "#2563eb",
                color: "#fff",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t(lang, "err.retry")}
            </button>
            <a
              href="/"
              data-testid="global-error-home"
              style={{
                minHeight: 48,
                display: "inline-flex",
                alignItems: "center",
                padding: "0 24px",
                borderRadius: 12,
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#334155",
                fontSize: 16,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {t(lang, "err.home")}
            </a>
          </div>
          <p style={{ margin: "28px auto 0", maxWidth: 360, fontSize: 12, lineHeight: 1.6, color: "#94a3b8" }}>
            {t(lang, "err.privacy")}
          </p>
        </div>
      </body>
    </html>
  );
}
