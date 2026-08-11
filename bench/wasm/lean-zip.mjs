#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import {
  REPORT_FORMAT,
  REPORT_VERSION,
  aggregateRuns,
  backendOrder,
  byteChecksum,
  readPackageInput,
  requirePositiveInteger,
  selectSuite,
  sha256,
  sha256File,
  validateNativeSampleReport,
  validatePlan,
} from "./lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const defaultPlan = join(scriptDir, "plan.json");

const usage = `usage:
  node bench/wasm/lean-zip.mjs demo [options]
  node bench/wasm/lean-zip.mjs bench --json <outside-repo.json> [options]

required backend options:
  --package PATH           one Vir .irpkg artifact
  --package-set PATH       Vir .irpkg-set.json descriptor
                           exactly one package input is required
  --vir-root PATH          Vir checkout/worktree (derives runtime module and Wasm)
  --vir-runtime PATH       override web/src/vir-runtime-node.js
  --wasm PATH              override web/public/vir-upstream.wasm

benchmark inputs:
  --plan PATH              benchmark plan (default: bench/wasm/plan.json)
  --suite ID               suite id (default: smoke)
  --filter ID              select a workload id; repeatable
  --entry NAME             Vir export; inferred when the package has one export
  --native-oracle PATH     default: .lake/build/bin/zip-wasm-oracle
  --native-bench PATH      default: .lake/build/bin/zip-wasm-bench-native
  --passes N               override AB/BA pass count
  --samples N              override samples per backend block
  --warmups N              override warmups per backend block
  --iterations N           override calls per timed sample
  --json PATH              new benchmark report path outside the repository
`;

function parseArgs(argv) {
  const command = argv[0];
  if (!["demo", "bench"].includes(command)) throw new Error(usage);
  const environmentPath = (name) => {
    const value = process.env[name];
    return value === undefined ? null : resolve(value);
  };
  const parsed = {
    command,
    plan: defaultPlan,
    suite: "smoke",
    filters: [],
    entry: null,
    virRoot: environmentPath("LEAN_ZIP_VIR_ROOT"),
    virRuntime: environmentPath("LEAN_ZIP_VIR_RUNTIME"),
    wasm: environmentPath("LEAN_ZIP_VIR_WASM"),
    package: environmentPath("LEAN_ZIP_VIR_PACKAGE"),
    packageSet: environmentPath("LEAN_ZIP_VIR_PACKAGE_SET"),
    nativeOracle: join(repoRoot, ".lake/build/bin/zip-wasm-oracle"),
    nativeBench: join(repoRoot, ".lake/build/bin/zip-wasm-bench-native"),
    json: null,
    overrides: {},
  };
  const requireValue = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") throw new Error(usage);
    if (option === "--filter") parsed.filters.push(requireValue(index++, option));
    else if (option === "--plan") parsed.plan = resolve(requireValue(index++, option));
    else if (option === "--suite") parsed.suite = requireValue(index++, option);
    else if (option === "--entry") parsed.entry = requireValue(index++, option);
    else if (option === "--vir-root") parsed.virRoot = resolve(requireValue(index++, option));
    else if (option === "--vir-runtime") parsed.virRuntime = resolve(requireValue(index++, option));
    else if (option === "--wasm") parsed.wasm = resolve(requireValue(index++, option));
    else if (option === "--package") parsed.package = resolve(requireValue(index++, option));
    else if (option === "--package-set") parsed.packageSet = resolve(requireValue(index++, option));
    else if (option === "--native-oracle") parsed.nativeOracle = resolve(requireValue(index++, option));
    else if (option === "--native-bench") parsed.nativeBench = resolve(requireValue(index++, option));
    else if (option === "--json") parsed.json = resolve(requireValue(index++, option));
    else if (["--passes", "--samples", "--iterations"].includes(option)) {
      parsed.overrides[option.slice(2)] = requirePositiveInteger(requireValue(index++, option), option);
    } else if (option === "--warmups") {
      const value = Number(requireValue(index++, option));
      if (!Number.isInteger(value) || value < 0) throw new Error("--warmups must be non-negative");
      parsed.overrides.warmups = value;
    } else {
      throw new Error(`unknown option: ${option}\n${usage}`);
    }
  }
  if (parsed.virRoot !== null) {
    parsed.virRuntime ??= join(parsed.virRoot, "web/src/vir-runtime-node.js");
    parsed.wasm ??= join(parsed.virRoot, "web/public/vir-upstream.wasm");
  }
  for (const [label, value] of [
    ["--vir-runtime or --vir-root", parsed.virRuntime],
    ["--wasm or --vir-root", parsed.wasm],
  ]) {
    if (value === null) throw new Error(`${label} is required`);
  }
  if ((parsed.package === null) === (parsed.packageSet === null)) {
    throw new Error("exactly one of --package or --package-set is required");
  }
  if (command === "bench" && parsed.json === null) throw new Error("bench requires --json");
  return parsed;
}

function run(path, args, options = {}) {
  const result = spawnSync(path, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${basename(path)} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitIdentity(root) {
  const git = (args) => run("git", args, { cwd: root }).trim();
  const status = git(["status", "--porcelain=v1"]);
  const diff = run("git", ["diff", "--binary", "HEAD"], { cwd: root });
  return {
    root,
    head: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]) || null,
    dirty: status !== "",
    status: status === "" ? [] : status.split("\n"),
    trackedDiffSha256: sha256(Buffer.from(diff)),
  };
}

function memorySnapshot(runtime) {
  const bytes = runtime.exports.memory.buffer.byteLength;
  return { bytes, pages: bytes / 65536 };
}

function inferEntry(runtime, requested) {
  if (requested !== null) {
    if (runtime.findManifestEntry(requested) === null) {
      throw new Error(`Vir package does not export ${requested}`);
    }
    return requested;
  }
  const exports = runtime.interfaceManifest?.exports ?? [];
  if (exports.length !== 1) {
    throw new Error("--entry is required when the Vir package does not have exactly one export");
  }
  return exports[0].entry;
}

async function loadInput(workload) {
  if (workload.source.kind === "utf8") {
    return {
      bytes: new TextEncoder().encode(workload.source.value),
      source: { kind: "utf8", label: workload.id },
    };
  }
  const path = isAbsolute(workload.source.path)
    ? workload.source.path
    : resolve(repoRoot, workload.source.path);
  try {
    return { bytes: new Uint8Array(await readFile(path)), source: { kind: "file", path } };
  } catch (error) {
    if (error?.code === "ENOENT" && workload.source.optional === true) return null;
    throw error;
  }
}

async function nativeReference(nativeOracle, tempDir, caseId, input, level) {
  const inputPath = join(tempDir, `${caseId}.input`);
  const outputPath = join(tempDir, `${caseId}.deflate`);
  await writeFile(inputPath, input, { flag: "wx" });
  run(nativeOracle, ["raw", String(level), inputPath, outputPath]);
  return { inputPath, bytes: new Uint8Array(await readFile(outputPath)) };
}

function nativeSamples(nativeBench, inputPath, level, timing, inputBytes, expectedBytes) {
  const stdout = run(nativeBench, [
    "raw", String(level), String(timing.warmups), String(timing.iterations),
    String(timing.samples), inputPath,
  ]);
  const report = JSON.parse(stdout);
  return validateNativeSampleReport(report, {
    level,
    inputBytes,
    outputBytes: expectedBytes.byteLength,
    outputChecksum: byteChecksum(expectedBytes),
    warmups: timing.warmups,
    iterations: timing.iterations,
    samples: timing.samples,
  });
}

function runVirSamples(runtime, entry, input, expected, timing) {
  for (let warmup = 0; warmup < timing.warmups; warmup += 1) {
    assert.deepEqual(runtime.call(entry, input, expected.level), expected.bytes);
  }
  const samples = [];
  for (let sample = 0; sample < timing.samples; sample += 1) {
    let last = null;
    let checksum = 0;
    const started = performance.now();
    for (let iteration = 0; iteration < timing.iterations; iteration += 1) {
      last = runtime.call(entry, input, expected.level);
      checksum += byteChecksum(last);
    }
    const stopped = performance.now();
    assert.deepEqual(last, expected.bytes);
    samples.push({
      sample,
      nsPerCall: Math.round((stopped - started) * 1e6 / timing.iterations),
      checksum,
    });
  }
  return samples;
}

function effectiveTiming(workload, overrides) {
  return { ...workload.timing, ...overrides };
}

function selectedWorkloads(suite, filters) {
  if (filters.length === 0) return suite.workloads;
  const selected = suite.workloads.filter((workload) => filters.includes(workload.id));
  const missing = filters.filter((filter) => !suite.workloads.some((workload) => workload.id === filter));
  if (missing.length > 0) throw new Error(`workload filters not found in suite: ${missing.join(", ")}`);
  return selected;
}

async function prepare(options) {
  const artifactReadStarted = performance.now();
  const [planBytes, wasmBytes, packageInput] = await Promise.all([
    readFile(options.plan),
    readFile(options.wasm),
    readPackageInput({ packagePath: options.package, packageSetPath: options.packageSet }),
  ]);
  const artifactReadMs = performance.now() - artifactReadStarted;
  const plan = validatePlan(JSON.parse(planBytes.toString("utf8")));
  const suite = selectSuite(plan, options.suite);
  const runtimeModule = await import(pathToFileURL(options.virRuntime));
  if (typeof runtimeModule.createVirRuntimeFactory !== "function") {
    throw new Error("Vir runtime module does not export createVirRuntimeFactory");
  }
  const factory = runtimeModule.createVirRuntimeFactory({ wasmBytes });
  const compileStarted = performance.now();
  await factory.module();
  const wasmCompileMs = performance.now() - compileStarted;
  return { planBytes, plan, suite, wasmBytes, packageInput, factory, artifactReadMs, wasmCompileMs };
}

async function runDemo(options, prepared) {
  const tempDir = await mkdtemp(join(tmpdir(), "lean-zip-wasm-demo-"));
  try {
    const workloads = selectedWorkloads(prepared.suite, options.filters);
    let ran = 0;
    for (const workload of workloads) {
      const loaded = await loadInput(workload);
      if (loaded === null) {
        console.log(`skip ${workload.id}: optional input is absent`);
        continue;
      }
      for (const level of workload.levels) {
        const caseId = `${workload.id}-l${level}`;
        const expected = await nativeReference(options.nativeOracle, tempDir, caseId, loaded.bytes, level);
        assert.deepEqual(new Uint8Array(inflateRawSync(expected.bytes)), loaded.bytes);
        const runtime = await prepared.factory.instantiate();
        try {
          runtime.loadIrPackageSetBytes(prepared.packageInput.packageBytes);
          const entry = inferEntry(runtime, options.entry);
          const actual = runtime.call(entry, loaded.bytes, level);
          assert.deepEqual(actual, expected.bytes);
          console.log(
            `${caseId}: ${loaded.bytes.byteLength} -> ${actual.byteLength} bytes ` +
            `sha256=${sha256(actual)} entry=${entry}`,
          );
          ran += 1;
        } finally {
          runtime.dispose();
        }
      }
    }
    if (ran === 0) throw new Error("demo selected no available cases");
    console.log(`lean-zip Vir demo ok: ${ran} native-equal raw-DEFLATE cases`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function benchmarkCase(options, prepared, tempDir, workload, loaded, level) {
  const timing = effectiveTiming(workload, options.overrides);
  const caseId = `${workload.id}-l${level}`;
  const expectedRef = await nativeReference(options.nativeOracle, tempDir, caseId, loaded.bytes, level);
  assert.deepEqual(new Uint8Array(inflateRawSync(expectedRef.bytes)), loaded.bytes);

  const instantiateStarted = performance.now();
  const runtime = await prepared.factory.instantiate();
  const instantiateMs = performance.now() - instantiateStarted;
  try {
    const memoryAfterInstantiate = memorySnapshot(runtime);
    const packageLoadStarted = performance.now();
    runtime.loadIrPackageSetBytes(prepared.packageInput.packageBytes);
    const packageLoadMs = performance.now() - packageLoadStarted;
    const memoryAfterPackageLoad = memorySnapshot(runtime);
    const entry = inferEntry(runtime, options.entry);
    const firstCallStarted = performance.now();
    const first = runtime.call(entry, loaded.bytes, level);
    const firstCallMs = performance.now() - firstCallStarted;
    assert.deepEqual(first, expectedRef.bytes);
    const memoryAfterFirstCall = memorySnapshot(runtime);

    const rawRuns = [];
    const memoryByPass = [];
    for (let pass = 0; pass < timing.passes; pass += 1) {
      const order = backendOrder(pass);
      for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
        const backend = order[orderIndex];
        if (backend === "native") {
          const native = nativeSamples(
            options.nativeBench,
            expectedRef.inputPath,
            level,
            timing,
            loaded.bytes.byteLength,
            expectedRef.bytes,
          );
          native.sampleNs.forEach((nsPerCall, sample) => rawRuns.push({
            pass, order: orderIndex, backend, sample, iterations: timing.iterations,
            nsPerCall, checksum: native.sampleChecksums[sample],
          }));
        } else {
          const before = memorySnapshot(runtime);
          const samples = runVirSamples(runtime, entry, loaded.bytes, {
            level,
            bytes: expectedRef.bytes,
          }, timing);
          const after = memorySnapshot(runtime);
          memoryByPass.push({ pass, before, after, growthBytes: after.bytes - before.bytes });
          for (const sample of samples) {
            rawRuns.push({
              pass, order: orderIndex, backend, sample: sample.sample,
              iterations: timing.iterations, nsPerCall: sample.nsPerCall,
              checksum: sample.checksum,
            });
          }
        }
      }
    }

    const diagnostic = runtime.callTimed(entry, loaded.bytes, level);
    assert.deepEqual(diagnostic.value, expectedRef.bytes);
    const memoryFinal = memorySnapshot(runtime);
    const aggregate = aggregateRuns(rawRuns, loaded.bytes.byteLength);
    console.log(
      `${caseId}: native=${aggregate.native.medianMs.toFixed(3)}ms ` +
      `vir=${aggregate.vir.medianMs.toFixed(3)}ms ` +
      `ratio=${aggregate.virToNativeTimeRatio.toFixed(2)}x`,
    );
    return {
      id: caseId,
      workload: workload.id,
      class: workload.class,
      source: loaded.source,
      level,
      timing,
      inputBytes: loaded.bytes.byteLength,
      inputSha256: sha256(loaded.bytes),
      outputBytes: expectedRef.bytes.byteLength,
      outputSha256: sha256(expectedRef.bytes),
      compressionRatio: expectedRef.bytes.byteLength / Math.max(loaded.bytes.byteLength, 1),
      entry,
      setup: {
        instantiateMs,
        packageLoadMs,
        firstCallMs,
        memoryAfterInstantiate,
        memoryAfterPackageLoad,
        memoryAfterFirstCall,
      },
      rawRuns,
      aggregate,
      memoryByPass,
      memoryFinal,
      diagnosticCallTimed: {
        headline: false,
        reason: "callTimed is opt-in instrumentation and is excluded from headline medians",
        timings: diagnostic.timings,
      },
    };
  } finally {
    runtime.dispose();
  }
}

async function buildIdentity(options, prepared) {
  const nativeSource = join(repoRoot, "ZipWasmBenchNative.lean");
  const [
    runtimeHash, wasmHash, nativeOracleHash, nativeBenchHash, harnessHash, libHash,
    nativeSourceHash,
  ] =
    await Promise.all([
      sha256File(options.virRuntime), sha256File(options.wasm),
      sha256File(options.nativeOracle), sha256File(options.nativeBench),
      sha256File(fileURLToPath(import.meta.url)), sha256File(join(scriptDir, "lib.mjs")),
      sha256File(nativeSource),
    ]);
  const cpuInfo = cpus();
  return {
    leanZip: gitIdentity(repoRoot),
    vir: options.virRoot === null ? null : gitIdentity(options.virRoot),
    node: process.version,
    toolchains: {
      leanZip: run("lean", ["--version"], { cwd: repoRoot }).trim(),
      vir: options.virRoot === null
        ? null
        : run("lean", ["--version"], { cwd: options.virRoot }).trim(),
    },
    platform: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model ?? null,
    },
    files: {
      plan: { path: options.plan, sha256: sha256(prepared.planBytes) },
      harness: { path: fileURLToPath(import.meta.url), sha256: harnessHash },
      library: { path: join(scriptDir, "lib.mjs"), sha256: libHash },
      nativeSource: { path: nativeSource, sha256: nativeSourceHash },
      virRuntime: { path: options.virRuntime, sha256: runtimeHash },
      wasm: { path: options.wasm, sha256: wasmHash },
      nativeOracle: { path: options.nativeOracle, sha256: nativeOracleHash },
      nativeBench: { path: options.nativeBench, sha256: nativeBenchHash },
      packageInput: {
        kind: prepared.packageInput.kind,
        path: prepared.packageInput.inputPath,
        sha256: prepared.packageInput.inputSha256,
        members: prepared.packageInput.members.map((member) => ({
          module: member.module,
          role: member.role,
          path: member.path,
          sha256: member.sha256,
          bytes: member.bytes.byteLength,
        })),
      },
    },
  };
}

async function runBench(options, prepared) {
  const insideRepo = relative(repoRoot, options.json);
  if (insideRepo === "" || (!insideRepo.startsWith("..") && !isAbsolute(insideRepo))) {
    throw new Error("benchmark --json output must be outside the lean-zip repository");
  }
  try {
    await stat(options.json);
    throw new Error(`refusing to overwrite benchmark report: ${options.json}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tempDir = await mkdtemp(join(tmpdir(), "lean-zip-wasm-bench-"));
  try {
    const workloads = selectedWorkloads(prepared.suite, options.filters);
    const cases = [];
    const skipped = [];
    for (const workload of workloads) {
      const loaded = await loadInput(workload);
      if (loaded === null) {
        skipped.push({ workload: workload.id, reason: "optional input is absent" });
        console.log(`skip ${workload.id}: optional input is absent`);
        continue;
      }
      for (const level of workload.levels) {
        cases.push(await benchmarkCase(options, prepared, tempDir, workload, loaded, level));
      }
    }
    if (cases.length === 0) throw new Error("benchmark selected no available cases");
    const report = {
      format: REPORT_FORMAT,
      version: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      suite: prepared.suite.id,
      suiteDescription: prepared.suite.description,
      filters: options.filters,
      schedule: "pass-level AB/BA; even native->vir, odd vir->native",
      aggregation: "repository median (sorted index floor(n/2)) over every raw per-call sample",
      evidence: {
        deterministic: ["hashes", "output bytes", "inflate result", "closure identity"],
        noisy: ["elapsed timing", "memory growth"],
        headlineDiagnostics: "off",
      },
      globalSetup: {
        artifactReadMs: prepared.artifactReadMs,
        wasmCompileMs: prepared.wasmCompileMs,
      },
      identity: await buildIdentity(options, prepared),
      skipped,
      cases,
    };
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(`wrote lean-zip WASM benchmark report: ${options.json}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prepared = await prepare(options);
  if (options.command === "demo") await runDemo(options, prepared);
  else await runBench(options, prepared);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
