#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const build = JSON.parse(await readFile(join(root, "BUILD.json"), "utf8"));
const oracle = JSON.parse(
  await readFile(join(root, build.workload.nativeOracle), "utf8"),
);

assert.equal(build.schemaVersion, 1);
assert.equal(build.kind, "lean-zip/browser-benchmark-source");
assert.equal(build.producerProtocol, "browser-benchmarks/source-package/v1");
assert.deepEqual(build.workload.browserBackends, [
  "vir",
  "fir-native",
  "fir-emscripten",
  "compression-stream",
  "fflate",
]);
assert.equal(oracle.schemaVersion, 1);
assert.equal(oracle.kind, "lean-zip/native-oracle-vectors");

let checked = 0;
for (const vector of oracle.vectors) {
  const input = await readFile(join(root, vector.input.file));
  assert.equal(input.byteLength, vector.input.byteLength);
  for (const expected of vector.expected) {
    const compressed = await readFile(join(root, expected.file));
    assert.equal(compressed.byteLength, expected.byteLength);
    assert.deepEqual(inflateRawSync(compressed), input);
    checked += 1;
  }
}

assert.ok(checked >= 6, "source package must exercise multiple levels and inputs");
console.log(
  `lean-zip source package smoke passed: ${oracle.vectors.length} inputs, ${checked} native outputs`,
);
