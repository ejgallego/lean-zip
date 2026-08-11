export const REPORT_FORMAT = "lean-zip-web-comparison-report";
export const REPORT_VERSION = 1;

export const BACKENDS = Object.freeze([
  {
    id: "native",
    name: "Native Lean",
    family: "lean-zip",
    execution: "server process",
    setting: (level) => `lean-zip level ${level}`,
  },
  {
    id: "vir",
    name: "Lean via VIR",
    family: "lean-zip",
    execution: "browser WebAssembly interpreter",
    setting: (level) => `lean-zip level ${level}`,
  },
  {
    id: "compression-stream",
    name: "CompressionStream",
    family: "browser-native",
    execution: "browser raw DEFLATE",
    setting: () => "browser default (no level API)",
  },
  {
    id: "fflate",
    name: "fflate",
    family: "javascript",
    execution: "browser JavaScript",
    setting: (level) => `fflate level ${Math.min(level, 9)}`,
  },
  {
    id: "fir-emscripten",
    name: "FIR C / Emscripten",
    family: "lean-zip",
    execution: "browser WebAssembly",
    setting: (level) => `lean-zip level ${level}`,
  },
  {
    id: "fir-native",
    name: "FIR native",
    family: "lean-zip",
    execution: "browser WebAssembly",
    setting: (level) => `lean-zip level ${level}`,
  },
]);

export function backendById(id) {
  const backend = BACKENDS.find((candidate) => candidate.id === id);
  if (backend === undefined) throw new Error(`unknown backend: ${id}`);
  return backend;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("median requires a nonempty array");
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("median values must be finite and non-negative");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function mibPerSecond(inputBytes, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return (inputBytes / (1024 * 1024)) / (milliseconds / 1000);
}

export function normalizeRunSettings(value) {
  const integer = (field, minimum, maximum) => {
    const parsed = Number(value?.[field]);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new TypeError(`${field} must be an integer in ${minimum}..${maximum}`);
    }
    return parsed;
  };
  return {
    level: integer("level", 0, 10),
    warmups: integer("warmups", 0, 10),
    iterations: integer("iterations", 1, 100),
    samples: integer("samples", 1, 20),
  };
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < view.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== "string") throw new TypeError("base64 value must be a string");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function makeReport({ info, source, settings, results, userAgent }) {
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
    source,
    settings,
    artifacts: info.artifacts,
    repositories: info.repositories,
    results: results.map(({ output, ...result }) => ({
      ...result,
      outputBytes: output?.byteLength ?? result.outputBytes ?? null,
    })),
    caveats: [
      "Interactive local evidence; not a controlled performance campaign.",
      "Codec level numbers are backend-specific and do not imply equal compression effort.",
      "Correctness validation and report rendering are outside timed regions.",
      "Native Lean samples exclude process startup; browser samples run in dedicated workers.",
    ],
  };
}
