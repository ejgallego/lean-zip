#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import inspector from "node:inspector";
import { cpus, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { sha256, sha256File, validateUtf8Fixture } from "./lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const defaultInput = Uint8Array.of(0, 1, 127, 128, 254, 255);

const usage = `usage:
  node bench/wasm/profile-fir.mjs --package PATH --inventory PATH \\
    --fir-root PATH --cpu-profile PATH --json PATH [options]

required:
  --package PATH           immutable FIR Level-1 package directory
  --inventory PATH         FIR function inventory for the exact Wasm
  --fir-root PATH          FIR checkout/worktree that produced the artifact
  --cpu-profile PATH       new diagnostics-only V8 CPU profile outside this repository
  --json PATH              new attribution report outside this repository

options:
  --native-oracle PATH     default: .lake/build/bin/zip-wasm-oracle
  --input PATH             binary input; default is the package's six-byte boundary smoke
  --text VALUE             UTF-8 input
  --fixture PATH           exact UTF-8 fixture JSON
                           --input, --text, and --fixture are mutually exclusive
  --warmups N              excluded calls before profiling (default: 0)
  --iterations N           calls inside the profile (default: 1)
  --profile-interval-us N  requested sampling interval (default: 1000)
`;

function parseArgs(argv) {
  const parsed = {
    package: null,
    inventory: null,
    firRoot: null,
    nativeOracle: resolve(repoRoot, ".lake/build/bin/zip-wasm-oracle"),
    input: null,
    text: null,
    fixture: null,
    warmups: 0,
    iterations: 1,
    profileIntervalUs: 1000,
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
    else if (option === "--inventory") parsed.inventory = resolve(take(index++, option));
    else if (option === "--fir-root") parsed.firRoot = resolve(take(index++, option));
    else if (option === "--native-oracle") parsed.nativeOracle = resolve(take(index++, option));
    else if (option === "--input") parsed.input = resolve(take(index++, option));
    else if (option === "--text") parsed.text = take(index++, option);
    else if (option === "--fixture") parsed.fixture = resolve(take(index++, option));
    else if (option === "--warmups") parsed.warmups = natural(take(index++, option), option);
    else if (option === "--iterations") parsed.iterations = natural(take(index++, option), option, 1);
    else if (option === "--profile-interval-us") {
      parsed.profileIntervalUs = natural(take(index++, option), option, 1);
    } else if (option === "--cpu-profile") parsed.cpuProfile = resolve(take(index++, option));
    else if (option === "--json") parsed.json = resolve(take(index++, option));
    else throw new Error(`unknown option: ${option}\n${usage}`);
  }
  if ([parsed.package, parsed.inventory, parsed.firRoot, parsed.cpuProfile, parsed.json]
      .some((value) => value === null)) {
    throw new Error(usage);
  }
  if ([parsed.input, parsed.text, parsed.fixture].filter((value) => value !== null).length > 1) {
    throw new Error("--input, --text, and --fixture are mutually exclusive");
  }
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

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function encodeName(value) {
  const bytes = new TextEncoder().encode(value);
  return [...encodeU32(bytes.byteLength), ...bytes];
}

function functionCount(wasm) {
  const readU32 = (offset) => {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (true) {
      const byte = wasm[cursor++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [value >>> 0, cursor];
      shift += 7;
    }
  };
  let offset = 8;
  while (offset < wasm.byteLength) {
    const id = wasm[offset++];
    const [length, payload] = readU32(offset);
    if (id === 3) return readU32(payload)[0];
    offset = payload + length;
  }
  throw new Error("Wasm has no function section");
}

function addFunctionNames(wasm, names) {
  assert.equal(functionCount(wasm), names.length,
    "FIR inventory order must cover every defined Wasm function");
  const associations = [
    ...encodeU32(names.length),
    ...names.flatMap((name, index) => [...encodeU32(index), ...encodeName(name)]),
  ];
  const subsection = [1, ...encodeU32(associations.length), ...associations];
  const payload = [...encodeName("name"), ...subsection];
  return Uint8Array.from([...wasm, 0, ...encodeU32(payload.length), ...payload]);
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
  if (/distCodeWordBytes|lenCodeWordTab|_closed_/.test(name)) return "closed constants/initializers";
  if (/fir_big|fir_ext_Nat|fir_ext_USize_toNat|^Nat\.|^BitVec\./.test(name)) {
    return "generic numeric runtime";
  }
  if (/fir_heap_alloc|fir_.*alloc|fir_.*ctor|fir_.*pap|fir_.*box/.test(name)) {
    return "object/closure allocation";
  }
  if (/Zip\.Native\.Deflate|Deflate\.Spec|Huffman\.Spec/.test(name)) return "lean-zip compressor";
  if (/^fir_/.test(name)) return "other FIR runtime";
  if (/wasm-to-js|js-to-wasm|createLeanZip|compress|decodeByteArray|encodeByteArray/.test(name)) {
    return "host/adapter";
  }
  return "other/unattributed";
}

function summarize(profile, limit = 30) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const names = new Map(profile.nodes.map((node) => [
    node.id,
    node.callFrame.functionName || "(anonymous)",
  ]));
  const self = new Map();
  const inclusive = new Map();
  const categories = new Map();
  for (const id of profile.samples ?? []) {
    const name = names.get(id) ?? "(unknown)";
    self.set(name, (self.get(name) ?? 0) + 1);
    const bucket = category(name);
    categories.set(bucket, (categories.get(bucket) ?? 0) + 1);
    const seen = new Set();
    let cursor = id;
    while (nodes.has(cursor)) {
      const ancestor = names.get(cursor) ?? "(unknown)";
      if (!seen.has(ancestor)) inclusive.set(ancestor, (inclusive.get(ancestor) ?? 0) + 1);
      seen.add(ancestor);
      cursor = parents.get(cursor);
    }
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
    topSelf: rows(self).slice(0, limit),
    topInclusive: rows(inclusive).slice(0, limit),
    heuristicSelfCategories: rows(categories),
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

async function nativeReference(oracle, input) {
  const directory = await mkdtemp(resolve(tmpdir(), "lean-zip-fir-profile-"));
  try {
    const inputPath = resolve(directory, "input");
    const outputPath = resolve(directory, "output.deflate");
    await writeFile(inputPath, input, { flag: "wx" });
    run(oracle, ["level1", inputPath, outputPath]);
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
    stat(options.nativeOracle),
  ]);
  const wasmPath = resolve(options.package, "lean-zip-level1.wasm");
  const descriptorPath = resolve(options.package, "lean-zip-level1.wasm.json");
  const buildPath = resolve(options.package, "BUILD.json");
  const adapterPath = resolve(options.package, "lean-zip-level1-browser-adapter.mjs");
  const [wasmFile, descriptorFile, buildFile, inventoryFile, inputFile] = await Promise.all([
    readFile(wasmPath),
    readFile(descriptorPath),
    readFile(buildPath),
    readFile(options.inventory),
    options.input !== null ? readFile(options.input)
      : options.text !== null ? new TextEncoder().encode(options.text)
      : options.fixture !== null ? readFile(options.fixture)
      : defaultInput,
  ]);
  const wasm = new Uint8Array(wasmFile);
  const descriptor = JSON.parse(descriptorFile.toString("utf8"));
  const build = JSON.parse(buildFile.toString("utf8"));
  const inventory = JSON.parse(inventoryFile.toString("utf8"));
  const fixtureFile = options.fixture === null ? null : new Uint8Array(inputFile);
  const input = options.fixture === null
    ? new Uint8Array(inputFile)
    : validateUtf8Fixture(JSON.parse(Buffer.from(fixtureFile).toString("utf8")), options.fixture).bytes;
  assert.equal(build.wasm.sha256, sha256(wasm), "package Wasm identity mismatch");
  assert.equal(inventory.functions.length,
    build.closure.retainedSourceFunctions.length + build.closure.residentHelpers.length,
    "inventory function count differs from package metadata");
  const namedWasm = addFunctionNames(wasm, inventory.functions);
  const namedModule = await WebAssembly.compile(namedWasm);
  assert.equal(WebAssembly.Module.customSections(namedModule, "name").length, 1);
  assert.deepEqual(WebAssembly.Module.imports(namedModule), []);

  const expected = await nativeReference(options.nativeOracle, input);
  if (options.input === null && options.text === null && options.fixture === null) {
    assert.deepEqual(expected, Uint8Array.of(99, 96, 172, 111, 248, 247, 31, 0));
  }

  const { createLeanZipLevel1Adapter } = await import(pathToFileURL(adapterPath));
  const adapter = await createLeanZipLevel1Adapter({ module: namedModule, descriptor });
  for (let index = 0; index < options.warmups; index += 1) {
    const result = adapter.compressLevel1(input);
    assert.deepEqual(result.bytes, expected);
  }

  let profile;
  const calls = [];
  const session = await startProfile(options.profileIntervalUs);
  try {
    for (let index = 0; index < options.iterations; index += 1) {
      const started = performance.now();
      const result = adapter.compressLevel1(input);
      const elapsedMs = performance.now() - started;
      assert.deepEqual(result.bytes, expected);
      assert.deepEqual(new Uint8Array(inflateRawSync(result.bytes)), input);
      calls.push({ elapsedMs, timings: result.timings, memory: result.memory });
    }
  } finally {
    profile = await stopProfile(session);
  }

  const profileBytes = Buffer.from(`${JSON.stringify(profile)}\n`);
  const summary = summarize(profile);
  const cpuInfo = cpus();
  const report = {
    format: "lean-zip-fir-cpu-attribution",
    version: 1,
    generatedAt: new Date().toISOString(),
    workload: {
      class: options.input === null && options.text === null && options.fixture === null
        ? "focused" : "representative",
      phase: "production Level-1 calls; package validation, compile, instantiate, and persistent initialization excluded",
      entry: "Zip.Wasm.compressLevel1",
      warmups: options.warmups,
      iterations: options.iterations,
      expectedTerminalState: "native-byte-equal and independently inflatable",
      observedTerminalState: "native-byte-equal and independently inflatable",
    },
    measurement: {
      diagnostics: "V8 CPU sampling profile over a names-only Wasm copy",
      requestedIntervalUs: options.profileIntervalUs,
      timingWarning: "profiled call timings are attribution-only, not headline benchmark data",
      initialization: adapter.initialization,
      calls,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model ?? null,
      node: process.version,
      v8: process.versions.v8,
    },
    repositories: { leanZip: gitIdentity(repoRoot), fir: gitIdentity(options.firRoot) },
    artifacts: {
      input: {
        kind: options.input !== null ? "file"
          : options.text !== null ? "utf8"
          : options.fixture !== null ? "utf8-fixture"
          : "boundary-smoke",
        path: options.input ?? options.fixture,
        bytes: input.byteLength,
        sha256: sha256(input),
        fixtureSha256: fixtureFile === null ? null : sha256(fixtureFile),
      },
      output: { bytes: expected.byteLength, sha256: sha256(expected) },
      wasm: { path: wasmPath, bytes: wasm.byteLength, sha256: sha256(wasm) },
      namedProfileWasm: { bytes: namedWasm.byteLength, sha256: sha256(namedWasm) },
      inventory: { path: options.inventory, sha256: sha256(inventoryFile) },
      descriptor: { path: descriptorPath, sha256: sha256(descriptorFile) },
      build: { path: buildPath, sha256: sha256(buildFile) },
      adapter: { path: adapterPath, sha256: await sha256File(adapterPath) },
      cpuProfile: { path: options.cpuProfile, bytes: profileBytes.byteLength, sha256: sha256(profileBytes) },
    },
    attribution: {
      confidence: "diagnostic V8 self/inclusive samples; names come from FIR's exact ordered inventory",
      ...summary,
    },
  };
  await writeFile(options.cpuProfile, profileBytes, { flag: "wx" });
  await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

  console.log("# FIR CPU attribution: Zip.Wasm.compressLevel1");
  console.log(`input: ${input.byteLength} bytes; ${options.iterations} profiled call(s)`);
  console.log(`samples: ${summary.totalSamples}`);
  console.log("top self symbols:");
  for (const row of summary.topSelf.slice(0, 12)) {
    console.log(`${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
  console.log("top inclusive symbols:");
  for (const row of summary.topInclusive.slice(0, 12)) {
    console.log(`${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
  console.log(`wrote ${options.cpuProfile}`);
  console.log(`wrote ${options.json}`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
