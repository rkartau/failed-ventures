// Mock registry server (plan §6.2) — one tiny node:http server serving the
// recorded/synthetic fixtures from tests/fixtures/registry/ on localhost with
// per-country path prefixes, so adapters can be exercised end-to-end with ZERO
// live registry traffic. Adapters reach it via the REGISTRY_BASE_* env
// overrides, honored only when REGISTRY_MOCK=1 outside production:
//
//   REGISTRY_BASE_DK=http://127.0.0.1:4123/dk    POST /dk/api/validate
//   REGISTRY_BASE_UK=http://127.0.0.1:4123/uk    GET  /uk/Certificate-Search-Results/
//   REGISTRY_BASE_NO=http://127.0.0.1:4123/no    POST /no/aps-personalcertificate-internal/v3/verifycertificate/bynumberandidentity
//   REGISTRY_BASE_EE=http://127.0.0.1:4123/ee    GET  /ee/<category>/by-access-token/<code>
//   REGISTRY_BASE_FR=http://127.0.0.1:4123/fr    GET (session) + POST /fr/promete/ConsulterTitreOuVisa
//   REGISTRY_BASE_HR=http://127.0.0.1:4123/hr    APEX session round-trip under /hr/ords/ (see below)
//   REGISTRY_BASE_BG=http://127.0.0.1:4123/bg    POST /bg/seaman/validate
//   REGISTRY_BASE_CY=http://127.0.0.1:4123/cy    GET (session) + POST /cy/emarcos/cert_ver/stcw/sea_auth_search_form.php
//   REGISTRY_BASE_UA=http://127.0.0.1:4123/ua    POST /ua/en/validate-certificate/
//   REGISTRY_BASE_UA_MARAD=http://127.0.0.1:4123/ua-marad
//                                                GET (session) + POST /ua-marad/check-document
//   REGISTRY_BASE_AZ=http://127.0.0.1:4123/az    POST /az/seamencheck/check
//
// Known-good lookup keys (everything else takes the country's REAL miss path):
//   DK  code           70012345                   -> dk-valid.json  (else dk-negative-result.json, HTTP 200 in-body miss)
//   UK  documentId     1122334455 + date 1990-01-01 -> uk-valid.html
//       documentId     1122334466 + date 1990-01-01 -> uk-notvalid.html (positive invalid verdict)
//       (else uk-noresults.html — the real "No CoC Record Found" banner)
//   NO  certificateNumber 12345678901 + dateofBirth 1990-01-01 -> 200 no-valid.json
//       certificateNumber 12345678902 + dateofBirth 1990-01-01 -> 200 no-expired.json
//       (else HTTP 404 no-notfound.json — the real problem+json miss)
//   FR  numeroTitre 7654321 + numeroAdm 1234567   -> fr-valid.html
//       numeroTitre 7654329 + numeroAdm 1234567   -> fr-invalid.html (explicit Non valide)
//       (else fr-nomatch.html — the REAL "No result correponds" page)
//       SESSION SHAPE enforced (live drift 2026-08-12): the form GET mints a
//       JSESSIONID cookie; a POST WITHOUT it gets the REAL technical-error
//       page (fr-technical-error.html), exactly like live Promete v1.6.7.
//   CY  sea_id 445566 + cert_no 654321            -> cy-valid.html (SYNTHETIC hit)
//       (else cy-nomatch.html — the REAL "The Certificate was not found" page)
//       SESSION SHAPE enforced: the form GET mints a PHPSESSID cookie; a POST
//       WITHOUT it gets the bare form back (no verdict -> indeterminate).
//   HR  P10_IME IVAN + P10_PREZIME HORVAT + P10_BROJ 12345 -> hr-valid.html
//       P10_IME ORATEST (any rest)                -> hr-ora20999.html (suspicious-activity guard)
//       (else hr-nomatch.html — the REAL "Nema podataka." no_data region)
//       FULL SESSION SHAPE enforced: GET /hr/ords/f?p=300:10:0… 302s into a fresh
//       session (Set-Cookie ORA_WWV_MOCK), the form GET requires the cookie, the
//       wwv_flow.accept POST must replay p_instance + pSalt from the served form
//       (wrong plumbing -> ORA-20999, exactly like live APEX), then 302 -> result.
//   BG  identifier 7523169263 + doc_number 543210 -> bg-valid.json (presence image)
//       doc_number 999111                          -> bg-captcha.html (R10 tripwire drill)
//       (else bg-nomatch.json — the REAL generic failure body, HTTP 200)
//   UA  surname IVANOV + certificate_number 20930001 -> ua-tccs-valid.html
//       surname IVANOV + certificate_number 20930002 -> ua-tccs-expired.html
//       (else ua-tccs-miss.html — the REAL ambiguous "contact us" text)
//   UA-MARAD  qualification_doctype 70 + doc 12345/2024 + issue date 2024-05-07
//       -> ua-marad-valid.html (SYNTHETIC hit: result block with .pdf links)
//       (else ua-marad-miss.html — the REAL "документ не знайдено" page)
//       SESSION SHAPE enforced (live 2026-08-13): the form GET mints PHPSESSID
//       + __cf_bm cookies; a POST WITHOUT PHPSESSID gets the bare form back
//       (no verdict -> indeterminate).
//   AZ  code 123456/24 + birth 1990-01-01       -> az-valid.json
//       code 123457/24 + birth 1990-01-01       -> az-expired.json (row status Expired)
//       (else az-miss.json — the check.js miss shape; non-"competency" type
//       ALWAYS misses: v1 wires competency only)
//   EE  always 404 (keeps the EE fallback offline in mock journeys)
//
// Ops endpoints (test-only):
//   GET  /__log    -> the per-run request log [{method, path, at}]
//   POST /__reset  -> clears the request log
//   GET  /__health -> 200 "ok"
//
// Lifecycle: started/stopped by the test runner (startMockRegistry() /
// stopMockRegistry()), or standalone: `node tests/mock-registry.mjs`.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MOCK_REGISTRY_PORT = 4123;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "registry");
const fixture = (...p) => fs.readFileSync(path.join(FIXTURES, ...p), "utf-8");
// Binary fixtures (the UA-MARAD result PDFs) — a utf-8 read would corrupt them.
const fixtureBytes = (...p) => fs.readFileSync(path.join(FIXTURES, ...p));

export const MOCK_CODES = {
  DK_VALID: "70012345",
  UK_VALID: "1122334455",
  UK_NOTVALID: "1122334466",
  UK_DOB: "1990-01-01",
  NO_VALID: "12345678901",
  NO_EXPIRED: "12345678902",
  NO_DOB: "1990-01-01",
  FR_TITRE: "7654321",
  FR_TITRE_INVALID: "7654329",
  FR_ADM: "1234567",
  HR_FIRST: "IVAN",
  HR_LAST: "HORVAT",
  HR_SERIAL: "12345",
  HR_ORA_FIRST: "ORATEST", // any lookup with this first name -> ORA-20999 page
  BG_EGN: "7523169263", // checksum-valid dummy EGN from the dossier — never a real person's
  BG_DOC: "543210",
  BG_CAPTCHA_DOC: "999111", // -> active-reCAPTCHA tripwire response
  CY_SEA_ID: "445566",
  CY_VALID: "654321",
  UA_SURNAME: "IVANOV",
  UA_VALID: "20930001",
  UA_EXPIRED: "20930002",
  // UA-MARAD state registry (quick-search form): the doc value the mock
  // expects is the PRINTED slash form — the adapter reconstructs it from the
  // dispatcher-normalized digits + the issue year.
  UA_MARAD_DOCTYPE: "70",
  UA_MARAD_DOC: "12345/2024",
  UA_MARAD_ISSUED: "2024-05-07", // -> day "7", month "5", year "2024" (non-padded)
  // Azerbaijan DDLA (JSON POST): codes are the WIRE slash form — the adapter
  // reconstructs "NNNNNN/YY" from the dispatcher-normalized digits.
  AZ_VALID: "123456/24",
  AZ_EXPIRED: "123457/24",
  AZ_DOB: "1990-01-01",
};

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

export function createMockRegistry() {
  const log = [];
  // HR APEX session state: sid -> { salt, subId, submitted: {ime, prezime, broj} | null }
  const hrSessions = new Map();
  let hrNextSid = 71000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_REGISTRY_PORT}`);
    const p = url.pathname;
    if (p !== "/__log" && p !== "/__reset" && p !== "/__health") {
      log.push({ method: req.method, path: p, at: new Date().toISOString() });
    }

    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };

    // ---- ops -----------------------------------------------------------
    if (p === "/__health") return send(200, "ok", "text/plain");
    if (p === "/__log") return send(200, JSON.stringify(log));
    if (p === "/__reset" && req.method === "POST") {
      log.length = 0;
      return send(200, "{}");
    }

    // ---- Denmark: POST /dk/api/validate {"code": "..."} ---------------
    if (p === "/dk/api/validate" && req.method === "POST") {
      let code = "";
      try {
        code = JSON.parse(await readBody(req)).code ?? "";
      } catch {
        /* fall through to the miss */
      }
      return send(
        200,
        code === MOCK_CODES.DK_VALID ? fixture("dk", "dk-valid.json") : fixture("dk", "dk-negative-result.json")
      );
    }

    // ---- UK: GET /uk/Certificate-Search-Results/?documentId=..&date=.. -
    if (p.startsWith("/uk/Certificate-Search-Results") && req.method === "GET") {
      const id = url.searchParams.get("documentId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const html =
        date === MOCK_CODES.UK_DOB && id === MOCK_CODES.UK_VALID
          ? fixture("uk", "uk-valid.html")
          : date === MOCK_CODES.UK_DOB && id === MOCK_CODES.UK_NOTVALID
            ? fixture("uk", "uk-notvalid.html")
            : fixture("uk", "uk-noresults.html");
      return send(200, html, "text/html");
    }

    // ---- Norway: POST /no/.../verifycertificate/bynumberandidentity ----
    if (p === "/no/aps-personalcertificate-internal/v3/verifycertificate/bynumberandidentity" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        /* fall through to the miss */
      }
      const num = body.certificateNumber ?? "";
      const dob = body.dateofBirth ?? ""; // dossier-confirmed lowercase "of"
      if (dob === MOCK_CODES.NO_DOB && num === MOCK_CODES.NO_VALID) {
        return send(200, fixture("no", "no-valid.json"));
      }
      if (dob === MOCK_CODES.NO_DOB && num === MOCK_CODES.NO_EXPIRED) {
        return send(200, fixture("no", "no-expired.json"));
      }
      return send(404, fixture("no", "no-notfound.json"), "application/problem+json");
    }

    // ---- France: GET (session) + POST /fr/promete/ConsulterTitreOuVisa ----
    // Live drift 2026-08-12: Promete is session-stateful — the form GET mints
    // a JSESSIONID; a cookie-less POST answers the REAL technical-error page.
    if (p === "/fr/promete/ConsulterTitreOuVisa" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "JSESSIONID=MOCKFRSESSION; Path=/fr/promete",
      });
      return res.end("<html><body><form id=\"formRechercheTitreOuVisa\"></form></body></html>");
    }
    if (p === "/fr/promete/ConsulterTitreOuVisa" && req.method === "POST") {
      if (!/JSESSIONID=/.test(req.headers.cookie ?? "")) {
        return send(200, fixture("fr", "fr-technical-error.html"), "text/html");
      }
      const f = parseForm(await readBody(req));
      const titre = f.numeroTitre ?? "";
      const adm = f.numeroAdm ?? "";
      const html =
        adm === MOCK_CODES.FR_ADM && titre === MOCK_CODES.FR_TITRE
          ? fixture("fr", "fr-valid.html")
          : adm === MOCK_CODES.FR_ADM && titre === MOCK_CODES.FR_TITRE_INVALID
            ? fixture("fr", "fr-invalid.html")
            : fixture("fr", "fr-nomatch.html");
      return send(200, html, "text/html");
    }

    // ---- Cyprus: GET (session) + POST the deep sea_auth_search_form.php ----
    // Wire confirmed live 2026-08-12: PHP session cookie from the form GET,
    // then a plain sea_id/cert_no/search POST answering inline.
    if (p === "/cy/emarcos/cert_ver/stcw/sea_auth_search_form.php" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "PHPSESSID=MOCKCYSESSION; Path=/cy",
      });
      return res.end(fixture("cy", "cy-form.html"));
    }
    if (p === "/cy/emarcos/cert_ver/stcw/sea_auth_search_form.php" && req.method === "POST") {
      if (!/PHPSESSID=/.test(req.headers.cookie ?? "")) {
        // No session: the bare form again — no verdict on the page.
        return send(200, fixture("cy", "cy-form.html"), "text/html");
      }
      const f = parseForm(await readBody(req));
      const html =
        (f.sea_id ?? "") === MOCK_CODES.CY_SEA_ID && (f.cert_no ?? "") === MOCK_CODES.CY_VALID
          ? fixture("cy", "cy-valid.html")
          : fixture("cy", "cy-nomatch.html"); // REAL "The Certificate was not found"
      return send(200, html, "text/html");
    }

    // ---- Bulgaria: POST /bg/seaman/validate (urlencoded -> JSON) --------
    if (p === "/bg/seaman/validate" && req.method === "POST") {
      const f = parseForm(await readBody(req));
      if ((f.doc_number ?? "") === MOCK_CODES.BG_CAPTCHA_DOC) {
        // R10 tripwire drill: an active challenge instead of the JSON answer.
        return send(200, fixture("bg", "bg-captcha.html"), "text/html");
      }
      if (!/^\d{10}$/.test(f.identifier ?? "")) {
        // express-validator input rejection (dossier: 400 {error}).
        return send(400, fixture("bg", "bg-badrequest.json"));
      }
      const body =
        f.identifier === MOCK_CODES.BG_EGN && (f.doc_number ?? "") === MOCK_CODES.BG_DOC
          ? fixture("bg", "bg-valid.json")
          : fixture("bg", "bg-nomatch.json"); // REAL body: HTTP 200 generic failure
      return send(200, body);
    }

    // ---- UA-TCCS: POST /ua/en/validate-certificate/ (urlencoded -> HTML)
    if (p === "/ua/en/validate-certificate/" && req.method === "POST") {
      const f = parseForm(await readBody(req));
      const surname = (f.surname ?? "").toUpperCase();
      const num = f.certificate_number ?? "";
      const html =
        surname === MOCK_CODES.UA_SURNAME && num === MOCK_CODES.UA_VALID
          ? fixture("ua", "ua-tccs-valid.html")
          : surname === MOCK_CODES.UA_SURNAME && num === MOCK_CODES.UA_EXPIRED
            ? fixture("ua", "ua-tccs-expired.html")
            : fixture("ua", "ua-tccs-miss.html");
      return send(200, html, "text/html");
    }

    // ---- UA-MARAD: GET (session) + POST /ua-marad/check-document --------
    // Live shape 2026-08-13: the form GET mints PHPSESSID (+ Cloudflare
    // __cf_bm); the quick-search POST answers inline. A cookie-less POST gets
    // the bare form back (no verdict — the adapter maps it indeterminate).
    if (p === "/ua-marad/check-document" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": [
          "PHPSESSID=MOCKUAMARADSESSION; Path=/ua-marad; HttpOnly",
          "__cf_bm=MOCKCFBM; Path=/; HttpOnly",
        ],
      });
      return res.end(fixture("ua-marad", "ua-marad-form.html"));
    }
    if (p === "/ua-marad/check-document" && req.method === "POST") {
      if (!/PHPSESSID=/.test(req.headers.cookie ?? "")) {
        return send(200, fixture("ua-marad", "ua-marad-form.html"), "text/html");
      }
      const f = parseForm(await readBody(req));
      const yyyy = MOCK_CODES.UA_MARAD_ISSUED.slice(0, 4);
      const hit =
        (f.qualification_doctype ?? "") === MOCK_CODES.UA_MARAD_DOCTYPE &&
        (f.doc ?? "") === MOCK_CODES.UA_MARAD_DOC &&
        (f.qualification_gmzlb_date_day ?? "") === "7" && // non-padded selects
        (f.qualification_gmzlb_date_month ?? "") === "5" &&
        (f.qualification_gmzlb_date_year ?? "") === yyyy;
      const html = hit
        ? fixture("ua-marad", "ua-marad-valid.html") // SYNTHETIC (.pdf result links)
        : fixture("ua-marad", "ua-marad-miss.html"); // REAL "документ не знайдено"
      return send(200, html, "text/html");
    }
    // Hash-link result PDF (v2-A): the hit page's ephemeral evidence links.
    // Same-session like the live portal — a cookie-less GET is refused, which
    // pins that the adapter rides its PHPSESSID onto the PDF fetch. Serves the
    // ENDORSEMENT-layout fixture (Ukrainian session, "до: 20.10.2029") so the
    // adapter e2e can assert a REAL date landing in cert.validUntil.
    if (p.startsWith("/ua-marad/services/documents/pdf/hash/") && req.method === "GET") {
      if (!/PHPSESSID=/.test(req.headers.cookie ?? "")) {
        return send(403, "no session", "text/plain");
      }
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(fixtureBytes("ua-marad", "result-endorse-uk.pdf"));
    }

    // ---- Croatia: APEX session round-trip under /hr/ords/ ---------------
    // Faithfully mirrors the dossier shape so the adapter's honest replay is
    // exercised end-to-end: fresh-session redirect + cookie, form with hidden
    // plumbing, wwv_flow.accept POST validated against that plumbing (wrong
    // plumbing -> ORA-20999, like live APEX), 302 to the result render.
    if (p === "/hr/ords/f" && req.method === "GET") {
      const pParam = url.searchParams.get("p") ?? "";
      const parts = pParam.split(":"); // app:page:session:...
      const sid = parts[2] ?? "";
      const cookieSid = /ORA_WWV_MOCK=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!sid || sid === "0" || !hrSessions.has(sid)) {
        const newSid = String(hrNextSid++);
        hrSessions.set(newSid, {
          salt: `salt-${newSid}`,
          subId: `sub-${newSid}`,
          submitted: null,
        });
        res.writeHead(302, {
          Location: `/hr/ords/f?p=300:10:${newSid}:::10::`,
          "Set-Cookie": `ORA_WWV_MOCK=${newSid}; Path=/hr`,
        });
        return res.end();
      }
      const sess = hrSessions.get(sid);
      if (cookieSid !== sid) {
        // No/foreign cookie: live APEX bounces into a fresh session.
        const newSid = String(hrNextSid++);
        hrSessions.set(newSid, { salt: `salt-${newSid}`, subId: `sub-${newSid}`, submitted: null });
        res.writeHead(302, {
          Location: `/hr/ords/f?p=300:10:${newSid}:::10::`,
          "Set-Cookie": `ORA_WWV_MOCK=${newSid}; Path=/hr`,
        });
        return res.end();
      }
      if (sess.submitted) {
        // Result render after an accepted submission.
        const { ime, prezime, broj } = sess.submitted;
        sess.submitted = null;
        const html =
          ime === MOCK_CODES.HR_ORA_FIRST
            ? fixture("hr", "hr-ora20999.html")
            : ime === MOCK_CODES.HR_FIRST &&
                prezime === MOCK_CODES.HR_LAST &&
                broj === MOCK_CODES.HR_SERIAL
              ? fixture("hr", "hr-valid.html")
              : fixture("hr", "hr-nomatch.html"); // REAL "Nema podataka."
        return send(200, html, "text/html");
      }
      // The page-10 search form, templated with THIS session's plumbing.
      const form = fixture("hr", "hr-form.html")
        .replaceAll("SID123", sid)
        .replaceAll("SALT456", sess.salt)
        .replaceAll("SUB789", sess.subId)
        .replaceAll("PROT000", `prot-${sid}`);
      return send(200, form, "text/html");
    }
    if (p === "/hr/ords/wwv_flow.accept" && req.method === "POST") {
      const f = parseForm(await readBody(req));
      const sid = f.p_instance ?? "";
      const sess = hrSessions.get(sid);
      const cookieSid = /ORA_WWV_MOCK=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!sess || cookieSid !== sid || f.pSalt !== sess.salt || f.p_flow_id !== "300") {
        // Wrong/missing plumbing — live APEX answers the suspicious-activity page.
        return send(200, fixture("hr", "hr-ora20999.html"), "text/html");
      }
      sess.submitted = {
        ime: (f.P10_IME ?? "").toUpperCase(),
        prezime: (f.P10_PREZIME ?? "").toUpperCase(),
        broj: f.P10_BROJ ?? "",
      };
      res.writeHead(302, { Location: `/hr/ords/f?p=300:10:${sid}:::::` });
      return res.end();
    }

    // ---- Azerbaijan: POST /az/seamencheck/check (JSON -> JSON) ----------
    // Sessionless, matching live (2026-08-24: bare JSON POST answers — no
    // CAPTCHA/cookies/CSRF). Non-competency types miss (v1 wires competency
    // only; the mock pins that the adapter never posts another type).
    if (p === "/az/seamencheck/check" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        /* fall through to the miss */
      }
      const type = body.type ?? "";
      const code = body.code ?? "";
      const birth = body.birth ?? "";
      if (type !== "competency") {
        // DDLA's HTTP status for a NON-competency-type miss is unverified; only
        // the competency code-miss (the other site below) is confirmed 404
        // (2026-09-08). Leave this at 200 rather than assert unobserved behavior.
        return send(200, fixture("az", "az-miss.json"));
      }
      if (birth === MOCK_CODES.AZ_DOB && code === MOCK_CODES.AZ_VALID) {
        return send(200, fixture("az", "az-valid.json"));
      }
      if (birth === MOCK_CODES.AZ_DOB && code === MOCK_CODES.AZ_EXPIRED) {
        return send(200, fixture("az", "az-expired.json"));
      }
      // Confirmed live 2026-09-08: a competency code-miss is HTTP 404 +
      // {"status":"error","message":"Information not found."} (the health probe
      // 000000/00 and every unknown-code lookup land here).
      return send(404, fixture("az", "az-miss.json"));
    }

    // ---- Estonia: every code misses (offline EE fallback) --------------
    if (p.startsWith("/ee/")) {
      return send(404, "{}");
    }

    return send(404, JSON.stringify({ error: "unknown mock route", path: p }));
  });

  return {
    server,
    log,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(MOCK_REGISTRY_PORT, "127.0.0.1", () => resolve(server));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Convenience env block for spawning `next dev` (or the in-process adapters)
// against this mock.
export function mockEnv() {
  const base = `http://127.0.0.1:${MOCK_REGISTRY_PORT}`;
  return {
    REGISTRY_MOCK: "1",
    REGISTRY_BASE_DK: `${base}/dk`,
    REGISTRY_BASE_UK: `${base}/uk`,
    REGISTRY_BASE_NO: `${base}/no`,
    REGISTRY_BASE_EE: `${base}/ee`,
    REGISTRY_BASE_FR: `${base}/fr`,
    REGISTRY_BASE_HR: `${base}/hr`,
    REGISTRY_BASE_BG: `${base}/bg`,
    REGISTRY_BASE_CY: `${base}/cy`,
    REGISTRY_BASE_UA: `${base}/ua`,
    REGISTRY_BASE_UA_MARAD: `${base}/ua-marad`,
    REGISTRY_BASE_AZ: `${base}/az`,
  };
}

// Standalone: `node tests/mock-registry.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const m = createMockRegistry();
  m.start().then(() => {
    console.log(`[mock-registry] listening on http://127.0.0.1:${MOCK_REGISTRY_PORT}`);
  });
}
