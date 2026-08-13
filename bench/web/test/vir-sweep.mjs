#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const take = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const csv = (name, fallback, parse = (value) => value) =>
  take(name, fallback).split(",").map((value) => parse(value.trim()));
const debugPort = Number(take("--debug-port", "9223"));
const baseUrl = new URL(take("--base-url", "http://127.0.0.1:4173/"));
const timeoutMs = Number(take("--timeout-ms", "300000"));
const backendId = take("--backend", "vir");
const cases = csv("--cases", "repeated,structured,random");
const sizes = csv("--sizes", "1024,16384,65536", Number);
const levels = csv("--levels", "0,1,6", Number);
const samples = Number(take("--samples", "5"));
const warmups = Number(take("--warmups", "3"));
const iterations = Number(take("--iterations", "1"));
const outputPath = take("--out");

if (!Number.isInteger(debugPort) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !["vir", "fir-native", "fir-level1", "fir-raw"].includes(backendId) ||
    ![1, 3, 5, 9].includes(samples) || ![0, 1, 3, 5, 10].includes(warmups) ||
    ![1, 3, 5, 10, 20].includes(iterations) ||
    cases.some((value) => !["editable", "repeated", "structured", "random", "zeros"]
      .includes(value)) ||
    sizes.some((value) => ![6, 83, 96, 256, 1024, 4096, 16384,
      65536, 262144, 1048576].includes(value)) ||
    levels.some((value) => !Number.isInteger(value) || value < 0 || value > 10)) {
  throw new Error("invalid sweep arguments");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const stability = (values) => {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  return {
    minimumMs: Math.min(...values),
    maximumMs: Math.max(...values),
    madMs: mad,
    relativeMad: center > 0 ? mad / center : null,
  };
};

async function findPage() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = pages.find((candidate) => candidate.type === "page");
      if (page !== undefined) {
        for (const sibling of pages) {
          if (sibling.type === "page" && sibling.id !== page.id) {
            await fetch(`http://127.0.0.1:${debugPort}/json/close/${sibling.id}`);
          }
        }
        return page;
      }
    } catch {
      // Chrome may still be starting.
    }
    await delay(100);
  }
  throw new Error("Chrome debugging page did not become available");
}

const page = await findPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function runCase(kind, bytes, level) {
  const url = new URL(baseUrl);
  if (kind !== "editable") {
    url.searchParams.set("case", kind);
    url.searchParams.set("bytes", String(bytes));
  }
  url.searchParams.set("level", String(level));
  url.searchParams.set("samples", String(samples));
  url.searchParams.set("warmups", String(warmups));
  url.searchParams.set("iterations", String(iterations));
  url.searchParams.set("backends", `native,${backendId}`);
  url.searchParams.set("autorun", "1");
  await command("Page.navigate", { url: url.href });
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(`({
        href: location.href,
        status: document.documentElement.dataset.runStatus || null,
      })`);
      if (state.href === url.href) {
        status = state.status;
        if (status === "complete" || status === "failed") break;
      }
    } catch {
      // Navigation temporarily destroys the execution context.
    }
    await delay(100);
  }
  if (status !== "complete") {
    let summary = "unavailable";
    try {
      summary = await evaluate("document.querySelector('#status')?.textContent ?? 'missing status'");
    } catch {
      // Retain the generic summary.
    }
    throw new Error(`${kind}/${bytes}/L${level} ${status ?? "timed out"}: ${summary}`);
  }
  const report = await evaluate("globalThis.__leanZipLatestReport");
  const expectedSource = kind === "editable" ? "textarea" : `${kind}-${bytes}`;
  if (report?.source?.name !== expectedSource || report?.source?.bytes !== bytes ||
      report?.settings?.level !== level) {
    throw new Error(`${kind}/${bytes}/L${level}: browser returned the wrong report`);
  }
  const native = report.results.find((result) => result.id === "native");
  const candidate = report.results.find((result) => result.id === backendId);
  if (native?.valid !== true || candidate?.valid !== true || candidate?.exactNative !== true) {
    throw new Error(`${kind}/${bytes}/L${level}: native/${backendId} correctness gate failed`);
  }
  const executeShare = candidate.phaseMedians?.totalMs > 0
    ? candidate.phaseMedians.executeMs / candidate.phaseMedians.totalMs
    : null;
  const row = {
    source: report.source,
    settings: report.settings,
    native,
    candidate,
    ratios: {
      candidateOverNative: native.medianMs > 0 ? candidate.medianMs / native.medianMs : null,
      coldOverWarm: candidate.medianMs > 0
        ? (candidate.primingMs ?? candidate.firstCallMs) / candidate.medianMs
        : null,
      executeShare,
    },
    stability: {
      native: stability(native.sampleMs),
      candidate: stability(candidate.sampleMs),
    },
  };
  if (backendId === "vir") {
    row.vir = candidate;
    row.ratios.virOverNative = row.ratios.candidateOverNative;
  } else if (backendId === "fir-native") {
    row.firNative = candidate;
    row.ratios.firNativeOverNative = row.ratios.candidateOverNative;
  } else if (backendId === "fir-level1") {
    row.firLevel1 = candidate;
    row.ratios.firLevel1OverNative = row.ratios.candidateOverNative;
  } else {
    row.firRaw = candidate;
    row.ratios.firRawOverNative = row.ratios.candidateOverNative;
  }
  delete row.candidate;
  const ratio = row.ratios.candidateOverNative?.toFixed(1) ?? "—";
  const share = executeShare === null ? "—" : `${(executeShare * 100).toFixed(1)}%`;
  const dispersion = row.stability.candidate.relativeMad === null
    ? "—"
    : `${(100 * row.stability.candidate.relativeMad).toFixed(1)}%`;
  console.log(
    `${kind.padEnd(10)} ${String(bytes).padStart(7)}B L${String(level).padStart(2)} ` +
    `native=${native.medianMs.toFixed(3).padStart(9)}ms ` +
    `${backendId}=${candidate.medianMs.toFixed(3).padStart(9)}ms ` +
    `overhead=${ratio.padStart(7)}x execute=${share} rMAD=${dispersion}`,
  );
  return { report, row };
}

await command("Runtime.enable");
await command("Page.enable");
const runs = [];
let identity = null;
try {
  for (const kind of cases) {
    for (const bytes of sizes) {
      for (const level of levels) {
        const { report, row } = await runCase(kind, bytes, level);
        const currentIdentity = JSON.stringify({
          artifacts: report.artifacts,
          repositories: report.repositories,
          userAgent: report.userAgent,
        });
        if (identity === null) identity = currentIdentity;
        else if (identity !== currentIdentity) throw new Error("artifact identity changed during sweep");
        runs.push(row);
      }
    }
  }
} finally {
  socket.close();
}

const identityValue = JSON.parse(identity);
const result = {
  format: `lean-zip-${backendId}-browser-sweep`,
  version: 1,
  generatedAt: new Date().toISOString(),
  matrix: { backend: backendId, cases, sizes, levels, samples, warmups, iterations },
  ...identityValue,
  runs,
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath === null) console.log(serialized);
else {
  await writeFile(outputPath, serialized);
  console.log(`wrote ${runs.length} verified runs to ${outputPath}`);
}
