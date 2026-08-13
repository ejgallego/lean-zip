import {
  BACKENDS,
  BENCHMARK_INPUTS,
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  capabilityForInputSize,
  makeReport,
  makeBenchmarkInput,
  normalizeRunSettings,
} from "./protocol.mjs";

const elements = Object.fromEntries([
  "input", "file", "source-label", "input-size", "preset", "preset-size", "level", "samples", "warmups", "iterations", "run",
  "status", "backend-rows", "chart", "identity", "export", "isolation",
  "vir-phase-status", "vir-phase-metrics",
  "diagnostic-run", "diagnostic-status", "diagnostic-metrics",
].map((id) => [id, document.getElementById(id)]));

const rowCells = new Map();
const clients = new Map();
let info = null;
let selectedFile = null;
let generatedInput = null;
let generatedName = null;
let latestRun = null;
let latestDiagnostic = null;
const pageQuery = new URL(location.href).searchParams;
const requestedBackends = pageQuery.get("backends");
const enabledBackendIds = requestedBackends === null
  ? new Set(BACKENDS.map((backend) => backend.id))
  : new Set(requestedBackends.split(",").filter((id) => BACKENDS.some((backend) => backend.id === id)));

const colors = new Map([
  ["native", "#c7f36b"],
  ["vir", "#ff8a50"],
  ["compression-stream", "#65d8d2"],
  ["fflate", "#b59cff"],
  ["fir-emscripten", "#f1d27a"],
  ["fir-native", "#ff7b72"],
  ["fir-level1", "#ffb86b"],
  ["fir-raw", "#f1d27a"],
]);

class WorkerClient {
  constructor(backendId) {
    this.worker = new Worker(`/backend-worker.mjs?backend=${encodeURIComponent(backendId)}`, { type: "module" });
    this.nextId = 1;
    this.pending = new Map();
    this.worker.addEventListener("message", (event) => {
      const request = this.pending.get(event.data.id);
      if (request === undefined) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) request.resolve(event.data.value);
      else request.reject(new Error(event.data.error));
    });
    this.worker.addEventListener("error", (event) => {
      for (const request of this.pending.values()) request.reject(event.error ?? new Error(event.message));
      this.pending.clear();
    });
  }

  request(type, value, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, value }, transfer);
    });
  }
}

function backendCapability(id) {
  return info?.backends.find((backend) => backend.id === id) ?? {
    id,
    available: false,
    reason: "backend metadata unavailable",
  };
}

function capabilityForLevel(id, level) {
  const capability = backendCapability(id);
  if (!enabledBackendIds.has(id)) {
    return { ...capability, available: false, reason: "excluded from this run" };
  }
  if (!capability.available) return capability;
  if (Array.isArray(capability.levels) && !capability.levels.includes(level)) {
    return {
      ...capability,
      available: false,
      reason: `level ${level} not supported · select level ${capability.levels.join(" or ")}`,
    };
  }
  return capability;
}

function capabilityForRun(id, level, inputBytes) {
  return capabilityForInputSize(capabilityForLevel(id, level), inputBytes);
}

function createRows() {
  for (const backend of BACKENDS) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const nameStrong = document.createElement("span");
    nameStrong.className = "backend-name";
    nameStrong.textContent = backend.name;
    const kind = document.createElement("span");
    kind.className = "backend-kind";
    kind.textContent = backend.execution;
    name.append(nameStrong, kind);
    const setting = document.createElement("td");
    const size = document.createElement("td");
    const first = document.createElement("td");
    const steady = document.createElement("td");
    const throughput = document.createElement("td");
    const verification = document.createElement("td");
    verification.innerHTML = '<span class="state pending">waiting</span>';
    for (const cell of [setting, size, first, steady, throughput]) cell.textContent = "—";
    row.append(name, setting, size, first, steady, throughput, verification);
    elements["backend-rows"].append(row);
    rowCells.set(backend.id, { row, setting, size, first, steady, throughput, verification });
  }
}

function setState(id, label, className = "pending") {
  const cell = rowCells.get(id).verification;
  cell.replaceChildren();
  const state = document.createElement("span");
  state.className = `state ${className}`;
  state.textContent = label;
  cell.append(state);
}

function formatMs(value) {
  if (value === null || value === undefined) return "not captured";
  if (value < 0.01) return `${(value * 1000).toFixed(2)} µs`;
  if (value < 10) return `${value.toFixed(3)} ms`;
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatThroughput(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 0.01) return `${(value * 1024).toFixed(2)} KiB/s`;
  return `${value.toFixed(value < 10 ? 2 : 1)} MiB/s`;
}

function renderResult(result, inputBytes) {
  const cells = rowCells.get(result.id);
  const ratio = inputBytes === 0 ? 0 : result.output.byteLength / inputBytes;
  cells.setting.textContent = result.effectiveSetting;
  cells.size.textContent = `${formatBytes(result.output.byteLength)} / ${(ratio * 100).toFixed(1)}%`;
  cells.first.textContent = formatMs(result.firstCallMs);
  cells.steady.textContent = formatMs(result.medianMs);
  cells.throughput.textContent = formatThroughput(result.mibPerSecond);
  const detail = result.exactNative === null
    ? "inflate ✓"
    : result.exactNative
      ? "exact + inflate ✓"
      : "native mismatch";
  setState(result.id, detail, result.valid && result.exactNative !== false ? "good" : "bad");
}

function renderRuntimePhases(result) {
  const setup = result.preparation?.preparePhases;
  const priming = result.primingPhases;
  const first = result.firstCallPhases;
  const steady = result.phaseMedians;
  const lazyCachePriming = result.profile === "resident-raw-v2";
  const primingArena = result.primingDetails?.arena;
  const firstArena = result.firstCallDetails?.arena;
  const steadyArena = result.sampleDetails?.at(-1)?.arena;
  const phase = (value, name) => value === null || value === undefined
    ? "—"
    : formatMs(value[name]);
  const values = [
    ["Setup total", setup === null || setup === undefined ? "—" : formatMs(setup.totalMs)],
    ["Artifact acquisition", phase(setup, "acquireMs")],
    ["Wasm compilation", phase(setup, "compileMs")],
    ["Wasm instantiation", phase(setup, "instantiateMs")],
    ["Persistent initialization", phase(setup, "initializeMs")],
    ["Initializer idempotence check", phase(setup, "idempotenceMs")],
    ["IR package load", phase(setup, "packageLoadMs")],
    ...(lazyCachePriming ? [
      ["Workload lazy-cache priming", formatMs(result.primingMs)],
      ["Priming execute", phase(priming, "executeMs")],
      ["Priming marshal / decode", priming === null ? "—" : `${formatMs(priming.marshalMs)} / ${formatMs(priming.decodeMs)}`],
      ["Priming persistent cache growth",
        primingArena === undefined ? "—" : formatBytes(primingArena.persistentGrowth)],
    ] : []),
    [lazyCachePriming ? "First measured wall (post-prime)" : "Cold call wall",
      formatMs(result.firstCallMs)],
    [lazyCachePriming ? "First measured execute" : "Cold interpreter",
      phase(first, "executeMs")],
    [lazyCachePriming ? "First measured marshal / decode" : "Cold marshal / decode",
      first === null ? "—" : `${formatMs(first.marshalMs)} / ${formatMs(first.decodeMs)}`],
    ...(lazyCachePriming ? [
      ["First measured persistent growth",
        firstArena === undefined ? "—" : formatBytes(firstArena.persistentGrowth)],
    ] : []),
    ["Steady wall", formatMs(result.medianMs)],
    ["Steady interpreter", phase(steady, "executeMs")],
    ["Steady marshal / decode", steady === null ? "—" : `${formatMs(steady.marshalMs)} / ${formatMs(steady.decodeMs)}`],
    ["Steady host-native", phase(steady, "hostMs")],
    ...(lazyCachePriming ? [
      ["Steady persistent cache growth",
        steadyArena === undefined ? "—" : formatBytes(steadyArena.persistentGrowth)],
    ] : []),
    ["Wasm pages", lazyCachePriming
      ? `${result.memoryPagesBefore} → ${result.memoryPagesAfterPriming} after prime → ${result.memoryPagesAfter}`
      : `${result.memoryPagesBefore} → ${result.memoryPagesAfterFirst} → ${result.memoryPagesAfter}`],
  ];
  elements["vir-phase-metrics"].replaceChildren();
  for (const [term, description] of values) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    item.append(dt, dd);
    elements["vir-phase-metrics"].append(item);
  }
  elements["vir-phase-status"].textContent = lazyCachePriming
    ? `${result.name} primes Lean lazy caches with the selected workload before timing. Priming stays visible; every measured call is rejected unless persistent growth is zero.`
    : `${result.name} runtime timings are diagnostic; wall samples remain the headline benchmark.`;
}

async function responseJson(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function api(path, body) {
  return responseJson(await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sourceBytes() {
  if (selectedFile !== null) return new Uint8Array(await selectedFile.arrayBuffer());
  if (generatedInput !== null) return generatedInput;
  return new TextEncoder().encode(elements.input.value);
}

function applyPreset() {
  const kind = elements.preset.value;
  if (kind === "custom") {
    generatedInput = null;
    generatedName = null;
    elements["source-label"].textContent = "text input";
  } else {
    const size = Number(elements["preset-size"].value);
    generatedInput = makeBenchmarkInput(kind, size);
    generatedName = `${kind}-${size}`;
    selectedFile = null;
    elements.file.value = "";
    elements["source-label"].textContent = `${BENCHMARK_INPUTS.find((item) => item.id === kind).name} · generated`;
  }
  updateInputSize();
  clearDiagnostic();
}

function currentSettings() {
  return normalizeRunSettings({
    level: Number(elements.level.value),
    warmups: Number(elements.warmups.value),
    iterations: Number(elements.iterations.value),
    samples: Number(elements.samples.value),
  });
}

async function validateResult(input, output) {
  return api("/api/validate", { input: bytesToBase64(input), output: bytesToBase64(output) });
}

async function prepareBackend(id) {
  if (clients.has(id)) return clients.get(id);
  setState(id, "preparing", "running");
  const client = new WorkerClient(id);
  clients.set(id, client);
  const configuration = id === "vir"
    ? { ...info.runtime, entry: info.entry }
    : id === "fir-native"
        ? info.firNative
        : id === "fir-level1"
          ? info.firLevel1
          : id === "fir-raw"
            ? info.firRaw
          : {};
  try {
    const preparation = await client.request("prepare", configuration);
    client.preparation = preparation;
    setState(id, "ready", "pending");
    return client;
  } catch (error) {
    clients.delete(id);
    client.worker.terminate();
    throw error;
  }
}

async function runWorkerBackend(id, input, settings) {
  const client = await prepareBackend(id);
  setState(id, "running", "running");
  const copy = input.slice();
  const value = await client.request("run", { input: copy.buffer, settings }, [copy.buffer]);
  return { ...value, preparation: client.preparation };
}

function renderIdentity() {
  const values = [
    ["lean-zip", `${info.repositories.leanZip.head.slice(0, 12)}${info.repositories.leanZip.dirty ? " · dirty" : " · clean"}`],
    ["VIR", `${info.repositories.vir.head.slice(0, 12)}${info.repositories.vir.dirty ? " · dirty" : " · clean"}`],
    ["VIR profile", info.artifacts.virProfile],
    ["VIR runtime", `${info.artifacts.virRuntime.files} files · ${info.artifacts.virRuntime.sha256.slice(0, 16)}…`],
    ["VIR Wasm", `${formatBytes(info.artifacts.virWasm.bytes)} · ${info.artifacts.virWasm.sha256.slice(0, 16)}…`],
    ["IR package", `${info.artifacts.virPackageInput.members.length} member(s) · ${info.artifacts.virPackageInput.sha256.slice(0, 16)}…`],
    ["VIR stage profiles", "production acceptance package"],
    ["fflate", `${formatBytes(info.artifacts.fflate.bytes)} · ${info.artifacts.fflate.sha256.slice(0, 16)}…`],
  ];
  if (info.artifacts.firNative !== null) {
    values.push(
      ["FIR native", `${info.artifacts.firNative.firCommit.slice(0, 12)} · stored level 0`],
      ["FIR Wasm", `${formatBytes(info.artifacts.firNative.wasm.bytes)} · ${info.artifacts.firNative.wasm.sha256.slice(0, 16)}…`],
    );
  }
  if (info.artifacts.firLevel1 !== null) {
    values.push(
      ["FIR Level 1", `${info.artifacts.firLevel1.firCommit.slice(0, 12)} · production level 1`],
      ["FIR L1 Wasm", `${formatBytes(info.artifacts.firLevel1.wasm.bytes)} · ${info.artifacts.firLevel1.wasm.sha256.slice(0, 16)}…`],
    );
  }
  if (info.artifacts.firRaw !== null) {
    values.push(
      ["FIR levels 1–10", `${info.artifacts.firRaw.firCommit.slice(0, 12)} · production dispatcher`],
      ["FIR raw Wasm", `${formatBytes(info.artifacts.firRaw.wasm.bytes)} · ${info.artifacts.firRaw.wasm.sha256.slice(0, 16)}…`],
    );
  }
  elements.identity.replaceChildren();
  for (const [term, description] of values) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    elements.identity.append(dt, dd);
  }
}

function clearDiagnostic() {
  latestDiagnostic = null;
  elements["diagnostic-metrics"].replaceChildren();
  const available = info?.runtime.diagnostic !== null && Number(elements.level.value) >= 1;
  elements["diagnostic-run"].disabled = !available;
  elements["diagnostic-status"].textContent = available
    ? "Ready. Stages run after an explicit untimed warmup in the production VIR runtime."
    : "Stage profiling requires Lean level 1 or higher.";
}

function renderDiagnostic(value) {
  const share = (stage) => value.whole.executeMs <= 0
    ? null
    : 100 * stage.executeMs / value.whole.executeMs;
  const stage = (timing) => timing === null
    ? "not exposed at this level"
    : `${formatMs(timing.executeMs)} · ${share(timing).toFixed(1)}% of whole`;
  const remainder = value.whole.executeMs - value.matcher.executeMs - value.base.executeMs;
  const values = [
    ["Packed stream", `${value.tokens} tokens · ${formatBytes(value.packedBytes)}`],
    ["Whole compressor", formatMs(value.whole.executeMs)],
    ["Matcher", stage(value.matcher)],
    ["Base preparation", stage(value.base)],
    ["Direct level body", stage(value.direct)],
    ["Direct / whole bytes", value.directMatchesWhole === null
      ? "not exposed at this level"
      : value.directMatchesWhole ? "equal ✓" : "mismatch"],
    ["Optimal candidate", stage(value.optimal)],
    ["Non-additive remainder", formatMs(Math.max(0, remainder))],
    ["Warmup / whole bytes", value.warmupMatchesWhole ? "equal ✓" : "mismatch"],
    ["Wasm pages", `${value.pagesBefore} → ${value.pagesAfter}`],
  ];
  elements["diagnostic-metrics"].replaceChildren();
  for (const [term, description] of values) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    item.append(dt, dd);
    elements["diagnostic-metrics"].append(item);
  }
}

async function runVirDiagnostic() {
  elements["diagnostic-run"].disabled = true;
  elements.run.disabled = true;
  elements["diagnostic-status"].textContent = "Warming the package, then timing production stages in isolated VIR calls…";
  document.documentElement.dataset.diagnosticStatus = "running";
  try {
    if (info.runtime.diagnostic === null) throw new Error("VIR production stage exports are unavailable");
    const input = await sourceBytes();
    if (input.byteLength > info.maxInputBytes) throw new Error(`input exceeds ${formatBytes(info.maxInputBytes)}`);
    const level = Number(elements.level.value);
    const client = await prepareBackend("vir");
    const copy = input.slice();
    const value = await client.request("diagnose", { input: copy.buffer, level }, [copy.buffer]);
    latestDiagnostic = {
      kind: "vir-production-stage-profile",
      level,
      ...value,
    };
    renderDiagnostic(latestDiagnostic);
    if (latestRun !== null) latestRun.diagnostics = latestDiagnostic;
    const equal = value.warmupMatchesWhole && value.directMatchesWhole !== false;
    elements["diagnostic-status"].textContent = equal
      ? "Production stage profile complete. Isolated stages are attribution evidence, not additive wall time."
      : "A production stage output differed from the whole call; discard this profile.";
    document.documentElement.dataset.diagnosticStatus = equal ? "complete" : "failed";
  } catch (error) {
    elements["diagnostic-status"].textContent = error.message;
    document.documentElement.dataset.diagnosticStatus = "failed";
  } finally {
    elements["diagnostic-run"].disabled = info.runtime.diagnostic === null || Number(elements.level.value) < 1;
    elements.run.disabled = false;
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function renderChart(results, inputBytes) {
  const points = results.filter((result) => result.valid && result.mibPerSecond > 0);
  elements.chart.replaceChildren();
  if (points.length === 0) {
    const empty = svgElement("text", { x: 350, y: 180, "text-anchor": "middle", class: "empty-chart" });
    empty.textContent = "No verified timing points.";
    elements.chart.append(empty);
    return;
  }
  const left = 70;
  const right = 660;
  const top = 28;
  const bottom = 305;
  const ratios = points.map((result) => inputBytes === 0 ? 0 : result.output.byteLength / inputBytes * 100);
  const logs = points.map((result) => Math.log10(result.mibPerSecond));
  const minRatio = Math.max(0, Math.min(...ratios) - 8);
  const maxRatio = Math.max(minRatio + 10, Math.max(...ratios) + 8);
  const minLog = Math.floor(Math.min(...logs) - .3);
  const maxLog = Math.max(minLog + 1, Math.ceil(Math.max(...logs) + .3));
  const x = (value) => left + (Math.log10(value) - minLog) / (maxLog - minLog) * (right - left);
  const y = (value) => top + (value - minRatio) / (maxRatio - minRatio) * (bottom - top);

  for (let tick = minLog; tick <= maxLog; tick += 1) {
    const tickX = left + (tick - minLog) / (maxLog - minLog) * (right - left);
    elements.chart.append(svgElement("line", { x1: tickX, y1: top, x2: tickX, y2: bottom, class: "grid" }));
    const label = svgElement("text", { x: tickX, y: bottom + 24, "text-anchor": "middle" });
    label.textContent = `${10 ** tick} MiB/s`;
    elements.chart.append(label);
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = minRatio + (maxRatio - minRatio) * tick / 4;
    const tickY = y(ratio);
    elements.chart.append(svgElement("line", { x1: left, y1: tickY, x2: right, y2: tickY, class: "grid" }));
    const label = svgElement("text", { x: left - 12, y: tickY + 4, "text-anchor": "end" });
    label.textContent = `${ratio.toFixed(0)}%`;
    elements.chart.append(label);
  }
  const axis = svgElement("text", { x: (left + right) / 2, y: 352, "text-anchor": "middle", class: "axis-label" });
  axis.textContent = "steady throughput (log scale)";
  elements.chart.append(axis);
  for (const [index, result] of points.entries()) {
    const ratio = ratios[index];
    const pointX = x(result.mibPerSecond);
    const pointY = y(ratio);
    elements.chart.append(svgElement("circle", { cx: pointX, cy: pointY, r: 8, fill: colors.get(result.id) }));
    const labelPlacement = result.id === "fflate"
      ? { x: pointX - 12, y: pointY + 20, "text-anchor": "end" }
      : result.id === "compression-stream"
        ? { x: pointX + 12, y: pointY + 20, "text-anchor": "start" }
        : { x: pointX + 12, y: pointY - 11, "text-anchor": "start" };
    const label = svgElement("text", { ...labelPlacement, class: "point-label" });
    label.textContent = result.name;
    elements.chart.append(label);
  }
}

async function runComparison() {
  elements.run.disabled = true;
  elements.export.disabled = true;
  latestRun = null;
  globalThis.__leanZipLatestReport = null;
  elements["vir-phase-metrics"].replaceChildren();
  elements["vir-phase-status"].textContent = "Waiting for a VIR or FIR lane…";
  document.documentElement.dataset.runStatus = "running";
  const results = [];
  let failed = false;
  try {
    const input = await sourceBytes();
    if (input.byteLength > info.maxInputBytes) throw new Error(`input exceeds ${formatBytes(info.maxInputBytes)}`);
    const settings = currentSettings();
    const source = {
      kind: selectedFile !== null ? "file" : generatedInput !== null ? "generated" : "utf8",
      name: selectedFile?.name ?? generatedName ?? "textarea",
      bytes: input.byteLength,
      sha256: await sha256(input),
    };
    elements.status.textContent = "Native Lean is establishing the reference stream…";
    for (const backend of BACKENDS) {
      const capability = capabilityForRun(backend.id, settings.level, input.byteLength);
      if (!capability.available) setState(backend.id, capability.reason, "pending");
      else setState(backend.id, "queued", "pending");
    }

    let nativeOutput = null;
    if (capabilityForRun("native", settings.level, input.byteLength).available) {
      try {
        setState("native", "running", "running");
        const nativeValue = await api("/api/native/run", { input: bytesToBase64(input), ...settings });
        nativeOutput = base64ToBytes(nativeValue.output);
        const validation = await validateResult(input, nativeOutput);
        const native = { ...nativeValue, output: nativeOutput, valid: validation.valid, exactNative: true };
        results.push(native);
        renderResult(native, input.byteLength);
      } catch (error) {
        failed = true;
        setState("native", error.message, "bad");
      }
    }

    for (const id of ["vir", "fir-native", "fir-level1", "fir-raw",
      "compression-stream", "fflate"]) {
      if (!capabilityForRun(id, settings.level, input.byteLength).available) continue;
      elements.status.textContent = `${BACKENDS.find((backend) => backend.id === id).name} is running in its worker…`;
      try {
        const value = await runWorkerBackend(id, input, settings);
        const validation = await validateResult(input, value.output);
        const exactNative = value.family === "lean-zip"
          ? nativeOutput === null ? null : bytesEqual(value.output, nativeOutput)
          : null;
        const result = { ...value, valid: validation.valid, exactNative, sha256: validation.sha256 };
        results.push(result);
        renderResult(result, input.byteLength);
        if (["vir", "fir-native", "fir-level1", "fir-raw"].includes(id)) {
          renderRuntimePhases(result);
        }
        if (!validation.valid || exactNative === false) failed = true;
      } catch (error) {
        failed = true;
        setState(id, error.message.split("\n")[0], "bad");
      }
    }

    renderChart(results, input.byteLength);
    latestRun = makeReport({
      info,
      source,
      settings,
      results,
      diagnostics: latestDiagnostic,
      userAgent: navigator.userAgent,
    });
    globalThis.__leanZipLatestReport = latestRun;
    elements.export.disabled = false;
    elements.status.textContent = failed
      ? "Run completed with unavailable or failed lanes; inspect the verification column."
      : `Run complete · ${results.length} verified lanes · validation excluded from timing.`;
    document.documentElement.dataset.runStatus = failed ? "failed" : "complete";
  } catch (error) {
    failed = true;
    elements.status.textContent = error.message;
    document.documentElement.dataset.runStatus = "failed";
  } finally {
    elements.run.disabled = false;
  }
}

function exportReport() {
  if (latestRun === null) return;
  const blob = new Blob([`${JSON.stringify(latestRun, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lean-zip-web-comparison-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function updateInputSize() {
  sourceBytes().then((bytes) => {
    elements["input-size"].textContent = formatBytes(bytes.byteLength);
  });
}

async function initialize() {
  createRows();
  elements.isolation.textContent = crossOriginIsolated ? "cross-origin isolated" : "isolation unavailable";
  elements.isolation.classList.toggle("good", crossOriginIsolated);
  elements.input.addEventListener("input", () => {
    selectedFile = null;
    generatedInput = null;
    generatedName = null;
    elements.preset.value = "custom";
    elements.file.value = "";
    elements["source-label"].textContent = "text input";
    updateInputSize();
    clearDiagnostic();
  });
  elements.file.addEventListener("change", () => {
    selectedFile = elements.file.files[0] ?? null;
    generatedInput = null;
    generatedName = null;
    elements.preset.value = "custom";
    elements["source-label"].textContent = selectedFile?.name ?? "text input";
    updateInputSize();
    clearDiagnostic();
  });
  elements.preset.addEventListener("change", applyPreset);
  elements["preset-size"].addEventListener("change", () => {
    if (elements.preset.value !== "custom") applyPreset();
  });
  elements.level.addEventListener("change", () => {
    clearDiagnostic();
    if (info !== null) {
      const level = Number(elements.level.value);
      for (const backend of BACKENDS) {
        const capability = capabilityForLevel(backend.id, level);
        setState(backend.id, capability.available ? "ready" : capability.reason, "pending");
      }
    }
  });
  elements.run.addEventListener("click", runComparison);
  elements["diagnostic-run"].addEventListener("click", runVirDiagnostic);
  elements.export.addEventListener("click", exportReport);
  updateInputSize();
  try {
    info = await responseJson(await fetch("/api/info", { cache: "no-store" }));
    renderIdentity();
    clearDiagnostic();
    const query = pageQuery;
    const requestedLevel = query.get("level");
    if (requestedLevel !== null && /^(?:[0-9]|10)$/.test(requestedLevel)) {
      elements.level.value = requestedLevel;
    }
    const requestedInput = query.get("case");
    const requestedBytes = query.get("bytes");
    const requestedSize = Number(requestedBytes);
    if (BENCHMARK_INPUTS.some((item) => item.id === requestedInput) &&
        Number.isInteger(requestedSize) && requestedSize >= 0 &&
        requestedSize <= info.maxInputBytes) {
      elements.preset.value = requestedInput;
      if (["1024", "16384", "65536", "262144", "1048576"]
          .includes(requestedBytes)) {
        elements["preset-size"].value = requestedBytes;
        applyPreset();
      } else {
        generatedInput = makeBenchmarkInput(requestedInput, requestedSize);
        generatedName = `${requestedInput}-${requestedSize}`;
        selectedFile = null;
        elements.file.value = "";
        elements["source-label"].textContent =
          `${BENCHMARK_INPUTS.find((item) => item.id === requestedInput).name} · generated`;
        updateInputSize();
      }
    }
    if (["1", "3", "5", "9"].includes(query.get("samples"))) {
      elements.samples.value = query.get("samples");
    }
    if (["0", "1", "3", "5", "10"].includes(query.get("warmups"))) {
      elements.warmups.value = query.get("warmups");
    }
    if (["1", "3", "5", "10", "20"].includes(query.get("iterations"))) {
      elements.iterations.value = query.get("iterations");
    }
    clearDiagnostic();
    for (const backend of BACKENDS) {
      const capability = capabilityForLevel(backend.id, Number(elements.level.value));
      setState(backend.id, capability.available ? "ready" : capability.reason, "pending");
    }
    elements.status.textContent = "Artifacts identified. Ready to run sequentially.";
    if (query.get("autorun") === "1") {
      if (!query.has("samples")) elements.samples.value = "1";
      await runComparison();
    }
    if (query.get("diagnose") === "1") await runVirDiagnostic();
  } catch (error) {
    elements.status.textContent = error.message;
    document.documentElement.dataset.runStatus = "failed";
  }
}

initialize();
