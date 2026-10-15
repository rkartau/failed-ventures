// Minimal, dependency-free .xlsx reader — just enough to turn a crew roster
// workbook into a grid of rows, so an agent can import a native Excel file in ONE
// step instead of "Save As CSV" first. An .xlsx is a ZIP of XML parts; we unzip
// with the platform's DecompressionStream (no npm dependency), then read the first
// worksheet + the shared-strings table into a string[][].
//
// Scope is deliberately small (a name/rank roster, a few hundred rows): no styles,
// no dates, no formulas beyond their cached string value, no ZIP64. Anything it
// can't parse throws, and the caller falls back to the "Save As CSV" path — the
// import is never left broken.

// --- ZIP ------------------------------------------------------------------

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const ds = new DecompressionStream("deflate-raw");
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const stream = new Blob([ab]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function readCentralDirectory(view: DataView): ZipEntry[] {
  const len = view.byteLength;
  // EOCD is at the end (22 bytes + optional comment); scan back for its signature.
  let eocd = -1;
  for (let i = len - 22; i >= 0 && i >= len - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP (no EOCD)");
  const total = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < total; i++) {
    if (view.getUint32(ptr, true) !== CDIR_SIG) break;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + ptr + 46, nameLen);
    // ZIP names should use "/", but some writers emit Windows "\" separators.
    // Normalise so downstream path matching ("xl/worksheets/sheet1.xml") works.
    const name = new TextDecoder().decode(nameBytes).replace(/\\/g, "/");
    entries.push({ name, method, compressedSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf: ArrayBuffer, view: DataView, e: ZipEntry): Promise<string> {
  // Local header: 30 fixed bytes, then filename + extra, then data.
  const nameLen = view.getUint16(e.localOffset + 26, true);
  const extraLen = view.getUint16(e.localOffset + 28, true);
  const dataStart = e.localOffset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buf, dataStart, e.compressedSize);
  const bytes = e.method === 0 ? raw : await inflateRaw(raw);
  return new TextDecoder().decode(bytes);
}

// --- XML ------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

// Shared-strings table: each <si> is one string; concatenate all its <t> runs.
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []) {
    let text = "";
    for (const t of si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []) {
      text += t.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, "");
    }
    out.push(decodeEntities(text));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Worksheet -> grid of trimmed cell strings, indexed by column position.
function parseSheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  for (const rowXml of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const c of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/\br="([A-Z]+\d+)"/)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      const type = c.match(/\bt="([^"]+)"/)?.[1];
      let value = "";
      if (type === "inlineStr") {
        value = (c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
        value = decodeEntities(value);
      } else {
        const v = c.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (v != null) {
          if (type === "s") value = shared[parseInt(decodeEntities(v), 10)] ?? "";
          else value = decodeEntities(v);
        }
      }
      cells[idx] = value.trim();
    }
    // Normalise holes to "".
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    grid.push(cells);
  }
  return grid;
}

/** Parse an .xlsx workbook (as an ArrayBuffer) into a grid of the first sheet. */
export async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const view = new DataView(buf);
  const entries = readCentralDirectory(view);

  const byName = new Map(entries.map((e) => [e.name, e]));
  // Shared strings (optional — a sheet can hold inline strings only).
  const ssEntry = byName.get("xl/sharedStrings.xml");
  const shared = ssEntry ? parseSharedStrings(await readEntry(buf, view, ssEntry)) : [];

  // First worksheet by lowest sheetN.xml.
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sheetEntries.length === 0) throw new Error("No worksheet in workbook");

  const sheetXml = await readEntry(buf, view, sheetEntries[0]);
  return parseSheet(sheetXml, shared);
}
