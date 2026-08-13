#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const packageDirectory = resolve(process.argv[2]);
const oracle = resolve(process.argv[3]);
const { loadLeanZipEmscriptenAdapter } = await import(pathToFileURL(
  join(packageDirectory, "lean-zip-emscripten-adapter.mjs")));
const adapter = await loadLeanZipEmscriptenAdapter(pathToFileURL(
  join(packageDirectory, "lean-zip-emscripten.manifest.json")));
const temporary = mkdtempSync(join(tmpdir(), "lean-zip-emscripten-check-"));

const repeated = new TextEncoder().encode(
  "abracadabra — lean-zip C/Emscripten — ".repeat(1600),
);
const random = new Uint8Array(16384);
let state = 0x6c65616e;
for (let index = 0; index < random.length; index += 1) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  random[index] = state >>> 24;
}
const cases = [new Uint8Array(), Uint8Array.of(0), repeated, random];

try {
  for (const [caseIndex, input] of cases.entries()) {
    const inputPath = join(temporary, `input-${caseIndex}`);
    writeFileSync(inputPath, input);
    for (let level = 1; level <= 10; level += 1) {
      const outputPath = join(temporary, `output-${caseIndex}-${level}`);
      execFileSync(oracle, ["raw", String(level), inputPath, outputPath]);
      const expected = new Uint8Array(readFileSync(outputPath));
      let first;
      let second;
      try {
        first = adapter.compressRaw(input, level);
        second = adapter.compressRaw(input, level);
      } catch (error) {
        throw new Error(`case ${caseIndex}, level ${level}: ${error.message}`,
          { cause: error });
      }
      assert.deepEqual(first.bytes, expected,
        `case ${caseIndex}, level ${level}: native bytes differ`);
      assert.deepEqual(second.bytes, expected,
        `case ${caseIndex}, level ${level}: repeated bytes differ`);
      assert.deepEqual(new Uint8Array(inflateRawSync(first.bytes)), input,
        `case ${caseIndex}, level ${level}: independent inflate differs`);
    }
  }
  console.log(`FIR C/Emscripten differential: PASS (${cases.length} cases × 10 levels)`);
} finally {
  adapter.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
