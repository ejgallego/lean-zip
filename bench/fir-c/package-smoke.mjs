#!/usr/bin/env node

import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

import { loadLeanZipEmscriptenAdapter } from
  "./lean-zip-emscripten-adapter.mjs";

const input = new TextEncoder().encode(
  "abracadabra abracadabra — lean-zip FIR C/Emscripten package smoke — ".repeat(8),
);
const adapter = await loadLeanZipEmscriptenAdapter(
  new URL("./lean-zip-emscripten.manifest.json", import.meta.url),
);
const result = adapter.compressRaw(input, 6);
assert.ok(result.bytes instanceof Uint8Array);
assert.deepEqual(inflateRawSync(result.bytes), Buffer.from(input));
for (const name of ["encodeMs", "executeMs", "decodeMs", "totalMs"]) {
  assert.ok(Number.isFinite(result.timings[name]) && result.timings[name] >= 0);
}
console.log("FIR C/Emscripten lean-zip package smoke passed");
