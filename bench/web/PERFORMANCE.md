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
- FIR stored package: FIR `5033d797`, lean-zip `30737b4e`
- FIR Wasm: 11,667 bytes,
  `a639faedf81e1812d5fe9bb535aaced79b7230699c541b049eb0e4b08424870b`

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

The remainder is `whole - matcher - base` from isolated calls and is not an
additive profile. The direct level-6 entry emitted bytes identical to the whole
dispatcher. These results make the matcher/interpreter instruction path the
next VIR target; they do not support a JavaScript-boundary or missing-inline
explanation.

## Stored level: FIR-native and VIR

The stronger stored runs use nine samples, ten excluded warmups, and twenty
iterations per sample on 1 MiB of seeded random bytes. Content should not
affect stored DEFLATE; random bytes make the source identity explicit.

| backend | median wall | throughput | execution share | relative MAD |
| --- | ---: | ---: | ---: | ---: |
| FIR native stored | 5.87 ms | 170 MiB/s | 79% | 16% |
| VIR stored | 1.34 ms | 748 MiB/s | 40% | 17% |

The relatively large dispersion is reported rather than hidden: garbage
collection, CPU scheduling, and browser tiering still affect this local page.
Independent clean passes placed FIR around 4.6–5.9 ms (170–216 MiB/s); the
landed VIR pass had clean samples from 1.1–2.8 ms. A controlled campaign needs
multiple order-balanced browser-process passes before release claims.

At 1 MiB, the displayed FIR run's median phase split was 0.287 ms encode,
4.616 ms execute, and 0.753 ms decode. Its 11.8 KiB package prepared in
11.6 ms, versus 90.2 ms for VIR's 1.89 MiB runtime plus package in that run.
FIR therefore has a much smaller deployment/startup surface, while VIR's
mature resident runtime is substantially faster once loaded. This setup
comparison is descriptive, not apples-to-apples: FIR is a specialized module
and VIR is a general IR interpreter.

FIR memory grows from 1 to 335 pages on the first 1 MiB input and then remains
at 335 pages across warmups and samples. The measured scratch frontier grows by
21,899,688 bytes and rewinds to 1,024 after every call, so this is retained
linear-memory capacity rather than a per-call leak. This roughly 20.9x peak
temporary-footprint multiplier is the clearest FIR optimization lead.

## Next measurements

1. Profile VIR's matcher with instruction/op counters or a CPU profile inside
   the persistent interpreter; distinguish declaration lookup, object
   allocation/refcounting, and opcode dispatch before changing lean-zip.
2. Repeat the compressed matrix at 256 KiB and on representative corpus files
   once thermal/order controls are in place.
3. Retain FIR arena peak/frontier data per sample and explain the stored
   encoder's high temporary-capacity multiplier.
4. After FIR Level 1 capture succeeds, run exactly the same level-1 matrix and
   phase contract before adding higher levels.

Local evidence packets used for this note were written under `/tmp` by
`npm run bench:vir` and `npm run bench:fir`; the commands and JSON schema are
documented in the sibling README. The landed-main 27-cell sweep is
`f9640a0817ebc93d990f90547a187438775524730a46790feb84f652edc660fd`,
and the 1 MiB stored control is
`9f74d72ff56536105e2f102797d088977f9aeb383d4d2f2fcffa210c86733c36`.
