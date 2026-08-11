import {
  BACKENDS,
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  makeReport,
  normalizeRunSettings,
} from "./protocol.mjs";

const elements = Object.fromEntries([
  "input", "file", "source-label", "input-size", "level", "samples", "iterations", "run",
  "status", "backend-rows", "chart", "identity", "export", "isolation",
].map((id) => [id, document.getElementById(id)]));

const rowCells = new Map();
const clients = new Map();
let info = null;
let selectedFile = null;
let latestRun = null;

const colors = new Map([
  ["native", "#c7f36b"],
  ["vir", "#ff8a50"],
  ["compression-stream", "#65d8d2"],
  ["fflate", "#b59cff"],
  ["fir-emscripten", "#f1d27a"],
  ["fir-native", "#ff7b72"],
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
  return new TextEncoder().encode(elements.input.value);
}

function currentSettings() {
  return normalizeRunSettings({
    level: Number(elements.level.value),
    warmups: 0,
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
  const configuration = id === "vir" ? { ...info.runtime, entry: info.entry } : {};
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
    ["fflate", `${formatBytes(info.artifacts.fflate.bytes)} · ${info.artifacts.fflate.sha256.slice(0, 16)}…`],
  ];
  elements.identity.replaceChildren();
  for (const [term, description] of values) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    elements.identity.append(dt, dd);
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
  document.documentElement.dataset.runStatus = "running";
  const results = [];
  let failed = false;
  try {
    const input = await sourceBytes();
    if (input.byteLength > info.maxInputBytes) throw new Error(`input exceeds ${formatBytes(info.maxInputBytes)}`);
    const settings = currentSettings();
    const source = {
      kind: selectedFile === null ? "utf8" : "file",
      name: selectedFile?.name ?? "textarea",
      bytes: input.byteLength,
      sha256: await sha256(input),
    };
    elements.status.textContent = "Native Lean is establishing the reference stream…";
    for (const backend of BACKENDS) {
      const capability = backendCapability(backend.id);
      if (!capability.available) setState(backend.id, capability.reason, "pending");
      else setState(backend.id, "queued", "pending");
    }

    let nativeOutput = null;
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

    for (const id of ["vir", "compression-stream", "fflate"]) {
      if (!backendCapability(id).available) continue;
      elements.status.textContent = `${BACKENDS.find((backend) => backend.id === id).name} is running in its worker…`;
      try {
        const value = await runWorkerBackend(id, input, settings);
        const validation = await validateResult(input, value.output);
        const exactNative = value.family === "lean-zip"
          ? nativeOutput !== null && bytesEqual(value.output, nativeOutput)
          : null;
        const result = { ...value, valid: validation.valid, exactNative, sha256: validation.sha256 };
        results.push(result);
        renderResult(result, input.byteLength);
        if (!validation.valid || exactNative === false) failed = true;
      } catch (error) {
        failed = true;
        setState(id, error.message.split("\n")[0], "bad");
      }
    }

    renderChart(results, input.byteLength);
    latestRun = makeReport({ info, source, settings, results, userAgent: navigator.userAgent });
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
    elements.file.value = "";
    elements["source-label"].textContent = "text input";
    updateInputSize();
  });
  elements.file.addEventListener("change", () => {
    selectedFile = elements.file.files[0] ?? null;
    elements["source-label"].textContent = selectedFile?.name ?? "text input";
    updateInputSize();
  });
  elements.run.addEventListener("click", runComparison);
  elements.export.addEventListener("click", exportReport);
  updateInputSize();
  try {
    info = await responseJson(await fetch("/api/info", { cache: "no-store" }));
    renderIdentity();
    for (const backend of BACKENDS) {
      const capability = backendCapability(backend.id);
      setState(backend.id, capability.available ? "ready" : capability.reason, "pending");
    }
    elements.status.textContent = "Artifacts identified. Ready to run sequentially.";
    if (new URL(location.href).searchParams.get("autorun") === "1") {
      elements.samples.value = "1";
      await runComparison();
    }
  } catch (error) {
    elements.status.textContent = error.message;
    document.documentElement.dataset.runStatus = "failed";
  }
}

initialize();
