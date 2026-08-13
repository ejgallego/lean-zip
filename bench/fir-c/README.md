# FIR C/Emscripten lean-zip package

This package is the full-runtime code-generation baseline for the comparison lab. It calls
the same `Zip.Wasm.compressRaw` production dispatcher as native Lean, VIR, and
FIR-native, but follows FIR's maintained final-LCNF → Lean C → LLVM →
Emscripten route and links the pinned full Lean runtime.

Build and test levels 1–10 against native Lean and an independent raw-DEFLATE
inflater:

```sh
node bench/fir-c/package.mjs
```

The generated package is local and ignored under
`bench/fir-c/_build/lean-zip-emscripten-current/`. Its manifest verifies the
Emscripten JavaScript and Wasm artifacts before initialization. The browser
adapter copies bytes through `HEAPU8`; no Lean object or raw address crosses
the public JavaScript API.

This lane is an engineering baseline, not FIR-native Wasm: it uses Lean's C
emitter and the full Lean runtime rather than FIR's resident lowering.

The current bridge also corrects one generated-C/runtime ABI mismatch exposed
by whole-program LTO. Generated C represents the final `Bool` argument of
`lean_byte_array_copy_slice` as `uint8_t`, while the C++ runtime defines it as
`bool`; LLVM sees those as `i8` and `i1`. The package stages calls through a
narrow compatible wrapper (including `ByteArray.extract`) until the shared FIR
Emscripten runtime provides that boundary directly. This wrapper contains no
compression logic.
