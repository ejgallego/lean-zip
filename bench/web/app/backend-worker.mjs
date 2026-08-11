import { backendById, median, mibPerSecond } from "./protocol.mjs";

const backendId = new URL(import.meta.url).searchParams.get("backend");
const backend = backendById(backendId);
let prepared = null;

function wasmMemoryPages(runtime) {
  return runtime?.exports?.memory?.buffer?.byteLength / 65536 ?? null;
}

async function prepareVir(config) {
  const [{ createVirRuntimeFactory }, wasmResponse, ...packageResponses] = await Promise.all([
    import(config.runtimeUrl),
    fetch(config.wasmUrl, { cache: "no-store" }),
    ...config.packageUrls.map((url) => fetch(url, { cache: "no-store" })),
  ]);
  for (const response of [wasmResponse, ...packageResponses]) {
    if (!response.ok) throw new Error(`artifact fetch failed: HTTP ${response.status}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  const packageBytes = await Promise.all(
    packageResponses.map(async (response) => new Uint8Array(await response.arrayBuffer())),
  );
  const factory = createVirRuntimeFactory({ wasmBytes });
  await factory.module();
  const runtime = await factory.instantiate();
  runtime.loadIrPackageSetBytes(packageBytes);
  if (runtime.findManifestEntry(config.entry) === null) {
    runtime.dispose();
    throw new Error(`VIR package does not export ${config.entry}`);
  }
  return {
    artifactBytes: wasmBytes.byteLength + packageBytes.reduce((sum, value) => sum + value.byteLength, 0),
    profile: config.profile,
    compress: (input, level) => runtime.call(config.entry, input, level),
    memory: () => wasmMemoryPages(runtime),
  };
}

async function prepareCompressionStream() {
  if (typeof CompressionStream !== "function") {
    throw new Error("CompressionStream is unavailable in this browser");
  }
  try {
    new CompressionStream("deflate-raw");
  } catch {
    throw new Error("this browser does not expose CompressionStream('deflate-raw')");
  }
  return {
    artifactBytes: 0,
    compress: async (input) => {
      const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
    memory: () => null,
  };
}

async function prepareFflate() {
  const { deflateSync } = await import("/vendor/fflate.mjs");
  return {
    artifactBytes: null,
    compress: (input, level) => deflateSync(input, { level: Math.min(level, 9) }),
    memory: () => null,
  };
}

async function prepare(config) {
  const started = performance.now();
  if (backendId === "vir") prepared = await prepareVir(config);
  else if (backendId === "compression-stream") prepared = await prepareCompressionStream();
  else if (backendId === "fflate") prepared = await prepareFflate();
  else throw new Error(`${backendId} is not a browser-worker backend`);
  return {
    prepareMs: performance.now() - started,
    artifactBytes: prepared.artifactBytes,
    wasmPages: prepared.memory(),
  };
}

async function compressOnce(input, level) {
  const output = await prepared.compress(input, level);
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

async function run(inputBuffer, settings) {
  if (prepared === null) throw new Error("backend has not been prepared");
  const input = new Uint8Array(inputBuffer);
  const memoryPagesBefore = prepared.memory();

  let started = performance.now();
  let output = await compressOnce(input, settings.level);
  const firstCallMs = performance.now() - started;

  let checksum = output.byteLength;
  for (let call = 0; call < settings.warmups; call += 1) {
    output = await compressOnce(input, settings.level);
    checksum += output.byteLength;
  }

  const sampleMs = [];
  for (let sample = 0; sample < settings.samples; sample += 1) {
    started = performance.now();
    for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
      output = await compressOnce(input, settings.level);
      checksum += output.byteLength;
    }
    sampleMs.push((performance.now() - started) / settings.iterations);
  }

  const medianMs = median(sampleMs);
  const stableOutput = output.slice();
  return {
    id: backendId,
    name: backend.name,
    family: backend.family,
    execution: backend.execution,
    effectiveSetting: backendId === "vir"
      ? `${backend.setting(settings.level)} · ${prepared.profile}`
      : backend.setting(settings.level),
    profile: prepared.profile ?? null,
    firstCallMs,
    sampleMs,
    medianMs,
    mibPerSecond: mibPerSecond(input.byteLength, medianMs),
    checksum,
    memoryPagesBefore,
    memoryPagesAfter: prepared.memory(),
    output: stableOutput,
  };
}

self.addEventListener("message", async (event) => {
  const { id, type, value } = event.data;
  try {
    const result = type === "prepare"
      ? await prepare(value)
      : type === "run"
        ? await run(value.input, value.settings)
        : (() => { throw new Error(`unknown worker request: ${type}`); })();
    const transfer = result.output instanceof Uint8Array ? [result.output.buffer] : [];
    self.postMessage({ id, ok: true, value: result }, transfer);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error?.stack ?? error?.message ?? String(error),
    });
  }
});
