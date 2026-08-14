#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
};
const packetPaths = {
  firRaw: take("--fir-raw").split(","),
  firEmscripten: take("--fir-c").split(","),
};
const outputPath = take("--out");

if (packetPaths.firRaw.length !== 2 || packetPaths.firEmscripten.length !== 2 ||
    Object.values(packetPaths).some((paths) => paths.some((path) => path === ""))) {
  throw new Error("--fir-raw and --fir-c each require the two packets from an ABBA run");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stability = (values) => {
  const center = median(values);
  const madMs = median(values.map((value) => Math.abs(value - center)));
  return {
    minimumMs: Math.min(...values),
    maximumMs: Math.max(...values),
    madMs,
    relativeMad: center > 0 ? madMs / center : null,
  };
};
const stableJson = (value) => JSON.stringify(value);

async function readPackets(paths, backend, candidateField) {
  return Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    const packet = JSON.parse(bytes);
    if (packet.format !== `lean-zip-${backend}-browser-sweep` || packet.version !== 1 ||
        packet.matrix?.backend !== backend || !Array.isArray(packet.runs)) {
      throw new Error(`${path}: not a ${backend} browser sweep`);
    }
    for (const run of packet.runs) {
      const candidate = run[candidateField];
      if (candidate?.valid !== true || candidate.exactNative !== true ||
          !Array.isArray(candidate.sampleMs) || candidate.sampleMs.length === 0) {
        throw new Error(`${path}: failed ${backend} correctness/sample gate`);
      }
    }
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes), packet };
  }));
}

const inputs = {
  firRaw: await readPackets(packetPaths.firRaw, "fir-raw", "firRaw"),
  firEmscripten: await readPackets(
    packetPaths.firEmscripten,
    "fir-emscripten",
    "firEmscripten",
  ),
};
const allInputs = [...inputs.firRaw, ...inputs.firEmscripten];
const baseline = allInputs[0].packet;
const matrixShape = ({ cases, sizes, levels, samples, warmups, iterations }) => ({
  cases, sizes, levels, samples, warmups, iterations,
});
const expectedMatrix = stableJson(matrixShape(baseline.matrix));
const expectedIdentity = stableJson({
  artifacts: baseline.artifacts,
  repositories: baseline.repositories,
  userAgent: baseline.userAgent,
});
for (const { path, packet } of allInputs.slice(1)) {
  if (stableJson(matrixShape(packet.matrix)) !== expectedMatrix) {
    throw new Error(`${path}: sweep matrix differs from the first packet`);
  }
  if (stableJson({
    artifacts: packet.artifacts,
    repositories: packet.repositories,
    userAgent: packet.userAgent,
  }) !== expectedIdentity) {
    throw new Error(`${path}: artifact/browser identity differs from the first packet`);
  }
}
if (baseline.matrix.levels.length !== 1) {
  throw new Error("scaling summary requires exactly one compression level");
}

function findRun(input, kind, bytes) {
  const run = input.packet.runs.find((candidate) =>
    candidate.source?.name === `${kind}-${bytes}` &&
    candidate.source?.bytes === bytes &&
    candidate.settings?.level === baseline.matrix.levels[0]);
  if (run === undefined) throw new Error(`${input.path}: missing ${kind}/${bytes}`);
  return run;
}

const rows = [];
for (const kind of baseline.matrix.cases) {
  let previous = null;
  for (const bytes of baseline.matrix.sizes) {
    const rawRuns = inputs.firRaw.map((input) => findRun(input, kind, bytes));
    const cRuns = inputs.firEmscripten.map((input) => findRun(input, kind, bytes));
    const rawOutput = rawRuns[0].firRaw;
    const cOutput = cRuns[0].firEmscripten;
    if (rawOutput.sha256 !== cOutput.sha256 || rawOutput.outputBytes !== cOutput.outputBytes ||
        [...rawRuns, ...cRuns].some((run) => {
          const candidate = run.firRaw ?? run.firEmscripten;
          return candidate.sha256 !== rawOutput.sha256 ||
            candidate.outputBytes !== rawOutput.outputBytes;
        })) {
      throw new Error(`${kind}/${bytes}: FIR native and FIR-C output identities differ`);
    }
    const rawSamples = rawRuns.flatMap((run) => run.firRaw.sampleMs);
    const cSamples = cRuns.flatMap((run) => run.firEmscripten.sampleMs);
    const rawMedian = median(rawSamples);
    const cMedian = median(cSamples);
    const row = {
      case: kind,
      bytes,
      level: baseline.matrix.levels[0],
      outputBytes: rawOutput.outputBytes,
      outputSha256: rawOutput.sha256,
      firRaw: {
        samples: rawSamples,
        medianMs: rawMedian,
        mibPerSecond: bytes / (1024 * 1024) / (rawMedian / 1000),
        stability: stability(rawSamples),
        growth: previous === null ? null : rawMedian / previous.firRaw.medianMs,
      },
      firEmscripten: {
        samples: cSamples,
        medianMs: cMedian,
        mibPerSecond: bytes / (1024 * 1024) / (cMedian / 1000),
        stability: stability(cSamples),
        growth: previous === null ? null : cMedian / previous.firEmscripten.medianMs,
      },
      firRawOverFirEmscripten: rawMedian / cMedian,
    };
    if (previous !== null) {
      const inputGrowth = bytes / previous.bytes;
      row.firRaw.localExponent = Math.log(row.firRaw.growth) / Math.log(inputGrowth);
      row.firEmscripten.localExponent =
        Math.log(row.firEmscripten.growth) / Math.log(inputGrowth);
    }
    rows.push(row);
    previous = row;
  }
}

const result = {
  format: "lean-zip-fir-browser-scaling-summary",
  version: 1,
  generatedAt: new Date().toISOString(),
  method: {
    packetOrder: ["fir-raw", "fir-emscripten", "fir-emscripten", "fir-raw"],
    aggregation: "median of all measured samples; first calls and warmups excluded",
    packetPairsPerBackend: packetPaths.firRaw.length,
  },
  matrix: matrixShape(baseline.matrix),
  artifacts: baseline.artifacts,
  repositories: baseline.repositories,
  userAgent: baseline.userAgent,
  inputs: {
    firRaw: inputs.firRaw.map(({ packet: _packet, ...identity }) => identity),
    firEmscripten: inputs.firEmscripten.map(({ packet: _packet, ...identity }) => identity),
  },
  rows,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

for (const row of rows) {
  const rawGrowth = row.firRaw.growth === null ? "—" : `${row.firRaw.growth.toFixed(2)}x`;
  const cGrowth = row.firEmscripten.growth === null
    ? "—"
    : `${row.firEmscripten.growth.toFixed(2)}x`;
  console.log(
    `${row.case.padEnd(10)} ${String(row.bytes).padStart(7)}B ` +
    `FIR=${row.firRaw.medianMs.toFixed(3).padStart(9)}ms (${rawGrowth.padStart(6)}) ` +
    `FIR-C=${row.firEmscripten.medianMs.toFixed(3).padStart(8)}ms (${cGrowth.padStart(6)}) ` +
    `ratio=${row.firRawOverFirEmscripten.toFixed(1)}x`,
  );
}
console.log(`wrote ${rows.length} paired scaling rows to ${outputPath}`);
