import {
  BROWSER_BACKENDS,
  bytesEqual,
  median,
  normalizeRunSettings,
} from "./protocol.mjs";

const LEAN_BACKENDS = new Set(["vir", "fir-native", "fir-emscripten"]);
const LEVELS = Object.freeze(Array.from({ length: 10 }, (_, index) => index + 1));

class WorkerClient {
  constructor(backendId, workerModule) {
    const url = new URL(workerModule);
    url.searchParams.set("backend", backendId);
    this.worker = new Worker(url, { type: "module" });
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
      const error = event.error ?? new Error(event.message);
      for (const request of this.pending.values()) request.reject(error);
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

  dispose() {
    this.worker.terminate();
  }
}

async function responseJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status}`);
  return response.json();
}

async function responseBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function readInteger(id, fallback, minimum, maximum) {
  const value = Number(document.querySelector(`#${id}`)?.value ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${id} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function setState(label, state, detail) {
  const labelElement = document.querySelector("#app-state");
  const detailElement = document.querySelector("#app-progress");
  if (labelElement) {
    labelElement.textContent = label;
    labelElement.dataset.state = state;
  }
  if (detailElement) detailElement.textContent = detail;
}

function formatMs(value) {
  return value < 1 ? `${value.toFixed(3)} ms` : `${value.toFixed(1)} ms`;
}

function selectionForStudy(context, studyId, options, oracle) {
  const data = options?.test?.data ??
    (studyId === context.variant.benchmark.study
      ? context.variant.benchmark.data
      : {});
  const ids = data.vectors === "all"
    ? oracle.vectors.map(({ id }) => id)
    : data.vectors;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`${studyId} must select at least one native-oracle vector`);
  }
  const selected = ids.map((id) => {
    const vector = oracle.vectors.find((candidate) => candidate.id === id);
    if (!vector) throw new Error(`${studyId} references unknown vector ${id}`);
    return vector;
  });
  const backends = options?.test?.backends ??
    Array.from(document.querySelectorAll(
      '#backend-list input[type="checkbox"]:checked',
    ), (input) => input.value);
  if (!Array.isArray(backends) || backends.length < 2) {
    throw new Error("select at least two browser backends");
  }
  return { selected, backends };
}

function expectedFor(vector, level) {
  const expected = vector.expected.find((candidate) => candidate.level === level);
  if (!expected) throw new Error(`${vector.id} has no native oracle for level ${level}`);
  return expected;
}

function renderReport(report) {
  const reportList = document.querySelector("#report-list");
  if (!reportList) return;
  reportList.querySelector("#empty-results")?.remove();
  const article = document.createElement("article");
  article.className = "report-card";
  const heading = document.createElement("h3");
  heading.textContent = `${report.study} · ${report.passed ? "verified" : "mismatch"}`;
  const copy = document.createElement("p");
  copy.textContent = `${report.cells.length} workload cells · ${
    report.backendIds.length
  } browser backends`;
  const list = document.createElement("ul");
  for (const cell of report.cells) {
    const item = document.createElement("li");
    const medians = cell.results.map((result) =>
      `${result.backend}: ${formatMs(result.medianMs)}`).join(" · ");
    item.textContent = `${cell.vector} · level ${cell.level} · ${medians}`;
    list.appendChild(item);
  }
  article.append(heading, copy, list);
  reportList.prepend(article);
}

export async function loadCatalogExample(context) {
  const artifactRoot = new URL("../", import.meta.url);
  const workerModule = new URL("backend-worker.mjs", import.meta.url);
  const [sourceBuild, oracle, firNativeBuild, firEmscriptenManifest] =
    await Promise.all([
      responseJson(new URL("BUILD.json", import.meta.url)),
      responseJson(new URL("native-oracle.json", import.meta.url)),
      responseJson(new URL("fir-native/BUILD.json", artifactRoot)),
      responseJson(new URL(
        "fir-emscripten/lean-zip-emscripten.manifest.json",
        artifactRoot,
      )),
    ]);
  const { inflateSync } = await import(new URL("fflate.mjs", import.meta.url));
  const configurations = {
    vir: {
      runtimeUrl: new URL("vir/lean-vir/js/vir-runtime.js", artifactRoot).href,
      wasmUrl: new URL("vir/lean-vir/wasm/vir-upstream.wasm", artifactRoot).href,
      packageUrls: [new URL("vir/lean-zip.irpkg", artifactRoot).href],
      entry: "VirLeanZipAcceptance.compressRaw",
      profile: "client-native",
      diagnostic: null,
    },
    "fir-native": {
      adapterUrl: new URL(
        "fir-native/lean-zip-raw-browser-adapter.mjs",
        artifactRoot,
      ).href,
      wasmUrl: new URL("fir-native/lean-zip-raw.wasm", artifactRoot).href,
      descriptorUrl: new URL(
        "fir-native/lean-zip-raw.wasm.json",
        artifactRoot,
      ).href,
      factoryExport: "createLeanZipRawAdapter",
      operation: "compressRaw",
      levelArgument: true,
      expectedLevels: LEVELS,
      sourceName: "Zip.Wasm.compressRaw",
      profile: "resident-raw-v2",
      persistentInitializer: null,
      completeRuntime: firNativeBuild.capabilities?.completeRuntime ?? null,
    },
    "fir-emscripten": {
      adapterUrl: new URL(
        "fir-emscripten/lean-zip-emscripten-adapter.mjs",
        artifactRoot,
      ).href,
      manifestUrl: new URL(
        "fir-emscripten/lean-zip-emscripten.manifest.json",
        artifactRoot,
      ).href,
      factoryExport: "loadLeanZipEmscriptenAdapter",
      operation: "compressRaw",
      expectedLevels: LEVELS,
      sourceName: "Zip.Wasm.compressRaw",
      artifactBytes:
        firEmscriptenManifest.artifacts.module.byteLength +
        firEmscriptenManifest.artifacts.wasm.byteLength,
    },
    "compression-stream": {},
    fflate: { moduleUrl: new URL("fflate.mjs", import.meta.url).href },
  };
  const states = new Map(
    BROWSER_BACKENDS.map((backend) => [backend.id, {
      id: backend.id,
      label: backend.name,
      status: "loading",
      client: null,
    }]),
  );

  function renderBackends() {
    const root = document.querySelector("#backend-list");
    if (!root) return;
    const selected = new Set(Array.from(root.querySelectorAll(
      'input[type="checkbox"]:checked',
    ), (input) => input.value));
    root.replaceChildren();
    for (const backend of states.values()) {
      const label = document.createElement("label");
      label.className = "backend-card";
      label.dataset.backend = backend.id;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = backend.id;
      input.checked = selected.size === 0 || selected.has(backend.id);
      input.disabled = backend.status !== "ready";
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = backend.label;
      const id = document.createElement("code");
      id.textContent = backend.id;
      const status = document.createElement("em");
      status.textContent = backend.status;
      status.dataset.state = backend.status;
      text.append(name, id);
      label.append(input, text, status);
      root.appendChild(label);
    }
  }

  async function prepareBackend(backend) {
    const client = new WorkerClient(backend.id, workerModule);
    backend.client = client;
    try {
      await client.request("prepare", configurations[backend.id]);
      backend.status = "ready";
    } catch (error) {
      backend.status = error instanceof Error ? error.message.split("\n")[0] : "failed";
      client.dispose();
      backend.client = null;
    }
  }

  renderBackends();
  const ready = Promise.all(Array.from(states.values(), prepareBackend)).then(() => {
    renderBackends();
    const readyCount = Array.from(states.values()).filter(
      ({ status }) => status === "ready",
    ).length;
    setState(
      readyCount === states.size ? "Ready" : "Degraded",
      readyCount === states.size ? "ready" : "failed",
      `${readyCount}/${states.size} browser backends available`,
    );
    return { readyCount, backendCount: states.size };
  });

  let running = false;
  let latestReport = null;
  async function runStudy(studyId, options = {}) {
    await ready;
    if (running) throw new Error("a lean-zip study is already running");
    running = true;
    setState("Running", "running", `Running ${studyId}…`);
    try {
      const { selected, backends } = selectionForStudy(
        context,
        studyId,
        options,
        oracle,
      );
      for (const id of backends) {
        if (states.get(id)?.status !== "ready") {
          throw new Error(`${studyId} requires unavailable backend ${id}`);
        }
      }
      const settings = normalizeRunSettings({
        level: 1,
        warmups: readInteger("warmup", 1, 0, 10),
        iterations: readInteger("iterations", 1, 1, 20),
        samples: readInteger("samples", 3, 1, 20),
      });
      const cells = [];
      let passed = true;
      for (const vector of selected) {
        const input = await responseBytes(new URL(vector.input.file.replace(
          "workload/",
          "",
        ), import.meta.url));
        for (const expected of vector.expected) {
          if (Array.isArray(options?.test?.data?.levels) &&
              !options.test.data.levels.includes(expected.level)) continue;
          const native = await responseBytes(new URL(expected.file.replace(
            "workload/",
            "",
          ), import.meta.url));
          const results = [];
          for (const id of backends) {
            const copy = input.slice();
            const value = await states.get(id).client.request("run", {
              input: copy.buffer,
              settings: { ...settings, level: expected.level },
            }, [copy.buffer]);
            const inflated = inflateSync(value.output);
            const valid = bytesEqual(inflated, input);
            const exactNative = LEAN_BACKENDS.has(id)
              ? bytesEqual(value.output, native)
              : null;
            passed &&= valid && exactNative !== false;
            results.push({
              backend: id,
              outputBytes: value.output.byteLength,
              outputSha256: await sha256(value.output),
              valid,
              exactNative,
              firstCallMs: value.firstCallMs,
              sampleMs: value.sampleMs,
              medianMs: median(value.sampleMs),
              phaseMedians: value.phaseMedians,
            });
          }
          cells.push({ vector: vector.id, level: expected.level, results });
        }
      }
      latestReport = {
        schemaVersion: 1,
        kind: "lean-zip/browser-benchmark-report",
        generatedAt: new Date().toISOString(),
        study: studyId,
        passed,
        backendIds: [...backends],
        examplePackage: {
          example: context.example.id,
          variant: context.variant.id,
          test: options?.test?.id ?? null,
          testPackage: context.testPackageIdentity,
        },
        source: sourceBuild.source,
        settings: {
          warmups: settings.warmups,
          iterations: settings.iterations,
          samples: settings.samples,
        },
        cells,
        caveats: [
          "Interactive measurements from this machine are diagnostic only.",
          "Native Lean supplies build-time oracle bytes and is not timed in the browser.",
          "FIR-native and FIR C/Emscripten are distinct compiler routes.",
        ],
      };
      renderReport(latestReport);
      const download = document.querySelector("#download-results");
      const clear = document.querySelector("#clear-results");
      if (download) download.disabled = false;
      if (clear) clear.disabled = false;
      setState(
        passed ? "Complete" : "Mismatch",
        passed ? "ready" : "failed",
        `${cells.length} workload cells checked`,
      );
      return latestReport;
    } finally {
      running = false;
    }
  }

  document.querySelectorAll("[data-study]").forEach((button) => {
    button.addEventListener("click", () => {
      runStudy(button.dataset.study).catch((error) => {
        setState("Failed", "failed", error instanceof Error ? error.message : String(error));
      });
    });
  });
  const download = document.querySelector("#download-results");
  download?.addEventListener("click", () => {
    if (latestReport === null) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(
      [`${JSON.stringify(latestReport, null, 2)}\n`],
      { type: "application/json" },
    ));
    link.download = "lean-zip-browser-report.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  document.querySelector("#clear-results")?.addEventListener("click", () => {
    latestReport = null;
    document.querySelector("#report-list")?.replaceChildren();
    if (download) download.disabled = true;
    const clear = document.querySelector("#clear-results");
    if (clear) clear.disabled = true;
  });
  const load = document.querySelector("#load-results");
  if (load) load.disabled = true;

  return {
    ready,
    getBackends: () => Array.from(states.values(), ({ id, label, status }) => ({
      id,
      label,
      status,
    })),
    runStudy,
    dispose: () => {
      for (const backend of states.values()) backend.client?.dispose();
    },
  };
}
