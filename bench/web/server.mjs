#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import {
  byteChecksum,
  median,
  readPackageInput,
  sha256,
  sha256File,
  validateNativeSampleReport,
} from "../wasm/lib.mjs";
import {
  FIR_PACKAGE_PROFILES,
  firPackageRequiredFiles,
  validateFirPackageMetadata,
} from "./fir-package.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const appRoot = join(scriptDir, "app");
const maxInputBytes = 1024 * 1024;
const maxCompressedBytes = maxInputBytes + 65536;
const maxRequestBytes = Math.ceil((maxInputBytes + maxCompressedBytes) * 4 / 3) + 16384;
// The persistent-cache package stays within the comparison lab's global input
// bound across the producer and real-engine gates.

const usage = `usage:
  node bench/web/server.mjs (--package PATH | --package-set PATH) --vir-root PATH [options]

options:
  --package PATH           one Vir .irpkg artifact
  --package-set PATH       Vir .irpkg-set.json descriptor
  --vir-root PATH          Vir checkout/worktree containing web/src and web/public
  --wasm PATH              override Vir web/public/vir-upstream.wasm
  --native-oracle PATH     default: .lake/build/bin/zip-wasm-oracle
  --native-bench PATH      default: .lake/build/bin/zip-wasm-bench-native
  --entry NAME             default: VirLeanZipAcceptance.compressRaw
  --vir-profile LABEL      artifact profile label (default: portable)
  --fir-native-package PATH
                           alias for --fir-stored-package
  --fir-stored-package PATH
                           optional immutable FIR stored-DEFLATE package directory
  --fir-raw-package PATH   optional immutable FIR levels 1-10 package directory
  --port N                 loopback port (default: 4173)
`;

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const options = {
    package: null,
    packageSet: null,
    virRoot: null,
    wasm: null,
    nativeOracle: join(repoRoot, ".lake/build/bin/zip-wasm-oracle"),
    nativeBench: join(repoRoot, ".lake/build/bin/zip-wasm-bench-native"),
    entry: "VirLeanZipAcceptance.compressRaw",
    virProfile: "portable",
    firStoredPackage: null,
    firRawPackage: null,
    port: 4173,
  };
  const take = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--package") options.package = resolve(take(index++, option));
    else if (option === "--package-set") options.packageSet = resolve(take(index++, option));
    else if (option === "--vir-root") options.virRoot = resolve(take(index++, option));
    else if (option === "--wasm") options.wasm = resolve(take(index++, option));
    else if (option === "--native-oracle") options.nativeOracle = resolve(take(index++, option));
    else if (option === "--native-bench") options.nativeBench = resolve(take(index++, option));
    else if (option === "--entry") options.entry = take(index++, option);
    else if (option === "--fir-native-package" || option === "--fir-stored-package") {
      if (options.firStoredPackage !== null) {
        throw new Error("specify the FIR stored package only once");
      }
      options.firStoredPackage = resolve(take(index++, option));
    }
    else if (option === "--fir-raw-package") {
      options.firRawPackage = resolve(take(index++, option));
    }
    else if (option === "--vir-profile") {
      options.virProfile = take(index++, option);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.virProfile)) {
        throw new Error("--vir-profile must be a short identifier");
      }
    }
    else if (option === "--port") {
      options.port = Number(take(index++, option));
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error("--port must be an integer in 1..65535");
      }
    } else throw new Error(`unknown option: ${option}\n${usage}`);
  }
  if ((options.package === null) === (options.packageSet === null)) {
    throw new Error("exactly one of --package or --package-set is required");
  }
  if (options.virRoot === null) throw new Error(`--vir-root is required\n${usage}`);
  options.wasm ??= join(options.virRoot, "web/public/vir-upstream.wasm");
  return options;
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'",
  "X-Content-Type-Options": "nosniff",
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".irpkg", "application/octet-stream"],
]);

function send(response, status, body, contentType) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": contentType,
    "Content-Length": bytes.byteLength,
  });
  response.end(bytes);
}

function json(response, status, value) {
  send(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

async function sendFile(response, path) {
  const bytes = await readFile(path);
  send(response, 200, bytes, mimeTypes.get(extname(path)) ?? "application/octet-stream");
}

async function snapshotTree(root, prefix = "") {
  const files = new Map();
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [path, bytes] of await snapshotTree(root, relativePath)) files.set(path, bytes);
    } else if (entry.isFile()) {
      files.set(relativePath, await readFile(join(root, ...relativePath.split("/"))));
    }
  }
  return files;
}

function treeIdentity(files) {
  const members = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  }));
  return {
    files: members.length,
    bytes: members.reduce((sum, member) => sum + member.bytes, 0),
    sha256: sha256(Buffer.from(JSON.stringify(members))),
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxRequestBytes) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function decodeBytes(value, label, maximumBytes) {
  if (typeof value !== "string") throw new Error(`${label} must be base64 text`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return bytes;
}

function settingsFrom(body) {
  const bound = (field, minimum, maximum) => {
    if (!Number.isInteger(body[field]) || body[field] < minimum || body[field] > maximum) {
      throw new Error(`${field} must be an integer in ${minimum}..${maximum}`);
    }
    return body[field];
  };
  return {
    level: bound("level", 0, 10),
    warmups: bound("warmups", 0, 10),
    iterations: bound("iterations", 1, 100),
    samples: bound("samples", 1, 20),
  };
}

function run(path, args, options = {}) {
  const result = spawnSync(path, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(path)} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
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

async function fileIdentity(path, executable = false) {
  await access(path, executable ? fsConstants.X_OK : fsConstants.R_OK);
  const metadata = await stat(path);
  return { path, bytes: metadata.size, sha256: await sha256File(path) };
}

async function readFirPackage(directory, profile) {
  const names = firPackageRequiredFiles(profile);
  const entries = await Promise.all(names.map(async (name) => [
    name,
    await readFile(join(directory, name)),
  ]));
  const files = new Map(entries);
  const build = JSON.parse(files.get("BUILD.json").toString("utf8"));
  const descriptor = JSON.parse(files.get(profile.descriptorFile).toString("utf8"));
  validateFirPackageMetadata(profile, build, descriptor);
  const wasmBytes = files.get(profile.wasmFile);
  const wasmSha256 = sha256(wasmBytes);
  if (wasmSha256 !== build.wasm.sha256 || wasmBytes.byteLength !== build.wasm.byteLength) {
    throw new Error(`FIR ${profile.id} package Wasm identity differs from BUILD.json`);
  }
  const checksumNames = new Set();
  for (const line of files.get("SHA256SUMS").toString("utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (match === null || match[2] === "SHA256SUMS" || checksumNames.has(match[2]) ||
        !files.has(match[2]) || sha256(files.get(match[2])) !== match[1]) {
      throw new Error(`FIR ${profile.id} package checksum mismatch: ${line}`);
    }
    checksumNames.add(match[2]);
  }
  for (const name of names) {
    if (name !== "SHA256SUMS" && !checksumNames.has(name)) {
      throw new Error(`FIR ${profile.id} package checksum is missing ${name}`);
    }
  }
  const module = new WebAssembly.Module(wasmBytes);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error(`FIR ${profile.id} Wasm has imports`);
  }
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some(({ name, kind }) => name === profile.sourceName && kind === "function") ||
      !exports.some(({ name, kind }) => name === "memory" && kind === "memory")) {
    throw new Error(`FIR ${profile.id} Wasm is missing its entry or module-owned memory`);
  }
  if (profile.persistentInitializer !== null &&
      !exports.some(({ name, kind }) =>
        name === profile.persistentInitializer && kind === "function")) {
    throw new Error(`FIR ${profile.id} Wasm is missing its persistent initializer`);
  }
  return { directory, files, build, descriptor, profile, wasmSha256 };
}

function firBrowserConfig(value) {
  if (value === null) return null;
  const { build, profile } = value;
  return {
    adapterUrl: `/fir/${profile.adapterFile}`,
    wasmUrl: `/artifacts/${profile.wasmFile}`,
    descriptorUrl: `/artifacts/${profile.descriptorFile}`,
    factoryExport: profile.factoryExport,
    operation: profile.operation,
    levelArgument: profile.levelArgument ?? false,
    expectedLevels: profile.levels,
    sourceName: profile.sourceName,
    profile: profile.profile,
    persistentInitializer: profile.persistentInitializer,
    completeRuntime: build.capabilities.completeRuntime ?? null,
  };
}

function firArtifactIdentity(value) {
  if (value === null) return null;
  const { build, directory, files, profile, wasmSha256 } = value;
  return {
    directory,
    packageProfile: profile.id,
    schemaVersion: build.schemaVersion,
    firCommit: build.sources.fir.commit,
    leanZipCommit: build.sources.leanZip.commit,
    sourceName: profile.sourceName,
    levels: profile.levels,
    layoutVersion: build.capabilities.byteArray.layoutVersion,
    persistentInitializer: profile.persistentInitializer,
    frontier: build.wasm.frontier ?? null,
    completeRuntime: build.capabilities.completeRuntime ?? null,
    wasm: {
      path: join(directory, profile.wasmFile),
      bytes: files.get(profile.wasmFile).byteLength,
      sha256: wasmSha256,
    },
  };
}

async function runNative(options, input, settings) {
  const workDir = await mkdtemp(join(tmpdir(), "lean-zip-web-native-"));
  try {
    const inputPath = join(workDir, "input");
    const outputPath = join(workDir, "output.deflate");
    await writeFile(inputPath, input);
    run(options.nativeOracle, ["raw", String(settings.level), inputPath, outputPath]);
    const output = await readFile(outputPath);
    const stdout = run(options.nativeBench, [
      "raw",
      String(settings.level),
      String(settings.warmups),
      String(settings.iterations),
      String(settings.samples),
      inputPath,
    ]);
    const samples = validateNativeSampleReport(JSON.parse(stdout), {
      level: settings.level,
      inputBytes: input.byteLength,
      outputBytes: output.byteLength,
      warmups: settings.warmups,
      iterations: settings.iterations,
      samples: settings.samples,
      outputChecksum: byteChecksum(output),
    });
    const sampleMs = samples.sampleNs.map((value) => value / 1e6);
    const medianMs = median(sampleMs);
    return {
      id: "native",
      name: "Native Lean",
      family: "lean-zip",
      execution: "server process; timing excludes process startup",
      effectiveSetting: `lean-zip level ${settings.level}`,
      firstCallMs: null,
      sampleMs,
      medianMs,
      mibPerSecond: medianMs <= 0 ? null : (input.byteLength / (1024 * 1024)) / (medianMs / 1000),
      output: output.toString("base64"),
      outputBytes: output.byteLength,
      sha256: sha256(output),
      memoryPagesBefore: null,
      memoryPagesAfter: null,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const packageInput = await readPackageInput({
    packagePath: options.package,
    packageSetPath: options.packageSet,
  });
  const fflatePath = join(scriptDir, "node_modules/fflate/esm/browser.js");
  const virSourceRoot = join(options.virRoot, "web/src");
  const [wasmBytes, virSourceFiles, nativeOracle, nativeBench, fflateIdentity] = await Promise.all([
    readFile(options.wasm),
    snapshotTree(virSourceRoot),
    fileIdentity(options.nativeOracle, true),
    fileIdentity(options.nativeBench, true),
    fileIdentity(fflatePath),
  ]);
  const wasmIdentity = { path: options.wasm, bytes: wasmBytes.byteLength, sha256: sha256(wasmBytes) };
  const packageUrls = packageInput.members.map((_, index) => `/artifacts/package-${index}.irpkg`);
  const firNative = options.firStoredPackage === null
    ? null
    : await readFirPackage(options.firStoredPackage, FIR_PACKAGE_PROFILES.stored);
  const firRaw = options.firRawPackage === null
    ? null
    : await readFirPackage(options.firRawPackage, FIR_PACKAGE_PROFILES.raw);
  const info = {
    format: "lean-zip-web-comparison-info",
    version: 1,
    entry: options.entry,
    maxInputBytes,
    crossOriginIsolationHeaders: true,
    runtime: {
      runtimeUrl: "/vir/vir-runtime.js",
      wasmUrl: "/artifacts/vir-upstream.wasm",
      packageUrls,
      profile: options.virProfile,
      diagnostic: {
        matcherEntry: "VirLeanZipAcceptance.profileMatchTokens",
        baseEntry: "VirLeanZipAcceptance.profileBasePrepSize",
        levelEntries: {
          5: "VirLeanZipAcceptance.profileLevel5",
          6: "VirLeanZipAcceptance.profileLevel6",
          7: "VirLeanZipAcceptance.profileLevel7",
          8: "VirLeanZipAcceptance.profileLevel8",
          9: "VirLeanZipAcceptance.profileLevel9",
          10: "VirLeanZipAcceptance.profileLevel10",
        },
        optimalEntries: {
          9: "VirLeanZipAcceptance.profileOptimalFast",
          10: "VirLeanZipAcceptance.profileOptimalExact",
        },
      },
    },
    firNative: firBrowserConfig(firNative),
    firRaw: firBrowserConfig(firRaw),
    backends: [
      { id: "native", available: true },
      { id: "vir", available: true, profile: options.virProfile },
      { id: "compression-stream", available: true, availabilityCheckedInBrowser: true },
      { id: "fflate", available: true },
      {
        id: "fir-emscripten",
        available: false,
        reason: "Awaiting FIR C/Emscripten bundle and HEAPU8 ByteArray adapter",
      },
      {
        id: "fir-native",
        available: firNative !== null,
        levels: [0],
        reason: firNative === null
          ? "FIR-native stored artifact not attached"
          : null,
      },
      {
        id: "fir-raw",
        available: firRaw !== null,
        levels: FIR_PACKAGE_PROFILES.raw.levels,
        maxInputBytes,
        reason: firRaw === null
          ? "FIR-native levels 1-10 artifact not attached"
          : null,
      },
    ],
    repositories: {
      leanZip: gitIdentity(repoRoot),
      vir: gitIdentity(options.virRoot),
    },
    artifacts: {
      virProfile: options.virProfile,
      virWasm: { path: options.wasm, bytes: wasmIdentity.bytes, sha256: wasmIdentity.sha256 },
      virRuntime: { path: virSourceRoot, ...treeIdentity(virSourceFiles) },
      virPackageInput: {
        kind: packageInput.kind,
        sha256: packageInput.inputSha256,
        members: packageInput.members.map((member, index) => ({
          module: member.module,
          role: member.role,
          bytes: member.bytes.byteLength,
          sha256: member.sha256,
          url: packageUrls[index],
        })),
      },
      nativeOracle,
      nativeBench,
      fflate: { path: fflatePath, bytes: fflateIdentity.bytes, sha256: fflateIdentity.sha256 },
      firNative: firArtifactIdentity(firNative),
      firRaw: firArtifactIdentity(firRaw),
    },
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        await sendFile(response, join(appRoot, "index.html"));
      } else if (request.method === "GET" && [
        "/styles.css", "/main.mjs", "/backend-worker.mjs", "/protocol.mjs",
      ].includes(url.pathname)) {
        await sendFile(response, join(appRoot, url.pathname.slice(1)));
      } else if (request.method === "GET" && url.pathname.startsWith("/vir/")) {
        const path = decodeURIComponent(url.pathname.slice(5));
        const bytes = virSourceFiles.get(path);
        if (bytes === undefined) throw new Error("VIR runtime asset not found");
        send(response, 200, bytes, mimeTypes.get(extname(path)) ?? "application/octet-stream");
      } else if (request.method === "GET" && url.pathname.startsWith("/fir/")) {
        const name = decodeURIComponent(url.pathname.slice(5));
        const candidates = name === "lean-zip-byte-array-browser-adapter.mjs"
          ? [firRaw, firNative]
          : [firNative, firRaw];
        const candidate = candidates.find(
          (value) => value !== null &&
            (value.profile.adapterFile === name ||
              value.profile.adapterImplementationFile === name ||
              (value.profile.auxiliaryFiles ?? []).includes(name)),
        );
        if (candidate === undefined) throw new Error("FIR adapter artifact is unavailable");
        send(response, 200, candidate.files.get(name), "text/javascript; charset=utf-8");
      } else if (request.method === "GET" && url.pathname === "/vendor/fflate.mjs") {
        await sendFile(response, fflatePath);
      } else if (request.method === "GET" && url.pathname === "/artifacts/vir-upstream.wasm") {
        send(response, 200, wasmBytes, "application/wasm");
      } else if (request.method === "GET" && url.pathname.startsWith("/artifacts/lean-zip-")) {
        const name = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const candidate = [firNative, firRaw].find(
          (value) => value !== null &&
            (value.profile.wasmFile === name || value.profile.descriptorFile === name),
        );
        if (candidate === undefined) throw new Error("FIR module artifact is unavailable");
        send(response, 200, candidate.files.get(name), mimeTypes.get(extname(name)));
      } else if (request.method === "GET" && /^\/artifacts\/package-\d+\.irpkg$/.test(url.pathname)) {
        const index = Number(url.pathname.match(/\d+/)[0]);
        if (index >= packageInput.members.length) throw new Error("package artifact not found");
        send(response, 200, packageInput.members[index].bytes, "application/octet-stream");
      } else if (request.method === "GET" && url.pathname === "/api/info") {
        json(response, 200, info);
      } else if (request.method === "POST" && url.pathname === "/api/native/run") {
        const body = await readJsonBody(request);
        const input = decodeBytes(body.input, "input", maxInputBytes);
        json(response, 200, await runNative(options, input, settingsFrom(body)));
      } else if (request.method === "POST" && url.pathname === "/api/validate") {
        const body = await readJsonBody(request);
        const input = decodeBytes(body.input, "input", maxInputBytes);
        const output = decodeBytes(body.output, "output", maxCompressedBytes);
        let inflated;
        try {
          inflated = inflateRawSync(output);
        } catch (error) {
          json(response, 200, { valid: false, reason: error.message, sha256: sha256(output) });
          return;
        }
        const valid = inflated.equals(input);
        json(response, 200, {
          valid,
          reason: valid ? null : "inflated bytes differ from the input",
          sha256: sha256(output),
          inflatedBytes: inflated.byteLength,
        });
      } else {
        json(response, 404, { error: "not found" });
      }
    } catch (error) {
      json(response, 400, { error: error?.message ?? String(error) });
    }
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`lean-zip comparison lab: http://127.0.0.1:${options.port}/`);
    console.log(`VIR ${options.entry}; ${packageInput.members.length} package(s); Ctrl-C to stop`);
    if (firNative !== null) console.log("FIR native mode: stored DEFLATE at level 0");
    if (firRaw !== null) console.log("FIR native mode: production DEFLATE at levels 1-10");
  });
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
