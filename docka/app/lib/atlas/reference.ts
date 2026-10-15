// lib/atlas/reference.ts — Lead Atlas reference constants (pure data, no imports).
//
// Client-safe: this module has ZERO imports, so it is equally safe to bundle into
// the browser (view.tsx reads POPULATION for the per-capita index) and to import
// server-side (geo.ts reads ISO2_NUMERIC + MICRO_COORDS to build the mesh join).
//
// PROVENANCE — the three tables below were lifted verbatim from the reviewed Lead
// Atlas artifact (scratchpad/lead-atlas.html, RAW + COORDS arrays), NOT re-derived.
//
//  * POPULATION  — per-country head-count, World Bank / UN 2023 estimates,
//                  retrieved 2026-09-03. This is the ONE bundled data table that
//                  carries a staleness liability: figures drift year over year.
//                  A country ABSENT from this table has perM === null (excluded
//                  from the per-million metric, "—" in the tooltip, ignored by
//                  "densest market"), never a NaN/Infinity divide.
//  * ISO2_NUMERIC — ISO-3166-1 alpha-2 → ISO-3166-1 numeric. Joins a country_iso2
//                  count to a TopoJSON feature id (numeric). Covers the countries
//                  the base has ever carried; a live code outside it becomes an
//                  "unmapped territory" surfaced in the provenance line.
//  * MICRO_COORDS — [lon, lat] for micro-states / dependencies too small to own a
//                  polygon in the 110m mesh; projected to a marker dot by geo.ts.

/** Per-country population (World Bank / UN 2023 estimates, retrieved 2026-09-03). */
export const POPULATION: Record<string, number> = {
  AE: 9440000, AG: 94000, AI: 16000, AO: 36000000, AR: 45800000, AT: 9100000, AU: 26600000,
  AX: 30000, AZ: 10300000, BD: 172000000, BE: 11700000, BG: 6450000, BH: 1570000, BM: 64000,
  BN: 450000, BR: 216000000, BS: 410000, BZ: 410000, CA: 40000000, CG: 6100000, CH: 8800000,
  CI: 28000000, CL: 19600000, CM: 28000000, CN: 1410000000, CO: 52000000, CR: 5200000,
  CU: 11000000, CV: 600000, CW: 152000, CY: 1260000, CZ: 10900000, DE: 84000000, DJ: 1100000,
  DK: 5930000, DZ: 45400000, EC: 18000000, EE: 1370000, EG: 112000000, ES: 48000000,
  FI: 5560000, FK: 3700, FO: 54000, FR: 68000000, GA: 2400000, GB: 67000000, GE: 3730000,
  GG: 64000, GH: 34000000, GI: 32000, GL: 57000, GP: 400000, GR: 10400000, HK: 7500000,
  HN: 10600000, HR: 3850000, HT: 11700000, HU: 9600000, ID: 277000000, IE: 5100000,
  IL: 9700000, IM: 84000, IN: 1428000000, IR: 89000000, IS: 375000, IT: 58900000, JE: 103000,
  JM: 2800000, JO: 11300000, JP: 124000000, KE: 55000000, KH: 17000000, KI: 130000,
  KR: 51700000, KW: 4300000, KY: 69000, KZ: 19600000, LB: 5300000, LI: 40000, LK: 22000000,
  LR: 5400000, LT: 2860000, LU: 660000, LV: 1880000, LY: 6900000, MA: 37800000, MC: 36000,
  ME: 620000, MG: 30000000, MH: 42000, MM: 54000000, MR: 4900000, MS: 4400, MT: 540000,
  MU: 1300000, MV: 520000, MX: 128000000, MY: 34000000, MZ: 33000000, NA: 2600000,
  NG: 224000000, NL: 17800000, NO: 5470000, NZ: 5200000, OM: 4600000, PA: 4450000,
  PE: 34000000, PG: 10300000, PH: 117000000, PK: 240000000, PL: 37700000, PR: 3200000,
  PT: 10400000, QA: 2700000, RE: 870000, RO: 19000000, RS: 6700000, RU: 144000000,
  SA: 36900000, SC: 107000, SD: 48000000, SE: 10500000, SG: 5920000, SI: 2120000, SN: 18000000,
  SX: 44000, SY: 22000000, TG: 9000000, TH: 71800000, TN: 12400000, TR: 85000000, TT: 1530000,
  TW: 23900000, TZ: 67000000, UA: 38000000, US: 335000000, UY: 3400000, VC: 100000,
  VE: 28800000, VG: 31000, VI: 87000, VN: 98900000, WS: 220000, YE: 34000000, ZA: 60400000,
  ZM: 20000000,
};

/** ISO-3166-1 alpha-2 → ISO-3166-1 numeric (the TopoJSON feature id space). */
export const ISO2_NUMERIC: Record<string, number> = {
  AE: 784, AG: 28, AI: 660, AO: 24, AR: 32, AT: 40, AU: 36, AX: 248, AZ: 31, BD: 50, BE: 56,
  BG: 100, BH: 48, BM: 60, BN: 96, BR: 76, BS: 44, BZ: 84, CA: 124, CG: 178, CH: 756, CI: 384,
  CL: 152, CM: 120, CN: 156, CO: 170, CR: 188, CU: 192, CV: 132, CW: 531, CY: 196, CZ: 203,
  DE: 276, DJ: 262, DK: 208, DZ: 12, EC: 218, EE: 233, EG: 818, ES: 724, FI: 246, FK: 238,
  FO: 234, FR: 250, GA: 266, GB: 826, GE: 268, GG: 831, GH: 288, GI: 292, GL: 304, GP: 312,
  GR: 300, HK: 344, HN: 340, HR: 191, HT: 332, HU: 348, ID: 360, IE: 372, IL: 376, IM: 833,
  IN: 356, IR: 364, IS: 352, IT: 380, JE: 832, JM: 388, JO: 400, JP: 392, KE: 404, KH: 116,
  KI: 296, KR: 410, KW: 414, KY: 136, KZ: 398, LB: 422, LI: 438, LK: 144, LR: 430, LT: 440,
  LU: 442, LV: 428, LY: 434, MA: 504, MC: 492, ME: 499, MG: 450, MH: 584, MM: 104, MR: 478,
  MS: 500, MT: 470, MU: 480, MV: 462, MX: 484, MY: 458, MZ: 508, NA: 516, NG: 566, NL: 528,
  NO: 578, NZ: 554, OM: 512, PA: 591, PE: 604, PG: 598, PH: 608, PK: 586, PL: 616, PR: 630,
  PT: 620, QA: 634, RE: 638, RO: 642, RS: 688, RU: 643, SA: 682, SC: 690, SD: 729, SE: 752,
  SG: 702, SI: 705, SN: 686, SX: 534, SY: 760, TG: 768, TH: 764, TN: 788, TR: 792, TT: 780,
  TW: 158, TZ: 834, UA: 804, US: 840, UY: 858, VC: 670, VE: 862, VG: 92, VI: 850, VN: 704,
  WS: 882, YE: 887, ZA: 710, ZM: 894,
};

/** [lon, lat] for micro-states / dependencies absent from the 110m polygon mesh. */
export const MICRO_COORDS: Record<string, [number, number]> = {
  AG: [-61.8, 17.1], AI: [-63.06, 18.22], AX: [19.9, 60.18], BB: [-59.55, 13.18],
  BH: [50.55, 26.06], BM: [-64.75, 32.32], BN: [114.7, 4.5], BS: [-77.4, 25.03],
  BZ: [-88.5, 17.2], CV: [-23.6, 15.12], CW: [-68.99, 12.17], DJ: [42.6, 11.75],
  FO: [-6.91, 62], GG: [-2.58, 49.46], GI: [-5.35, 36.14], GP: [-61.55, 16.25],
  HK: [114.15, 22.35], IM: [-4.55, 54.24], JE: [-2.13, 49.21], KI: [173, 1.87],
  KW: [47.7, 29.3], KY: [-81.25, 19.31], LI: [9.55, 47.16], LU: [6.13, 49.75],
  MC: [7.42, 43.74], MH: [171.2, 7.1], MT: [14.4, 35.9], MU: [57.55, -20.28], MV: [73.5, 3.2],
  PR: [-66.5, 18.2], QA: [51.2, 25.3], RE: [55.53, -21.11], SC: [55.49, -4.68],
  SG: [103.8, 1.35], SX: [-63.05, 18.04], TT: [-61.25, 10.5], VC: [-61.2, 13.16],
  VG: [-64.6, 18.42], VI: [-64.9, 18.34], WS: [-172.1, -13.76],
};
