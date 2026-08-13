# Vir/FIR WASM port plan

Status: native/VIR and both FIR production levels 1–10 routes are integrated.
The constant-time resident Array repair is accepted on FIR main; the comparison
lab admits both its clean resident-native package and the full-runtime
C/Emscripten package.

Local worktree: `.worktrees/vir-fir-wasm-port`

Local branch: `feat/vir-fir-wasm-port`

## Current execution order (2026-08-13)

| Priority | Track | State | Next acceptance boundary |
| --- | --- | --- | --- |
| P0 | Coordination and artifact identity | complete | Keep this plan and the VIR/FIR handoffs synchronized with immutable artifact hashes. |
| P1 | FIR production dispatcher | integrated; scaling study next | Run the clean levels 1–10 package across representative sizes and profile the post-Array-fix runtime. |
| P2 | VIR performance | attributed; VIR experiment pending | Screen call-site symbol resolution first, then re-profile and run order-balanced representative acceptance. |
| P3 | FIR C/Emscripten | integrated | Compare it order-balanced with FIR native, then move the narrow generated-C/runtime Bool ABI correction into shared infrastructure. |
| P4 | Historical stored control | retired from UI | Keep its scratch-frontier diagnosis as historical evidence; do not present it as a production competitor. |

## Current local checkpoint (2026-08-12)

- `Zip.Wasm.compressStored` is isolated in `Zip.Wasm.Stored`, so backends can
  probe ByteArray/stored-block support without importing the dynamic matcher.
- `Zip.Wasm.compressRaw` is the complete backend-neutral production root.
- `Zip.Wasm.distanceCodeCacheProbe` isolates one production distance-code
  cache access per input byte, providing FIR a small lazy-initializer lifetime
  regression before it reruns the complete compressor.
- `zip-wasm-oracle` provides a binary file-to-file native reference for the
  stored control, production dispatcher, and cache probe.
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

### Vir portable completion (2026-08-11)

Vir's complete lean-zip support is merged into Vir `main` at
`9f69f1348da15274090d9074bbeded1eafc6b27a` (`feat: support lean-zip deflate
packages (#125)`). The former feature worktree and branch were retired. A clean
detached checkout at that exact commit was rebuilt and accepted independently
against lean-zip `f244c00a1d7ad837563b560633542755d154c654`, with only the
compatibility checkout's `lean-toolchain` changed from rc1 to rc2.
The release artifacts and memory figures below were superseded by the final
exact-source revalidation against landed VIR PR #131.

- `vir_extern_fallback Foo.bar, ...` accepts explicitly named transparent
  `@[extern] def`s and rejects opaque, bodyless, duplicate, non-extern, and
  directly recursive requests. Native compilation remains unchanged.
- Fallback clones are authenticated by a persistent environment extension;
  names placed under the private-looking namespace cannot spoof fallback
  ownership or change package resolution.
- Package generation emits an ownership-preserving adapter at the original
  extern name and calls a private compiled clone of its Lean reference body.
  The seven lean-zip accelerators use this boundary.
- The generic runtime provides `ByteArray.set` and the canonical WASI-libm
  `Float.log2`. `UInt8.ofNatLT` uses a dedicated native registration with the
  distinct compiler-generated `l_UInt8_ofNatLT` lookup stem.
- The authoritative executable adapter and acceptance oracle are owned by
  Vir's checked-in `fixtures/lean-zip/VirLeanZipAcceptance` package.

Clean merged-main gates:

```text
npm run build:demo                                      PASS (strict unresolved: 0)
node scripts/runtime-tests/package-generator-smoke.mjs  PASS
node scripts/runtime-tests/package-generation-lifecycle-cases.mjs  PASS
npm run check:native-externs                            PASS
  477 unique entries; 466 Lean-derived; 11 Vir overrides
npm run accept:lean-zip -- RC2_LEAN_ZIP --passes 3 --keep  PASS
```

The authoritative current browser artifact identity is recorded in
`bench/web/PERFORMANCE.md`. Historical portable-package sizes below remain
useful compatibility evidence but are not the active comparison-lab artifact.

The acceptance run made 279 native/Vir compression calls over 3,899,628 input
bytes: 89 vectors at every level 0 through 10 repeated three times, plus 12
larger optimal-path vectors. Every output was byte-identical to native and
independently inflated to the input. Nine 1 MiB prescan cases agreed across the
observed alphabet-205/206 threshold. Wasm memory reached 344 pages and remained
exactly `344,344,344` after the three matrix passes.

This closes Phase C and the Vir portion of Phase F for correctness and repeated
memory behavior. Interpreter performance and finer optimal-path attribution
remain optimization work, not support blockers.

### Vir client-native completion (2026-08-11)

Client-native extern manifests landed in VIR PR #127, and the package-lifetime
interpreter cache fix landed in PR #131 at
`d43a947e65cec5dbda9e2393a5e74d1150ca144f`. The active comparison artifact
was rebuilt from that landed revision under VIR's rc2 toolchain.

The checked-in `lean-vir-native-externs.json` selects exactly seven declarations
from `Zip.Native.Wide` and the single `c/bytearray_wide_ffi.c` provider. Static
validation maps every selected Lean declaration to its `@[extern]` symbol and
to a C definition. Dynamic package and link evidence is stronger than output
parity alone:

- the package contains 662 Lean IR declarations and 141 native externs;
- all seven `_virExternFallback.*` clones are absent;
- the package report maps all seven original Lean names to their `lean_zip_*`
  raw symbols;
- the linked native-support object defines all seven symbols and the strict
  Wasm link has zero unresolved symbols; and
- the boundary report records one client provider and the exact manifest path.

The optimized package is 1,151,430 bytes with SHA-256
`3f3db6f2a75085f193e8dbe569d8b8ac53dceb9a789e2ef641df6665a711c1d7`.
Its stripped release Wasm is 742,811 bytes with SHA-256
`a09ad75ada18d90c6aec881fdf5bd34537029c2c5be243e477102adb200e3f78`.

Three-pass acceptance made the same 279 compression calls and nine prescan
decisions as the portable profile. Every result was byte-identical to native
and independently inflated to the input. Wasm memory stabilized at
`338,338,338` pages, versus `344,344,344` for the exact-source portable run.
Both immutable profile snapshots also passed the browser comparison smoke with
four verified lanes. Tiny interactive timings remain smoke evidence, not a
performance claim.

### Shared benchmark checkpoint (2026-08-11)

`bench/wasm` now owns the application-level demo and performance contract. Its
tracked plan separates micro smoke, focused levels 0 through 10, representative
Canterbury cells, and optional real Silesia prescan cells. Every timed case is
gated by byte equality with the native oracle and independent raw-DEFLATE
inflation. The report keeps artifact/compile/instantiate/package/first-call
costs separate from diagnostics-off steady calls, alternates native/Vir block
order AB/BA, retains raw samples and checksums, tracks Wasm memory growth, and
hashes the executables, sources, runtime, shared Wasm, direct package or
package-set descriptor, and every package member. Reports must be written
outside the repository and are never overwritten.

Both merged-main profiles pass the repository-owned smoke demo at levels 1 and
6 and the multi-backend browser smoke at level 6. Artifact reports record clean
Vir identity, package and Wasm hashes, native byte equality, and independent
inflation. Tiny inputs and single-sample browser timings are integration
evidence, not optimization claims. Track D remains authoritative for native
compressor throughput and compression-ratio claims.

### Comparison-lab completion (2026-08-11)

The browser comparison now runs native-reference, Vir, browser
`CompressionStream`, and pinned fflate adapters behind one worker protocol.
Native Lean has a binary oracle and steady-state runner; Vir has a clean
identified producer, runtime, package, JavaScript byte boundary, and
repeated-call evidence. Each lane is independently inflated, and the Lean lanes
must additionally match native bytes exactly.

FIR exposes two production routes rather than one ambiguous "FIR" result:

- **FIR-native** remains the target compiler-backend result. The stored control
  is no longer presented as a separate level-0 row. The clean production
  `compressRaw` package handles every level from 1 through 10 through one ABI
  and one browser row. FIR `1d79658d`
  supplies constant-time resident Array indexing; the resulting 1,753,310-byte
  zero-import Wasm has SHA-256
  `0686e69684c187b1b14415f0f3b88fe4ce28514c97f8aac003fbd7359f15b838`.
  The full 5-case × 10-level native-byte/inflate gate passes.
- **FIR C/Emscripten** calls the identical production dispatcher through final
  LCNF, Lean C, LLVM, Emscripten, and the full Lean runtime. A binary-safe
  allocation/result bridge transfers bytes through `HEAPU8`; the package links
  the lean-zip native providers explicitly and verifies its manifest before
  initialization. Its 4-case × 10-level Node gate and 27-cell real-browser
  sweep pass exact native bytes and independent inflate.

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
`Zip` module. It should expose two roots:

1. `compressStored` for a level-0 vertical slice;
2. `compressRaw` for the complete `deflateRaw` dispatch.

`compressStored` is diagnostic scaffolding. `compressRaw` is the public
deliverable for compressed levels.

## 2. Repository and compiler constraints

The local repositories currently disagree on their Lean compiler revision:

| Repository | Inspected revision | Lean toolchain | Role |
| --- | --- | --- | --- |
| lean-zip comparison lab | `74e4826c` | `v4.33.0-rc1` | application, native oracle, and published comparison harness |
| VIR accepted artifact | `d43a947e` | `v4.33.0-rc2` | merged client-native package generator, persistent interpreter, and shared WASM runtime |
| FIR production packages | accepted FIR `1d79658d` | `v4.33.0` | zero-import stored control and levels 1–10 production dispatcher admitted |

Generated Lean IR/LCNF is compiler-version-sensitive, so each backend must
compile lean-zip with its own exact compiler revision. The local probes establish
that the source itself needs no compatibility patch:

- Vir can compile the integration source directly with its rc2 toolchain.
- FIR has compiled both published production scopes with the lane's exact
  pinned v4.33.0 toolchain.

Do not reuse generated rc1 IR/LCNF in either backend; rebuild the source roots
under the backend's pinned toolchain as the compatibility probes did.

FIR's repository instructions also constrain ownership. Native WASM generation
work belongs in its `wasm/generation` worktree/lane; concrete runtime changes
cross the W6/W7 boundary. Do not edit FIR's `main` checkout. Create or select an
appropriate Vir worktree before changing Vir. The present worktree is the
lean-zip integration/driver worktree.

## 3. Known runtime surface

`deflateRaw` is pure Lean at the source level, but the compiled compression
closure reaches seven lean-zip native accelerators. Each declaration has a Lean
reference body. Vir can select those bodies through its authenticated explicit
fallback boundary or select the same seven declarations as native and link the
project provider through the client manifest. FIR's production dispatcher
closes the source-defined fixed-width APIs internally and links its reviewed
`Float.log2` prescan surface through the standard math runtime.

| Lean operation | Native symbol | Compression use |
| --- | --- | --- |
| `ByteArray.ugetUInt32LE` | `lean_zip_uget_u32le` | match tables and packed tokens |
| `ByteArray.ugetUInt64LE` | `lean_zip_uget_u64le` | match counting and fused paths |
| `ByteArray.usetUInt32LE` | `lean_zip_uset_u32le` | direct-head match tables |
| `ByteArray.usetUInt64LE` | `lean_zip_uset_u64le` | fused frequency bins |
| `ByteArray.pushUInt64LE` | `lean_zip_push_u64le` | token arrays and bit writer |
| `UInt32.log2Clz` | `lean_zip_uint32_log2_clz` | distance/length coding |
| `UInt64.ctzFast` | `lean_zip_ctz64` | match-length calculation |

The full entry point also uses `Float.log2` in `incompressiblePrescan`. Vir's
merged runtime supplies the audited WASI-libm provider and the acceptance matrix
pins the observed alphabet-205/206 routing threshold. FIR must preserve the same
decision when its full entry is brought up.

The initial compressor port does not need the decompressor-only native
operations (`ByteArray.copyWithin`, `extendWithin`, or InflateFast helpers).

Backend readiness differs substantially:

- Vir exposes `ByteArray` and scalar interface values and maps the public
  signature to JavaScript bytes. Its `.irpkg` is consumed by a shared
  `vir-upstream.wasm`; correctness, closure coverage, and repeated memory are
  complete, while interpreter cost remains high.
- FIR emits the stored control and production levels 1–10 dispatcher as
  zero-import Wasm with concrete ByteArray input/result support. Both pass
  native differential and browser inflate gates.

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
3. Bring up `compressStored`, then the production `compressRaw` dispatcher,
   using the closure report after each step.
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
5. Bring up `compressRaw`, implementing missing Array/Nat/fixed-width numeric
   operations and the seven native primitives as exposed by the closure report,
   then implement `Float.log2` and any remaining
   initialization/static-data support.
6. Run FIR semantic-host validation at each stage, but do not call the port
   complete until the encoded WASM runs with the concrete/resident runtime.

Exit criterion: FIR emits a raw `.wasm` plus manifest for `compressRaw`, the
artifact validates and instantiates, and its bytes match the native oracle.

### Phase E: optional compiler-native comparison path

FIR also documents a Lean-C/Emscripten artifact path. It can provide an earlier
comparison artifact after toolchain alignment, with lean-zip's C accelerators
passed as explicit extra C sources and a binary-safe exported bridge. This is a
useful smoke/performance reference, but it does not satisfy the FIR-native
final-LCNF lowering goal and must not be reported as such.

Current decision (2026-08-13): defer this path. FIR's maintained builder now
already supports extra Lean/C sources, explicit C exports, verified manifests,
and an optional `HEAPU8` bulk-transfer view. lean-zip would still need a small
binary request/result bridge and its seven C providers linked explicitly, but
that work would produce a full Lean-runtime Emscripten artifact rather than
advance FIR-native production-dispatcher performance. Reopen Phase E only if a
near-term compiler-native-C reference is worth that separate artifact and
maintenance surface.

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
2. Native boundary: resolved for both VIR profiles and FIR's production dispatcher. FIR's
   generic numeric and provenance stack closes the former `fir_getTag` and
   `Nat.mod 2^32` traps. The full dispatcher must still preserve the
   `Float.log2` prescan decision.
3. FIR generated declarations: caller/callee provenance captures the two
   former Core-generated List specializations, and Lean's standard
   `ExplicitBoxing` path regenerates the former `_boxed` imports. Preserve
   these generic mechanisms through integration and package publication.
4. Closure size: production imports theorem-backed helpers and large matcher
   tables; module capture must avoid pulling unrelated public APIs/specs while
   retaining required initializers.
5. Backend cost: VIR and FIR remain materially slower than native on compressed
   levels; post-Array-fix FIR scaling is the next measurement boundary.
6. Output parity: replacing the entropy prescan or wide primitives can preserve
   DEFLATE validity while changing exact bytes; the oracle prevents unnoticed
   divergence.

The correctness path is complete for the full FIR dispatcher. Current work is
post-fix scaling and profiling, while VIR call-site lookup and FIR stored-arena
experiments address the remaining attributed performance tracks.
