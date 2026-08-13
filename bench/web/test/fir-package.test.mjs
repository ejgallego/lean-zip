import assert from "node:assert/strict";
import test from "node:test";

import {
  FIR_PACKAGE_PROFILES,
  firPackageRequiredFiles,
  validateFirPackageMetadata,
} from "../fir-package.mjs";

function validMetadata(profile) {
  return {
    build: {
      schemaVersion: profile.schemaVersion,
      entry: {
        sourceName: profile.sourceName,
        ...(profile.id === "raw" ? { levels: [...profile.levels] } : {}),
      },
      wasm: {
        file: profile.wasmFile,
        byteLength: 123,
        sha256: "0".repeat(64),
        functionImportCount: 0,
        memoryImportCount: 0,
        memoryOwner: "module",
        exports: profile.persistentInitializer === null ? [] : [
          { name: profile.persistentInitializer, kind: "function" },
        ],
        ...(profile.id === "raw" ? {
          frontier: {
            imports: [
              { module: "lean.extern", name: "Float.ofNat", kind: "function" },
              { module: "lean.extern", name: "Float.ofScientific", kind: "function" },
              { module: "lean.extern", name: "Float.log2", kind: "function" },
            ],
          },
        } : {}),
      },
      closure: { residualRuntimeOperations: 0 },
      capabilities: {
        byteArray: { layoutVersion: "fir.wasm.byte-array/v2" },
        adapter: {
          module: profile.adapterFile,
          implementationModule: profile.adapterImplementationFile,
          apiVersion: profile.adapterApiVersion,
        },
        ...(profile.persistentInitializer === null ? {} : {
          persistentCaches: {
            initializer: profile.persistentInitializer,
            idempotent: true,
          },
        }),
        ...(profile.id === "raw" ? {
          completeRuntime: {
            selfContained: true,
            externalRuntime: {
              version: "fir.standard-math/v1",
              reservedMemoryBytes: 65536,
              declarations: [
                "Float.ofNat", "Float.ofScientific", "Float.log2",
              ],
            },
          },
        } : {}),
      },
    },
    descriptor: {
      entry: profile.sourceName,
      sourceEntry: profile.sourceName,
      imports: [],
      params: ["object"],
      result: "object",
      ...(profile.id === "raw" ? {
        completeRuntime: true,
        externalRuntime: {
          version: "fir.standard-math/v1",
          reservedMemoryBytes: 65536,
          declarations: [
            "Float.ofNat", "Float.ofScientific", "Float.log2",
          ],
        },
      } : {}),
    },
  };
}

test("stored and Level-1 FIR profiles have disjoint immutable package names", () => {
  const stored = FIR_PACKAGE_PROFILES.stored;
  const level1 = FIR_PACKAGE_PROFILES.level1;
  assert.notEqual(stored.backendId, level1.backendId);
  assert.notEqual(stored.adapterFile, level1.adapterFile);
  assert.notEqual(stored.wasmFile, level1.wasmFile);
  assert.deepEqual(firPackageRequiredFiles(level1), [
    "BUILD.json",
    "SHA256SUMS",
    "lean-zip-byte-array-browser-adapter.mjs",
    "lean-zip-level1-browser-adapter.mjs",
    "lean-zip-level1.wasm",
    "lean-zip-level1.wasm.json",
    "smoke.mjs",
  ]);
});

test("raw FIR profile advertises the production levels 1 through 10", () => {
  const profile = FIR_PACKAGE_PROFILES.raw;
  const { build, descriptor } = validMetadata(profile);
  build.entry.persistentInitializer = profile.persistentInitializer;
  descriptor.params = ["object", "uint8"];
  assert.equal(validateFirPackageMetadata(profile, build, descriptor), profile);
  assert.deepEqual(profile.levels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(firPackageRequiredFiles(profile), [
    "BUILD.json",
    "SHA256SUMS",
    "lean-zip-byte-array-browser-adapter.mjs",
    "lean-zip-raw-browser-adapter.mjs",
    "standard-math-runtime-contract.mjs",
    "lean-zip-raw.wasm",
    "lean-zip-raw.wasm.json",
    "smoke.mjs",
  ]);
  assert.throws(() => validateFirPackageMetadata(profile,
    { ...build, entry: { ...build.entry, levels: [1] } }, descriptor),
  /unsupported level set/);
  assert.throws(() => validateFirPackageMetadata(profile,
    {
      ...build,
      capabilities: {
        ...build.capabilities,
        completeRuntime: {
          ...build.capabilities.completeRuntime,
          externalRuntime: {
            ...build.capabilities.completeRuntime.externalRuntime,
            reservedMemoryBytes: 32768,
          },
        },
      },
    }, descriptor), /standard-math runtime contract/);
});

test("Level-1 FIR package metadata binds source entry, ABI, and zero-import closure", () => {
  const profile = FIR_PACKAGE_PROFILES.level1;
  const { build, descriptor } = validMetadata(profile);
  build.entry.persistentInitializer = profile.persistentInitializer;
  assert.equal(validateFirPackageMetadata(profile, build, descriptor), profile);

  assert.throws(
    () => validateFirPackageMetadata(profile,
      { ...build, entry: { sourceName: "Zip.Wasm.compressStored" } }, descriptor),
    /does not expose Zip\.Wasm\.compressLevel1/,
  );
  assert.throws(
    () => validateFirPackageMetadata(profile,
      { ...build, wasm: { ...build.wasm, functionImportCount: 1 } }, descriptor),
    /zero-import/,
  );
  assert.throws(
    () => validateFirPackageMetadata(profile, build,
      { ...descriptor, imports: [{ module: "lean.extern", name: "List.zip" }] }),
    /zero imports/,
  );
  assert.throws(
    () => validateFirPackageMetadata(profile,
      { ...build, closure: { residualRuntimeOperations: 1 } }, descriptor),
    /retains runtime operations/,
  );
  assert.throws(
    () => validateFirPackageMetadata(profile,
      {
        ...build,
        capabilities: {
          ...build.capabilities,
          persistentCaches: {
            ...build.capabilities.persistentCaches,
            idempotent: false,
          },
        },
      }, descriptor),
    /persistent-cache contract/,
  );
});
