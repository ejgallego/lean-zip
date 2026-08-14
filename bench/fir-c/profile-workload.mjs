import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { makeBenchmarkInput } from "../web/app/protocol.mjs";

const packageDirectory = join(import.meta.dirname,
  "_build/lean-zip-emscripten-current");
const manifestPath = join(packageDirectory,
  "lean-zip-emscripten.manifest.json");
const adapterPath = join(packageDirectory,
  "lean-zip-emscripten-adapter.mjs");
const inputKind = "random";
const inputBytes = 256 * 1024;
const level = 6;
const warmupRounds = 3;
const steadyRounds = 16;

export const metadata = {
  id: "lean-zip/fir-c/random-256k-level6",
  inputKind,
  inputBytes,
  level,
  warmupRounds,
  steadyRounds,
};

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equalBytes = (left, right) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const checkedCompress = (state) => {
  const result = state.adapter.compressRaw(state.input, level);
  if (state.expected !== null) {
    assert(equalBytes(result.bytes, state.expected),
      "FIR-C steady output differs from the checked first call");
  }
  return result;
};

export async function setup(context) {
  const { loadLeanZipEmscriptenAdapter } = await import(
    pathToFileURL(adapterPath).href);
  const adapter = await loadLeanZipEmscriptenAdapter(
    pathToFileURL(manifestPath), { wasmBinary: context.wasmBytes });
  return {
    adapter,
    input: makeBenchmarkInput(inputKind, inputBytes),
    expected: null,
  };
}

export async function firstCall(state) {
  const result = checkedCompress(state);
  const inflated = new Uint8Array(inflateRawSync(result.bytes));
  assert(equalBytes(inflated, state.input),
    "FIR-C first-call stream does not inflate to the input");
  state.expected = result.bytes;
  return {
    ok: true,
    observation: {
      inputBytes: state.input.byteLength,
      outputBytes: result.bytes.byteLength,
      outputSha256: digest(result.bytes),
    },
  };
}

export async function warmup(state) {
  for (let round = 0; round < warmupRounds; round += 1) checkedCompress(state);
  return {
    ok: true,
    observation: { rounds: warmupRounds, outputSha256: digest(state.expected) },
  };
}

export async function steady(state) {
  for (let round = 0; round < steadyRounds; round += 1) checkedCompress(state);
  return {
    ok: true,
    observation: { rounds: steadyRounds, outputSha256: digest(state.expected) },
  };
}

export async function teardown(state) {
  state.adapter.dispose();
}
