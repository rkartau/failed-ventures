"use client";

import { useEffect } from "react";

// Registers the offline-shell service worker (public/sw.js) once, on the client.
// Kept as a tiny client component so the root layout can stay a server component.
// Registration is best-effort: any failure (unsupported browser, blocked SW) is
// swallowed so it can never break the app.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
