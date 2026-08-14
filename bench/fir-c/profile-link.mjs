#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const args = process.argv.slice(2);
const take = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  assert(index + 1 < args.length && !args[index + 1].startsWith("--"),
    `${name} requires a value`);
  return args[index + 1];
};
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node profile-link.mjs --out-dir DIR [--package DIR] [--fir-root DIR] [--cache-dir DIR]");
  process.exit(0);
}
for (let index = 0; index < args.length; index += 2) {
  assert(["--out-dir", "--package", "--fir-root", "--cache-dir"].includes(args[index]),
    `unknown argument ${args[index]}`);
}

const packageDirectory = resolve(take("--package",
  join(scriptDirectory, "_build/lean-zip-emscripten-current")));
const outputArgument = take("--out-dir");
assert.equal(typeof outputArgument, "string", "--out-dir is required");
const outputDirectory = resolve(outputArgument);
const gitCommonDirectory = execFileSync("git", [
  "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir",
], { encoding: "utf8" }).trim();
const firRoot = resolve(take("--fir-root", process.env.FIR_ROOT ??
  join(dirname(dirname(gitCommonDirectory)), "fir")));
const mainDepsRoot = join(firRoot, ".deps/lcnf-c-wasm");
const laneDepsRoot = join(firRoot, ".worktrees/wasm-generation/.deps/lcnf-c-wasm");
const depsRoot = resolve(process.env.FIR_LCNF_C_WASM_DEPS ??
  (existsSync(join(mainDepsRoot, "lean4-emscripten-build/lib/lean/libleanrt.a"))
    ? mainDepsRoot
    : laneDepsRoot));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readVarUint32 = (bytes, offset) => {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.byteLength && shift < 35) {
    const byte = bytes[cursor++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new Error(`invalid Wasm varuint32 at byte ${offset}`);
};
const stripCustomSections = (bytes) => {
  assert(bytes.byteLength >= 8, "truncated Wasm module");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "0061736d01000000",
    "invalid Wasm header");
  const chunks = [bytes.subarray(0, 8)];
  let cursor = 8;
  while (cursor < bytes.byteLength) {
    const sectionStart = cursor;
    const id = bytes[cursor++];
    const size = readVarUint32(bytes, cursor);
    const sectionEnd = size.next + size.value;
    assert(sectionEnd <= bytes.byteLength, `truncated Wasm section ${id}`);
    if (id !== 0) chunks.push(bytes.subarray(sectionStart, sectionEnd));
    cursor = sectionEnd;
  }
  return Buffer.concat(chunks);
};
const assertSameCore = (candidatePath, baselinePath, description) => {
  assert.equal(
    sha256(stripCustomSections(readFileSync(candidatePath))),
    sha256(stripCustomSections(readFileSync(baselinePath))),
    `${description} changed non-custom Wasm sections`,
  );
};
const fileIdentity = (path) => {
  const bytes = readFileSync(path);
  return { file: basename(path), byteLength: bytes.byteLength, sha256: sha256(bytes) };
};
const inside = relative(repoRoot, outputDirectory);
assert(inside !== "" && (inside.startsWith("..") || isAbsolute(inside)),
  "--out-dir must be outside the lean-zip repository");
assert(!existsSync(outputDirectory), `refusing to overwrite ${outputDirectory}`);

const buildPath = join(packageDirectory, "BUILD.json");
const manifestPath = join(packageDirectory, "lean-zip-emscripten.manifest.json");
const checksumPath = join(packageDirectory, "SHA256SUMS");
const build = JSON.parse(readFileSync(buildPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(build.schemaVersion, "fir.lean-zip.emscripten.build/v1");
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.profile, "emscripten");
for (const line of readFileSync(checksumPath, "utf8").trim().split("\n")) {
  const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
  assert(match !== null, `invalid package checksum line: ${line}`);
  assert.equal(sha256(readFileSync(join(packageDirectory, match[2]))), match[1],
    `package checksum mismatch for ${match[2]}`);
}

const artifactName = "lean-zip-emscripten";
const entryObject = join(packageDirectory, "LeanZipFirC.o");
const bridgeObjects = readdirSync(packageDirectory)
  .map((name) => {
    const match = /^lean-zip-emscripten\.bridge\.(\d+)\.o$/.exec(name);
    return match === null ? null : { index: Number(match[1]), path: join(packageDirectory, name) };
  })
  .filter((item) => item !== null)
  .sort((left, right) => left.index - right.index)
  .map((item) => item.path);
const hostObject = join(packageDirectory, `${artifactName}.module.o`);
assert(statSync(entryObject).isFile() && statSync(hostObject).isFile());
assert(bridgeObjects.length >= 40, "FIR-C package is missing its full closure objects");

const emsdkDirectory = join(depsRoot, "emsdk");
const emxx = join(emsdkDirectory, "upstream/emscripten/em++");
const binaryenDirectory = join(emsdkDirectory, "upstream/bin");
const wasmOpt = join(binaryenDirectory, "wasm-opt");
const wasmMetadce = join(binaryenDirectory, "wasm-metadce");
const firToolingScript = join(firRoot,
  ".worktrees/tooling/tooling/wasm/function-index.mjs");
const firToolingLibrary = join(firRoot,
  ".worktrees/tooling/tooling/wasm/function-index-lib.mjs");
const leanBuild = join(depsRoot, "lean4-emscripten-build");
const libraries = ["libStd.a", "libInit.a", "libleanrt.a"]
  .map((name) => join(leanBuild, "lib/lean", name));
for (const path of [emxx, wasmOpt, wasmMetadce, firToolingScript,
  firToolingLibrary, ...libraries]) {
  assert(statSync(path).isFile(), `missing ${path}`);
}

const nodeDirectories = readdirSync(join(emsdkDirectory, "node"))
  .map((name) => join(emsdkDirectory, "node", name, "bin/node"))
  .filter((path) => existsSync(path));
assert.equal(nodeDirectories.length, 1, "expected one pinned Emscripten Node runtime");
mkdirSync(outputDirectory, { recursive: true });
const privateEmscriptenCache = resolve(take("--cache-dir",
  join(outputDirectory, ".emscripten-cache")));
mkdirSync(privateEmscriptenCache, { recursive: true });
const emscriptenTemporaryDirectory = join(outputDirectory, ".emscripten-temp");
mkdirSync(emscriptenTemporaryDirectory, { recursive: true });
const emscriptenEnvironment = {
  EMSDK: emsdkDirectory,
  EMSDK_NODE: nodeDirectories[0],
  EMSDK_PYTHON: "/usr/bin/python3",
  EMSDK_QUIET: "1",
  EM_CONFIG: join(emsdkDirectory, ".emscripten"),
  EM_CACHE: privateEmscriptenCache,
  EMCC_DEBUG: "1",
  EMCC_DEBUG_SAVE: "1",
  EMCC_TEMP_DIR: emscriptenTemporaryDirectory,
  PATH: `${join(emsdkDirectory, "upstream/emscripten")}:/usr/bin:/bin`,
  LANG: "C",
  LC_ALL: "C",
};

const modulePath = join(outputDirectory, `${artifactName}.mjs`);
const wasmPath = join(outputDirectory, `${artifactName}.wasm`);
const linkMapPath = join(outputDirectory, `${artifactName}.link-map.txt`);
const linkFlags = manifest.build.linkFlags;
assert(Array.isArray(linkFlags) && linkFlags.every((flag) => typeof flag === "string"));
assert(linkFlags.includes("-Wl,--strip-all"),
  "expected the release link to strip names");
execFileSync(emxx, [
  entryObject,
  ...bridgeObjects,
  hostObject,
  "-Wl,--start-group",
  ...libraries,
  "-Wl,--end-group",
  ...linkFlags,
  `-Wl,-Map,${linkMapPath}`,
  "-o", modulePath,
], { env: emscriptenEnvironment, stdio: "ignore" });

assert(statSync(linkMapPath).isFile(), "wasm-ld did not emit its link map");

const releaseWasmPath = join(packageDirectory, build.artifacts.wasm.file);
const releaseWasm = readFileSync(releaseWasmPath);
const mappedWasm = readFileSync(wasmPath);
assert.equal(sha256(mappedWasm), sha256(releaseWasm),
  "link-map relink changed release Wasm bytes");

const stageDirectory = join(emscriptenTemporaryDirectory, "emscripten_temp");
const stageFile = (suffix, ordinal = 0) => {
  const matches = readdirSync(stageDirectory)
    .filter((name) => new RegExp(`^emcc-[0-9]+-${suffix.replaceAll(".", "\\.")}$`).test(name))
    .sort((left, right) => Number(/^emcc-([0-9]+)/.exec(left)[1]) -
      Number(/^emcc-([0-9]+)/.exec(right)[1]));
  assert(ordinal < matches.length,
    `missing retained Emscripten ${suffix} stage ${ordinal}`);
  return join(stageDirectory, matches[ordinal]);
};
const baseStage = stageFile("base.wasm");
const baselineOptimizedStage = stageFile("wasm-opt.wasm");
const baselineMetadceStage = stageFile("wasm-metadce.wasm");
const dceGraphs = readdirSync(stageDirectory)
  .filter((name) => /^emcc_dce_graph_.+\.json$/.test(name));
assert.equal(dceGraphs.length, 1, "expected one retained Emscripten meta-DCE graph");
const dceGraphPath = join(stageDirectory, dceGraphs[0]);

const baseShape = (() => {
  const bytes = readFileSync(baseStage);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module)
    .filter(({ kind }) => kind === "function").length;
  let cursor = 8;
  let definitions = null;
  while (cursor < bytes.byteLength) {
    const id = bytes[cursor++];
    const size = readVarUint32(bytes, cursor);
    if (id === 3) {
      definitions = readVarUint32(bytes, size.next).value;
      break;
    }
    cursor = size.next + size.value;
  }
  assert.notEqual(definitions, null, "base Wasm is missing its function section");
  return { imports, definitions, functions: imports + definitions };
})();

const codeRows = new Map();
let inCode = false;
for (const line of readFileSync(linkMapPath, "utf8").split("\n")) {
  const match = /^\s*-\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\S.*)$/.exec(line);
  if (match === null) continue;
  if (match[3] === "CODE") {
    inCode = true;
    continue;
  }
  if (match[3] === "DATA") break;
  if (!inCode) continue;
  const offset = Number.parseInt(match[1], 16);
  if (!codeRows.has(offset)) codeRows.set(offset, []);
  const symbol = /:\((.*)\)$/.exec(match[3])?.[1];
  if (symbol !== undefined) codeRows.get(offset).push(symbol);
}
const orderedRows = [...codeRows].sort(([left], [right]) => left - right);
assert.equal(orderedRows.length, baseShape.definitions,
  "linker map does not name every pre-Binaryen definition");
assert(orderedRows.every(([, names]) => names.length !== 0),
  "linker map contains an unnamed code contribution");
const primaryNames = orderedRows.map(([, names]) => names[0]);
const nameCounts = new Map();
for (const name of primaryNames) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
const definitionNames = orderedRows.map(([offset], index) => {
  const name = primaryNames[index];
  return nameCounts.get(name) === 1 ? name : `${name}@link+0x${offset.toString(16)}`;
});
const isLeanSource = (name) => name.startsWith("lp_LeanZipFirC_") ||
  name.startsWith("initialize_LeanZipFirC_") ||
  name.startsWith("_init_lp_LeanZipFirC_");
const isResidentHelper = (name) => name.startsWith("lean_") ||
  name.startsWith("fir_lean_zip_c_") || name === "fir_lcnf_c_initialize";
const inventory = {
  schemaVersion: "lean-zip.fir-c.link-inventory/v1",
  functions: definitionNames,
  sourceFunctions: definitionNames.filter(isLeanSource),
  residentHelpers: definitionNames.filter(isResidentHelper),
};
const inventoryPath = join(outputDirectory, "pre-binaryen.inventory.json");
writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });

const featureArgs = [
  "--mvp-features",
  "--enable-threads",
  "--enable-bulk-memory",
  "--enable-bulk-memory-opt",
  "--enable-call-indirect-overlong",
  "--enable-exception-handling",
  "--enable-multivalue",
  "--enable-mutable-globals",
  "--enable-nontrapping-float-to-int",
  "--enable-reference-types",
  "--enable-sign-ext",
];
const firstOptimizerArgs = [
  "--strip-target-features",
  "--post-emscripten",
  "-O3",
  "--low-memory-unused",
  "--zero-filled-memory",
  "--pass-arg=directize-initial-contents-immutable",
  "--no-stack-ir",
  ...featureArgs,
];
const finalOptimizerArgs = [
  "--minify-imports-and-exports-and-modules",
  "--optimize-level=3",
  "--shrink-level=0",
  "--optimize-stack-ir",
  ...featureArgs,
];
const firstArgsPath = join(outputDirectory, "first-wasm-opt-args.json");
writeFileSync(firstArgsPath, `${JSON.stringify(firstOptimizerArgs, null, 2)}\n`, { flag: "wx" });

const namedBase = join(outputDirectory, "pre-binaryen.named.wasm");
const baseCapture = join(outputDirectory, "pre-binaryen.capture.json");
const functionIndex = await import(pathToFileURL(firToolingLibrary).href);
const normalizeBinaryenTokens = (capture, wasmStage) => {
  const importCount = WebAssembly.Module.imports(
    new WebAssembly.Module(readFileSync(wasmStage)))
    .filter(({ kind }) => kind === "function").length;
  for (const identity of capture.identities) {
    identity.token = identity.index < importCount ?
      `fimport$${identity.index}` : String(identity.index - importCount);
  }
  assert.equal(new Set(capture.identities.map(({ token }) => token)).size,
    capture.identities.length, "normalized Binaryen tokens are not unique");
  return capture;
};
const initialCapture = normalizeBinaryenTokens(
  functionIndex.makeCapture(readFileSync(baseStage), inventory, basename(baseStage)),
  baseStage,
);
writeFileSync(baseCapture, `${JSON.stringify(initialCapture, null, 2)}\n`, { flag: "wx" });
writeFileSync(namedBase, functionIndex.injectFunctionIdentities(
  readFileSync(baseStage), initialCapture.identities), { flag: "wx" });

const namedOptimized = join(outputDirectory, "first-wasm-opt.named.wasm");
execFileSync(wasmOpt, [
  ...firstOptimizerArgs,
  "--debuginfo",
  namedBase,
  "-o", namedOptimized,
], { stdio: "inherit" });
assertSameCore(namedOptimized, baselineOptimizedStage,
  "identity-preserving first optimizer stage");
const restampedOptimized = join(outputDirectory, "first-wasm-opt.restamped.wasm");
const optimizedCapture = join(outputDirectory, "first-wasm-opt.capture.json");
execFileSync(process.execPath, [firToolingScript, "restamp",
  "--binaryen-dir", binaryenDirectory,
  "--wasm", namedOptimized,
  "--capture", baseCapture,
  "--wasm-opt-args", firstArgsPath,
  "--named-wasm", restampedOptimized,
  "--output", optimizedCapture,
], { stdio: "inherit" });
const normalizedOptimizedCapture = normalizeBinaryenTokens(
  JSON.parse(readFileSync(optimizedCapture, "utf8")), namedOptimized);
writeFileSync(optimizedCapture,
  `${JSON.stringify(normalizedOptimizedCapture, null, 2)}\n`);
writeFileSync(restampedOptimized, functionIndex.injectFunctionIdentities(
  readFileSync(namedOptimized), normalizedOptimizedCapture.identities));

const namedMetadce = join(outputDirectory, "wasm-metadce.named.wasm");
execFileSync(wasmMetadce, [
  `--graph-file=${dceGraphPath}`,
  restampedOptimized,
  "-o", namedMetadce,
  ...featureArgs,
  "--debuginfo",
], { stdio: "inherit" });
assertSameCore(namedMetadce, baselineMetadceStage,
  "identity-preserving meta-DCE stage");
const restampedMetadce = join(outputDirectory, "wasm-metadce.restamped.wasm");
const metadceCapture = join(outputDirectory, "wasm-metadce.capture.json");
execFileSync(process.execPath, [firToolingScript, "restamp",
  "--binaryen-dir", binaryenDirectory,
  "--wasm", namedMetadce,
  "--capture", optimizedCapture,
  "--wasm-opt-args", firstArgsPath,
  "--named-wasm", restampedMetadce,
  "--output", metadceCapture,
], { stdio: "inherit" });
const normalizedMetadceCapture = normalizeBinaryenTokens(
  JSON.parse(readFileSync(metadceCapture, "utf8")), namedMetadce);
writeFileSync(metadceCapture,
  `${JSON.stringify(normalizedMetadceCapture, null, 2)}\n`);
writeFileSync(restampedMetadce, functionIndex.injectFunctionIdentities(
  readFileSync(namedMetadce), normalizedMetadceCapture.identities));

const indexedReleasePath = join(outputDirectory, "indexed-release.wasm");
const sidecarPath = join(outputDirectory,
  "lean-zip-emscripten.wasm.functions.json");
const finalOptimizerOutput = execFileSync(wasmOpt, [
  ...finalOptimizerArgs,
  "--print-function-map",
  restampedMetadce,
  "-o", indexedReleasePath,
], { encoding: "utf8" });
const finalFunctionMap = finalOptimizerOutput.split(/\r?\n/)
  .filter((line) => /^\d+:/.test(line)).join("\n");
assert.equal(sha256(readFileSync(indexedReleasePath)), sha256(releaseWasm),
  "identity-carrying pipeline did not reproduce the exact release artifact");
const callGraphCopy = join(outputDirectory, "call-graph-copy.wasm");
const finalCallGraph = execFileSync(wasmOpt, [
  ...featureArgs,
  "--print-function-map",
  "--print-call-graph",
  indexedReleasePath,
  "-o", callGraphCopy,
], { encoding: "utf8" });
const normalizeCallGraph = (source, importCount) => {
  const edge = /^\s*"((?:[^"\\]|\\.)*)"\s*->\s*"((?:[^"\\]|\\.)*)"/;
  const absolute = (name) => {
    const importMatch = /^fimport\$(\d+)$/.exec(name);
    if (importMatch !== null) return Number(importMatch[1]);
    return /^\d+$/.test(name) ? Number(name) + importCount : name;
  };
  const lines = ["digraph call {"];
  for (const line of source.split(/\r?\n/)) {
    const match = edge.exec(line);
    if (match === null) continue;
    const caller = JSON.parse(`"${match[1]}"`);
    const callee = JSON.parse(`"${match[2]}"`);
    lines.push(`  ${JSON.stringify(String(absolute(caller)))} -> ` +
      `${JSON.stringify(String(absolute(callee)))};`);
  }
  lines.push("}");
  return lines.join("\n");
};
const normalizedFinalCallGraph = normalizeCallGraph(finalCallGraph,
  baseShape.imports);
const sidecar = functionIndex.makeSidecar(
  readFileSync(indexedReleasePath),
  normalizedMetadceCapture,
  finalFunctionMap,
  normalizedFinalCallGraph,
  {
    artifactFile: basename(releaseWasmPath),
    producer: {
      tool: "bench/fir-c/profile-link.mjs",
      firTooling: fileIdentity(firToolingLibrary),
      binaryenVersion: execFileSync(wasmOpt, ["--version"],
        { encoding: "utf8" }).trim(),
      optimizerArgs: finalOptimizerArgs,
    },
  },
);
functionIndex.validateSidecar(readFileSync(releaseWasmPath), sidecar);
writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx" });

const evidence = {
  schemaVersion: "lean-zip.fir-c.function-map/v1",
  evidenceClass: "exact-artifact-function-index",
  generatedAt: new Date().toISOString(),
  route: "linker inventory carried through the exact Emscripten Binaryen pipeline",
  package: {
    directory: packageDirectory,
    build: fileIdentity(buildPath),
    manifest: fileIdentity(manifestPath),
    checksums: fileIdentity(checksumPath),
    sources: build.sources,
  },
  artifact: {
    release: { path: releaseWasmPath, ...fileIdentity(releaseWasmPath) },
    mappedRelink: { path: wasmPath, ...fileIdentity(wasmPath) },
    byteIdentical: true,
  },
  linkerMap: {
    path: linkMapPath,
    ...fileIdentity(linkMapPath),
  },
  functionIndex: {
    sidecar: { path: sidecarPath, ...fileIdentity(sidecarPath) },
    indexedRelease: {
      path: indexedReleasePath,
      ...fileIdentity(indexedReleasePath),
      byteIdentical: true,
    },
    baseShape,
    inventory: {
      path: inventoryPath,
      ...fileIdentity(inventoryPath),
      leanSourceFunctions: inventory.sourceFunctions.length,
      residentHelpers: inventory.residentHelpers.length,
    },
    stages: {
      firstOptimizer: {
        baseline: fileIdentity(baselineOptimizedStage),
        identityCarrying: fileIdentity(namedOptimized),
        nonCustomSectionsByteIdentical: true,
      },
      metaDce: {
        baseline: fileIdentity(baselineMetadceStage),
        identityCarrying: fileIdentity(namedMetadce),
        nonCustomSectionsByteIdentical: true,
      },
    },
  },
  linker: {
    emxx,
    version: execFileSync(emxx, ["--version"], {
      env: emscriptenEnvironment,
      encoding: "utf8",
    }).split("\n")[0],
    originalFlags: linkFlags,
    evidenceOnlyChanges: {
      removed: [],
      added: [`-Wl,-Map,${linkMapPath}`],
    },
    inputs: [entryObject, ...bridgeObjects, hostObject, ...libraries]
      .map((path) => ({ path, ...fileIdentity(path) })),
  },
  outputs: {
    module: { path: modulePath, ...fileIdentity(modulePath) },
    wasm: { path: wasmPath, ...fileIdentity(wasmPath) },
    linkerMap: { path: linkMapPath, ...fileIdentity(linkMapPath) },
    functionSidecar: { path: sidecarPath, ...fileIdentity(sidecarPath) },
    emscriptenStages: emscriptenTemporaryDirectory,
  },
};
const evidencePath = join(outputDirectory, "function-map-evidence.json");
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
console.log("FIR-C exact-release function identities captured");
console.log(`release Wasm unchanged: ${evidence.artifact.release.sha256}`);
console.log(evidencePath);
