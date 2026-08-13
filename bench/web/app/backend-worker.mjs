import { backendById, median, mibPerSecond } from "./protocol.mjs";

const backendId = new URL(import.meta.url).searchParams.get("backend");
const backend = backendById(backendId);
let prepared = null;

function wasmMemoryPages(runtime) {
  return runtime?.exports?.memory?.buffer?.byteLength / 65536 ?? null;
}

async function prepareVir(config) {
  const prepareStarted = performance.now();
  let started = prepareStarted;
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
  const acquireMs = performance.now() - started;
  started = performance.now();
  const factory = createVirRuntimeFactory({ wasmBytes });
  await factory.module();
  const compileMs = performance.now() - started;
  started = performance.now();
  const runtime = await factory.instantiate();
  const instantiateMs = performance.now() - started;
  started = performance.now();
  runtime.loadIrPackageSetBytes(packageBytes);
  const packageLoadMs = performance.now() - started;
  if (runtime.findManifestEntry(config.entry) === null) {
    runtime.dispose();
    throw new Error(`VIR package does not export ${config.entry}`);
  }
  const diagnosticReady = config.diagnostic !== null &&
    runtime.findManifestEntry(config.diagnostic.matcherEntry) !== null &&
    runtime.findManifestEntry(config.diagnostic.baseEntry) !== null;
  const bytesEqual = (left, right) => left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
  return {
    artifactBytes: wasmBytes.byteLength + packageBytes.reduce((sum, value) => sum + value.byteLength, 0),
    profile: config.profile,
    compress: (input, level) => runtime.call(config.entry, input, level),
    compressTimed: (input, level) => runtime.callTimed(config.entry, input, level),
    preparePhases: {
      acquireMs,
      compileMs,
      instantiateMs,
      packageLoadMs,
      totalMs: performance.now() - prepareStarted,
    },
    diagnose: !diagnosticReady ? null : async (input, level) => {
      if (level < 1) throw new Error("VIR stage profiling requires Lean level 1 or higher");
      const pagesBefore = wasmMemoryPages(runtime);
      const warmupOutput = runtime.call(config.entry, input, level);
      const matcher = runtime.callTimed(config.diagnostic.matcherEntry, input, level);
      const packedTokens = matcher.value;
      const base = runtime.callTimed(
        config.diagnostic.baseEntry,
        input,
        packedTokens,
      );
      const directEntry = config.diagnostic.levelEntries[String(level)] ?? null;
      const direct = directEntry !== null && runtime.findManifestEntry(directEntry) !== null
        ? runtime.callTimed(directEntry, input)
        : null;
      const optimalEntry = config.diagnostic.optimalEntries[String(level)] ?? null;
      const optimal = optimalEntry !== null && runtime.findManifestEntry(optimalEntry) !== null
        ? runtime.callTimed(optimalEntry, input)
        : null;
      const whole = runtime.callTimed(config.entry, input, level);
      return {
        inputBytes: input.byteLength,
        outputBytes: whole.value.byteLength,
        packedBytes: packedTokens.byteLength,
        tokens: packedTokens.byteLength / 4,
        matcher: matcher.timings,
        base: base.timings,
        baseOutputBytes: String(base.value),
        direct: direct?.timings ?? null,
        directEntry,
        directMatchesWhole: direct === null ? null : bytesEqual(direct.value, whole.value),
        optimal: optimal?.timings ?? null,
        optimalEntry,
        optimalOutputBytes: optimal?.value?.byteLength ?? null,
        whole: whole.timings,
        warmupMatchesWhole: bytesEqual(warmupOutput, whole.value),
        pagesBefore,
        pagesAfter: wasmMemoryPages(runtime),
      };
    },
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

function requireFirResult(result, sourceName) {
  if (result === null || typeof result !== "object") {
    throw new Error(`${sourceName} adapter returned a non-object result`);
  }
  const bytes = result.bytes instanceof Uint8Array
    ? result.bytes
    : result.bytes instanceof ArrayBuffer
      ? new Uint8Array(result.bytes)
      : null;
  if (bytes === null) throw new Error(`${sourceName} adapter did not return bytes`);
  const timings = result.timings;
  for (const name of ["encodeMs", "executeMs", "decodeMs", "totalMs"]) {
    if (!Number.isFinite(timings?.[name]) || timings[name] < 0) {
      throw new Error(`${sourceName} adapter returned an invalid ${name}`);
    }
  }
  if (!Number.isFinite(result.memory?.pages) || result.memory.pages < 0) {
    throw new Error(`${sourceName} adapter returned invalid memory telemetry`);
  }
  return { ...result, bytes };
}

async function prepareFirNative(config) {
  const prepareStarted = performance.now();
  let started = prepareStarted;
  const [adapterModule, wasmResponse, descriptorResponse] = await Promise.all([
    import(config.adapterUrl),
    fetch(config.wasmUrl, { cache: "no-store" }),
    fetch(config.descriptorUrl, { cache: "no-store" }),
  ]);
  for (const response of [wasmResponse, descriptorResponse]) {
    if (!response.ok) throw new Error(`FIR artifact fetch failed: HTTP ${response.status}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
  const descriptorBytes = await descriptorResponse.arrayBuffer();
  const descriptor = JSON.parse(new TextDecoder().decode(descriptorBytes));
  const acquireMs = performance.now() - started;
  started = performance.now();
  const module = await WebAssembly.compile(wasmBytes);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error(`${config.sourceName} module is not zero-import`);
  }
  const compileMs = performance.now() - started;
  started = performance.now();
  const createAdapter = adapterModule[config.factoryExport];
  if (typeof createAdapter !== "function") {
    throw new Error(`FIR adapter does not export ${config.factoryExport}`);
  }
  const adapter = await createAdapter({ module, descriptor });
  if (!(adapter?.memory instanceof WebAssembly.Memory) ||
      typeof adapter[config.operation] !== "function") {
    throw new Error(`FIR adapter does not implement ${config.operation}`);
  }
  const adapterPrepareMs = performance.now() - started;
  const initialization = adapter.initialization ?? null;
  if (config.persistentInitializer !== null) {
    if (initialization?.entry !== config.persistentInitializer ||
        !Number.isFinite(initialization.initializeMs) ||
        !Number.isFinite(initialization.idempotenceMs) ||
        initialization.checkpoint < initialization.initialFrontier) {
      throw new Error(`${config.sourceName} adapter did not initialize persistent caches`);
    }
  }
  const reservedMemoryBytes =
    config.completeRuntime?.externalRuntime?.reservedMemoryBytes;
  if (reservedMemoryBytes !== undefined &&
      (initialization?.reservedFrontier !== reservedMemoryBytes ||
        initialization.initialFrontier !== reservedMemoryBytes)) {
    throw new Error(`${config.sourceName} adapter did not reserve its external runtime memory`);
  }
  const initializeMs = initialization?.initializeMs ?? 0;
  const idempotenceMs = initialization?.idempotenceMs ?? 0;
  const instantiateMs = Math.max(0,
    adapterPrepareMs - initializeMs - idempotenceMs);
  let memoryPages = adapter.memory.buffer.byteLength / 65536;
  const call = (input, level) => {
    if (!config.expectedLevels.includes(level)) {
      throw new Error(`${config.sourceName} does not support Lean level ${level}`);
    }
    const operationArguments = config.levelArgument
      ? [input, level]
      : [input];
    const result = requireFirResult(
      adapter[config.operation](...operationArguments), config.sourceName);
    memoryPages = result.memory.pages;
    return result;
  };
  return {
    artifactBytes: wasmBytes.byteLength + descriptorBytes.byteLength,
    profile: config.profile,
    compress: (input, level) => call(input, level).bytes,
    compressTimed: (input, level) => {
      const result = call(input, level);
      return {
        value: result.bytes,
        timings: {
          marshalMs: result.timings.encodeMs,
          executeMs: result.timings.executeMs,
          decodeMs: result.timings.decodeMs,
          hostMs: 0,
          totalMs: result.timings.totalMs,
        },
        details: { arena: result.memory },
      };
    },
    preparePhases: {
      acquireMs,
      compileMs,
      instantiateMs,
      initializeMs,
      idempotenceMs,
      packageLoadMs: 0,
      totalMs: performance.now() - prepareStarted,
    },
    memory: () => memoryPages,
  };
}

async function prepare(config) {
  const started = performance.now();
  if (backendId === "vir") prepared = await prepareVir(config);
  else if (["fir-native", "fir-level1", "fir-raw"].includes(backendId)) {
    prepared = await prepareFirNative(config);
  }
  else if (backendId === "compression-stream") prepared = await prepareCompressionStream();
  else if (backendId === "fflate") prepared = await prepareFflate();
  else throw new Error(`${backendId} is not a browser-worker backend`);
  return {
    prepareMs: performance.now() - started,
    preparePhases: prepared.preparePhases ?? null,
    artifactBytes: prepared.artifactBytes,
    wasmPages: prepared.memory(),
  };
}

async function compressOnce(input, level) {
  if (prepared.compressTimed !== undefined) {
    const { value, timings, details = null } = await prepared.compressTimed(input, level);
    return {
      output: value instanceof Uint8Array ? value : new Uint8Array(value),
      phases: timings,
      details,
    };
  }
  const output = await prepared.compress(input, level);
  return {
    output: output instanceof Uint8Array ? output : new Uint8Array(output),
    phases: null,
    details: null,
  };
}

async function run(inputBuffer, settings) {
  if (prepared === null) throw new Error("backend has not been prepared");
  const input = new Uint8Array(inputBuffer);
  const memoryPagesBefore = prepared.memory();
  const primeLazyCaches = backendId === "fir-raw" &&
    prepared.profile === "resident-raw-v2";

  let primingMs = null;
  let primingPhases = null;
  let primingDetails = null;
  let memoryPagesAfterPriming = memoryPagesBefore;
  let output = new Uint8Array();
  let checksum = 0;
  if (primeLazyCaches) {
    const primingStarted = performance.now();
    const priming = await compressOnce(input, settings.level);
    primingMs = performance.now() - primingStarted;
    primingPhases = priming.phases;
    primingDetails = priming.details;
    memoryPagesAfterPriming = prepared.memory();
    output = priming.output;
    checksum += output.byteLength;
  }

  const requireFlatCache = (call, label) => {
    if (primeLazyCaches && call.details?.arena?.persistentGrowth !== 0) {
      throw new Error(`${backend.name} ${label} populated a lazy cache after priming`);
    }
  };

  let started = performance.now();
  let call = await compressOnce(input, settings.level);
  requireFlatCache(call, "first measured call");
  const firstCallMs = performance.now() - started;
  output = call.output;
  const firstCallPhases = call.phases;
  const firstCallDetails = call.details;
  const memoryPagesAfterFirst = prepared.memory();

  checksum += output.byteLength;
  for (let call = 0; call < settings.warmups; call += 1) {
    const warmup = await compressOnce(input, settings.level);
    requireFlatCache(warmup, `warmup ${call + 1}`);
    output = warmup.output;
    checksum += output.byteLength;
  }
  const memoryPagesAfterWarmups = prepared.memory();

  const sampleMs = [];
  const phaseSamples = [];
  const memoryPageSamples = [];
  const sampleDetails = [];
  for (let sample = 0; sample < settings.samples; sample += 1) {
    const phaseTotals = {};
    started = performance.now();
    for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
      call = await compressOnce(input, settings.level);
      requireFlatCache(call, `sample ${sample + 1} iteration ${iteration + 1}`);
      output = call.output;
      if (call.phases !== null) {
        for (const [name, value] of Object.entries(call.phases)) {
          phaseTotals[name] = (phaseTotals[name] ?? 0) + value;
        }
      }
      checksum += output.byteLength;
    }
    sampleMs.push((performance.now() - started) / settings.iterations);
    memoryPageSamples.push(prepared.memory());
    sampleDetails.push(call.details);
    if (Object.keys(phaseTotals).length > 0) {
      phaseSamples.push(Object.fromEntries(
        Object.entries(phaseTotals).map(([name, value]) => [name, value / settings.iterations]),
      ));
    }
  }

  const medianMs = median(sampleMs);
  const phaseMedians = phaseSamples.length === 0
    ? null
    : Object.fromEntries(Object.keys(phaseSamples[0]).map((name) => [
      name,
      median(phaseSamples.map((sample) => sample[name])),
    ]));
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
    primingMs,
    primingPhases,
    primingDetails,
    firstCallMs,
    firstCallPhases,
    firstCallDetails,
    sampleMs,
    phaseSamples,
    phaseMedians,
    sampleDetails,
    medianMs,
    mibPerSecond: mibPerSecond(input.byteLength, medianMs),
    checksum,
    memoryPagesBefore,
    memoryPagesAfterPriming,
    memoryPagesAfterFirst,
    memoryPagesAfterWarmups,
    memoryPageSamples,
    memoryPagesAfter: prepared.memory(),
    output: stableOutput,
  };
}

async function diagnose(inputBuffer, level) {
  if (prepared === null) throw new Error("backend has not been prepared");
  if (prepared.diagnose === null || prepared.diagnose === undefined) {
    throw new Error("VIR diagnostic package is unavailable");
  }
  return prepared.diagnose(new Uint8Array(inputBuffer), level);
}

self.addEventListener("message", async (event) => {
  const { id, type, value } = event.data;
  try {
    const result = type === "prepare"
      ? await prepare(value)
      : type === "run"
        ? await run(value.input, value.settings)
        : type === "diagnose"
          ? await diagnose(value.input, value.level)
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
