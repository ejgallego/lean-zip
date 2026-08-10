# Vir/FIR WASM port plan

Status: Phase A complete; Vir Phase C integration in progress

Local worktree: `.worktrees/vir-fir-wasm-port`

Local branch: `feat/vir-fir-wasm-port`

## Current local checkpoint (2026-08-10)

- `Zip.Wasm.compressStored` is isolated in `Zip.Wasm.Stored`, so backends can
  probe ByteArray/stored-block support without importing the dynamic matcher.
- `Zip.Wasm.compressLevel1` is isolated in `Zip.Wasm.Level1`.
- `Zip.Wasm.compressRaw` is the complete backend-neutral production root.
- `zip-wasm-oracle` provides a binary file-to-file native reference for all
  three roots.
- `zip-wasm-test` checks exact delegation, native inflate round-trips, levels
  0/1/6/10/11, the 32 KiB window boundary, and the deterministic 1 MiB
  incompressibility-prescan path.
- The focused executables and tests pass under rc1, Vir's rc2, and FIR's 4.32
  toolchains without source changes. Cold `DeflateDynamic` olean builds took
  728 seconds on rc1, 601 seconds on rc2, and 700 seconds on 4.32; wrapper
  modules stayed below 400 milliseconds.
- Each toolchain's native oracle compressed `README.md` at level 6 to the same
  5,888 bytes, SHA-256
  `7d3d2614084b718182c87f02cc4d1ea2b98056189fbb960500c3b746efc039bf`,
  and the stream independently inflated to the 13,013-byte source.
- The compatibility probes used detached local worktrees and independent local
  `zipCommon` worktrees at the pinned commit; no dependency was fetched.

### Vir progress sync (2026-08-10)

Vir's local `feat/lean-zip-deflate-probe` worktree now contains an uncommitted
implementation of the general reference-body mechanism requested by this plan:

- `vir_extern_fallback Foo.bar, ...` accepts explicitly named `@[extern] def`s,
  rejects declarations without transparent bodies and recursive reference
  bodies, and compiles private clones of the selected Lean bodies;
- package indexing hides the private clones, installs their function bodies
  under the original extern names, and follows the clones during export
  validation; and
- the command is exposed by the top-level `Vir` import, so a backend-owned
  adapter can opt in without adding Vir attributes or imports to lean-zip's
  production modules;
- full-dispatch preparation also registers `UInt8.ofNatLT` and proposes a
  WASI-libm `Float.log2` provider, measured at 3,019 raw bytes (2,512 bytes
  under deterministic gzip) with a strict WASI SDK 33 link.

This is the correct integration boundary for the six fixed-level-1 externs and
later `UInt32.log2Clz`. The lean-zip adapter should consume it only after Vir's
interface and tests settle; the stable modules in `Zip.Wasm` remain
backend-neutral.

Current validation is not green yet. `lake build Vir` passes, but the focused
`package-generator-smoke.mjs` run reaches a Lean IR-interpreter assertion in
the pre-existing marked-package case, before exercising the new fallback case.
An intermediate import-layout revision also made the generated-library build
lose `Vir/GeneratePackage/Basic.olean`; that layout has since been removed. No
lean-zip level-1 package or runtime parity result has therefore been
established from these changes yet.

Next Vir acceptance sequence:

1. restore the package-generator smoke to green;
2. generate `Zip.Wasm.compressLevel1` with fallbacks for the six known externs
   and require zero unresolved declarations or native registrations;
3. compare its output byte-for-byte with `zip-wasm-oracle level1`, including
   repeated calls in one interpreter instance; and
4. only then exercise the seventh fallback and validate the currently proposed
   `Float.log2` and `UInt8.ofNatLT` providers for `Zip.Wasm.compressRaw`, with
   special attention to prescan route and byte parity.

This plan assumes that "the main routine" means the pure compressor entry point
`Zip.Native.Deflate.deflateRaw`, rather than the `ZipTest.main` test runner or the
file-I/O shell in `bench/ZipCompressFile.lean`. The first target is raw DEFLATE.
Zlib/gzip framing and decompression are explicitly deferred.

## 1. Porting boundary

The application boundary should be a pure binary function:

```text
(input : ByteArray, level : UInt8) -> compressed : ByteArray
```

The host owns files, JavaScript typed arrays, and error presentation. The Lean
entry point owns compression only. This keeps `IO.FS`, the system zlib FFI, tar,
archive, and the test runner out of the compiler closure.

The production dispatch is in `Zip/Native/DeflateDynamic.lean`:

- level 0 selects the proved stored-block implementation;
- levels 1 through 10 select the existing matcher/parse/emitter routes;
- levels greater than or equal to 10 retain the current exact-DP route;
- a large-input incompressibility prescan may select stored blocks before the
  level-specific matcher.

The WASM driver should import `Zip.Native.DeflateDynamic`, not the aggregate
`Zip` module. It should expose three roots while bringing up the backends:

1. `compressStored` for a level-0 vertical slice;
2. `compressLevel1` for the first real matcher/emitter slice;
3. `compressRaw` for the complete `deflateRaw` dispatch.

The first two roots are diagnostic scaffolding. `compressRaw` is the public
deliverable.

## 2. Repository and compiler constraints

The local repositories currently disagree on their Lean compiler revision:

| Repository | Inspected revision | Lean toolchain | Role |
| --- | --- | --- | --- |
| lean-zip | `9bc0e7d2` | `v4.33.0-rc1` | application and reference behavior |
| Vir | `607ef30` | `v4.33.0-rc2` | IR package generator and shared WASM interpreter |
| FIR | `31b9290c` | `v4.32.0` | final-LCNF-to-WASM pipeline |

Generated Lean IR/LCNF is compiler-version-sensitive, so each backend must
compile lean-zip with its own exact compiler revision. The local probes establish
that the source itself needs no compatibility patch:

- Vir can compile the integration source directly with its rc2 toolchain.
- FIR can compile the same integration source directly with its 4.32 toolchain.

Do not reuse generated rc1 IR/LCNF in either backend; rebuild the source roots
under the backend's pinned toolchain as the compatibility probes did.

FIR's repository instructions also constrain ownership. Native WASM generation
work belongs in its `wasm/generation` worktree/lane; concrete runtime changes
cross the W6/W7 boundary. Do not edit FIR's `main` checkout. Create or select an
appropriate Vir worktree before changing Vir. The present worktree is the
lean-zip integration/driver worktree.

## 3. Known runtime surface

`deflateRaw` is pure Lean at the source level, but the compiled compression
closure currently reaches seven lean-zip native accelerators. Each declaration
has a Lean reference body, which is useful for a portable implementation, but
Vir currently treats the native symbol as a required registered provider.

| Lean operation | Native symbol | Compression use |
| --- | --- | --- |
| `ByteArray.ugetUInt32LE` | `lean_zip_uget_u32le` | match tables and packed tokens |
| `ByteArray.ugetUInt64LE` | `lean_zip_uget_u64le` | match counting and fused paths |
| `ByteArray.usetUInt32LE` | `lean_zip_uset_u32le` | direct-head match tables |
| `ByteArray.usetUInt64LE` | `lean_zip_uset_u64le` | fused frequency bins |
| `ByteArray.pushUInt64LE` | `lean_zip_push_u64le` | token arrays and bit writer |
| `UInt32.log2Clz` | `lean_zip_uint32_log2_clz` | distance/length coding |
| `UInt64.ctzFast` | `lean_zip_ctz64` | match-length calculation |

The full entry point also uses `Float.log2` in `incompressiblePrescan`. That is
not currently present in Vir's inspected native-provider registry.

The initial compressor port does not need the decompressor-only native
operations (`ByteArray.copyWithin`, `extendWithin`, or InflateFast helpers).

Backend readiness differs substantially:

- Vir already exposes `ByteArray` and scalar interface values and can map the
  public signature to JavaScript bytes. Its output is an `.irpkg` consumed by a
  shared `vir-upstream.wasm`, rather than a fresh standalone WASM module for
  every application. Its immediate gaps are closure/native-provider coverage,
  toolchain alignment, and likely runtime cost for the large compressor graph.
- FIR can emit raw WASM from captured final LCNF and can model ByteArray in its
  semantic validation layer. Its concrete/resident runtime does not yet provide
  a complete physical ByteArray representation and operation set. Full native
  FIR lowering therefore requires backend/runtime enablement, not only an
  exported wrapper.

## 4. Implementation phases

### Phase A: freeze the contract and native oracle

1. Add a minimal, backend-neutral driver module with the three roots above.
2. Keep backend dependencies out of lean-zip's normal import graph; use an
   optional Lake target or small integration subpackage.
3. Produce a deterministic native golden corpus containing input bytes, level,
   compressed bytes, and decompression result.
4. Preserve byte-for-byte output, including the incompressible-prescan choice.
   A merely valid but differently encoded DEFLATE stream is not enough unless a
   later decision explicitly relaxes this requirement.
5. Record behavior for every `UInt8` level used by the dispatch, including
   values above 10.

Exit criterion: the driver agrees exactly with direct native `deflateRaw` on the
shared corpus and introduces no I/O or zlib imports.

### Phase B: probe compiler closures before implementing providers

For each backend, capture level 0, level 1, and full-entry closure reports. The
reports should enumerate declarations, initializers, unresolved externals,
unsupported LCNF/IR forms, and generated artifact size.

This phase decides how to handle the seven native accelerators. Evaluate in
this order:

1. teach the backend to select the declaration's Lean reference body for a
   project-local extern when a portable body is available;
2. add narrowly scoped WASM providers for the seven symbols;
3. refactor lean-zip behind an explicit portable primitive layer if neither
   backend can select the reference bodies cleanly.

Avoid a global compiler substitution that slows or changes the existing native
build. Also avoid adding lean-zip-specific symbols to a generic runtime without
a registration boundary and ownership rationale.

Exit criterion: the chosen primitive strategy is shared where practical,
preserves native performance defaults, and has a small independent test for
each little-endian load/store, append, CLZ/log2, and CTZ operation.

### Phase C: Vir package

1. Align the toolchain and add a local path dependency on Vir; do not fetch a
   remote dependency as part of this work.
2. Mark the driver roots with `@[vir_export]` and build the module facet (for
   example `lake build +Zip.Wasm:vir`).
3. Bring up `compressStored`, then `compressLevel1`, then `compressRaw`, using
   the closure report after each step.
4. Resolve `Float.log2` without changing the prescan's decisions. Prefer a
   correctly specified runtime provider; use a portable prescan implementation
   only if it is proven to make the same branch decision.
5. Add a JavaScript adapter exposing `(Uint8Array, number) -> Uint8Array` and
   validate repeated calls against the same shared Vir interpreter instance.
6. Measure interpreter fuel/time and memory growth on representative inputs.
   If full compression is impractical in the interpreter, retain the evidence
   and identify the exact hot declaration rather than weakening correctness.

Exit criterion: the generated `.irpkg` has no unresolved native externs, loads
in `vir-upstream.wasm`, and matches native compressed bytes for the full corpus.

### Phase D: FIR feasibility gate and first artifact

1. Work in FIR's WASM-generation lane and align its compiler with the driver.
2. Capture the final LCNF module closure. A single-entry command may leave
   imported lean-zip declarations external, so use the internalized/multi-module
   capture path when the report shows unresolved imported declarations.
3. Lower `compressStored` first. This is the smallest end-to-end test of input
   ByteArray representation, output allocation, mutation/append, and host
   reconstruction.
4. Extend the manifest and concrete/resident runtime with a physical ByteArray
   contract. At minimum cover construction/capacity, size, indexed reads and
   writes, push/append, extract/copy, and result export. Prove or validate the
   object layout before adding compressor-specific helpers.
5. Bring up `compressLevel1`, implementing missing Array/Nat/fixed-width numeric
   operations and the seven native primitives as exposed by the closure report.
6. Bring up `compressRaw`, then implement `Float.log2` and any remaining
   initialization/static-data support.
7. Run FIR semantic-host validation at each stage, but do not call the port
   complete until the encoded WASM runs with the concrete/resident runtime.

Exit criterion: FIR emits a raw `.wasm` plus manifest for `compressRaw`, the
artifact validates and instantiates, and its bytes match the native oracle.

### Phase E: optional compiler-native comparison path

FIR also documents a Lean-C/Emscripten artifact path. It can provide an earlier
comparison artifact after toolchain alignment, with lean-zip's C accelerators
passed as explicit extra C sources and a binary-safe exported bridge. This is a
useful smoke/performance reference, but it does not satisfy the FIR-native
final-LCNF lowering goal and must not be reported as such.

### Phase F: shared validation and hardening

Run the same matrix through native Lean, Vir, and FIR:

- empty and very short inputs;
- repeated bytes and long runs;
- data that exercises 32 KiB window and block boundaries;
- mixed structured text/binary samples;
- high-entropy inputs below and above the prescan threshold, including inputs
  over 1 MiB;
- levels 0 through 10 and selected values above 10;
- repeated invocations in one runtime instance.

For every case:

1. compare compressed bytes with the native oracle;
2. inflate the result independently and compare with the original input;
3. check module validation, manifest/export shape, traps, and memory growth;
4. retain generator closure reports showing no accidental unresolved imports;
5. record artifact size and runtime only after correctness is established.

Repository-local completion checks include `git diff --check`, clean builds at
the pinned toolchain revision, Vir package/JS smoke tests, and FIR's documented
`make check`, `make talos-check`, and artifact checks as applicable.

## 5. Deliverables

- backend-neutral lean-zip WASM driver and native golden-corpus generator;
- Vir module facet/package, JavaScript byte adapter, and closure report;
- FIR-native WASM module, manifest, runtime support, and semantic/concrete
  validation fixtures;
- shared cross-backend conformance tests;
- a short compatibility document pinning exact local revisions/toolchains and
  listing the chosen native-primitive strategy;
- optional Emscripten comparison artifact, clearly labeled as non-FIR-native.

## 6. Principal risks

1. Compiler drift: rc1, rc2, and 4.32 cannot safely share generated IR/LCNF.
2. Native boundary: seven lean-zip externs and `Float.log2` need portable bodies
   or explicit WASM providers.
3. FIR ByteArray: semantic support exists, but concrete physical layout and the
   required mutation/allocation operations are incomplete.
4. Closure size: production imports theorem-backed helpers and large matcher
   tables; module capture must avoid pulling unrelated public APIs/specs while
   retaining required initializers.
5. Vir cost: an interpreter can be functionally correct yet too slow or memory
   hungry for the complete production matcher.
6. Output parity: replacing the entropy prescan or wide primitives can preserve
   DEFLATE validity while changing exact bytes; the oracle prevents unnoticed
   divergence.

The critical path is therefore: exact toolchain alignment -> level-0 closure ->
portable/native primitive policy -> Vir full closure -> FIR concrete ByteArray
runtime -> FIR full closure -> cross-backend parity.
