import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BACKENDS,
  backendById,
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  capabilityForInputSize,
  median,
  mibPerSecond,
  makeBenchmarkInput,
  normalizeRunSettings,
} from "../app/protocol.mjs";

test("upper median matches the lean-zip benchmark convention", () => {
  assert.equal(median([9, 1, 4]), 4);
  assert.equal(median([9, 1, 4, 2]), 4);
});

test("benchmark inputs are exact-size and deterministic", () => {
  for (const kind of ["repeated", "structured", "random", "zeros"]) {
    const left = makeBenchmarkInput(kind, 4097);
    const right = makeBenchmarkInput(kind, 4097);
    assert.equal(left.byteLength, 4097);
    assert.deepEqual(left, right);
  }
  assert.notDeepEqual(makeBenchmarkInput("structured", 1024), makeBenchmarkInput("repeated", 1024));
  assert.throws(() => makeBenchmarkInput("unknown", 10));
});

test("binary base64 round-trip is lossless", () => {
  const input = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  assert.equal(bytesEqual(base64ToBytes(bytesToBase64(input)), input), true);
});

test("run settings enforce the interactive safety bounds", () => {
  assert.deepEqual(normalizeRunSettings({ level: 6, warmups: 1, iterations: 2, samples: 3 }), {
    level: 6,
    warmups: 1,
    iterations: 2,
    samples: 3,
  });
  assert.throws(() => normalizeRunSettings({ level: 11, warmups: 0, iterations: 1, samples: 1 }));
});

test("backend-specific input caps fail closed without disabling other runs", () => {
  const capability = { id: "fir-raw", available: true, maxInputBytes: 1048576 };
  assert.equal(capabilityForInputSize(capability, 1048576), capability);
  assert.deepEqual(capabilityForInputSize(capability, 1048577), {
    ...capability,
    available: false,
    reason: "input exceeds this backend's 1048576-byte demo safety cap",
  });
  assert.equal(
    capabilityForInputSize({ id: "vir", available: true }, 1024).available,
    true,
  );
});

test("throughput and backend settings remain backend-specific", () => {
  assert.equal(mibPerSecond(1024 * 1024, 500), 2);
  assert.equal(backendById("compression-stream").setting(9), "browser default (no level API)");
  assert.equal(backendById("fflate").setting(10), "fflate level 9");
  assert.equal(backendById("vir").setting(6), "lean-zip level 6");
  assert.equal(backendById("fir-native").setting(0), "stored DEFLATE control · Lean level 0");
  assert.equal(backendById("fir-native").setting(6), "stored DEFLATE control · level 0 only");
  assert.equal(backendById("fir-raw").setting(1), "production DEFLATE · Lean level 1");
  assert.equal(backendById("fir-raw").setting(10), "production DEFLATE · Lean level 10");
});

test("production FIR is displayed immediately after VIR", () => {
  assert.deepEqual(BACKENDS.slice(0, 4).map(({ id }) => id), [
    "native", "vir", "fir-raw", "fir-native",
  ]);
});

test("client-native profile closes over lean-zip's seven wide accelerators", async () => {
  const expected = [
    ["ByteArray.pushUInt64LE", "lean_zip_push_u64le", "pushUInt64LE"],
    ["ByteArray.ugetUInt32LE", "lean_zip_uget_u32le", "ugetUInt32LE"],
    ["ByteArray.ugetUInt64LE", "lean_zip_uget_u64le", "ugetUInt64LE"],
    ["UInt64.ctzFast", "lean_zip_ctz64", "UInt64.ctzFast"],
    ["ByteArray.usetUInt64LE", "lean_zip_uset_u64le", "usetUInt64LE"],
    ["ByteArray.usetUInt32LE", "lean_zip_uset_u32le", "usetUInt32LE"],
    ["UInt32.log2Clz", "lean_zip_uint32_log2_clz", "UInt32.log2Clz"],
  ];
  const manifest = JSON.parse(await readFile(
    new URL("../../../lean-vir-native-externs.json", import.meta.url),
    "utf8",
  ));
  const leanSource = await readFile(
    new URL("../../../Zip/Native/Wide.lean", import.meta.url),
    "utf8",
  );
  const providerSource = await readFile(
    new URL("../../../c/bytearray_wide_ffi.c", import.meta.url),
    "utf8",
  );
  assert.equal(manifest.format, "lean-vir-client-native-externs");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.modules, ["Zip.Native.Wide"]);
  assert.deepEqual(manifest.externs, expected.map(([name]) => name));
  assert.deepEqual(manifest.providerSources, ["c/bytearray_wide_ffi.c"]);
  for (const [name, symbol, declaration] of expected) {
    assert.ok(
      leanSource.includes(`@[extern "${symbol}"]\ndef ${declaration}`),
      `${name} must retain its ${symbol} extern declaration`,
    );
    assert.ok(
      providerSource.includes(`${symbol}(`),
      `${name} must have a ${symbol} provider definition`,
    );
  }
});
