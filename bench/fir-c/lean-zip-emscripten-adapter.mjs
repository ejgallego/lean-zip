import { loadEmscriptenModule } from "./emscripten-loader.mjs";

export const LEAN_ZIP_EMSCRIPTEN_ADAPTER_API_VERSION =
  "fir.lean-zip.emscripten.browser/v1";

const REQUIRED_EXPORTS = Object.freeze([
  "fir_lean_zip_c_input_alloc",
  "fir_lean_zip_c_compress",
  "fir_lean_zip_c_result_ptr",
  "fir_lean_zip_c_result_len",
  "fir_lean_zip_c_release",
]);

function fail(message) {
  throw new Error(`FIR C/Emscripten lean-zip adapter: ${message}`);
}

function elapsed(started) {
  const result = performance.now() - started;
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

export async function loadLeanZipEmscriptenAdapter(manifestSource, options = {}) {
  const loadStarted = performance.now();
  const loaded = await loadEmscriptenModule(manifestSource, options);
  const loadAndInitializeMs = elapsed(loadStarted);
  for (const name of REQUIRED_EXPORTS) {
    if (typeof loaded.exports[name] !== "function") {
      fail(`package does not export ${name}`);
    }
  }
  if (!(loaded.module.HEAPU8 instanceof Uint8Array)) {
    fail("package does not expose Emscripten HEAPU8");
  }

  let disposed = false;
  const release = () => loaded.exports.fir_lean_zip_c_release();
  return {
    apiVersion: LEAN_ZIP_EMSCRIPTEN_ADAPTER_API_VERSION,
    manifest: loaded.manifest,
    initialization: { loadAndInitializeMs },
    get memoryPages() {
      return loaded.module.HEAPU8.buffer.byteLength / 65536;
    },
    compressRaw(input, level) {
      if (disposed) fail("adapter has been disposed");
      if (!(input instanceof Uint8Array)) fail("input must be a Uint8Array");
      if (!Number.isInteger(level) || level < 1 || level > 10) {
        fail("level must be an integer in 1..10");
      }
      const totalStarted = performance.now();
      let started = totalStarted;
      const inputPointer = loaded.exports.fir_lean_zip_c_input_alloc(
        input.byteLength,
      );
      if (inputPointer === 0) fail("could not allocate the input transfer buffer");
      try {
        if (input.byteLength !== 0) {
          loaded.module.HEAPU8.set(input, inputPointer);
        }
        const encodeMs = elapsed(started);
        started = performance.now();
        const status = loaded.exports.fir_lean_zip_c_compress(
          input.byteLength,
          level,
        );
        const executeMs = elapsed(started);
        if (status !== 0) fail(`compression failed with status ${status}`);
        started = performance.now();
        const resultPointer = loaded.exports.fir_lean_zip_c_result_ptr();
        const resultLength = loaded.exports.fir_lean_zip_c_result_len();
        if (resultLength !== 0 && resultPointer === 0) {
          fail("compression returned a null result buffer");
        }
        const bytes = loaded.module.HEAPU8.slice(
          resultPointer,
          resultPointer + resultLength,
        );
        const decodeMs = elapsed(started);
        const totalMs = elapsed(totalStarted);
        return {
          bytes,
          timings: {
            encodeMs,
            executeMs,
            decodeMs,
            totalMs,
            overheadMs: Math.max(0, totalMs - encodeMs - executeMs - decodeMs),
          },
          memory: {
            pages: loaded.module.HEAPU8.buffer.byteLength / 65536,
          },
        };
      } finally {
        release();
      }
    },
    dispose() {
      if (!disposed) {
        release();
        disposed = true;
      }
    },
  };
}
