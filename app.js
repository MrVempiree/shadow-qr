// shadow-qr — QR encoder (byte mode, versions 1–10) + decoder UI.
// Pure logic is exported for tests; UI code is guarded so this file
// can be imported in Node without a DOM.

/* ------------------------------------------------------------------ */
/* GF(256) arithmetic — primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D) */
/* ------------------------------------------------------------------ */

export const gfExp = new Array(512);
export const gfLog = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
}

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}

export function gfDiv(a, b) {
  if (b === 0) throw new RangeError("GF division by zero");
  if (a === 0) return 0;
  return gfExp[gfLog[a] - gfLog[b] + 255];
}

/* ------------------------- Reed–Solomon --------------------------- */

export function rsGeneratorPoly(degree) {
  // Product of (x - alpha^i) for i = 0..degree-1.
  // Coefficients highest-degree first, leading coefficient 1.
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                      // multiply by x
      next[j + 1] ^= gfMul(poly[j], gfExp[i]); // multiply by alpha^i
    }
    poly = next;
  }
  return poly;
}

export function rsComputeEC(data, ecLength) {
  // Remainder of data * x^ecLength divided by the generator polynomial.
  const gen = rsGeneratorPoly(ecLength);
  const work = [...data, ...new Array(ecLength).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        work[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return work.slice(data.length);
}

/* --------------------------- Capacity table ------------------------ */
/* Per version (1–10) and EC level: [ecCodewordsPerBlock, groups]     */
/* where each group is [blockCount, dataCodewordsPerBlock].          */

export const EC_TABLE = {
  1:  { L: [7,  [[1, 19]]],            M: [10, [[1, 16]]],            Q: [13, [[1, 13]]],            H: [17, [[1, 9]]] },
  2:  { L: [10, [[1, 34]]],            M: [16, [[1, 28]]],            Q: [22, [[1, 22]]],            H: [28, [[1, 16]]] },
  3:  { L: [15, [[1, 55]]],            M: [26, [[1, 44]]],            Q: [18, [[2, 17]]],            H: [22, [[2, 13]]] },
  4:  { L: [20, [[1, 80]]],            M: [18, [[2, 32]]],            Q: [26, [[2, 24]]],            H: [16, [[4, 9]]] },
  5:  { L: [26, [[1, 108]]],           M: [24, [[2, 43]]],            Q: [18, [[2, 15], [2, 16]]],   H: [22, [[2, 11], [2, 12]]] },
  6:  { L: [18, [[2, 68]]],            M: [16, [[4, 27]]],            Q: [24, [[4, 19]]],            H: [28, [[4, 15]]] },
  7:  { L: [20, [[2, 78]]],            M: [18, [[4, 31]]],            Q: [18, [[2, 14], [4, 15]]],   H: [26, [[4, 13], [1, 14]]] },
  8:  { L: [24, [[2, 97]]],            M: [22, [[2, 38], [2, 39]]],   Q: [22, [[4, 18], [2, 19]]],   H: [26, [[4, 14], [2, 15]]] },
  9:  { L: [30, [[2, 116]]],           M: [22, [[3, 36], [2, 37]]],   Q: [20, [[4, 16], [4, 17]]],   H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]],   M: [26, [[4, 43], [1, 44]]],   Q: [24, [[6, 19], [2, 20]]],   H: [28, [[6, 15], [2, 16]]] },
};

const ALIGNMENT_CENTERS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };
const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

export function totalDataCodewords(version, ecLevel) {
  const [, groups] = EC_TABLE[version][ecLevel];
  return groups.reduce((sum, [count, dcw]) => sum + count * dcw, 0);
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16; // byte mode
}

/** Smallest version (1–10) that fits `byteLength` bytes at `ecLevel`. */
export function chooseVersion(byteLength, ecLevel = "M") {
  for (let v = 1; v <= 10; v++) {
    const capacityBits = totalDataCodewords(v, ecLevel) * 8;
    if (4 + charCountBits(v) + byteLength * 8 <= capacityBits) return v;
  }
  throw new RangeError(
    `Input too large: ${byteLength} bytes exceeds version 10 capacity at EC level ${ecLevel}`
  );
}

/* --------------------------- Format / version info ----------------- */

export function getFormatBits(ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function getVersionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/* ------------------------------ Encoding --------------------------- */

function buildDataCodewords(bytes, version, ecLevel) {
  const totalCw = totalDataCodewords(version, ecLevel);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  const capacityBits = totalCw * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let cw = 0;
    for (let j = 0; j < 8; j++) cw = (cw << 1) | bits[i + j];
    codewords.push(cw);
  }
  for (let pad = 0xec; codewords.length < totalCw; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

function interleaveWithEC(dataCodewords, version, ecLevel) {
  const [ecPerBlock, groups] = EC_TABLE[version][ecLevel];
  const blocks = [];
  let offset = 0;
  for (const [count, dcw] of groups) {
    for (let i = 0; i < count; i++) {
      const data = dataCodewords.slice(offset, offset + dcw);
      offset += dcw;
      blocks.push({ data, ec: rsComputeEC(data, ecPerBlock) });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) result.push(b.ec[i]);
  }
  return result;
}

const MASK_CONDITIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export const DEFAULT_MASK = 0;

/**
 * Encode text as a QR module matrix.
 * Returns { version, size, ecLevel, mask, modules } where modules[y][x]
 * is 1 for a dark module and 0 for a light module (no quiet zone).
 */
export function encodeQR(text, ecLevel = "M", mask = DEFAULT_MASK) {
  if (!EC_FORMAT_BITS.hasOwnProperty(ecLevel)) {
    throw new RangeError(`Unknown EC level: ${ecLevel}`);
  }
  const bytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(bytes.length, ecLevel);
  const size = 17 + 4 * version;

  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      modules[y][x] = dark ? 1 : 0;
      isFunction[y][x] = true;
    }
  };

  // Finder patterns + separators
  for (const [cx, cy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const dark =
          (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
          (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        setFn(cx + dx, cy + dy, dark);
      }
    }
  }

  // Timing patterns
  for (let i = 0; i < size; i++) {
    if (!isFunction[6][i]) setFn(i, 6, i % 2 === 0);
    if (!isFunction[i][6]) setFn(6, i, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version];
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) === 2 || (dx === 0 && dy === 0);
          setFn(cx + dx, cy + dy, dark);
        }
      }
    }
  }

  // Reserve format information areas (filled after masking)
  for (let i = 0; i <= 5; i++) setFn(8, i, false);
  setFn(8, 7, false); setFn(8, 8, false); setFn(7, 8, false);
  for (let i = 0; i <= 5; i++) setFn(i, 8, false);
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, false);
  for (let i = 0; i < 7; i++) setFn(8, size - 1 - i, false);
  setFn(8, size - 8, true); // dark module

  // Reserve version information areas (version >= 7)
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      setFn(size - 11 + (i % 3), Math.floor(i / 3), false);
      setFn(Math.floor(i / 3), size - 11 + (i % 3), false);
    }
  }

  // Data bits
  const dataCw = buildDataCodewords(bytes, version, ecLevel);
  const allCw = interleaveWithEC(dataCw, version, ecLevel);
  const bits = [];
  for (const cw of allCw) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bits.push(0);

  // Place data in zig-zag, applying the mask to data modules only
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          let bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
          if (MASK_CONDITIONS[mask](y, x)) bit ^= 1;
          modules[y][x] = bit;
        }
      }
    }
  }

  // Format information
  const fmt = getFormatBits(ecLevel, mask);
  const fmtBit = (i) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFn(8, i, fmtBit(i));
  setFn(8, 7, fmtBit(6));
  setFn(8, 8, fmtBit(7));
  setFn(7, 8, fmtBit(8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, fmtBit(i));
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, fmtBit(i));
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, fmtBit(i));
  setFn(8, size - 8, true); // dark module

  // Version information
  if (version >= 7) {
    const vbits = getVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) === 1;
      setFn(size - 11 + (i % 3), Math.floor(i / 3), dark);
      setFn(Math.floor(i / 3), size - 11 + (i % 3), dark);
    }
  }

  return { version, size, ecLevel, mask, modules };
}

/* ------------------------------------------------------------------ */
/* UI (browser only)                                                  */
/* ------------------------------------------------------------------ */

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const textInput = $("qr-text");
  const sizeInput = $("qr-size");
  const ecInput = $("qr-ec");
  const fgInput = $("qr-fg");
  const bgInput = $("qr-bg");
  const canvas = $("qr-canvas");
  const genError = $("gen-error");
  const genMeta = $("gen-meta");
  const downloadBtn = $("download-btn");

  function renderQR() {
    const text = textInput.value;
    genError.textContent = "";
    if (!text) {
      genMeta.textContent = "Type something to generate a code.";
      downloadBtn.disabled = true;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    let qr;
    try {
      qr = encodeQR(text, ecInput.value);
    } catch (err) {
      genError.textContent = err.message;
      downloadBtn.disabled = true;
      return;
    }
    const quiet = 4;
    const modulesWithQuiet = qr.size + quiet * 2;
    const px = Number(sizeInput.value);
    const scale = Math.max(1, Math.floor(px / modulesWithQuiet));
    canvas.width = modulesWithQuiet * scale;
    canvas.height = modulesWithQuiet * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bgInput.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = fgInput.value;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    }
    genMeta.textContent =
      `Version ${qr.version} · ${qr.size}×${qr.size} modules · EC level ${qr.ecLevel}`;
    downloadBtn.disabled = false;
  }

  for (const el of [textInput, sizeInput, ecInput, fgInput, bgInput]) {
    el.addEventListener("input", renderQR);
    el.addEventListener("change", renderQR);
  }

  downloadBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "shadow-qr.png";
    a.click();
  });

  renderQR();

  /* ------------------------------ Decoder ------------------------------ */

  const dropZone = $("drop-zone");
  const fileInput = $("file-input");
  const decodeResult = $("decode-result");
  const decodeError = $("decode-error");
  const decodedText = $("decoded-text");
  const urlWarning = $("url-warning");
  const copyBtn = $("copy-btn");
  const decoderNote = $("decoder-note");

  const detectorSupported = "BarcodeDetector" in window;
  if (!detectorSupported) {
    decoderNote.textContent =
      "Decoding uses the BarcodeDetector API, which needs a Chromium-based browser (Chrome, Edge, Brave…). The generator above works everywhere.";
  }

  function showDecoded(value) {
    decodeError.textContent = "";
    decodedText.value = value;
    decodeResult.hidden = false;
    let isUrl = false;
    try {
      const u = new URL(value);
      isUrl = u.protocol === "http:" || u.protocol === "https:";
      if (isUrl) {
        urlWarning.textContent =
          `⚠ This code contains a URL pointing to "${u.hostname}". QR codes can hide phishing links — check the domain carefully before opening it.`;
      }
    } catch {
      isUrl = false;
    }
    urlWarning.hidden = !isUrl;
  }

  async function decodeFile(file) {
    decodeError.textContent = "";
    decodeResult.hidden = true;
    if (!detectorSupported) {
      decodeError.textContent =
        "BarcodeDetector is not available in this browser, so decoding is unavailable here. Try a Chromium-based browser.";
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const results = await detector.detect(bitmap);
      if (!results.length) {
        decodeError.textContent = "No QR code found in that image. Try a sharper, larger image.";
        return;
      }
      showDecoded(results[0].rawValue);
    } catch (err) {
      decodeError.textContent = `Could not decode that image: ${err.message}`;
    }
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) decodeFile(fileInput.files[0]);
  });

  for (const evt of ["dragenter", "dragover"]) {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragging");
    });
  }
  for (const evt of ["dragleave", "drop"]) {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragging");
    });
  }
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) decodeFile(file);
  });
  dropZone.addEventListener("click", () => fileInput.click());

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(decodedText.value);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      decodedText.select();
      document.execCommand("copy");
    }
  });
}
