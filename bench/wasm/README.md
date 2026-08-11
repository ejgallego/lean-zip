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
- runtime instantiation and IR package-set loading;
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

## Vir artifact

The backend adapter is [`vir/ZipVirBench.lean`](vir/ZipVirBench.lean). Build it
in a Lean 4.33.0-rc2 client package with the local Vir commit that provides
`vir_extern_fallback`:

```text
Vir commit: 9fc13ce22a01b6713f3868938697129bb687fc76
lake build +Zip.VirBench:vir
```

Keep that Vir dependency in the integration package; do not add it to
lean-zip's production import graph. Pass the resulting full-compressor
`.irpkg-set.json` explicitly to the harness. Generated rc1 IR must not be mixed
with Vir's rc2 runtime.

The retained feasibility artifact can currently be used directly:

```text
VIR=/home/egallego/lean/vir/.worktrees/lean-zip-deflate-probe
SET=/tmp/vir-lean-zip-rc2.DC1lfY/.lake/build/vir/module-sets/Zip/VirProbeFull.irpkg-set.json

node bench/wasm/lean-zip.mjs demo \
  --vir-root "$VIR" --package-set "$SET"
```

The export name is inferred when the package contains one export, so the same
command works with `Zip.VirProbeFull.compressRaw` and the permanent
`Zip.VirBench.compressRaw` adapter.

## Benchmark

Reports must be new paths outside the repository so creating a report cannot
change the recorded Git identity:

```text
node bench/wasm/lean-zip.mjs bench \
  --vir-root "$VIR" --package-set "$SET" \
  --suite smoke --json /tmp/lean-zip-vir-smoke.json
```

Useful controls include `--suite`, repeatable `--filter`, and explicit
`--passes`, `--samples`, `--warmups`, and `--iterations` overrides. The report
hashes the plan, harness, native executables, Vir runtime, shared Wasm,
descriptor, every package member, and every input. It also records repository
heads, dirty state, raw run order, and all samples.

Do not compare the first-call or package-load rows with native steady-state
throughput. Do not use a one-pass smoke run as an optimization claim. For a
performance decision, preserve the JSON report and use the representative
suite under stable machine conditions.
