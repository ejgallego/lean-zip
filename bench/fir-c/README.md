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

## Exact-release profile evidence

The C control can be indexed without benchmarking a named or otherwise
different Wasm build:

```sh
node bench/fir-c/profile-link.mjs --out-dir /tmp/lean-zip-fir-c-map

node ../fir/.worktrees/tooling/tooling/profile/node-profile.mjs \
  --wasm bench/fir-c/_build/lean-zip-emscripten-current/lean-zip-emscripten.wasm \
  --sidecar /tmp/lean-zip-fir-c-map/lean-zip-emscripten.wasm.functions.json \
  --workload bench/fir-c/profile-workload.mjs \
  --out-dir /tmp/lean-zip-fir-c-profile \
  --sampling-interval-micros 500
```

`profile-link.mjs` requires a new output directory outside the repository. It
checks the immutable package, relinks with the manifest's exact inputs and
flags plus wasm-ld's diagnostic map, and rejects the result unless it is
byte-identical to the served release. It then carries the complete pre-
Binaryen linker inventory through Emscripten's retained optimizer and meta-DCE
stages. Identity-carrying intermediate modules must differ only by custom name
metadata, and the final indexed module must again be byte-identical to the
release before a function sidecar is accepted.

The checked workload keeps setup, honest first call, warmup, and sampled steady
execution separate. Its first 256 KiB seeded-random level-6 stream must inflate
to the input; all subsequent outputs must equal that checked stream exactly.
The profile is diagnostic evidence, not a headline timing run.

This workflow currently consumes FIR's local tooling lane. Once the generic
function-index support is integrated, the package-produced sidecar should be
preferred and this client relink retained as an independent FIR-C control.
