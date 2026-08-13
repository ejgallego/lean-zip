import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateRuns,
  backendOrder,
  median,
  readPackageInput,
  validateUtf8Fixture,
  validateNativeSampleReport,
  validatePlan,
} from "./lib.mjs";

test("AB/BA schedule alternates backend order", () => {
  assert.deepEqual(backendOrder(0), ["native", "vir"]);
  assert.deepEqual(backendOrder(1), ["vir", "native"]);
  assert.deepEqual(backendOrder(2), ["native", "vir"]);
});

test("median uses the repository sorted-index convention", () => {
  assert.equal(median([9, 1, 5, 3, 7]), 5);
  assert.equal(median([9, 1, 5, 3]), 5);
});

test("workload timing overrides inherited suite timing", () => {
  const timing = { passes: 2, samples: 5, warmups: 1, iterations: 1 };
  const validated = validatePlan({
    format: "lean-zip-wasm-benchmark-plan",
    version: 1,
    timing,
    suites: [{
      id: "override",
      workloads: [{
        id: "x",
        class: "micro",
        source: { kind: "utf8", value: "x" },
        levels: [1],
        timing: { samples: 7 },
      }],
    }],
  });
  assert.deepEqual(validated.suites[0].workloads[0].timing, { ...timing, samples: 7 });
});

test("native report validator binds timing and output identity", () => {
  const expected = {
    level: 6,
    inputBytes: 81,
    outputBytes: 47,
    outputChecksum: 123,
    warmups: 1,
    iterations: 2,
    samples: 2,
  };
  const report = {
    format: "lean-zip-wasm-native-samples",
    version: 1,
    level: 6,
    inputBytes: 81,
    outputBytes: 47,
    warmups: 1,
    iterations: 2,
    samples: 2,
    warmupChecksum: 123,
    sampleNs: [10, 11],
    sampleChecksums: [246, 246],
  };
  assert.equal(validateNativeSampleReport(report, expected), report);
  assert.throws(
    () => validateNativeSampleReport({ ...report, outputBytes: 48 }, expected),
    /outputBytes mismatch/,
  );
});

test("aggregate keeps raw backend populations separate", () => {
  const aggregate = aggregateRuns([
    { backend: "native", nsPerCall: 100 },
    { backend: "vir", nsPerCall: 900 },
    { backend: "native", nsPerCall: 110 },
    { backend: "vir", nsPerCall: 1000 },
  ], 1024);
  assert.equal(aggregate.native.medianNs, 110);
  assert.equal(aggregate.vir.medianNs, 1000);
  assert.equal(aggregate.virToNativeTimeRatio, 1000 / 110);
});

test("tracked benchmark plan validates", async () => {
  const plan = JSON.parse(await readFile(new URL("./plan.json", import.meta.url), "utf8"));
  const validated = validatePlan(plan);
  assert.deepEqual(validated.suites.map((suite) => suite.id), [
    "smoke", "level-matrix", "canterbury", "prescan-threshold",
  ]);
  assert.deepEqual(validated.suites[1].workloads[0].levels, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("tracked FIR cache-cliff fixture has an exact UTF-8 identity", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/fir-level1-cache-cliff.json", import.meta.url),
    "utf8",
  ));
  const validated = validateUtf8Fixture(fixture);
  assert.equal(validated.bytes.byteLength, 83);
  assert.equal(
    fixture.sha256,
    "7454c48bf467ffb1242de50e40a8a03d6640680d39e2775318561e7f131a8ead",
  );
  assert.throws(
    () => validateUtf8Fixture({ ...fixture, byteLength: fixture.byteLength + 1 }),
    /byteLength mismatch/,
  );
});

test("plan rejects duplicate suite ids", () => {
  const timing = { passes: 2, samples: 5, warmups: 1, iterations: 1 };
  const workload = {
    id: "x",
    class: "micro",
    source: { kind: "utf8", value: "x" },
    levels: [1],
  };
  assert.throws(() => validatePlan({
    format: "lean-zip-wasm-benchmark-plan",
    version: 1,
    timing,
    suites: [
      { id: "same", timing, workloads: [workload] },
      { id: "same", timing, workloads: [workload] },
    ],
  }), /duplicate id/);
});

test("single package input preserves bytes and identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lean-zip-package-input-test-"));
  try {
    const path = join(directory, "application.irpkg");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await writeFile(path, bytes);
    const input = await readPackageInput({ packagePath: path });
    assert.equal(input.kind, "package");
    assert.equal(input.inputPath, path);
    assert.equal(input.members.length, 1);
    assert.deepEqual(input.packageBytes[0], bytes);
    assert.equal(input.inputSha256, input.members[0].sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package input requires exactly one source", async () => {
  await assert.rejects(() => readPackageInput({}), /exactly one/);
  await assert.rejects(
    () => readPackageInput({ packagePath: "a", packageSetPath: "b" }),
    /exactly one/,
  );
});
