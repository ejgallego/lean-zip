# lean-zip browser comparison lab

See [`PERFORMANCE.md`](PERFORMANCE.md) for the first phase-aware VIR and FIR
results and their artifact identities.

This loopback-only page compares one raw-DEFLATE input across:

- native lean-zip, used as the byte-for-byte Lean reference;
- lean-zip interpreted by VIR's package-scoped persistent-interpreter runtime;
- FIR's zero-import resident-ByteArray stored compressor at Lean level 0;
- an optional zero-import FIR production compressor at Lean level 1;
- an optional zero-import FIR production dispatcher at Lean levels 1–10;
- the browser's `CompressionStream("deflate-raw")` implementation; and
- pinned fflate JavaScript (`0.8.2`).

It also reserves separate capability rows for FIR's deferred C/Emscripten
bundle and full-dispatcher support. A missing or level-inapplicable
artifact is reported as unavailable, not silently substituted with another
implementation.

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
immutable stored and production Level-1 packages:

```text
npm run serve -- \
  --vir-root /path/to/vir \
  --package /path/to/lean-zip-acceptance.irpkg \
  --vir-profile client-native \
  --fir-stored-package /path/to/lean-zip-stored-package \
  --fir-level1-package /path/to/lean-zip-level1-package \
  --fir-raw-package /path/to/lean-zip-raw-package
```

`--fir-native-package` remains an alias for `--fir-stored-package`. Use
`?level=0&autorun=1` for FIR stored and `?level=1&autorun=1` for FIR Level 1.
An admitted raw package enables its own row for every level from 1 through 10.
Each FIR row remains visible but level-inapplicable outside its exact level.
The current Level-1 artifact initializes compiler-generated lazy constants once
per Wasm instance and retains them below its scratch checkpoint. It has passed
the normal preset matrix through the page's 1 MiB global input bound.

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

The same driver benchmarks the currently admitted FIR-native stored slice at
level 0 while retaining the adapter's encode/execute/decode phases:

```text
npm run bench:fir -- --debug-port 9223 --out /tmp/lean-zip-fir-stored-sweep.json
```

Once the Level-1 package is attached, its exact-native sweep is:

```text
npm run bench:fir-level1 -- \
  --debug-port 9223 --out /tmp/lean-zip-fir-level1-sweep.json
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

FIR Level-1 has a parallel diagnostics-only profiler. It appends a standard
name section from FIR's exact ordered function inventory without changing the
published module's code section, runs the normal package adapter, and requires
native byte equality plus independent inflation:

```text
node bench/wasm/profile-fir.mjs \
  --package /path/to/lean-zip-level1-package \
  --inventory /path/to/lean-zip-level1.inventory.json \
  --fir-root /path/to/fir \
  --fixture bench/wasm/fixtures/fir-level1-cache-cliff.json \
  --cpu-profile /tmp/lean-zip-fir.cpuprofile \
  --json /tmp/lean-zip-fir-profile.json
```

The committed fixture pins the exact 83-byte browser sample and validates both
its UTF-8 byte length and SHA-256 before profiling. `--text` and `--input`
remain available for other bounded diagnostics.

Profile timings are diagnostic and should not be presented as headline
benchmark results. Persistent initialization is reported separately and is
excluded from profiled compression calls.

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

The two FIR rows represent different deliverables:

1. **FIR C / Emscripten** remains disabled. It needs a browser-loadable module
   plus a stable `HEAPU8` adapter for binary-safe `ByteArray` input and output.
2. **FIR native · stored** is admitted for the zero-import stored compressor at
   level 0.
3. **FIR native · Level 1** has a complete consumer lane. The current immutable
   zero-import package has passed its producer-side real-engine execution smoke
   for `Zip.Wasm.compressLevel1 : ByteArray → ByteArray` and an independent
   browser native-byte/inflate gate. The server rejects a package with imports,
   residual runtime operations, a mismatched source entry, non-module-owned
   memory, an unknown ByteArray layout, an absent/non-idempotent persistent-cache
   contract, or incomplete checksums. The 20-cell browser gate admits the normal
   1 MiB comparison-lab input bound.
4. **FIR native · levels 1–10** has a complete package validator, browser
   adapter, worker lane, and level-aware call ABI, but is not admitted yet.
   The exact zero-import module reaches its producer smoke, where FIR's eager
   persistent-cache initializer incorrectly forces an unreachable panic-only
   lazy constant. No raw immutable package is attached until that generic FIR
   cache-semantics regression is fixed and the all-level native/inflate gate
   passes.

The expected Level-1 package contract is:

```text
BUILD.json                                  fir.lean-zip.level1.build/v2
SHA256SUMS                                  covers every other package member
lean-zip-byte-array-browser-adapter.mjs     shared binary-safe implementation
lean-zip-level1-browser-adapter.mjs         fir.lean-zip.level1.browser/v2
lean-zip-level1.wasm                        zero imports; module-owned memory
lean-zip-level1.wasm.json                   ByteArray object -> ByteArray object
smoke.mjs                                   producer-side package gate
```

The adapter exports `createLeanZipLevel1Adapter`; the returned object exposes
`memory` and `compressLevel1(Uint8Array)`. Results use the same
`{ bytes, timings, memory }` shape as the stored adapter, including
encode/execute/decode timing and page telemetry. `adapter.initialization`
records `fir_initialize_persistent_caches`, the pre/post frontiers, one-time
initialization timing, and an idempotence check.

The raw package adds `lean-zip-raw-browser-adapter.mjs`,
`standard-math-runtime-contract.mjs`, `lean-zip-raw.wasm`, and its descriptor.
It must record the exact pre-link frontier
`Float.ofNat`/`Float.ofScientific`/`Float.log2`, the standard-runtime version
and 65,536-byte reservation, a zero-import complete module, and the
`ByteArray × UInt8 → ByteArray` ABI. Its adapter operation is
`compressRaw(Uint8Array, level)` with `level` in 1–10. Unlike the Level-1
package, raw v2 does not eagerly call a persistent initializer: compiler lazy
caches are populated at their original use sites, publication advances a
monotonic resident rewind floor, and a repeated warm call must rewind flat to
the resulting checkpoint.

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
