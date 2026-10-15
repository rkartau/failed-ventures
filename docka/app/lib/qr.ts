// Client-safe QR-code generator (no npm dependency, no Node built-ins) so the
// seaman page, the share view and any server component can render a QR for the
// outward public re-verification link WITHOUT adding a package.
//
// This is a faithful, self-contained port of Nayuki's "QR Code generator library"
// (MIT-licensed, https://www.nayuki.io/page/qr-code-generator-library), trimmed to
// the byte-mode path this app needs and given a small `qrPath()` helper that emits
// an SVG-ready path string for inline rendering. Correctness (Reed–Solomon ECC,
// data masking, penalty scoring) is preserved from the reference implementation.
//
// Public API used by the app:
//   qrPath(text, { ecc? }) -> { size, path }  — module count + merged SVG path (1u modules)
//   qrSvg(text, { ecc?, margin?, dark?, light? }) -> string  — a full <svg> string.

// ---- Error-correction level -------------------------------------------
export type Ecc = "L" | "M" | "Q" | "H";

const ECC_ORDINAL: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
// Format-info bit pattern per ECC level (index by ordinal).
const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ---- QrSegment ---------------------------------------------------------

const MODE_BYTE_BITS = 4; // mode indicator for byte mode = 0b0100

class QrSegment {
  constructor(
    readonly numChars: number,
    readonly bitData: number[]
  ) {}

  // UTF-8 encode `text` into one byte-mode segment.
  static makeBytes(text: string): QrSegment {
    const bytes = utf8Bytes(text);
    const bits: number[] = [];
    for (const b of bytes) appendBits(b, 8, bits);
    return new QrSegment(bytes.length, bits);
  }

  // Character-count field bit width for byte mode at a given version.
  static countBits(version: number): number {
    if (version <= 9) return 8;
    return 16;
  }
}

// ---- QrCode ------------------------------------------------------------

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// Number of error-correction codewords, per (ecc ordinal, version 1..40).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  // Version: 1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// Number of error-correction blocks, per (ecc ordinal, version 1..40).
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

export class QrCode {
  readonly size: number;
  private readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  static encodeText(text: string, ecc: Ecc = "M"): QrCode {
    const seg = QrSegment.makeBytes(text);
    return QrCode.encodeSegment(seg, ecc);
  }

  private static encodeSegment(seg: QrSegment, ecl: Ecc): QrCode {
    // Choose the smallest version that fits, boosting ECC where free.
    let version = MIN_VERSION;
    let dataUsedBits = 0;
    for (; ; version++) {
      if (version > MAX_VERSION) throw new Error("Data too long for a QR code");
      const dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
      const usedBits = MODE_BYTE_BITS + QrSegment.countBits(version) + seg.bitData.length;
      if (usedBits <= dataCapacityBits) {
        dataUsedBits = usedBits;
        break;
      }
    }
    // Boost ECC level (free) if the data still fits at the chosen version.
    let ecc = ecl;
    for (const cand of ["M", "Q", "H"] as Ecc[]) {
      if (ECC_ORDINAL[cand] > ECC_ORDINAL[ecc] && dataUsedBits <= getNumDataCodewords(version, cand) * 8) {
        ecc = cand;
      }
    }

    // Assemble the bit stream: mode + char count + data.
    const bb: number[] = [];
    appendBits(0b0100, MODE_BYTE_BITS, bb); // byte mode
    appendBits(seg.numChars, QrSegment.countBits(version), bb);
    for (const b of seg.bitData) bb.push(b);

    const dataCapacityBits = getNumDataCodewords(version, ecc) * 8;
    // Terminator + bit/byte padding.
    appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
    appendBits(0, (8 - (bb.length % 8)) % 8, bb);
    for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      appendBits(padByte, 8, bb);
    }

    // Pack bits into codeword bytes.
    const dataCodewords: number[] = new Array(bb.length / 8).fill(0);
    for (let i = 0; i < bb.length; i++) {
      dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7));
    }

    return new QrCode(version, ecc, dataCodewords);
  }

  private constructor(version: number, ecc: Ecc, dataCodewords: number[]) {
    if (version < MIN_VERSION || version > MAX_VERSION) throw new Error("Version out of range");
    this.size = version * 4 + 17;
    const size = this.size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

    this.drawFunctionPatterns(version);
    const allCodewords = this.addEccAndInterleave(version, ecc, dataCodewords);
    this.drawCodewords(allCodewords);

    // Pick the mask (0..7) with the lowest penalty.
    let minPenalty = Infinity;
    let bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(ecc, mask);
      const penalty = this.getPenaltyScore();
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = mask;
      }
      this.applyMask(mask); // undo
    }
    this.applyMask(bestMask);
    this.drawFormatBits(ecc, bestMask);
  }

  getModule(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
  }

  // ---- Function-pattern drawing ----------------------------------------

  private drawFunctionPatterns(version: number): void {
    const size = this.size;
    // Timing patterns.
    for (let i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // Finder patterns (with separators).
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    // Alignment patterns.
    const alignPositions = getAlignmentPatternPositions(version);
    const numAlign = alignPositions.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        // Skip the three finder-pattern corners.
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === numAlign - 1) ||
          (i === numAlign - 1 && j === 0)
        )
          continue;
        this.drawAlignmentPattern(alignPositions[i], alignPositions[j]);
      }
    }

    // Reserve format + version info (drawn with dummy values now, real later).
    this.drawFormatBits("M", 0);
    this.drawVersion(version);
  }

  private drawFinderPattern(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunctionModule(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFormatBits(ecc: Ecc, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // First copy.
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    // Second copy.
    const size = this.size;
    for (let i = 0; i < 8; i++) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, size - 8, true); // always-dark module
  }

  private drawVersion(version: number): void {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    const size = this.size;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  // ---- ECC + interleaving ----------------------------------------------

  private addEccAndInterleave(version: number, ecc: Ecc, data: number[]): number[] {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ECC_ORDINAL[ecc]][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ECC_ORDINAL[ecc]][version];
    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks: number[][] = [];
    const rsDiv = reedSolomonComputeDivisor(blockEccLen);
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.slice(k, k + datLen);
      k += datLen;
      const eccBytes = reedSolomonComputeRemainder(dat, rsDiv);
      const block = dat.slice();
      if (i < numShortBlocks) block.push(0); // pad to align columns
      block.push(...eccBytes);
      blocks.push(block);
    }

    // Interleave the blocks.
    const result: number[] = [];
    const maxLen = shortBlockLen + 1;
    for (let i = 0; i < maxLen; i++) {
      for (let j = 0; j < blocks.length; j++) {
        // Skip the padding column of short blocks.
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
          result.push(blocks[j][i]);
        }
      }
    }
    return result;
  }

  private drawCodewords(data: number[]): void {
    const size = this.size;
    let i = 0; // bit index into data
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    const size = this.size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  private getPenaltyScore(): number {
    const size = this.size;
    let result = 0;
    const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

    // Adjacent modules in rows / columns with same colour.
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = new Array<number>(7).fill(0);
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = new Array<number>(7).fill(0);
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }

    // 2x2 blocks of the same colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x];
        if (
          c === this.modules[y][x + 1] &&
          c === this.modules[y + 1][x] &&
          c === this.modules[y + 1][x + 1]
        )
          result += PENALTY_N2;
      }
    }

    // Balance of dark/light.
    let dark = 0;
    for (const row of this.modules) for (const v of row) if (v) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  private finderPenaltyCountPatterns(runHistory: number[]): number {
    const n = runHistory[1];
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  }

  private finderPenaltyTerminateAndCount(currentRunColor: boolean, currentRunLength: number, runHistory: number[]): number {
    let runLength = currentRunLength;
    if (currentRunColor) {
      this.finderPenaltyAddHistory(runLength, runHistory);
      runLength = 0;
    }
    runLength += this.size;
    this.finderPenaltyAddHistory(runLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
    if (runHistory[0] === 0) currentRunLength += this.size; // add light border to first run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

// ---- Field helpers -----------------------------------------------------

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(version: number, ecc: Ecc): number {
  const o = ECC_ORDINAL[ecc];
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[o][version] * NUM_ERROR_CORRECTION_BLOCKS[o][version]
  );
}

function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// Reed–Solomon over GF(2^8) with the QR primitive polynomial (0x11D).
function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < result.length; i++) result[i] ^= reedSolomonMultiply(divisor[i], factor);
  }
  return result;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// ---- Bit / byte utilities ---------------------------------------------

function appendBits(val: number, len: number, out: number[]): void {
  for (let i = len - 1; i >= 0; i--) out.push((val >>> i) & 1);
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return out;
}

// ---- Rendering helpers -------------------------------------------------

/**
 * Build the dark-module matrix and an SVG path string (in 1-unit module
 * coordinates, no margin) for `text`. Consecutive dark modules in a row are
 * merged into one horizontal run to keep the path compact.
 */
export function qrPath(text: string, opts?: { ecc?: Ecc }): { size: number; path: string } {
  const qr = QrCode.encodeText(text, opts?.ecc ?? "M");
  const size = qr.size;
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.getModule(x, y)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && qr.getModule(x + run, y)) run++;
      parts.push(`M${x} ${y}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return { size, path: parts.join("") };
}

/**
 * A complete, self-contained <svg> string for `text`. `margin` is the quiet zone
 * in modules (default 4, per the QR spec). Colours default to black-on-white but
 * can be overridden (e.g. "currentColor").
 */
export function qrSvg(
  text: string,
  opts?: { ecc?: Ecc; margin?: number; dark?: string; light?: string }
): string {
  const { size, path } = qrPath(text, { ecc: opts?.ecc });
  const margin = opts?.margin ?? 4;
  const dim = size + margin * 2;
  const dark = opts?.dark ?? "#0f172a";
  const light = opts?.light ?? "#ffffff";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path transform="translate(${margin} ${margin})" d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
