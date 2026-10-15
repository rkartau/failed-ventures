// Test 1 — pure unit tests for lib/roster-parse (email header detection + coerceCell +
// isEmailish truth table). No server, no disk; runs on plain node with the @/* hook.
//
// Run: node --import ./tests/_register-alias.mjs tests/roster-parse.test.mjs

import assert from "node:assert/strict";
import { coerceCell, isEmailish, gridToRoster, parseRoster } from "@/lib/roster-parse";

let pass = 0;
const ok = (msg) => { console.log("  ok  -", msg); pass++; };

const ZWSP = String.fromCharCode(0x200b); // U+200B zero-width space
const BOM = String.fromCharCode(0xfeff); // U+FEFF BOM / ZWNBSP

// ---- coerceCell: never throws on odd cell values -------------------------
{
  assert.equal(coerceCell(null), "");
  assert.equal(coerceCell(undefined), "");
  assert.equal(coerceCell(42), "42");
  assert.equal(coerceCell(0), "0");
  assert.equal(coerceCell(true), "true");
  const d = new Date("2026-01-02T03:04:05.000Z");
  assert.equal(coerceCell(d), "2026-01-02T03:04:05.000Z");
  assert.equal(coerceCell(new Date("not-a-date")), "");
  // hyperlink-style object -> prefers .text
  assert.equal(coerceCell({ text: "mailto:a@b.com", hyperlink: "x" }), "mailto:a@b.com");
  assert.equal(coerceCell({ hyperlink: "a@b.com" }), "a@b.com");
  // opaque object -> "" (never "[object Object]")
  assert.equal(coerceCell({ foo: 1 }), "");
  // leading BOM stripped
  assert.equal(coerceCell(BOM + "john@x.com"), "john@x.com");
  // never throws on a getter that throws
  const evil = { get text() { throw new Error("boom"); } };
  assert.doesNotThrow(() => coerceCell(evil));
  ok("coerceCell: number/Date/object/null/BOM/throwing-getter all coerce without throwing");
}

// ---- isEmailish truth table ---------------------------------------------
{
  // valid
  assert.equal(isEmailish("john@example.com"), true);
  assert.equal(isEmailish("  john@example.com  "), true, "trims");
  assert.equal(isEmailish("a.b+c@sub.example.co.uk"), true);
  // CRLF header injection
  assert.equal(isEmailish("a@b.c\r\nBcc: evil@x.com"), false, "reject CRLF");
  assert.equal(isEmailish("a@b.c\nx"), false);
  // ASCII control
  assert.equal(isEmailish("a@b.c\x07"), false, "reject control char");
  // surrounding quotes
  assert.equal(isEmailish('"a@b.com"'), false, "reject leading+trailing quote");
  assert.equal(isEmailish("'a@b.com'"), false, "reject single quotes");
  assert.equal(isEmailish('a@b.com"'), false, "reject trailing quote");
  // > 128 chars
  assert.equal(isEmailish("a".repeat(120) + "@" + "b".repeat(20) + ".com"), false, "reject >128");
  // zero-width U+200B anywhere
  assert.equal(isEmailish("a@b.c" + ZWSP), false, "reject trailing U+200B");
  assert.equal(isEmailish("a" + ZWSP + "@b.com"), false, "reject mid U+200B");
  // BOM U+FEFF mid-string
  assert.equal(isEmailish("a@b" + BOM + ".com"), false, "reject mid U+FEFF");
  // spaces
  assert.equal(isEmailish("a b@c.com"), false, "reject spaces");
  // structural
  assert.equal(isEmailish("nodomaindot@localhost"), false, "reject no dot in domain");
  assert.equal(isEmailish("two@@at.com"), false, "reject two @");
  assert.equal(isEmailish("@b.com"), false, "reject empty local");
  assert.equal(isEmailish("a@.com"), false, "reject leading dot domain");
  assert.equal(isEmailish("a@b."), false, "reject trailing dot domain");
  // non-ASCII domain (MVP IDN policy)
  assert.equal(isEmailish("user@münchen.de"), false, "reject non-ASCII domain");
  assert.equal(isEmailish("user@xn--mnchen-3ya.de"), true, "punycode ASCII domain OK");
  ok("isEmailish: CRLF/control/quotes/>128/U+200B/U+FEFF/spaces/structure/non-ASCII-domain rejected; valid accepted");
}

// ---- header exact-ish email column detection -----------------------------
{
  // "Email" detected + lower-cased
  const g1 = gridToRoster([
    ["Name", "Rank", "Email"],
    ["Maria Silva", "Master", "MARIA@Ship.com"],
  ]);
  assert.equal(g1.length, 1);
  assert.equal(g1[0].email, "maria@ship.com", "Email header detected + lower-cased");

  // "E-mail" and "Contact Email" also detected
  assert.equal(gridToRoster([["Name", "E-mail"], ["A", "a@b.com"]])[0].email, "a@b.com");
  assert.equal(gridToRoster([["Crew Name", "Contact Email"], ["A", "a@b.com"]])[0].email, "a@b.com");

  // loose lookalikes NOT matched (email_opt_in / email_verified / emailed_date)
  for (const h of ["email_opt_in", "email_verified", "emailed_date"]) {
    const g = gridToRoster([["Name", h], ["A", "a@b.com"]]);
    assert.equal(g[0].email, null, `"${h}" is NOT treated as an email column`);
  }
  ok("header: Email/E-mail/Contact Email detected; email_opt_in/email_verified/emailed_date NOT matched");
}

// ---- duplicate email columns -> FIRST index wins -------------------------
{
  const g = gridToRoster([
    ["Name", "Email", "Email"],
    ["A", "first@x.com", "second@x.com"],
  ]);
  assert.equal(g[0].email, "first@x.com", "duplicate email columns -> first index");
  ok("duplicate email columns -> first index deterministically");
}

// ---- invalid email in a valid column -> null, row STILL present ----------
{
  const g = gridToRoster([
    ["Name", "Email"],
    ["Good", "good@x.com"],
    ["Bad", "not an email"],
    ["Blank", ""],
  ]);
  assert.equal(g.length, 3, "all rows imported");
  assert.equal(g[0].email, "good@x.com");
  assert.equal(g[1].email, null, "invalid email -> null, row kept");
  assert.equal(g[2].email, null, "blank email -> null, row kept");
  ok("invalid/blank email -> null, row still imported (never rejects the import)");
}

// ---- R2-1: header-less positional e-mail sniff ---------------------------
// (a) headered grid, e-mail-ish column NOT in EMAIL_HEADERS -> null (security: a
//     next-of-kin/agency address must never become importedEmail).
{
  const kin = gridToRoster([
    ["Name", "Rank", "Next of kin e-mail"],
    ["John Smith", "AB", "mum@x.com"],
  ]);
  assert.equal(kin[0].email, null, "next-of-kin e-mail column is NEVER imported");
  const agency = gridToRoster([
    ["Name", "Rank", "Agency contact"],
    ["A", "AB", "ops@agency.com"],
  ]);
  assert.equal(agency[0].email, null, "agency-contact column is NEVER imported");
  ok("R2-1a: headered grid with no exact EMAIL_HEADERS column -> email null (never a lookalike column)");
}

// (b) header-less single hit -> captured.
{
  const rows = parseRoster("John Smith,AB,john@x.com");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "john@x.com", "header-less single emailish cell -> captured");
  ok("R2-1b: header-less paste with exactly one emailish cell -> captured");
}

// (c) header-less ambiguous (>=2 emailish cells) -> null, never first-wins.
{
  const rows = gridToRoster([["John Smith", "AB", "john@x.com", "kin@x.com"]]);
  assert.equal(rows[0].email, null, "2+ emailish cells -> ambiguous -> null (never first-wins)");
  ok("R2-1c: header-less ambiguous (>=2 emailish cells) -> null");
}

// header-less 2-column paste: the address lands in the RANK position (no email
// mapping there is possible without misreading col1) -> documented limitation.
{
  const rows = parseRoster("John Smith,john@x.com");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, null, "header-less 2-col -> email null (positional col1 = rank)");
  assert.equal(rows[0].rank, "john@x.com", "the address is read as the rank — documented limitation");
  ok("header-less 2-column paste: address read as rank, email null (documented limitation)");
}

// headered exact match still wins over another emailish cell in the row.
{
  const g = gridToRoster([
    ["Name", "Email", "Notes"],
    ["A", "a@b.com", "b@c.com"],
  ]);
  assert.equal(g[0].email, "a@b.com", "headered exact EMAIL_HEADERS column wins over another emailish cell");
  ok("headered exact match wins over a second emailish cell elsewhere in the row");
}

// headered exact match with an INVALID cell -> null (unchanged from today).
{
  const g = gridToRoster([
    ["Name", "Email"],
    ["A", "not an email"],
  ]);
  assert.equal(g[0].email, null, "headered column with an invalid cell -> null");
  ok("headered exact-match column with an invalid cell -> null (unchanged)");
}

// ---- R2-2: surname column support (header-driven, both orders) -----------
{
  assert.equal(
    gridToRoster([["First name", "Surname", "Email"], ["John", "Smith", "j@x.com"]])[0].name,
    "John Smith",
    "First name,Surname,Email -> joined 'John Smith'"
  );
  assert.equal(
    gridToRoster([["Surname", "First name", "Email"], ["Smith", "John", "j@x.com"]])[0].name,
    "John Smith",
    "Surname,First name,Email -> joined by INDEX, not position -> still 'John Smith'"
  );
  assert.equal(
    gridToRoster([["Perekonnanimi", "Eesnimi", "E-mail"], ["Tamm", "Jaan", "j@x.ee"]])[0].name,
    "Jaan Tamm",
    "Estonian Perekonnanimi/Eesnimi headers -> joined 'Jaan Tamm'"
  );
  assert.equal(
    gridToRoster([["Name", "Surname", "Email"], ["John", "Smith", "j@x.com"]])[0].name,
    "John Smith",
    "whole-name column + surname column -> joined (conservative reading, pinned)"
  );
  assert.equal(
    gridToRoster([["Surname", "Rank"], ["Smith", "AB"]])[0].name,
    "Smith",
    "surname-only sheet -> the surname IS the name"
  );
  assert.equal(
    gridToRoster([["First name", "Surname"], ["", "Smith"]])[0].name,
    "Smith",
    "blank first name + surname -> 'Smith'"
  );
  assert.equal(
    gridToRoster([["First name", "Surname"], ["", ""]]).length,
    0,
    "both name parts blank -> row skipped"
  );
  // Header-less paste has NO surname handling (positional col0/col1 only) -
  // documented limitation.
  const headerless = parseRoster("John,Smith,AB");
  assert.equal(headerless[0].name, "John", "header-less paste: no surname join, col0 = name");
  assert.equal(headerless[0].rank, "Smith", "header-less paste: col1 = rank, even when it looks like a surname");
  ok("R2-2: surname column joins in both header orders + Estonian vocab; header-less paste stays positional (documented)");
}

console.log(`\nroster-parse.test.mjs — ${pass} groups passed`);
