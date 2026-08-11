import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  backendById,
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  median,
  mibPerSecond,
  normalizeRunSettings,
} from "../app/protocol.mjs";

test("upper median matches the lean-zip benchmark convention", () => {
  assert.equal(median([9, 1, 4]), 4);
  assert.equal(median([9, 1, 4, 2]), 4);
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

test("throughput and backend settings remain backend-specific", () => {
  assert.equal(mibPerSecond(1024 * 1024, 500), 2);
  assert.equal(backendById("compression-stream").setting(9), "browser default (no level API)");
  assert.equal(backendById("fflate").setting(10), "fflate level 9");
});

test("client-native profile closes over lean-zip's seven wide accelerators", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../../lean-vir-native-externs.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.format, "lean-vir-client-native-externs");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.modules, ["Zip.Native.Wide"]);
  assert.equal(manifest.externs.length, 7);
  assert.deepEqual(manifest.providerSources, ["c/bytearray_wide_ffi.c"]);
});
