import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const REPORT_FORMAT = "lean-zip-wasm-benchmark-report";
export const REPORT_VERSION = 1;
export const PLAN_FORMAT = "lean-zip-wasm-benchmark-plan";
export const PLAN_VERSION = 1;
export const NATIVE_SAMPLE_FORMAT = "lean-zip-wasm-native-samples";
export const NATIVE_SAMPLE_VERSION = 1;

export function requirePositiveInteger(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("median requires a nonempty array");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function mibPerSecond(inputBytes, nsPerCall) {
  if (nsPerCall <= 0) return null;
  return (inputBytes / (1024 * 1024)) / (nsPerCall / 1e9);
}

export function backendOrder(pass) {
  return pass % 2 === 0 ? ["native", "vir"] : ["vir", "native"];
}

export function byteChecksum(bytes) {
  return bytes.byteLength +
    (bytes.byteLength === 0 ? 0 : bytes[0]) +
    (bytes.byteLength === 0 ? 0 : bytes[bytes.byteLength - 1]);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function validateTiming(value, label, inherited = {}) {
  const timing = { ...inherited, ...requireObject(value ?? {}, label) };
  return {
    passes: requirePositiveInteger(timing.passes, `${label}.passes`),
    samples: requirePositiveInteger(timing.samples, `${label}.samples`),
    warmups: Number.isInteger(timing.warmups) && timing.warmups >= 0
      ? timing.warmups
      : (() => { throw new TypeError(`${label}.warmups must be a non-negative integer`); })(),
    iterations: requirePositiveInteger(timing.iterations, `${label}.iterations`),
  };
}

export function validatePlan(plan) {
  requireObject(plan, "benchmark plan");
  if (plan.format !== PLAN_FORMAT || plan.version !== PLAN_VERSION) {
    throw new TypeError(
      `unsupported benchmark plan ${JSON.stringify(plan.format)} version ${JSON.stringify(plan.version)}`,
    );
  }
  const defaultTiming = validateTiming(plan.timing, "benchmark plan timing");
  if (!Array.isArray(plan.suites) || plan.suites.length === 0) {
    throw new TypeError("benchmark plan must contain suites");
  }
  const suiteIds = new Set();
  const suites = plan.suites.map((suite, suiteIndex) => {
    requireObject(suite, `suite ${suiteIndex + 1}`);
    if (typeof suite.id !== "string" || suite.id === "" || suiteIds.has(suite.id)) {
      throw new TypeError(`suite ${suiteIndex + 1} has an invalid or duplicate id`);
    }
    suiteIds.add(suite.id);
    if (!Array.isArray(suite.workloads) || suite.workloads.length === 0) {
      throw new TypeError(`suite ${suite.id} must contain workloads`);
    }
    const timing = validateTiming(suite.timing, `suite ${suite.id} timing`, defaultTiming);
    const workloadIds = new Set();
    const workloads = suite.workloads.map((workload, workloadIndex) => {
      requireObject(workload, `suite ${suite.id} workload ${workloadIndex + 1}`);
      if (typeof workload.id !== "string" || workload.id === "" || workloadIds.has(workload.id)) {
        throw new TypeError(`suite ${suite.id} has an invalid or duplicate workload id`);
      }
      workloadIds.add(workload.id);
      if (!["micro", "focused", "representative"].includes(workload.class)) {
        throw new TypeError(`workload ${workload.id} has an invalid class`);
      }
      requireObject(workload.source, `workload ${workload.id} source`);
      if (workload.source.kind === "utf8") {
        if (typeof workload.source.value !== "string") {
          throw new TypeError(`workload ${workload.id} UTF-8 source must contain a string value`);
        }
      } else if (workload.source.kind === "file") {
        if (typeof workload.source.path !== "string" || workload.source.path === "") {
          throw new TypeError(`workload ${workload.id} file source must contain a path`);
        }
      } else {
        throw new TypeError(`workload ${workload.id} has an unsupported source kind`);
      }
      if (!Array.isArray(workload.levels) || workload.levels.length === 0 ||
          workload.levels.some((level) => !Number.isInteger(level) || level < 0 || level > 255)) {
        throw new TypeError(`workload ${workload.id} must contain UInt8 compression levels`);
      }
      const workloadTiming = validateTiming(
        workload.timing,
        `workload ${workload.id} timing`,
        timing,
      );
      return { ...workload, levels: [...new Set(workload.levels)], timing: workloadTiming };
    });
    return { ...suite, timing, workloads };
  });
  return { ...plan, timing: defaultTiming, suites };
}

export function validateNativeSampleReport(report, expected) {
  requireObject(report, "native sample report");
  requireObject(expected, "native sample expectation");
  if (report.format !== NATIVE_SAMPLE_FORMAT || report.version !== NATIVE_SAMPLE_VERSION) {
    throw new TypeError("native benchmark returned an incompatible report");
  }
  for (const field of [
    "level", "inputBytes", "outputBytes", "warmups", "iterations", "samples",
  ]) {
    if (report[field] !== expected[field]) {
      throw new TypeError(
        `native sample report ${field} mismatch: expected ${expected[field]}, got ${report[field]}`,
      );
    }
  }
  if (!Array.isArray(report.sampleNs) || report.sampleNs.length !== expected.samples ||
      report.sampleNs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("native sample report contains invalid sample timings");
  }
  const perCallChecksum = expected.outputChecksum;
  if (report.warmupChecksum !== perCallChecksum * expected.warmups) {
    throw new TypeError("native sample report warmup checksum mismatch");
  }
  if (!Array.isArray(report.sampleChecksums) ||
      report.sampleChecksums.length !== expected.samples ||
      report.sampleChecksums.some((value) => value !== perCallChecksum * expected.iterations)) {
    throw new TypeError("native sample report sample checksum mismatch");
  }
  return report;
}

export function selectSuite(plan, suiteId) {
  const suite = plan.suites.find((candidate) => candidate.id === suiteId);
  if (suite === undefined) throw new Error(`benchmark suite not found: ${suiteId}`);
  return suite;
}

export async function readPackageSet(descriptorPath) {
  const descriptorBytes = await readFile(descriptorPath);
  const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
  if (!Array.isArray(descriptor.packages) || descriptor.packages.length === 0) {
    throw new TypeError("Vir package-set descriptor contains no packages");
  }
  const base = dirname(descriptorPath);
  const members = [];
  for (const entry of descriptor.packages) {
    if (typeof entry.path !== "string" || entry.path === "") {
      throw new TypeError("Vir package-set descriptor contains an invalid member path");
    }
    const path = resolve(base, entry.path);
    const bytes = await readFile(path);
    members.push({ module: entry.module, role: entry.role, path, bytes, sha256: sha256(bytes) });
  }
  return {
    descriptorPath,
    descriptorBytes,
    descriptorSha256: sha256(descriptorBytes),
    descriptor,
    members,
    packageBytes: members.map((member) => member.bytes),
  };
}

export function aggregateRuns(runs, inputBytes) {
  const result = {};
  for (const backend of ["native", "vir"]) {
    const selected = runs.filter((run) => run.backend === backend).map((run) => run.nsPerCall);
    const medianNs = median(selected);
    result[backend] = {
      samples: selected.length,
      medianNs,
      medianMs: medianNs / 1e6,
      medianMiBPerSecond: mibPerSecond(inputBytes, medianNs),
    };
  }
  result.virToNativeTimeRatio = result.vir.medianNs / result.native.medianNs;
  return result;
}
