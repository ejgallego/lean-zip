#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const laneDirectory = dirname(fileURLToPath(import.meta.url));
const leanZipRoot = resolve(laneDirectory, "../..");
const gitCommonDirectory = execFileSync("git", [
  "-C", leanZipRoot, "rev-parse", "--path-format=absolute", "--git-common-dir",
], { encoding: "utf8" }).trim();
const firRoot = resolve(process.env.FIR_ROOT ??
  join(dirname(dirname(gitCommonDirectory)), "fir"));
const zipCommonRoot = resolve(leanZipRoot, ".lake/packages/zipCommon");
const rebuild = process.argv.includes("--rebuild");
const positional = process.argv.slice(2).filter((argument) => argument !== "--rebuild");
if (positional.length > 1) {
  throw new Error("usage: node package.mjs [--rebuild] [output-directory]");
}
const outputDirectory = resolve(positional[0] ??
  join(laneDirectory, "_build/lean-zip-emscripten-current"));
const stagingRoot = join(laneDirectory, "_build/emscripten-source-root");
const builder = join(firRoot, "integration/lcnf-c-wasm/build-emscripten.sh");
const firLoader = join(firRoot, "integration/lcnf-c-wasm/emscripten-loader.mjs");
const oracle = join(leanZipRoot, ".lake/build/bin/zip-wasm-oracle");
const mainDepsRoot = join(firRoot, ".deps/lcnf-c-wasm");
const laneDepsRoot = join(firRoot,
  ".worktrees/wasm-generation/.deps/lcnf-c-wasm");
const depsRoot = resolve(process.env.FIR_LCNF_C_WASM_DEPS ??
  (existsSync(join(mainDepsRoot, "lean4-emscripten-build/lib/lean/libleanrt.a"))
    ? mainDepsRoot
    : laneDepsRoot));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? laneDirectory,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "inherit"],
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitIdentity(root) {
  const invoke = (args) => run("git", ["-C", root, ...args]).trim();
  const status = invoke(["status", "--porcelain=v1"]);
  return {
    commit: invoke(["rev-parse", "HEAD"]),
    dirty: status !== "",
    dirtyStatusSha256: status === "" ? null : sha256(status),
  };
}

function filesUnder(root, suffix) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(suffix)) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

run("lake", [
  "--keep-toolchain",
  "--reconfigure",
  `-KleanZipRoot=${leanZipRoot}`,
  `-KzipCommonRoot=${zipCommonRoot}`,
  "build",
  "LeanZipFirC",
], { capture: false });

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
copyFileSync(join(laneDirectory, "LeanZipFirC.lean"),
  join(stagingRoot, "LeanZipFirC.lean"));
for (const moduleRoot of ["Zip", "ZipCommon", "ZipForStd"]) {
  cpSync(join(laneDirectory, ".lake/build/lib/lean", moduleRoot),
    join(stagingRoot, moduleRoot), { recursive: true });
}

const generatedSources = ["Zip", "ZipCommon", "ZipForStd"].flatMap(
  (moduleRoot) => filesUnder(join(laneDirectory, ".lake/build/ir", moduleRoot), ".c"),
);
assert.ok(generatedSources.length >= 40,
  `expected the full lean-zip C closure, found ${generatedSources.length} modules`);
const allCSources = [
  join(laneDirectory, "runtime/lean-zip-bridge.c"),
  join(leanZipRoot, "c/bytearray_wide_ffi.c"),
  join(leanZipRoot, "c/copy_within_ffi.c"),
  join(leanZipRoot, "c/extend_within_ffi.c"),
  ...generatedSources,
  join(laneDirectory, "runtime/lean-runtime-abi.c"),
];
const stagedCSourceDirectory = join(stagingRoot, "c");
mkdirSync(stagedCSourceDirectory, { recursive: true });
const stagedCSources = allCSources.map((source, index) => {
  const destination = join(stagedCSourceDirectory,
    `${String(index).padStart(3, "0")}-${basename(source)}`);
  const sourceText = readFileSync(source, "utf8");
  const leanHeader = "#include <lean/lean.h>";
  assert.ok(sourceText.includes(leanHeader),
    `C source does not include the Lean runtime header: ${source}`);
  // FIR's Emscripten runtime is compiled with LEAN_EMSCRIPTEN, and project C
  // must see the same target-layout define. In particular,
  // LEAN_SCALAR_PTR_LITERAL expands to two wasm32 pointer slots instead of one
  // native 64-bit slot. Keep this source-local until the shared FIR builder
  // supplies the define to every generated/project C compilation.
  let targetSource = sourceText.replace(leanHeader,
    `#ifndef LEAN_EMSCRIPTEN\n#define LEAN_EMSCRIPTEN 1\n#endif\n${leanHeader}`);
  if (generatedSources.includes(source)) {
    targetSource = targetSource.replaceAll("lean_byte_array_copy_slice(",
      "fir_lean_byte_array_copy_slice_u8(");
    targetSource = targetSource.replaceAll("l_ByteArray_extract(",
      "fir_lean_byte_array_extract_u8(");
  }
  writeFileSync(destination, targetSource);
  return destination;
});

mkdirSync(outputDirectory, { recursive: true });
const buildArguments = [
  ...(rebuild ? ["--rebuild"] : []),
  "--root", stagingRoot,
  "--out-dir", outputDirectory,
  "--name", "lean-zip-emscripten",
  "--heap-view",
  "--export", "fir_lean_zip_c_input_alloc",
  "--export", "fir_lean_zip_c_compress",
  "--export", "fir_lean_zip_c_result_ptr",
  "--export", "fir_lean_zip_c_result_len",
  "--export", "fir_lean_zip_c_release",
];
for (const source of stagedCSources) {
  buildArguments.push("--extra-c-source", source);
}
buildArguments.push(join(stagingRoot, "LeanZipFirC.lean"));
run(builder, buildArguments, {
  capture: false,
  cwd: firRoot,
  env: {
    ...process.env,
    FIR_LCNF_C_WASM_DEPS: depsRoot,
    LEAN_PATH: stagingRoot,
  },
});

copyFileSync(firLoader, join(outputDirectory, "emscripten-loader.mjs"));
copyFileSync(join(laneDirectory, "lean-zip-emscripten-adapter.mjs"),
  join(outputDirectory, "lean-zip-emscripten-adapter.mjs"));

const manifestPath = join(outputDirectory, "lean-zip-emscripten.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const build = {
  schemaVersion: "fir.lean-zip.emscripten.build/v1",
  route: "final LCNF through Lean C, LLVM, and Emscripten",
  sources: {
    fir: gitIdentity(firRoot),
    leanZip: gitIdentity(leanZipRoot),
    zipCommon: gitIdentity(zipCommonRoot),
  },
  entry: {
    sourceName: "Zip.Wasm.compressRaw",
    exportedFacade: "fir_lean_zip_c_compress_raw",
    levels: Array.from({ length: 10 }, (_, index) => index + 1),
  },
  runtime: {
    fullLeanRuntime: true,
    threads: manifest.runtime.threads,
    heapView: manifest.abi.runtimeMethods.includes("HEAPU8"),
    targetLayoutDefines: ["LEAN_EMSCRIPTEN=1"],
  },
  closure: {
    generatedLeanModules: generatedSources.length,
    projectExternProviders: [
      "bench/fir-c/runtime/lean-runtime-abi.c",
      "c/bytearray_wide_ffi.c",
      "c/copy_within_ffi.c",
      "c/extend_within_ffi.c",
    ],
  },
  artifacts: manifest.artifacts,
  manifest: {
    file: "lean-zip-emscripten.manifest.json",
    sha256: sha256(readFileSync(manifestPath)),
  },
};
writeFileSync(join(outputDirectory, "BUILD.json"), `${JSON.stringify(build, null, 2)}\n`);

const packageNames = [
  "BUILD.json",
  "emscripten-loader.mjs",
  "lean-zip-emscripten-adapter.mjs",
  "lean-zip-emscripten.manifest.json",
  "lean-zip-emscripten.mjs",
  "lean-zip-emscripten.wasm",
];
writeFileSync(join(outputDirectory, "SHA256SUMS"), packageNames.map((name) =>
  `${sha256(readFileSync(join(outputDirectory, name)))}  ${name}`).join("\n") + "\n");

run(process.execPath, [join(laneDirectory, "check.mjs"), outputDirectory, oracle],
  { capture: false });
console.log(`prepared tested FIR C/Emscripten lean-zip package: ${outputDirectory}`);
