# Lean 4.34 module and VIR/FIR integration

The `feat/module-vir-fir-4.34` branch stacks the Lean module port and browser
benchmark source on upstream's last 4.34-compatible commit, `8df2db25`.
Upstream `master` moved to Lean 4.35 RC after that point, so this branch keeps
the final `leanprover/lean4:v4.34.0` toolchain shared with current VIR main.

The module port depends on `ejgallego/lean-zip-common` commit
`25544958ec8fec76e8f720c5bdbe683cd897067a` on
`feat/module-system-4.34`. That commit applies the original module port to
upstream zip-common's 4.34 revision `6b7d018` and passed its build and module
tests. Both the root and conformance Lake manifests pin this published commit.

The browser source comes from the previously accepted
`feat/browser-catalog-package` producer. `Zip.Wasm.Entry` exposes the stored,
level-one, and production raw-DEFLATE entry points; `Zip.Wasm.CacheProbe`
isolates the distance-code cache. `zip-wasm-oracle` supplies binary-safe native
reference output. The exporter packages deterministic inputs, native oracle
outputs, browser protocol/worker/controller, and checksums for VIR/FIR consumers.

Validation commands from the repository root:

```sh
lake --no-cache build
lake --no-cache test
lake --no-cache build zip-wasm-oracle zip-wasm-bench-native zip-wasm-test
lake exe zip-wasm-test
npm ci --prefix bench/web
npm test --prefix bench/web
node --test bench/wasm/lib.test.mjs
node bench/catalog/export-browser-benchmark-source.mjs \
  --source . --output .local-deps/browser-source-smoke
```

The exporter requires a clean checkout by default. During local edits, add
`--allow-dirty`; the package records that state. Use a fresh output directory
under persistent `.local-deps/`, not `/tmp`.

At the 2026-09-28 refresh, published VIR main is
`149d2d4b615efbfaee8c1927e6adc6928410d9f4` on Lean 4.34.0; FIR main
is `259408c5d82fcbefd64097daca821e0474160d66` on Lean 4.34.1. Their
existing browser artifact/raw-source contracts still name the older lean-zip
producer `273d0d6c` and zip-common `4425bab1`. The new source package does
not replace those compiled artifacts on its own: the producer packages and
consumer pins must be refreshed together, using each producer's exact Lean
toolchain. In particular, FIR's 4.34.1 final-LCNF capture of the new module
sources remains an integration check for the FIR repository.
