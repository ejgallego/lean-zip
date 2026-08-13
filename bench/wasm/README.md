# lean-zip WASM demo and benchmarks

This directory owns the application-level benchmark contract for raw DEFLATE
through Vir today and FIR when its concrete `ByteArray` runtime is ready. It
does not replace the native [Track D dashboard](../README.md): Track D remains
the authoritative compressor throughput/ratio suite. These runs measure the
cost of executing the same lean-zip entry through a backend.

## What is measured

Every case first runs `zip-wasm-oracle raw`, compares the backend result
byte-for-byte, and independently inflates it with Node zlib. Timing begins only
after that correctness gate.

The report separates:

- artifact reading and WebAssembly compilation;
- runtime instantiation and IR package/package-set loading;
- the first application call;
- diagnostics-off steady calls from native Lean and Vir;
- Wasm memory before/after every Vir timing block; and
- one diagnostic `callTimed` sample split into marshal, execute, decode, and
  host phases. That diagnostic sample is never included in headline medians.

Native and Vir steady blocks use a pass-level AB/BA schedule: even passes run
native then Vir, odd passes Vir then native. Raw per-call samples retain pass,
order, backend, iteration count, and checksum. The aggregate is the
repository median (the sorted sample at index `floor(n / 2)`), matching
lean-zip's existing native convention. Elapsed
time and memory growth are noisy evidence; hashes, compressed bytes, package
closure identity, and inflate results are deterministic evidence.

## Workload classes

[`plan.json`](plan.json) defines four named suites:

- `smoke` — an 81-byte micro gate at levels 1 and 6;
- `level-matrix` — focused dispatch coverage over levels 0 through 10 using
  committed Canterbury HTML;
- `canterbury` — representative committed source, prose, and binary cells at
  levels 1, 6, and 10; and
- `prescan-threshold` — optional real poorly-compressible Silesia inputs for
  the `Float.log2` routing boundary. Missing fetched corpus files are reported
  as skipped, never replaced with synthetic noise.

Micro/focused results are guardrails. Representative workloads choose
performance targets.

## Build native peers

From the lean-zip integration worktree:

```text
lake build zip-wasm-oracle zip-wasm-bench-native
node --test bench/wasm/lib.test.mjs
```

`zip-wasm-bench-native` loads input and starts its process before timing. Its
reported samples contain only repeated `Zip.Wasm.compressRaw` calls.

## FIR lazy-cache regression root

[`../../Zip/Wasm/CacheProbe.lean`](../../Zip/Wasm/CacheProbe.lean) exposes
`Zip.Wasm.distanceCodeCacheProbe : ByteArray → ByteArray`. It performs one call
to the production `distCodeWordBytesImpl` accessor for each input byte and
packs each result as four little-endian bytes. Repeated input bytes are
intentional: a backend that preserves Lean's lazy constant cache initializes
the 32,769-entry table once, while a backend that substitutes the initializer
at every access repeats that construction without matcher or emitter noise.

The native oracle supports the same binary contract:

```text
zip-wasm-oracle cache-probe input.bin expected.bin
```

This root is a backend diagnostic, not a compressor or a proposed hand-written
replacement table. FIR cache-lifetime changes should gate here first, checking
native byte equality and stable repeated-call scratch, before rerunning the
complete production dispatcher.

## Vir artifact

Vir owns the authoritative executable adapter at
`fixtures/lean-zip/VirLeanZipAcceptance/Exports.lean`. Keeping the adapter in
the backend repository prevents its explicit fallback list from drifting away
from Vir's package-generator and runtime acceptance.

[`../../lean-vir-native-externs.json`](../../lean-vir-native-externs.json)
selects the same seven accelerators and their existing C provider when used
with VIR's client-native-extern manifest support. It is an optional optimized
profile: the portable reference-body package remains the compatibility path.
Do not set `VIR_NATIVE_EXTERN_MANIFEST` with a VIR revision that does not
implement `lean-vir-client-native-externs` version 1.

The consolidated producer revision is Vir `main` at
`d43a947e65cec5dbda9e2393a5e74d1150ca144f` (`fix: persist IR interpreter
caches across calls (#131)`), which includes client-native extern support from
`5703203e9a8d755645aa3249df654ef8cadcc63d` (#127) and portable lean-zip support
from `9f69f1348da15274090d9074bbeded1eafc6b27a` (#125). The last clean two-profile
replay used lean-zip `220c5c5ecb22528799a9b78bdcba09351ac4ae9d` under Vir's
rc2 toolchain. Treat the commit identities and content hashes in a benchmark
report as authoritative; retained `/tmp` paths are only local conveniences.

Generate and retain the direct package from the Vir worktree, using a separate
lean-zip compatibility checkout built with Vir's exact Lean 4.33.0-rc2
toolchain:

```text
cd /path/to/vir
npm run build:demo:release
npm run accept:lean-zip -- /path/to/lean-zip-rc2 --passes 3 --keep
```

For the optimized profile, use the client manifest for both runtime and package
generation:

```text
cd /path/to/vir
VIR_NATIVE_EXTERN_MANIFEST=/path/to/lean-zip-rc2/lean-vir-native-externs.json \
  npm run build:demo:release
VIR_NATIVE_EXTERN_MANIFEST=/path/to/lean-zip-rc2/lean-vir-native-externs.json \
  npm run accept:lean-zip -- /path/to/lean-zip-rc2 --passes 3 --keep
```

Do not rebuild one half of a profile before retaining or serving the other:
the generated package and `vir-upstream.wasm` must come from the same manifest
setting. The comparison server snapshots both inputs when it starts.

The primary lean-zip checkout remains on rc1; source compatibility does not
make rc1-generated IR compatible with Vir's rc2 runtime. The acceptance
command rejects mismatched toolchains. It prints the retained temporary
directory containing `lean-zip-acceptance.irpkg` and its package report.

Consume that artifact directly:

```text
VIR=/path/to/vir
PKG=/tmp/vir-lean-zip-acceptance-.../lean-zip-acceptance.irpkg
ENTRY=VirLeanZipAcceptance.compressRaw

node bench/wasm/lean-zip.mjs demo \
  --vir-root "$VIR" --package "$PKG" --entry "$ENTRY"
```

The harness also accepts `--package-set PATH` for modular feasibility artifacts.
An entry is inferred only when the package input exposes exactly one export.

## Browser demo

Serve a loopback-only interactive page using the same package input:

```text
node bench/wasm/serve.mjs \
  --vir-root "$VIR" --package "$PKG" --entry "$ENTRY"
```

Open `http://127.0.0.1:4173/`. Each request invokes the real Vir/Wasm entry,
compares its output byte-for-byte with `zip-wasm-oracle`, and independently
inflates the raw-DEFLATE result. The page reports compressed size, hash, Vir
call time, and Wasm memory pages. It binds only to loopback and caps UTF-8 input
at 4 KiB because the current interpreter is intentionally a correctness path,
not an interactive-throughput implementation.

For the multi-backend browser lab—native Lean, browser-local VIR,
`CompressionStream`, pinned fflate, and explicit FIR capability rows—see
[`../web/README.md`](../web/README.md). The small page in this directory remains
the minimal single-call VIR correctness demo.

## Benchmark

Reports must be new paths outside the repository so creating a report cannot
change the recorded Git identity:

```text
node bench/wasm/lean-zip.mjs bench \
  --vir-root "$VIR" --package "$PKG" --entry "$ENTRY" \
  --suite smoke --json /tmp/lean-zip-vir-smoke.json
```

Useful controls include `--suite`, repeatable `--filter`, and explicit
`--passes`, `--samples`, `--warmups`, and `--iterations` overrides. The report
hashes the plan, harness, native executables, Vir runtime, shared Wasm,
the direct package or package-set descriptor and members, and every input. It
also records repository heads, dirty state, raw run order, and all samples.

Do not compare the first-call or package-load rows with native steady-state
throughput. Do not use a one-pass smoke run as an optimization claim. For a
performance decision, preserve the JSON report and use the representative
suite under stable machine conditions.
