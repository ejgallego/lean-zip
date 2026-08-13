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
          persistentCaches: {
            initializer: null,
            cacheAwareRewind: true,
            warmCallStable: true,
          },
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
  assert.throws(() => validateFirPackageMetadata(profile,
    {
      ...build,
      capabilities: {
        ...build.capabilities,
        persistentCaches: {
          ...build.capabilities.persistentCaches,
          cacheAwareRewind: false,
        },
      },
    }, descriptor), /lazy-cache rewind contract/);
});

test("stored and raw FIR profiles have disjoint immutable package names", () => {
  const stored = FIR_PACKAGE_PROFILES.stored;
  const raw = FIR_PACKAGE_PROFILES.raw;
  assert.notEqual(stored.backendId, raw.backendId);
  assert.notEqual(stored.adapterFile, raw.adapterFile);
  assert.notEqual(stored.wasmFile, raw.wasmFile);
});
