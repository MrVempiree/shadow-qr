import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeQR,
  chooseVersion,
  getFormatBits,
  getVersionBits,
  gfMul,
  gfDiv,
  gfExp,
  gfLog,
  rsComputeEC,
  totalDataCodewords,
} from "../app.js";

test("matrix size matches version (17 + 4v)", () => {
  const qr = encodeQR("HELLO", "M");
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(qr.modules.length, 21);
  for (const row of qr.modules) assert.equal(row.length, 21);
});

test("longer input auto-selects a larger version", () => {
  const qr = encodeQR("A".repeat(50), "M");
  // Byte capacity: v3-M holds 42 bytes, v4-M holds 62.
  assert.equal(qr.version, 4);
  assert.equal(qr.size, 33);
});

test("chooseVersion respects byte-capacity boundaries", () => {
  assert.equal(chooseVersion(14, "M"), 1); // v1-M byte capacity is 14
  assert.equal(chooseVersion(15, "M"), 2);
  assert.equal(chooseVersion(271, "L"), 10); // v10-L byte capacity
  assert.equal(chooseVersion(119, "H"), 10); // v10-H byte capacity
});

test("finder patterns are present at all three corners", () => {
  const { modules, size } = encodeQR("finder check", "Q");
  const checkFinder = (ox, oy) => {
    assert.equal(modules[oy][ox], 1, "corner dark");
    assert.equal(modules[oy][ox + 6], 1, "top edge dark");
    assert.equal(modules[oy + 6][ox], 1, "side edge dark");
    assert.equal(modules[oy + 1][ox + 1], 0, "inner ring light");
    assert.equal(modules[oy + 3][ox + 3], 1, "centre dark");
  };
  checkFinder(0, 0); // top-left
  checkFinder(size - 7, 0); // top-right
  checkFinder(0, size - 7); // bottom-left
});

test("timing patterns alternate along row/column 6", () => {
  const { modules } = encodeQR("timing", "L");
  for (let i = 8; i < 13; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0);
  }
});

test("dark module is always set", () => {
  const { modules, size } = encodeQR("dark module", "H");
  assert.equal(modules[size - 8][8], 1);
});

test("format bits match the published table for mask 0", () => {
  assert.equal(getFormatBits("L", 0), 0x77c4);
  assert.equal(getFormatBits("M", 0), 0x5412);
  assert.equal(getFormatBits("Q", 0), 0x355f);
  assert.equal(getFormatBits("H", 0), 0x1689);
});

test("format bits embedded in the matrix match getFormatBits", () => {
  const { modules, ecLevel, mask } = encodeQR("format check", "Q");
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= modules[i][8] << i;
  bits |= modules[7][8] << 6;
  bits |= modules[8][8] << 7;
  bits |= modules[8][7] << 8;
  for (let i = 9; i < 15; i++) bits |= modules[8][14 - i] << i;
  assert.equal(bits, getFormatBits(ecLevel, mask));
});

test("version bits for version 7 match the published value", () => {
  assert.equal(getVersionBits(7), 0x07c94);
});

test("oversized input throws a capacity error", () => {
  assert.throws(() => encodeQR("x".repeat(272), "L"), /too large/i);
  assert.throws(() => encodeQR("x".repeat(120), "H"), /too large/i);
  assert.throws(() => chooseVersion(500, "M"), RangeError);
});

test("unknown EC level is rejected", () => {
  assert.throws(() => encodeQR("nope", "Z"), RangeError);
});

test("GF(256): exp/log are inverses and multiply behaves", () => {
  for (const v of [1, 2, 3, 29, 87, 128, 200, 255]) {
    assert.equal(gfExp[gfLog[v]], v);
  }
  assert.equal(gfMul(0, 55), 0);
  assert.equal(gfMul(1, 55), 55);
  assert.equal(gfMul(2, 128), 29); // 256 mod 0x11D = 0x1D
  assert.equal(gfMul(7, 11), gfMul(11, 7)); // commutative
  assert.equal(gfDiv(gfMul(9, 13), 13), 9);
});

test("Reed–Solomon EC matches a published worked example", () => {
  // Thonky QR tutorial: "HELLO WORLD" at 1-Q (alphanumeric) data codewords.
  const data = [0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec];
  const expected = [0xa8, 0x48, 0x16, 0x52, 0xd9, 0x36, 0x9c, 0x00, 0x2e, 0x0f, 0xb4, 0x7a, 0x10];
  assert.deepEqual(rsComputeEC(data, 13), expected);
});

test("total data codewords agree with the capacity table", () => {
  assert.equal(totalDataCodewords(1, "L"), 19);
  assert.equal(totalDataCodewords(5, "Q"), 62);
  assert.equal(totalDataCodewords(10, "H"), 122);
});

test("encoding is deterministic", () => {
  const a = encodeQR("same input", "M");
  const b = encodeQR("same input", "M");
  assert.deepEqual(a.modules, b.modules);
});

test("unicode input is encoded as UTF-8 bytes", () => {
  // "é" is 2 bytes in UTF-8; 8 of them = 16 bytes > v1-M capacity (14).
  const qr = encodeQR("é".repeat(8), "M");
  assert.equal(qr.version, 2);
});

test("version 7+ codes carry version information areas", () => {
  const qr = encodeQR("v".repeat(150), "L");
  assert.ok(qr.version >= 7);
  // Bottom-left version block should equal getVersionBits in its first bits.
  const vbits = getVersionBits(qr.version);
  for (let i = 0; i < 18; i++) {
    const expected = (vbits >>> i) & 1;
    assert.equal(qr.modules[Math.floor(i / 3)][qr.size - 11 + (i % 3)], expected);
  }
});
