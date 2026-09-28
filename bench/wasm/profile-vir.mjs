#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import inspector from "node:inspector";
import { cpus, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { readPackageInput, sha256, sha256File } from "./lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

const usage = `usage:
  node bench/wasm/profile-vir.mjs --package PATH --vir-root PATH --cpu-profile PATH --json PATH [options]

required:
  --package PATH           one VIR .irpkg artifact
  --package-set PATH       VIR .irpkg-set.json descriptor; exactly one package input is required
  --vir-root PATH          VIR checkout/worktree (derives runtime module and Wasm)
  --cpu-profile PATH       new diagnostics-only V8 CPU profile outside this repository
  --json PATH              new attribution report outside this repository

options:
  --vir-runtime PATH       override web/src/vir-runtime-node.js
  --wasm PATH              override optimized unstripped web/public/vir-upstream.dev.wasm
  --native-oracle PATH     default: .lake/build/bin/zip-wasm-oracle
  --entry NAME             default: VirLeanZipAcceptance.compressRaw
  --input PATH             default: bench/corpora/canterbury/alice29.txt
  --level N                lean-zip level 0..10 (default: 6)
  --warmups N              excluded calls before profiling (default: 2)
  --iterations N           production calls inside the profile (default: 3)
  --profile-interval-us N  requested sampling interval (default: 100)
`;

function parseArgs(argv) {
  const parsed = {
    package: null,
    packageSet: null,
    virRoot: null,
    virRuntime: null,
    wasm: null,
    nativeOracle: resolve(repoRoot, ".lake/build/bin/zip-wasm-oracle"),
    entry: "VirLeanZipAcceptance.compressRaw",
    input: resolve(repoRoot, "bench/corpora/canterbury/alice29.txt"),
    level: 6,
    warmups: 2,
    iterations: 3,
    profileIntervalUs: 100,
    cpuProfile: null,
    json: null,
  };
  const take = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  const natural = (value, option, minimum = 0) => {
    const parsedValue = Number(value);
    if (!Number.isInteger(parsedValue) || parsedValue < minimum) {
      throw new Error(`${option} must be an integer >= ${minimum}`);
    }
    return parsedValue;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (option === "--package") parsed.package = resolve(take(index++, option));
    else if (option === "--package-set") parsed.packageSet = resolve(take(index++, option));
    else if (option === "--vir-root") parsed.virRoot = resolve(take(index++, option));
    else if (option === "--vir-runtime") parsed.virRuntime = resolve(take(index++, option));
    else if (option === "--wasm") parsed.wasm = resolve(take(index++, option));
    else if (option === "--native-oracle") parsed.nativeOracle = resolve(take(index++, option));
    else if (option === "--entry") parsed.entry = take(index++, option);
    else if (option === "--input") parsed.input = resolve(take(index++, option));
    else if (option === "--level") parsed.level = natural(take(index++, option), option);
    else if (option === "--warmups") parsed.warmups = natural(take(index++, option), option);
    else if (option === "--iterations") parsed.iterations = natural(take(index++, option), option, 1);
    else if (option === "--profile-interval-us") {
      parsed.profileIntervalUs = natural(take(index++, option), option, 1);
    } else if (option === "--cpu-profile") parsed.cpuProfile = resolve(take(index++, option));
    else if (option === "--json") parsed.json = resolve(take(index++, option));
    else throw new Error(`unknown option: ${option}\n${usage}`);
  }
  if ((parsed.package === null) === (parsed.packageSet === null)) {
    throw new Error("exactly one of --package or --package-set is required");
  }
  if (parsed.virRoot === null || parsed.cpuProfile === null || parsed.json === null) {
    throw new Error(usage);
  }
  if (parsed.level > 10) throw new Error("--level must be in 0..10");
  parsed.virRuntime ??= resolve(parsed.virRoot, "web/src/vir-runtime-node.js");
  parsed.wasm ??= resolve(parsed.virRoot, "web/public/vir-upstream.dev.wasm");
  return parsed;
}

function run(path, args, options = {}) {
  const result = spawnSync(path, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(path)} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function requireNewOutsideRepo(path, option) {
  const inside = relative(repoRoot, path);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error(`${option} must be outside the lean-zip repository`);
  }
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${option} refuses to overwrite ${path}`);
}

function post(session, method, params = {}) {
  return new Promise((resolveValue, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolveValue(result));
  });
}

async function startProfile(interval) {
  const session = new inspector.Session();
  session.connect();
  await post(session, "Profiler.enable");
  await post(session, "Profiler.setSamplingInterval", { interval });
  await post(session, "Profiler.start");
  return session;
}

async function stopProfile(session) {
  try {
    return (await post(session, "Profiler.stop")).profile;
  } finally {
    session.disconnect();
  }
}

function category(name) {
  if (/symbol_cache_entry|constant_cache_entry|lookup_symbol|get_decl|find_env_decl|name_hash_map|lean_name_eq|memcmp/.test(name)) {
    return "declaration/symbol lookup";
  }
  if (/interpreter::call/.test(name)) return "interpreter call/dispatch";
  if (/eval_body|eval_expr|check_system/.test(name)) return "IR body/expression evaluation";
  if (/lean_dec|lean_inc|dlmalloc|dlfree|alloc_ctor|garbage collector|\(garbage collector\)/i.test(name)) {
    return "allocation/reference counting";
  }
  if (/box_t|unbox_t|curry|vector<.*>::resize/.test(name)) return "frames/boxing/closures";
  if (/^l_|^lean_(?!dec|inc)/.test(name)) return "native Lean/runtime call";
  return "other/unattributed";
}

function summarize(profile, limit = 30) {
  const names = new Map(profile.nodes.map((node) => [
    node.id,
    node.callFrame.functionName || "(anonymous)",
  ]));
  const byName = new Map();
  const byCategory = new Map();
  for (const id of profile.samples ?? []) {
    const name = names.get(id) ?? "(unknown)";
    byName.set(name, (byName.get(name) ?? 0) + 1);
    const bucket = category(name);
    byCategory.set(bucket, (byCategory.get(bucket) ?? 0) + 1);
  }
  const totalSamples = profile.samples?.length ?? 0;
  const rows = (counts) => [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, samples]) => ({
      name,
      samples,
      percent: totalSamples === 0 ? 0 : samples / totalSamples * 100,
    }));
  return {
    totalSamples,
    topSelf: rows(byName).slice(0, limit),
    heuristicSelfCategories: rows(byCategory),
  };
}

function gitIdentity(root) {
  const invoke = (args) => run("git", ["-C", root, ...args]).trim();
  const status = invoke(["status", "--porcelain=v1"]);
  return {
    head: invoke(["rev-parse", "HEAD"]),
    branch: invoke(["branch", "--show-current"]) || null,
    dirty: status !== "",
    status: status === "" ? [] : status.split("\n"),
  };
}

async function nativeReference(options, input) {
  const directory = await mkdtemp(resolve(tmpdir(), "lean-zip-vir-profile-"));
  try {
    const inputPath = resolve(directory, "input");
    const outputPath = resolve(directory, "output.deflate");
    await writeFile(inputPath, input, { flag: "wx" });
    run(options.nativeOracle, ["raw", String(options.level), inputPath, outputPath]);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await Promise.all([
    requireNewOutsideRepo(options.cpuProfile, "--cpu-profile"),
    requireNewOutsideRepo(options.json, "--json"),
    access(options.nativeOracle),
  ]);
  const [wasmFileBytes, inputFileBytes, packageInput] = await Promise.all([
    readFile(options.wasm),
    readFile(options.input),
    readPackageInput({ packagePath: options.package, packageSetPath: options.packageSet }),
  ]);
  const wasmBytes = new Uint8Array(wasmFileBytes);
  const input = new Uint8Array(inputFileBytes);
  const expected = await nativeReference(options, input);
  assert.deepEqual(new Uint8Array(inflateRawSync(expected)), input);

  const runtimeModule = await import(pathToFileURL(options.virRuntime));
  const factory = runtimeModule.createVirRuntimeFactory({ wasmBytes });
  await factory.module();
  const runtime = await factory.instantiate();
  let profile;
  const profiledCallsMs = [];
  try {
    runtime.loadIrPackageSetBytes(packageInput.packageBytes);
    if (runtime.findManifestEntry(options.entry) === null) {
      throw new Error(`VIR package does not export ${options.entry}`);
    }
    for (let index = 0; index < options.warmups; index += 1) {
      assert.deepEqual(runtime.call(options.entry, input, options.level), expected);
    }
    const session = await startProfile(options.profileIntervalUs);
    try {
      for (let index = 0; index < options.iterations; index += 1) {
        const started = performance.now();
        const output = runtime.call(options.entry, input, options.level);
        profiledCallsMs.push(performance.now() - started);
        assert.deepEqual(output, expected);
      }
    } finally {
      profile = await stopProfile(session);
    }
  } finally {
    runtime.dispose();
  }

  const profileBytes = Buffer.from(`${JSON.stringify(profile)}\n`);
  const summary = summarize(profile);
  const cpuInfo = cpus();
  const report = {
    format: "lean-zip-vir-cpu-attribution",
    version: 1,
    generatedAt: new Date().toISOString(),
    workload: {
      class: "representative",
      phase: "warmed production calls; compile, instantiate, package load, and warmup excluded",
      entry: options.entry,
      level: options.level,
      warmups: options.warmups,
      iterations: options.iterations,
      expectedTerminalState: "native-byte-equal and independently inflatable",
      observedTerminalState: "native-byte-equal and independently inflatable",
    },
    measurement: {
      diagnostics: "V8 CPU sampling profile",
      requestedIntervalUs: options.profileIntervalUs,
      timingWarning: "profiled call timings are attribution-only, not headline benchmark data",
      profiledCallsMs,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model ?? null,
      node: process.version,
      v8: process.versions.v8,
    },
    repositories: {
      leanZip: gitIdentity(repoRoot),
      vir: gitIdentity(options.virRoot),
    },
    artifacts: {
      input: { path: options.input, bytes: input.byteLength, sha256: sha256(input) },
      output: { bytes: expected.byteLength, sha256: sha256(expected) },
      wasm: { path: options.wasm, bytes: wasmBytes.byteLength, sha256: sha256(wasmBytes) },
      runtime: { path: options.virRuntime, sha256: await sha256File(options.virRuntime) },
      packageInput: {
        kind: packageInput.kind,
        path: packageInput.inputPath,
        sha256: packageInput.inputSha256,
        members: packageInput.members.map((member) => ({
          module: member.module,
          role: member.role,
          bytes: member.bytes.byteLength,
          sha256: member.sha256,
        })),
      },
      cpuProfile: { path: options.cpuProfile, bytes: profileBytes.byteLength, sha256: sha256(profileBytes) },
    },
    attribution: {
      confidence: "diagnostic self samples; category grouping is heuristic",
      ...summary,
    },
  };
  await writeFile(options.cpuProfile, profileBytes, { flag: "wx" });
  await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

  console.log(`# VIR CPU attribution: ${options.entry}`);
  console.log(`input: ${input.byteLength} bytes; level ${options.level}; ${options.iterations} profiled call(s)`);
  console.log(`samples: ${summary.totalSamples}`);
  for (const row of summary.heuristicSelfCategories) {
    console.log(`${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
  console.log("top self symbols:");
  for (const row of summary.topSelf.slice(0, 12)) {
    console.log(`${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
  console.log(`wrote ${options.cpuProfile}`);
  console.log(`wrote ${options.json}`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
