# lean-zip browser comparison lab

See [`PERFORMANCE.md`](PERFORMANCE.md) for the first phase-aware VIR and FIR
results and their artifact identities.

This loopback-only page compares one raw-DEFLATE input across:

- native lean-zip, used as the byte-for-byte Lean reference;
- lean-zip interpreted by VIR's package-scoped persistent-interpreter runtime;
- FIR's zero-import resident production dispatcher at Lean levels 1–10;
- the same dispatcher through FIR's Lean C/LLVM/Emscripten route and full Lean runtime;
- the browser's `CompressionStream("deflate-raw")` implementation; and
- pinned fflate JavaScript (`0.8.2`).

A missing or level-inapplicable artifact is reported as unavailable, not
silently substituted with another implementation.

## Run it

Build the two native peers and install the one pinned browser dependency:

```text
lake build zip-wasm-oracle zip-wasm-bench-native
cd bench/web
npm install
```

Then point the server at an exact VIR checkout and the package retained by
VIR's lean-zip acceptance command:

```text
npm run serve -- \
  --vir-root /path/to/vir \
  --package /path/to/lean-zip-acceptance.irpkg \
  --entry VirLeanZipAcceptance.compressRaw
```

Use landed VIR `main` as the sole VIR artifact and optionally attach FIR's
immutable resident-native and C/Emscripten production packages:

```text
npm run serve -- \
  --vir-root /path/to/vir \
  --package /path/to/lean-zip-acceptance.irpkg \
  --vir-profile client-native \
  --fir-raw-package /path/to/lean-zip-raw-package \
  --fir-emscripten-package /path/to/lean-zip-emscripten-package
```

Both FIR packages enable their own row for every level from 1 through 10. Each
row remains visible but level-inapplicable outside its advertised range.

The page also has deterministic exact-size inputs: repeated text, structured
records, seeded random bytes, and zero bytes. Query parameters such as
`?case=structured&bytes=65536&level=6&samples=3&backends=native,vir&autorun=1`
make a cold worker run reproducible.

The acceptance package also exposes production stage entries. The stage panel
performs an explicit untimed warmup and then profiles the matcher, base
preparation, direct level body where available, and whole compressor. Add
`?diagnose=1` to run it automatically; combine it with `?autorun=1` to capture
both sections in one local browser smoke.

Open `http://127.0.0.1:4173/`. The server never binds to a non-loopback
interface. `?autorun=1` selects one timing sample and starts the default case;
the document root receives `data-run-status="complete"` or `"failed"` for a
headless browser smoke check.

For a local Chrome smoke, launch Chrome with a debugging port and the autorun
URL, then run `node test/browser-smoke.mjs --debug-port 9223`. The waiter uses
the browser's local DevTools endpoint, requires the final status to be
`complete`, and prints the final execution-lane table as JSON. Add
`--screenshot /tmp/lean-zip-web.png` to retain a full-page rendering.

## Measurement and correctness contract

Each browser backend owns a dedicated module worker. Setup, Wasm compilation,
and package loading are recorded separately from the first call and the steady
samples. Lanes run sequentially to avoid deliberately benchmarking competing
compressors at the same time. Native timing comes from
`zip-wasm-bench-native`, which measures repeated calls inside one Lean process
and excludes process startup.

For VIR, each timed call additionally retains the runtime's diagnostic
`marshalMs`, `executeMs`, `decodeMs`, and `hostMs` phases. Outer wall time is
still the headline number. The call-anatomy panel and exported JSON use these
phases to distinguish interpreter execution from the JavaScript/Wasm boundary.

To collect a cold-worker matrix, start Chrome with a debugging port and run:

```text
npm run bench:vir -- --debug-port 9223 --out /tmp/lean-zip-vir-sweep.json
```

The default sweep covers three deterministic input classes, 1/16/64 KiB, and
Lean levels 0/1/6. Every cell runs native Lean and VIR, requires exact output
equality plus independent inflate, and rejects artifact identity changes during
the sweep. Three excluded warmups are used by default so V8 tier-up does not
pollute the measured median. `--cases`, `--sizes`, `--levels`, `--samples`,
`--warmups`, and `--iterations` accept comma-separated overrides.

The same driver benchmarks FIR C/Emscripten while retaining the adapter's
encode/execute/decode phases:

```text
npm run bench:fir-c -- --levels 1,6,10 \
  --debug-port 9223 --out /tmp/lean-zip-fir-emscripten-sweep.json
```

The production FIR dispatcher sweep is:

```text
npm run bench:fir-raw -- --levels 1,6,10 \
  --debug-port 9223 --out /tmp/lean-zip-fir-raw-sweep.json
```

The first call retains the now-once-per-package construction cost of lean-zip's
computed 32,769-entry `distCodeWordBytes` nullary table. The supported VIR
runtime retains that table across later public calls. Production stage profiles
run only after an explicit warmup, so cold initialization and steady execution
remain separate measurements.

For symbol-level attribution, profile warmed production calls in Node/V8 using
the same package and VIR's optimized unstripped companion Wasm. The command
verifies native byte equality and independent inflation, excludes setup and
warmups from the profile, refuses to overwrite its outputs, and labels profiled
timings diagnostic-only:

```text
node bench/wasm/profile-vir.mjs \
  --vir-root /path/to/vir \
  --package /path/to/lean-zip-acceptance.irpkg \
  --cpu-profile /tmp/lean-zip-vir.cpuprofile \
  --json /tmp/lean-zip-vir-profile.json
```

The report keeps raw self-sample symbols and a heuristic grouping for lookup,
interpreter dispatch, IR evaluation, frames/boxing, and allocation/reference
counting. Use the grouping to choose the next VIR runtime experiment, not as a
precise additive cost model.

After timing, the local server inflates every output with Node zlib. All active
Lean lanes must additionally match native lean-zip byte-for-byte. Other codecs may
legitimately produce different raw streams.

The level selector is not a cross-codec quality equivalence:

- native Lean and VIR receive lean-zip levels 0 through 10;
- fflate receives levels 0 through 9, with Lean level 10 shown as fflate 9;
- `CompressionStream` exposes no compression-level option, so its row says
  `browser default`.

The JSON export retains repository and artifact hashes, source identity, raw
timing samples, memory-page observations, and validation results. It omits the
input and compressed payloads. This makes the page useful for interactive
evidence, but it is not a replacement for a controlled representative-corpus
benchmark campaign.

At startup the server snapshots the full VIR browser runtime tree, shared Wasm,
and IR package bytes in memory. Requests never reread those producer paths.
This prevents a concurrent generic VIR build from silently pairing a
client-native package with a newly replaced portable Wasm; restarting the
server is the explicit artifact switch.

## FIR admission boundary

The FIR rows represent distinct deliverables:

1. **FIR native · levels 1–10** exercises FIR's zero-import resident lowering.
   Its immutable package has a complete validator, browser adapter, worker
   lane, and level-aware call ABI. The exact zero-import module passes the full
   5-case × 10-level native-byte/inflate gate. Lazy cache publication remains
   part of the honest first workload call.
2. **FIR C / Emscripten · levels 1–10** calls the identical Lean dispatcher
   through final LCNF, Lean C, LLVM, and Emscripten. Its manifest-verified ES
   module links the pinned full Lean runtime; a narrow `HEAPU8` bridge copies
   ordinary Lean `ByteArray` input and output at the browser boundary.

The raw package adds `lean-zip-raw-browser-adapter.mjs`,
`standard-math-runtime-contract.mjs`, `lean-zip-raw.wasm`, and its descriptor.
It must record the exact pre-link frontier
`Float.ofNat`/`Float.ofScientific`/`Float.log2`, the standard-runtime version
and 65,536-byte reservation, a zero-import complete module, and the
`ByteArray × UInt8 → ByteArray` ABI. Its adapter operation is
`compressRaw(Uint8Array, level)` with `level` in 1–10. Raw v2 does not eagerly
call a persistent initializer: compiler lazy
caches are populated at their original use sites, publication advances a
monotonic resident rewind floor, and a repeated warm call must rewind flat to
the resulting checkpoint. The comparison UI reports this workload-dependent
cold cache population as part of the first call (including persistent byte
growth), never as setup; steady samples run only after that separate cold call
and the configured warmups.

Every new FIR capability must first execute successfully in a real Wasm engine,
then use the same prepare/run phases and pass native byte equality plus
independent inflate before its advertised level set expands. A clean static
closure or successful instantiation alone is not an admission result.

## VIR portable and client-native profiles

The default VIR artifact uses the seven explicit portable Lean reference
bodies from VIR's lean-zip adapter. Client-native extern support is merged in
VIR `main` at `d43a947e65cec5dbda9e2393a5e74d1150ca144f`; it consumes
[`../../lean-vir-native-externs.json`](../../lean-vir-native-externs.json) and
compiles lean-zip's existing `c/bytearray_wide_ffi.c` provider into the shared
runtime. This revision includes the package-lifetime interpreter cache from
PR #131, so warm calls retain computed Lean constants without a separate fix
worktree. Both profiles use the same browser worker and correctness contract;
artifact hashes in the report identify which one was actually served. The
portable profile remains the compatibility baseline, while client-native is
the supported optimized profile.

Pass `--vir-profile client-native` when serving a package and Wasm built with
that manifest. The label appears beside the effective setting and in the JSON
artifact identity. It does not infer compatibility: the package and shared
Wasm must still come from the same profile build.
