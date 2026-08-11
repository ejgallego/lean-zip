# lean-zip browser comparison lab

This loopback-only page compares one raw-DEFLATE input across:

- native lean-zip, used as the byte-for-byte Lean reference;
- lean-zip interpreted by VIR's browser WebAssembly runtime;
- the browser's `CompressionStream("deflate-raw")` implementation; and
- pinned fflate JavaScript (`0.8.2`).

It also reserves separate capability rows for FIR's near-term C/Emscripten
bundle and its FIR-native WebAssembly path. A missing FIR artifact is reported
as unavailable, not silently substituted with another implementation.

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

After timing, the local server inflates every output with Node zlib. All Lean
lanes must additionally match native lean-zip byte-for-byte. Other codecs may
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

The two disabled rows intentionally represent different deliverables:

1. **FIR C / Emscripten** needs a browser-loadable module plus a stable
   `HEAPU8` adapter for binary-safe `ByteArray` input and output.
2. **FIR native** needs FIR closure/admission support for captured concrete
   `ByteArray` operations before the same worker protocol can host it.

Once either artifact exists, it should implement the worker's prepare/run
contract and pass the same native-equality and independent-inflate gates before
its capability flag becomes available.

## VIR portable and client-native profiles

The default VIR artifact uses the seven explicit portable Lean reference
bodies from VIR's lean-zip adapter. VIR's client-native-extern manifest lane
can instead consume [`../../lean-vir-native-externs.json`](../../lean-vir-native-externs.json)
and compile lean-zip's existing `c/bytearray_wide_ffi.c` provider into the
shared runtime. Both profiles use the same browser worker and correctness
contract; artifact hashes in the report identify which one was actually
served. Keep the portable profile as the landing baseline until the generic
manifest support is merged in VIR.

Pass `--vir-profile client-native` when serving a package and Wasm built with
that manifest. The label appears beside the effective setting and in the JSON
artifact identity. It does not infer compatibility: the package and shared
Wasm must still come from the same profile build.
