#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_BACKENDS,
  makeBenchmarkInput,
} from "../web/app/protocol.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const defaultSource = resolve(directory, "../..");
const vectors = Object.freeze([
  { id: "repeated-1k", kind: "repeated", bytes: 1024, levels: [1, 6] },
  { id: "structured-16k", kind: "structured", bytes: 16384, levels: [1, 6, 10] },
  { id: "random-4k", kind: "random", bytes: 4096, levels: [1, 6] },
]);

function usage() {
  console.log(`Usage: node bench/catalog/export-browser-benchmark-source.mjs [options]

Export the lean-zip-owned browser workload and native oracle into a fresh directory.

  --output PATH                 fresh caller-owned output directory
  --checkout producer=PATH      exact clean lean-zip checkout (catalog form)
  --source PATH                 lean-zip checkout (direct-use alias)
  --allow-dirty                 permit a dirty source for local development only`);
}

function parseArgs(argv) {
  const options = {
    output: null,
    source: null,
    producerCheckout: null,
    allowDirty: false,
  };
  const take = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  const setOnce = (field, value, option) => {
    if (options[field] !== null) throw new Error(`duplicate ${option}`);
    options[field] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      setOnce("output", take(index++, argument), argument);
    } else if (argument === "--source") {
      setOnce("source", take(index++, argument), argument);
    } else if (argument === "--checkout") {
      const assignment = take(index++, argument);
      const separator = assignment.indexOf("=");
      if (separator <= 0 || separator === assignment.length - 1) {
        throw new Error("--checkout requires ROLE=PATH");
      }
      const role = assignment.slice(0, separator);
      if (role !== "producer") throw new Error(`unknown checkout role: ${role}`);
      setOnce(
        "producerCheckout",
        assignment.slice(separator + 1),
        "--checkout producer",
      );
    } else if (argument === "--package") {
      take(index, argument);
      throw new Error("this source-only producer does not accept dependency packages");
    } else if (argument === "--allow-dirty") {
      if (options.allowDirty) throw new Error("duplicate --allow-dirty");
      options.allowDirty = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.output === null) throw new Error("pass --output PATH");
  if (options.producerCheckout !== null) {
    if (options.source !== null) {
      throw new Error("use either --checkout producer=PATH or --source, not both");
    }
    options.source = options.producerCheckout;
  }
  options.source ??= defaultSource;
  return options;
}

function run(command, args, { cwd, capture = false } = {}) {
  const value = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  return typeof value === "string" ? value.trim() : "";
}

function git(source, args) {
  return run("git", ["-C", source, ...args], { capture: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileRecord(root, path) {
  const bytes = await readFile(join(root, path));
  return { path, byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

async function assertSourceRoot(source) {
  if (git(source, ["rev-parse", "--show-toplevel"]) !== source) {
    throw new Error(`source must be a Git checkout root: ${source}`);
  }
  for (const path of [
    "lean-toolchain",
    "Zip/Wasm/Entry.lean",
    "bench/wasm/plan.json",
    "bench/web/app/protocol.mjs",
    "bench/web/app/backend-worker.mjs",
  ]) {
    if (!(await lstat(join(source, path)).catch(() => null))?.isFile()) {
      throw new Error(`lean-zip source is missing ${path}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await realpath(resolve(options.source));
  const output = resolve(options.output);
  if ((await lstat(output).catch(() => null)) !== null) {
    throw new Error(`output directory already exists: ${output}`);
  }
  await assertSourceRoot(source);
  const status = git(source, ["status", "--porcelain"]);
  if (status !== "" && !options.allowDirty) {
    throw new Error("lean-zip source must be clean; --allow-dirty is local-only");
  }
  const toolchain = (await readFile(join(source, "lean-toolchain"), "utf8")).trim();
  if (toolchain !== "leanprover/lean4:v4.33.0") {
    throw new Error(`lean-zip browser source requires Lean 4.33 final, got ${toolchain}`);
  }

  await mkdir(join(output, "workload/vectors"), { recursive: true });
  try {
    run("lake", ["build", "zip-wasm-oracle"], { cwd: source });
    const oracleExecutable = join(source, ".lake/build/bin/zip-wasm-oracle");
    const oracleVectors = [];
    for (const vector of vectors) {
      const inputFile = `workload/vectors/${vector.id}.input.bin`;
      const input = makeBenchmarkInput(vector.kind, vector.bytes);
      await writeFile(join(output, inputFile), input);
      const expected = [];
      for (const level of vector.levels) {
        const file = `workload/vectors/${vector.id}.level-${level}.raw`;
        run(
          oracleExecutable,
          ["raw", String(level), join(output, inputFile), join(output, file)],
          { cwd: source },
        );
        const bytes = await readFile(join(output, file));
        expected.push({ level, file, byteLength: bytes.byteLength, sha256: sha256(bytes) });
      }
      oracleVectors.push({
        id: vector.id,
        kind: vector.kind,
        input: {
          file: inputFile,
          byteLength: input.byteLength,
          sha256: sha256(input),
        },
        expected,
      });
    }

    const oracle = {
      schemaVersion: 1,
      kind: "lean-zip/native-oracle-vectors",
      contract: "lean-zip/raw-deflate/v1",
      vectors: oracleVectors,
    };
    await writeFile(
      join(output, "workload/native-oracle.json"),
      `${JSON.stringify(oracle, null, 2)}\n`,
    );
    await Promise.all([
      copyFile(
        join(source, "bench/web/app/protocol.mjs"),
        join(output, "workload/protocol.mjs"),
      ),
      copyFile(
        join(source, "bench/web/app/backend-worker.mjs"),
        join(output, "workload/backend-worker.mjs"),
      ),
      copyFile(
        join(source, "bench/wasm/plan.json"),
        join(output, "workload/plan.json"),
      ),
      copyFile(
        join(source, "bench/catalog/source-package-smoke.mjs"),
        join(output, "smoke.mjs"),
      ),
    ]);

    const payloadPaths = [
      "smoke.mjs",
      "workload/backend-worker.mjs",
      "workload/native-oracle.json",
      "workload/plan.json",
      "workload/protocol.mjs",
      ...oracleVectors.flatMap((vector) => [
        vector.input.file,
        ...vector.expected.map(({ file }) => file),
      ]),
    ].sort();
    const files = await Promise.all(payloadPaths.map((path) => fileRecord(output, path)));
    const build = {
      schemaVersion: 1,
      kind: "lean-zip/browser-benchmark-source",
      producerProtocol: "browser-benchmarks/source-package/v1",
      source: {
        commit: git(source, ["rev-parse", "HEAD"]),
        dirty: status !== "",
      },
      toolchain: {
        elan: toolchain,
        leanVersion: run("lake", ["env", "lean", "--version"], {
          cwd: source,
          capture: true,
        }),
      },
      workload: {
        contract: "lean-zip/raw-deflate/v1",
        plan: "workload/plan.json",
        nativeOracle: "workload/native-oracle.json",
        nativeOracleMode: "build-time",
        browserBackends: BROWSER_BACKENDS.map(({ id }) => id),
        protocol: "workload/protocol.mjs",
        worker: "workload/backend-worker.mjs",
      },
      files,
    };
    await writeFile(join(output, "BUILD.json"), `${JSON.stringify(build, null, 2)}\n`);
    const checksumPaths = ["BUILD.json", ...payloadPaths];
    const checksums = await Promise.all(checksumPaths.map(async (path) =>
      `${sha256(await readFile(join(output, path)))}  ${path}`));
    await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    run("sha256sum", ["--check", "SHA256SUMS"], { cwd: output });
    run(process.execPath, ["smoke.mjs"], { cwd: output });
    console.log(
      `exported lean-zip browser source: ${oracleVectors.length} inputs, ${
        oracleVectors.reduce((sum, vector) => sum + vector.expected.length, 0)
      } native outputs`,
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
