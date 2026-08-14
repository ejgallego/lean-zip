# VIR and FIR browser performance notes

These are local diagnostic results, not release claims. Every row used a fresh
browser worker, exact native lean-zip output comparison, and independent raw
inflate. All VIR rows use the package-set-lifetime cache landed in PR #131;
measurements from the known per-call-cache bug and deleted pre-merge worktree
are excluded.

## Artifact identity

- Chrome: headless 150.0.0.0 on Linux
- VIR main: `d43a947e65cec5dbda9e2393a5e74d1150ca144f`
  (`fix: persist IR interpreter caches across calls (#131)`)
- VIR profile: `client-native`
- VIR Wasm: 742,811 bytes,
  `a09ad75ada18d90c6aec881fdf5bd34537029c2c5be243e477102adb200e3f78`
- VIR browser runtime snapshot: 43 files / 925,039 bytes,
  `fbfda2cca0fb63ac69ffc43fbdd29ef107fa7807bdedce59f94a91fdcd5835df`
- VIR package input: 1,151,430 bytes,
  `3f3db6f2a75085f193e8dbe569d8b8ac53dceb9a789e2ef641df6665a711c1d7`
- FIR proof-indexed-Array package: clean FIR `11ea983f`, lean-zip `30737b4e`;
  the reviewed closure ratchet is also committed on the current W7 lane as
  `9ef45d3f`
- FIR native levels 1–10 Wasm: 902,411 bytes,
  `d3992d5b5e5a4bd11edb93f48e0b95fbc2148a1c0b7c87b395d208e4a61e44cc`
- Previous FIR production-dispatcher package: FIR `1d79658d`, 1,753,310 bytes,
  `0686e69684c187b1b14415f0f3b88fe4ce28514c97f8aac003fbd7359f15b838`
- FIR C/Emscripten producer: FIR `515bf401`, lean-zip `261268cc`
- FIR C/Emscripten Wasm: 2,346,345 bytes,
  `8a37e8c76883c29c04b2e764482c62ec303344129b547b1f6a150a74a0c9ec7f`

## VIR compressed levels

Five browser samples at 64 KiB, after three excluded warmups, gave:

| input | level | native | VIR | VIR / native |
| --- | ---: | ---: | ---: | ---: |
| repeated text | 1 | 0.197 ms | 37.0 ms | 188x |
| repeated text | 6 | 0.766 ms | 209.1 ms | 273x |
| structured records | 1 | 0.142 ms | 47.8 ms | 338x |
| structured records | 6 | 0.865 ms | 352.6 ms | 408x |
| seeded random | 1 | 0.936 ms | 313.0 ms | 335x |
| seeded random | 6 | 4.00 ms | 1,330.9 ms | 333x |

Across these cells, VIR's `executeMs` accounts for 99.35–99.93% of its timed
steady call. Marshal, decode, and JavaScript host time do not explain the gap.
The wide client-native helpers execute inside the shared Wasm and are included
in `executeMs`.

The first compressed call remains intentionally cold. Compressible 64 KiB
inputs measured roughly 0.66–1.09 seconds before settling because the computed
32,769-entry distance table is constructed lazily. The fixed runtime retains
that value for the rest of the loaded package-set lifetime; it no longer pays
the cost on every public call.

Warm production-stage probes at level 6 further narrow the steady cost:

| 64 KiB input | whole | matcher | base preparation | remainder proxy |
| --- | ---: | ---: | ---: | ---: |
| structured records | 236 ms | 193 ms (81.7%) | 8.65 ms (3.7%) | 34.5 ms |
| seeded random | 1,239 ms | 923 ms (74.5%) | 158 ms (12.8%) | 158 ms |

![Stacked stage-attribution bars showing that VIR matcher work takes 81.7% of the structured call and 74.5% of the random call](assets/vir-stage-attribution.svg)

The remainder is `whole - matcher - base` from isolated calls and is not an
additive profile. The direct level-6 entry emitted bytes identical to the whole
dispatcher. These results make the matcher/interpreter instruction path the
next VIR target; they do not support a JavaScript-boundary or missing-inline
explanation.

### VIR symbol-level attribution

A diagnostics-only Node/V8 profile then exercised the complete production
`VirLeanZipAcceptance.compressRaw` entry on Canterbury `alice29.txt` at level
6. The 152,089-byte input has SHA-256
`7467306ee0feed4971260f3c87421154a05be571d944e9cb021a5713700c38f0`;
the native-equal, independently inflatable 54,518-byte output has SHA-256
`762d58319c66b33a062da439d7bed7b33250493acb3bc2ceecdd05454ca34267`.
Two warmups, package loading, compilation, and instantiation were excluded.
Three production calls were sampled at a requested 100 microsecond interval.

The stripped release Wasm produced 45,557 valid samples but exposed only
`wasm-function[N]` names, so that capture is an intentionally inconclusive
symbolization control. Repeating with VIR's optimized unstripped companion
Wasm produced 51,850 symbolized samples:

| heuristic self-sample family | share |
| --- | ---: |
| IR body/expression evaluation | 25.5% |
| interpreter call/dispatch | 24.8% |
| declaration/symbol lookup | 24.8% |
| allocation/reference counting | 9.4% |
| frames/boxing/closures | 8.8% |
| native Lean/runtime calls | 6.3% |
| other/unattributed | 0.5% |

The leading individual symbols were `interpreter::call` at 24.8%,
`interpreter::eval_body` at 22.1%, the interpreter symbol-cache hash lookup at
16.7%, `memcmp` at 4.5%, `lean_dec_ref_cold` at 3.5%, `lookup_symbol` at 3.5%,
`eval_expr` at 3.3%, and `dlmalloc` at 3.3%. The client-native wide helpers
appear among the native calls but do not form a leading self-time bucket.

This refines the stage result: the first runtime experiment should remove or
amortize repeated interpreter-local symbol resolution at IR call sites, then
measure whether the combined `call`/`eval_body` dispatcher becomes the clear
ceiling. Allocation/reference counting is real but is not the first target.
This also rejects a lean-zip-specific missing-inline hypothesis for the current
gap; the dominant cost is generic interpreter machinery.

The symbolized Wasm is 3,923,468 bytes with SHA-256
`3bc9dad56bd4d0765f74115382fa03b5d9200262ce543ddac1ee51f4f65a2738`.
The producer checkout was VIR `15a4c5d`, a descendant of accepted `d43a947`;
the intervening commit changes surface-analysis tooling and no `web` or `wasm`
runtime source.
The raw symbolized profile is
`/tmp/lean-zip-vir-l6-alice-d43-symbolized.cpuprofile`, SHA-256
`4287179b5e987ee75e47ce50723e2dcb35e42f13a9b7e3ed9f30b3adb626e042`;
its identity/report packet is
`/tmp/lean-zip-vir-l6-alice-d43-symbolized.profile.json`, SHA-256
`91d801c40b492938e65c7a22d2bd840fb4c0a975dbc17d015c31dc28475ad05e`.
Profiled elapsed values are not headline timings.

## FIR proof-indexed Array package

The consolidated 2026-08-14 package exercises the proof-indexed Array lowering
landed on FIR `main`: typed `getInternal`, `uget`, `get`, `set`, `uset`, and
`swap` consume their erased bounds proofs without repeating representation or
bounds branches. Public/foreign helpers and dynamically checked `get!`/`set!`
remain checked. Its `BUILD.json` records clean FIR commit `11ea983f` and clean
lean-zip commit `30737b4e`; checksum verification and the producer's levels
1–10 smoke gate pass. The complete Wasm bytes are identical to the reviewed
preview and to W7's post-review generated artifact. The comparison server now
snapshots this clean immutable package rather than `/tmp/fir-lean-zip-raw-review`.

The reviewed isolated closure has 662 captured declarations, 128 reviewed
externals, 534 retained source functions, 2,598 resident helpers, 3,132
complete functions, and zero residual runtime operations. The complete module
is zero-import and 902,411 bytes, versus 1,753,310 bytes for the earlier
served package. This is principally a closure/source-isolation result, not an
Array speed claim.

A real Chrome checkpoint sweep covered repeated text, structured records, and
seeded random inputs at 16 and 64 KiB, levels 1/6/10, three measured samples
after three excluded warmups. A matching FIR C/Emscripten sweep used the same
matrix. All 36 browser cells emitted exact native Lean bytes and passed
independent raw-DEFLATE inflation.

Representative 64 KiB medians were:

| input | level | native | FIR native checkpoint | FIR C/Emscripten | FIR native / FIR C |
| --- | ---: | ---: | ---: | ---: | ---: |
| repeated text | 1 | 0.137 ms | 6.735 ms | 0.580 ms | 11.6x |
| repeated text | 6 | 0.771 ms | 28.700 ms | 1.605 ms | 17.9x |
| repeated text | 10 | 6.751 ms | 258.605 ms | 18.915 ms | 13.7x |
| structured records | 1 | 0.253 ms | 5.780 ms | 0.520 ms | 11.1x |
| structured records | 6 | 0.741 ms | 44.320 ms | 2.850 ms | 15.6x |
| structured records | 10 | 7.011 ms | 293.965 ms | 31.575 ms | 9.3x |
| seeded random | 1 | 1.132 ms | 17.800 ms | 3.010 ms | 5.9x |
| seeded random | 6 | 4.650 ms | 256.215 ms | 8.445 ms | 30.3x |
| seeded random | 10 | 16.617 ms | 588.535 ms | 46.170 ms | 12.7x |

FIR native execution accounted for 97.3–100.0% of steady call time across the
checkpoint matrix. The host load was elevated and the FIR-native and FIR-C
sweeps were sequential rather than order-balanced, so these rows are a
correctness-backed diagnostic checkpoint, not a performance acceptance or a
precise before/after Array measurement. They do establish that removing the
proof-indexed checks does not close the resident-native execution gap.

The FIR-native packet is
`/tmp/lean-zip-fir-d399-checkpoint-browser-sweep.json`, SHA-256
`28d48e3f37c3f593598d08d8c2b864c9e15c21acd0ae7e58dedc491139b8b1ec`.
The matching FIR-C packet is
`/tmp/lean-zip-fir-c-checkpoint-browser-sweep.json`, SHA-256
`d460643daddb24d9290bcfba219d2dc32874bf9a9141dc7d61e0aaed80954d2c`.

### FIR native versus FIR-C scalability

A second browser checkpoint measured the clean package beside FIR-C at level
6 on a geometric 4/16/64/256 KiB ladder. Collection order was FIR native,
FIR-C, FIR-C, FIR native. Each of the four packets used five measured calls
after three excluded warmups, so each displayed value is the median of ten
steady samples. All 48 underlying browser cells emitted exact native Lean
bytes and independently inflated.

The parenthesized value is growth from the preceding 4x-larger-input step:

| input | bytes | FIR native | FIR-C | FIR native / FIR-C |
| --- | ---: | ---: | ---: | ---: |
| repeated text | 4 KiB | 27.84 ms | 1.93 ms | 14.4x |
|  | 16 KiB | 26.17 ms (0.94x) | 3.02 ms (1.57x) | 8.7x |
|  | 64 KiB | 122.16 ms (4.67x) | 4.84 ms (1.60x) | 25.2x |
|  | 256 KiB | 325.47 ms (2.66x) | 10.30 ms (2.13x) | 31.6x |
| structured records | 4 KiB | 27.50 ms | 1.52 ms | 18.1x |
|  | 16 KiB | 63.61 ms (2.31x) | 1.93 ms (1.27x) | 32.9x |
|  | 64 KiB | 95.71 ms (1.50x) | 10.10 ms (5.23x) | 9.5x |
|  | 256 KiB | 419.36 ms (4.38x) | 7.98 ms (0.79x) | 52.5x |
| seeded random | 4 KiB | 46.47 ms | 3.38 ms | 13.7x |
|  | 16 KiB | 160.34 ms (3.45x) | 3.79 ms (1.12x) | 42.3x |
|  | 64 KiB | 482.58 ms (3.01x) | 26.25 ms (6.92x) | 18.4x |
|  | 256 KiB | 2,041.44 ms (4.23x) | 75.96 ms (2.89x) | 26.9x |

Seeded random is the useful complexity stress here: successive FIR-native
growth factors are 3.45x, 3.01x, and 4.23x for 4x input growth. Across the full
64x input range it grows 43.9x and reaches about 0.12 MiB/s at the large end.
That is compatible with linear work plus fixed and input-dependent costs, and
decisively unlike the old O(index) Array regression, which would trend toward
16x time for each 4x step. FIR-C grows 22.5x across the same 64x range and
reaches 3.29 MiB/s. Thus scalability is no longer the immediate alarm; the
remaining FIR-native problem is its roughly 27x large-random constant-factor
gap to the identical dispatcher through Lean C/LLVM/Emscripten.

The host load average was 12.7 before collection and reached 17.9, producing
visible dispersion and non-monotonic compressible-input points. These are
diagnostic complexity results, not acceptance timings. The consolidated
summary packet is `/tmp/lean-zip-fir-d399-paired-scaling.json`, SHA-256
`482149c2715766edf00ffb9c42796d8fe31384334fd8e16f6f2ca9ef4975c495`;
it records all ten samples per point plus the four source-packet identities.

## Previous FIR production levels 1–10

The sole FIR compressed-level lane is the production `compressRaw` dispatcher.
The clean immutable package has a two-argument ABI, reviewed standard-math
runtime link, module-owned memory, zero imports, and zero residual runtime
operations. Its producer gate passes exact native bytes plus independent raw
inflate for five inputs at every level from 1 through 10.

FIR `1d79658d` fixes an accidental O(index) cursor walk in every resident Array
access. On the same 1 KiB structured level-6 Node workload, cold execution fell
from 917.5 ms to 195.6 ms and the next three calls from 30.0/28.6/27.6 ms to
11.7/8.9/7.3 ms. Persistent-cache and scratch-frontier growth remained
byte-identical, and the final module became 217 bytes smaller.

A fresh Chrome sweep of the integrated artifact used five samples after three
excluded warmups. All rows were exact-native and independently inflatable:

| level | native median | FIR steady median | FIR / native | honest first call |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.121 ms | 9.615 ms | 79.4x | 388.8 ms |
| 6 | 0.146 ms | 11.530 ms | 78.7x | 318.6 ms |
| 10 | 0.624 ms | 25.425 ms | 40.8x | 452.4 ms |

Execution accounts for 98.7–99.7% of FIR's steady call. Lazy constants remain
lazy and their publication is included in the first workload call; the demo
does not prime or shift that cost into setup.

## FIR C/Emscripten baseline

The comparison lab now has a second production FIR route. It takes FIR's final
LCNF through Lean C, LLVM, and Emscripten, links the full Lean runtime, and
calls the same `Zip.Wasm.compressRaw` entry as FIR native. It is therefore a
useful code-generation baseline, not another compressor implementation.

The package gate made 40 Node calls (four inputs at every level 1–10). A real
Chrome sweep then made 27 measured cells over three input families, three
sizes, and levels 1/6/10. Every call emitted exactly the native lean-zip bytes
and passed independent raw-DEFLATE inflation.

Representative 64 KiB medians from three samples after one excluded warmup:

| input | level | native | FIR C/Emscripten | ratio |
| --- | ---: | ---: | ---: | ---: |
| repeated text | 1 | 0.156 ms | 0.600 ms | 3.8x |
| repeated text | 6 | 0.673 ms | 1.105 ms | 1.6x |
| repeated text | 10 | 8.571 ms | 18.395 ms | 2.1x |
| structured records | 1 | 0.190 ms | 0.835 ms | 4.4x |
| structured records | 6 | 1.099 ms | 3.360 ms | 3.1x |
| structured records | 10 | 7.070 ms | 21.565 ms | 3.1x |
| seeded random | 1 | 1.129 ms | 3.080 ms | 2.7x |
| seeded random | 6 | 3.257 ms | 7.885 ms | 2.4x |
| seeded random | 10 | 20.995 ms | 43.870 ms | 2.1x |

The runtime executes 94.7–99.7% of the steady timed call in these cells, so
browser boundary copies are not the leading cost. The first workload call is
reported separately and includes ordinary Lean lazy-constant work; module
acquisition and full-runtime initialization remain in preparation.

Whole-program LTO initially exposed a real ABI mismatch: Lean-generated C
declares the final `Bool` argument of `lean_byte_array_copy_slice` as `uint8_t`,
while the C++ runtime defines it as `bool`. Those become LLVM `i8` and `i1`, and
LTO optimized the `ByteArray.extract` path to `unreachable`. The local package
uses a narrow generated-C-compatible bridge for `copySlice` and `extract`.
This bridge only repairs the runtime ABI; compression remains the unmodified
Lean production routine. It should be removed once the shared runtime exposes
a matching entry point.

The browser sweep packet is
`/tmp/lean-zip-fir-emscripten-sweep.json`, SHA-256
`86270322902d3e9e4a341ccc6a126968d6324d9ce35849cf1e3120a6479658ad`.

## Next measurements

1. Run FIR native and FIR C/Emscripten in one order-balanced sweep across
   1–256 KiB and levels 1–10, retaining raw first-call and steady samples.
2. Profile the FIR native dispatcher to identify the next steady runtime
   hotspot without reintroducing a specialized compressor root.
3. Ask VIR to screen an interpreter-call-site symbol-resolution cache or
   equivalent resolved-call representation against the existing symbolized
   profile; accept only with a fresh profile and order-balanced representative
   runs.
4. Upstream or otherwise centralize the generated-C/runtime `Bool` ABI bridge,
   then rebuild the FIR C lane without source rewriting.

Local evidence packets used for this note were written under `/tmp` by
`npm run bench:vir` and `npm run bench:fir`; the commands and JSON schema are
documented in the sibling README. The landed-main 27-cell sweep is
`f9640a0817ebc93d990f90547a187438775524730a46790feb84f652edc660fd`,
and the 1 MiB stored control is
`9f74d72ff56536105e2f102797d088977f9aeb383d4d2f2fcffa210c86733c36`.
