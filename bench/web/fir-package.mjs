export const FIR_PACKAGE_PROFILES = Object.freeze({
  raw: Object.freeze({
    id: "raw",
    backendId: "fir-native",
    schemaVersion: "fir.lean-zip.raw.build/v3",
    sourceName: "Zip.Wasm.compressRaw",
    adapterApiVersion: "fir.lean-zip.raw.browser/v2",
    adapterFile: "lean-zip-raw-browser-adapter.mjs",
    adapterImplementationFile: "lean-zip-byte-array-browser-adapter.mjs",
    auxiliaryFiles: Object.freeze([
      "standard-libm-runtime-contract.mjs",
      "lean-zip-raw.wasm.functions.json",
    ]),
    factoryExport: "createLeanZipRawAdapter",
    operation: "compressRaw",
    levelArgument: true,
    wasmFile: "lean-zip-raw.wasm",
    descriptorFile: "lean-zip-raw.wasm.json",
    smokeFile: "smoke.mjs",
    profile: "resident-raw-v2",
    persistentInitializer: null,
    levels: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  }),
});

export const FIR_EMSCRIPTEN_PROFILE = Object.freeze({
  id: "emscripten",
  backendId: "fir-emscripten",
  schemaVersion: "fir.lean-zip.emscripten.build/v1",
  sourceName: "Zip.Wasm.compressRaw",
  adapterFile: "lean-zip-emscripten-adapter.mjs",
  adapterLoaderFile: "emscripten-loader.mjs",
  factoryExport: "loadLeanZipEmscriptenAdapter",
  operation: "compressRaw",
  manifestFile: "lean-zip-emscripten.manifest.json",
  moduleFile: "lean-zip-emscripten.mjs",
  wasmFile: "lean-zip-emscripten.wasm",
  levels: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireObject(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`);
}

export function firPackageRequiredFiles(profile) {
  return [
    "BUILD.json",
    "SHA256SUMS",
    profile.adapterImplementationFile,
    profile.adapterFile,
    ...(profile.auxiliaryFiles ?? []),
    profile.wasmFile,
    profile.descriptorFile,
    profile.smokeFile,
  ];
}

/**
 * Validate the consumer-facing FIR package contract without trusting filenames
 * or callable JavaScript symbols supplied by the package itself.
 */
export function validateFirPackageMetadata(profile, build, descriptor) {
  requireObject(profile, "FIR package profile");
  requireObject(build, "FIR BUILD.json");
  requireObject(descriptor, "FIR module descriptor");
  requireCondition(build.schemaVersion === profile.schemaVersion,
    `unsupported FIR ${profile.id} package schema: ${build.schemaVersion}`);
  requireCondition(build.entry?.sourceName === profile.sourceName,
    `FIR ${profile.id} package does not expose ${profile.sourceName}`);
  const advertisedLevels = build.entry?.levels ??
    (Number.isInteger(profile.level) ? [profile.level] : null);
  requireCondition(Array.isArray(advertisedLevels) &&
    advertisedLevels.length === profile.levels.length &&
    advertisedLevels.every((level, index) => level === profile.levels[index]),
  `FIR ${profile.id} package has an unsupported level set`);
  requireCondition(build.wasm?.file === profile.wasmFile,
    `FIR ${profile.id} package must name ${profile.wasmFile}`);
  requireCondition(build.wasm?.functionImportCount === 0 &&
    build.wasm?.memoryImportCount === 0 && build.wasm?.memoryOwner === "module",
  `FIR ${profile.id} package must be zero-import with module-owned memory`);
  requireCondition(build.capabilities?.byteArray?.layoutVersion === "fir.wasm.byte-array/v2",
    `FIR ${profile.id} package has an unsupported ByteArray layout`);
  requireCondition(build.capabilities?.adapter?.module === profile.adapterFile &&
    build.capabilities?.adapter?.implementationModule ===
      profile.adapterImplementationFile &&
    build.capabilities?.adapter?.apiVersion === profile.adapterApiVersion,
  `FIR ${profile.id} package has an unsupported browser adapter contract`);
  requireCondition(descriptor.entry === profile.sourceName &&
    (descriptor.sourceEntry === undefined || descriptor.sourceEntry === profile.sourceName),
  `FIR ${profile.id} descriptor entry does not match ${profile.sourceName}`);
  const expectedParams = profile.id === "raw"
    ? ["object", "uint8"] : ["object"];
  requireCondition(Array.isArray(descriptor.params) &&
    descriptor.params.length === expectedParams.length &&
    descriptor.params.every((kind, index) => kind === expectedParams[index]) &&
    descriptor.result === "object",
  `FIR ${profile.id} descriptor has an unsupported entry ABI`);
  requireCondition(Array.isArray(descriptor.imports) && descriptor.imports.length === 0,
    `FIR ${profile.id} descriptor must declare zero imports`);
  requireCondition(Number.isInteger(build.closure?.residualRuntimeOperations) &&
    build.closure.residualRuntimeOperations === 0,
  `FIR ${profile.id} package retains runtime operations`);
  if (profile.id === "raw") {
    const expectedFrontierImports = [
      { module: "lean.extern", name: "Float.log2", kind: "function" },
    ];
    const expectedMathDeclarations = expectedFrontierImports.map(
      ({ name }) => name);
    requireCondition(build.entry?.persistentInitializer === null &&
      build.capabilities?.persistentCaches?.initializer === null &&
      build.capabilities.persistentCaches.cacheAwareRewind === true &&
      build.capabilities.persistentCaches.warmCallStable === true,
    "FIR raw package has an unsupported lazy-cache rewind contract");
    requireCondition(build.capabilities?.completeRuntime?.selfContained === true &&
      build.capabilities.completeRuntime.externalRuntime?.version ===
        "fir.standard-libm/v2" &&
      build.capabilities.completeRuntime.externalRuntime.reservedMemoryBytes ===
        65536 &&
      JSON.stringify(build.capabilities.completeRuntime.externalRuntime.declarations) ===
        JSON.stringify(expectedMathDeclarations),
    "FIR raw package has an unsupported standard-libm runtime contract");
    requireCondition(Array.isArray(build.wasm?.frontier?.imports) &&
      JSON.stringify(build.wasm.frontier.imports) ===
        JSON.stringify(expectedFrontierImports),
    "FIR raw package has an unsupported pre-link math frontier");
    requireCondition(descriptor.completeRuntime === true &&
      descriptor.externalRuntime?.version === "fir.standard-libm/v2" &&
      descriptor.externalRuntime.reservedMemoryBytes === 65536 &&
      JSON.stringify(descriptor.externalRuntime.declarations) ===
        JSON.stringify(expectedMathDeclarations),
    "FIR raw descriptor omits its standard-libm runtime contract");
  }
  return profile;
}

export function firEmscriptenRequiredFiles() {
  const profile = FIR_EMSCRIPTEN_PROFILE;
  return [
    "BUILD.json",
    "SHA256SUMS",
    profile.adapterLoaderFile,
    profile.adapterFile,
    profile.manifestFile,
    profile.moduleFile,
    profile.wasmFile,
  ];
}

export function validateFirEmscriptenMetadata(build, manifest) {
  const profile = FIR_EMSCRIPTEN_PROFILE;
  requireObject(build, "FIR C/Emscripten BUILD.json");
  requireObject(manifest, "FIR C/Emscripten manifest");
  requireCondition(build.schemaVersion === profile.schemaVersion,
    `unsupported FIR C/Emscripten package schema: ${build.schemaVersion}`);
  requireCondition(build.entry?.sourceName === profile.sourceName &&
    Array.isArray(build.entry.levels) &&
    JSON.stringify(build.entry.levels) === JSON.stringify(profile.levels),
  "FIR C/Emscripten package has an unsupported entry or level set");
  requireCondition(build.runtime?.fullLeanRuntime === true &&
    build.runtime.threads === true && build.runtime.heapView === true,
  "FIR C/Emscripten package does not identify its full threaded Lean runtime");
  requireCondition(manifest.schemaVersion === 1 &&
    manifest.profile === "emscripten" && manifest.runtime?.threads === true,
  "FIR C/Emscripten manifest has an unsupported runtime profile");
  const requiredExports = [
    "fir_lean_zip_c_input_alloc",
    "fir_lean_zip_c_compress",
    "fir_lean_zip_c_result_ptr",
    "fir_lean_zip_c_result_len",
    "fir_lean_zip_c_release",
  ];
  requireCondition(JSON.stringify(manifest.abi?.exports) ===
    JSON.stringify(requiredExports) &&
    manifest.abi?.runtimeMethods?.includes("HEAPU8"),
  "FIR C/Emscripten manifest has an unsupported transfer ABI");
  requireCondition(manifest.artifacts?.module?.file === profile.moduleFile &&
    manifest.artifacts?.wasm?.file === profile.wasmFile,
  "FIR C/Emscripten manifest has unexpected artifact names");
  return profile;
}
