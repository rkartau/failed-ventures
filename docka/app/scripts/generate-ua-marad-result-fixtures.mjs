// Generates the two UA-MARAD result-PDF fixtures under
// tests/fixtures/registry/ua-marad/ (pdf-verify plan RUNG v2 item A).
//
// The real captures (2026-08-24: result_en.pdf CoC hit, endorse_1.pdf
// endorsement hit) contain the holder's full name and date of birth — PII
// that must never be committed. These fixtures are SYNTHESIZED instead:
// the same one-page FlateDecode structure, the same text-showing-operator
// shape (every string UTF-16BE, exactly like the portal generator's
// Unicode-CID composite font — `04 21` = С, `00 32` = "2", `21 16` = №),
// the same printed labels and the same dates/number — with the holder
// fields replaced by obvious specimens.
//
//   result-coc-en.pdf      EN session, CoC:        VALID, expire: Unlimited,
//                                                  №12345/2024 from 25.10.2024
//   result-endorse-uk.pdf  UK session, endorsement: ДІЙСНИЙ, до: 20.10.2029,
//                                                  №12345/2024 від 25.10.2024
//
// Deterministic — rerun any time: node scripts/generate-ua-marad-result-fixtures.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "registry",
  "ua-marad"
);

// A string as the portal generator writes it: UTF-16BE bytes inside a PDF
// literal, with the three literal-delimiters escaped byte-wise.
function utf16Literal(s) {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) throw new Error("BMP only");
    bytes.push((cp >> 8) & 0xff, cp & 0xff);
  }
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\";
    out += String.fromCharCode(b);
  }
  return out + ")";
}

function tj(x, y, s, opts = {}) {
  const rg = opts.green ? "0.141 0.604 0.102" : "0.192 0.192 0.192";
  return `q ${rg} rg  0 Tr BT ${x.toFixed(3)} ${y.toFixed(3)} Td  ${utf16Literal(s)} Tj ET Q`;
}

function contentStream(lines) {
  const ops = [
    " 2 J",
    "0.567 w",
    "BT /F1 10.500 Tf ET",
    "1.000 g",
    "0.000 G",
    ...lines,
  ].join("\n");
  return zlib.deflateSync(Buffer.from(ops, "latin1"));
}

function buildPdf(lines) {
  const stream = contentStream(lines);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.890] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 5 0 R >> >> >>",
    null, // 4: content stream (special-cased below)
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const chunks = [];
  const offsets = [0];
  let pos = 0;
  const push = (buf) => {
    chunks.push(buf);
    pos += buf.length;
  };
  push(Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1"));
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pos);
    if (i === 3) {
      push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"));
      push(stream);
      push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      push(Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, "latin1"));
    }
  }
  const xrefAt = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

// ---- EN session, CoC (mirrors result_en.pdf; holder scrubbed) ------------
const cocEn = buildPdf([
  tj(86.005, 780.846, "THE STATE SERVICE FOR MARITIME, INLAND WATERWAY"),
  tj(147.662, 759.846, "TRANSPORT AND SHIPPING OF UKRAINE"),
  tj(468.529, 700.653, "Document status:"),
  tj(518.845, 685.595, "VALID", { green: true }),
  tj(460.318, 670.595, "expire: Unlimited"),
  tj(374.901, 655.595, "verification date:"),
  tj(465.495, 655.595, " "),
  tj(468.498, 655.595, "24.08.2026 11:10"),
  tj(115.171, 565.541, "CERTIFICATE OF COMPETENCY"),
  tj(300.931, 565.541, " №12345/2024 from 25.10.2024"),
  tj(42.52, 529.58, "Name in english:"),
  tj(42.52, 514.938, "SPECIMEN SEAFARER"),
  tj(42.52, 489.68, "Date of birth:"),
  tj(42.52, 475.038, "01.01.1990"),
  tj(42.52, 449.78, "Citizenship:"),
  tj(42.52, 435.138, "Ukraine"),
  tj(42.52, 409.88, "Date of issue:"),
  tj(42.52, 395.238, "25.10.2024"),
]);

// ---- UK session, endorsement (mirrors endorse_1.pdf; holder scrubbed) ----
const endorseUk = buildPdf([
  tj(61.405, 780.846, "ДЕРЖАВНА СЛУЖБА МОРСЬКОГО І ВНУТРІШНЬОГО ВОДНОГО"),
  tj(128.642, 759.846, "ТРАНСПОРТУ ТА СУДНОПЛАВСТВА УКРАЇНИ"),
  tj(459.426, 700.653, "Статус документу:"),
  tj(496.722, 685.595, "ДІЙСНИЙ", { green: true }),
  tj(479.617, 670.595, "до:"),
  tj(495.703, 670.595, " "),
  tj(498.706, 670.595, "20.10.2029"),
  tj(366.816, 655.537, "Дата верифікації:"),
  tj(465.495, 655.537, " "),
  tj(468.498, 655.537, "24.08.2026 11:10"),
  tj(111.346, 588.956, "ПІДТВЕРДЖЕННЯ ДО ДИПЛОМУ"),
  tj(314.273, 588.956, " №12345/2024 від 25.10.2024"),
  tj(42.52, 552.995, "Ім’я Англійською:"),
  tj(42.52, 538.353, "SPECIMEN SEAFARER"),
  tj(42.52, 513.095, "Дата Народження:"),
  tj(42.52, 498.453, "01.01.1990"),
  tj(42.52, 473.195, "Дата видачі документу:"),
  tj(42.52, 458.553, "25.10.2024"),
  tj(42.52, 433.295, "Дійсний до:"),
  tj(42.52, 418.653, "20.10.2029"),
]);

fs.writeFileSync(path.join(OUT_DIR, "result-coc-en.pdf"), cocEn);
fs.writeFileSync(path.join(OUT_DIR, "result-endorse-uk.pdf"), endorseUk);
console.log(
  `wrote result-coc-en.pdf (${cocEn.length} bytes), result-endorse-uk.pdf (${endorseUk.length} bytes) to ${OUT_DIR}`
);
