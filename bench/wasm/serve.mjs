#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { readPackageSet, sha256 } from "./lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const maxInputBytes = 4096;

const usage = `usage:
  node bench/wasm/serve.mjs --package-set PATH --vir-root PATH [--port 4173]

options:
  --package-set PATH       Vir .irpkg-set.json for the full compressor
  --vir-root PATH          Vir checkout/worktree
  --vir-runtime PATH       override web/src/vir-runtime-node.js
  --wasm PATH              override web/public/vir-upstream.wasm
  --native-oracle PATH     default: .lake/build/bin/zip-wasm-oracle
  --entry NAME             Vir export; inferred for a single-export package
  --port N                 loopback port (default: 4173)
`;

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const environmentPath = (name) => {
    const value = process.env[name];
    return value === undefined ? null : resolve(value);
  };
  const options = {
    help: false,
    packageSet: environmentPath("LEAN_ZIP_VIR_PACKAGE_SET"),
    virRoot: environmentPath("LEAN_ZIP_VIR_ROOT"),
    virRuntime: environmentPath("LEAN_ZIP_VIR_RUNTIME"),
    wasm: environmentPath("LEAN_ZIP_VIR_WASM"),
    nativeOracle: join(repoRoot, ".lake/build/bin/zip-wasm-oracle"),
    entry: null,
    port: 4173,
  };
  const take = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--package-set") options.packageSet = resolve(take(index++, option));
    else if (option === "--vir-root") options.virRoot = resolve(take(index++, option));
    else if (option === "--vir-runtime") options.virRuntime = resolve(take(index++, option));
    else if (option === "--wasm") options.wasm = resolve(take(index++, option));
    else if (option === "--native-oracle") options.nativeOracle = resolve(take(index++, option));
    else if (option === "--entry") options.entry = take(index++, option);
    else if (option === "--port") {
      options.port = Number(take(index++, option));
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error("--port must be an integer in 1..65535");
      }
    } else {
      throw new Error(`unknown option: ${option}\n${usage}`);
    }
  }
  if (options.virRoot !== null) {
    options.virRuntime ??= join(options.virRoot, "web/src/vir-runtime-node.js");
    options.wasm ??= join(options.virRoot, "web/public/vir-upstream.wasm");
  }
  for (const [label, value] of [
    ["--package-set", options.packageSet],
    ["--vir-root or --vir-runtime", options.virRuntime],
    ["--vir-root or --wasm", options.wasm],
  ]) {
    if (value === null) throw new Error(`${label} is required\n${usage}`);
  }
  return options;
}

function run(path, args) {
  const result = spawnSync(path, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${basename(path)} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
}

function inferEntry(runtime, requested) {
  if (requested !== null) {
    if (runtime.findManifestEntry(requested) === null) {
      throw new Error(`Vir package does not export ${requested}`);
    }
    return requested;
  }
  const entries = runtime.interfaceManifest?.exports ?? [];
  if (entries.length !== 1) throw new Error("--entry is required for a multi-export package");
  return entries[0].entry;
}

async function nativeReference(nativeOracle, input, level) {
  const workDir = await mkdtemp(join(tmpdir(), "lean-zip-wasm-demo-oracle-"));
  try {
    const inputPath = join(workDir, "input");
    const outputPath = join(workDir, "output.deflate");
    await writeFile(inputPath, input);
    run(nativeOracle, ["raw", String(level), inputPath, outputPath]);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maxInputBytes * 4) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function page() {
  const levels = Array.from({ length: 11 }, (_, level) =>
    `<option value="${level}"${level === 6 ? " selected" : ""}>${level}</option>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>lean-zip · Vir/WASM demo</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #eaf0e8; background:
      radial-gradient(circle at 15% 0%, #23463e 0, transparent 34rem), #09110f; }
    main { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 72px; }
    .eyebrow { color: #8ee3bd; letter-spacing: .14em; text-transform: uppercase; font-size: .75rem; }
    h1 { margin: .4rem 0 .6rem; font-size: clamp(2.2rem, 7vw, 4.8rem); line-height: .95; }
    .lead { max-width: 720px; color: #adc0b8; font-size: 1.05rem; line-height: 1.6; }
    .pipeline { margin: 24px 0 30px; color: #b9f5d7; font-family: ui-monospace, monospace; }
    .panel { border: 1px solid #2b4c41; border-radius: 18px; padding: 22px; background: #0d1916dd;
      box-shadow: 0 24px 70px #0008; }
    label { display: grid; gap: 8px; color: #cbd8d2; font-size: .9rem; }
    textarea, select, button { font: inherit; }
    textarea, select { width: 100%; color: #f5fff9; background: #07100e; border: 1px solid #36594d;
      border-radius: 10px; padding: 12px; }
    textarea { min-height: 132px; resize: vertical; font-family: ui-monospace, monospace; line-height: 1.5; }
    .controls { display: grid; grid-template-columns: 140px 1fr; gap: 14px; align-items: end; margin-top: 14px; }
    button { min-height: 47px; border: 0; border-radius: 10px; padding: 0 20px; font-weight: 700;
      color: #092017; background: #84e8b8; cursor: pointer; }
    button:hover { background: #a0f2ca; }
    button:disabled { opacity: .55; cursor: wait; }
    #status { min-height: 1.4em; margin: 16px 0 0; color: #9fb2aa; }
    .results { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 18px; }
    .metric { border: 1px solid #29463d; border-radius: 12px; padding: 14px; background: #08120f; }
    .metric span { display: block; color: #8fa69c; font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
    .metric strong { display: block; margin-top: 5px; font-size: 1.2rem; }
    pre { overflow: auto; margin: 18px 0 0; padding: 16px; border-radius: 12px; color: #b9f5d7;
      background: #050b09; border: 1px solid #213a32; white-space: pre-wrap; word-break: break-all; }
    .fine { color: #7f968d; font-size: .78rem; line-height: 1.5; margin-top: 18px; }
    @media (max-width: 680px) { .results { grid-template-columns: 1fr 1fr; } .controls { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">real Lean compressor · local Vir interpreter</div>
  <h1>lean-zip<br>in WebAssembly</h1>
  <p class="lead">Compress UTF-8 text with the production raw-DEFLATE entry point. The server checks the
    Vir result byte-for-byte against native Lean and inflates it independently before showing success.</p>
  <div class="pipeline">ByteArray → Lean IR → Vir/WASM → raw DEFLATE</div>
  <section class="panel">
    <label>Input text
      <textarea id="input">abracadabra abracadabra abracadabra -- lean zip VIR fallback smoke -- abracadabra</textarea>
    </label>
    <div class="controls">
      <label>DEFLATE level<select id="level">${levels}</select></label>
      <button id="run" type="button">Compress with Vir/WASM</button>
    </div>
    <p id="status">Loading artifact identity…</p>
    <div class="results" hidden id="results">
      <div class="metric"><span>Input</span><strong id="inputBytes">—</strong></div>
      <div class="metric"><span>Compressed</span><strong id="outputBytes">—</strong></div>
      <div class="metric"><span>Ratio</span><strong id="ratio">—</strong></div>
      <div class="metric"><span>Vir call</span><strong id="elapsed">—</strong></div>
    </div>
    <pre id="detail" hidden></pre>
    <p class="fine">This is a correctness demo, not a browser-throughput claim. Vir currently interprets
      the compressor, so even the small default input can take a few seconds. Input is capped at ${maxInputBytes} bytes.</p>
  </section>
</main>
<script>
  const input = document.querySelector("#input");
  const level = document.querySelector("#level");
  const run = document.querySelector("#run");
  const status = document.querySelector("#status");
  const results = document.querySelector("#results");
  const detail = document.querySelector("#detail");
  const fields = Object.fromEntries(["inputBytes", "outputBytes", "ratio", "elapsed"]
    .map((id) => [id, document.querySelector("#" + id)]));

  async function responseJson(response) {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "request failed");
    return value;
  }

  fetch("/api/info").then(responseJson).then((info) => {
    status.textContent = "Ready · " + info.packages + " IR packages · " + info.entry;
  }).catch((error) => { status.textContent = error.message; });

  run.addEventListener("click", async () => {
    run.disabled = true;
    results.hidden = true;
    detail.hidden = true;
    status.textContent = "Vir is interpreting the compressor…";
    try {
      const value = await responseJson(await fetch("/api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.value, level: Number(level.value) }),
      }));
      fields.inputBytes.textContent = value.inputBytes + " B";
      fields.outputBytes.textContent = value.outputBytes + " B";
      fields.ratio.textContent = value.ratioPercent.toFixed(1) + "%";
      fields.elapsed.textContent = value.callMs.toFixed(1) + " ms";
      detail.textContent = [
        "✓ native byte equality: " + value.nativeEqual,
        "✓ independent raw inflate: " + value.inflatesToInput,
        "sha256: " + value.sha256,
        "Wasm memory: " + value.memoryPagesBefore + " → " + value.memoryPagesAfter + " pages",
        "raw DEFLATE hex: " + value.hex,
      ].join("\\n");
      results.hidden = false;
      detail.hidden = false;
      status.textContent = "Compression verified.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      run.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const [wasmBytes, packageSet] = await Promise.all([
    readFile(options.wasm),
    readPackageSet(options.packageSet),
  ]);
  const runtimeModule = await import(pathToFileURL(options.virRuntime));
  const factory = runtimeModule.createVirRuntimeFactory({ wasmBytes });
  await factory.module();
  const runtime = await factory.instantiate();
  runtime.loadIrPackageSetBytes(packageSet.packageBytes);
  const entry = inferEntry(runtime, options.entry);
  const html = page();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/info") {
        json(response, 200, {
          entry,
          packages: packageSet.members.length,
          packageSetSha256: packageSet.descriptorSha256,
          wasmSha256: sha256(wasmBytes),
          maxInputBytes,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/compress") {
        const body = await readJsonBody(request);
        if (typeof body?.text !== "string") throw new Error("text must be a string");
        if (!Number.isInteger(body.level) || body.level < 0 || body.level > 10) {
          throw new Error("level must be an integer in 0..10");
        }
        const input = new TextEncoder().encode(body.text);
        if (input.byteLength > maxInputBytes) {
          throw new Error(`UTF-8 input exceeds ${maxInputBytes} bytes`);
        }
        const native = await nativeReference(options.nativeOracle, input, body.level);
        const memoryPagesBefore = runtime.exports.memory.buffer.byteLength / 65536;
        const started = performance.now();
        const output = runtime.call(entry, input, body.level);
        const callMs = performance.now() - started;
        const memoryPagesAfter = runtime.exports.memory.buffer.byteLength / 65536;
        assert.deepEqual(output, native);
        assert.deepEqual(new Uint8Array(inflateRawSync(output)), input);
        json(response, 200, {
          entry,
          level: body.level,
          inputBytes: input.byteLength,
          outputBytes: output.byteLength,
          ratioPercent: input.byteLength === 0 ? 0 : output.byteLength / input.byteLength * 100,
          callMs,
          nativeEqual: true,
          inflatesToInput: true,
          sha256: sha256(output),
          memoryPagesBefore,
          memoryPagesAfter,
          hex: Buffer.from(output).toString("hex"),
        });
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error?.message ?? String(error) });
    }
  });

  const shutdown = () => server.close(() => {
    runtime.dispose();
    process.exitCode = 0;
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(options.port, "127.0.0.1", () => {
    console.log(`lean-zip Vir/WASM demo: http://127.0.0.1:${options.port}/`);
    console.log(`entry: ${entry}; packages: ${packageSet.members.length}; Ctrl-C to stop`);
  });
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
