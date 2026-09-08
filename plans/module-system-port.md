# Port lean-zip to Lean's module system

## Current update: upstream split and Lean 4.33.0 (2026-09-09)

The module branch now integrates upstream master at
`6226abae88923f382ac09ae833a9c3f8220dbbc6`. Upstream removed the archive APIs,
fixture scripts, and benchmark package, leaving the verified DEFLATE core and
a new `conformance/` package for comparison against system zlib. Both current
packages select final `leanprover/lean4:v4.33.0`.

The shipped library and root tests retain module headers, public re-exports,
and exposed computational definitions. Public API checks now cover the retained
native codec APIs; checks for the removed FFI/archive APIs were removed. CI
caches and jobs follow the new root/conformance structure.

The common dependency remains pinned to the published fork commit
`3247bd6d39c31e019f80a2def42790bc21ff5599`; upstream common main still points to
`4425bab1f9522307d77e8d485bc536149ba31c36`. The new conformance package imports
upstream `lean-zlib` at `1a79d2d7713e55d98084f4ed92fd44263aab133c`, which is
still a legacy Lean package. Conformance therefore retains upstream legacy
sources and is explicitly excluded from the module-header check until that
dependency is ported. Lake may warn about its imports of module-enabled packages.
This exception does not affect module use by downstream library consumers.

Current validation commands (no local dependency override):

```sh
lake --no-cache build
lake --no-cache test
lake -d conformance --no-cache build
lake -d conformance --no-cache test
```

Final 4.33.0 validation passed: clean root build (237 jobs), root native tests,
conformance build (257 jobs), conformance tests, and a separate module consumer
build/run. The consumer uses no extra link flags and passes five DEFLATE and gzip
roundtrips. CI lint, the 99-source module-header check, and diff checks passed.
Logs are under
`.local-deps/module-port-logs/v433-*.log`. The prior clean build and test results
below describe the pre-split 4.33.0-rc1 port.

## Historical port and publication record (2026-09-08)

Analysis baseline: `9bc0e7d2`, with both packages pinned to
`leanprover/lean4:v4.33.0-rc1`. The compatibility port is implemented on
`feat/module-system`; clean builds and tests have passed for both packages using
the local dependency override. The original plan and baseline inventory are
retained below. Inventory counts exclude existing
worktrees and the new public API test module.

Dependency handoff (2026-09-08): the dependency agent confirms its port implemented
and validated in `/home/egallego/lean/lean-zip-common`, branch
`feat/module-system`, commit `3247bd6d39c31e019f80a2def42790bc21ff5599`.
The dependency agent reported a clean checkout at handoff. Its
`ModuleTests/ZipCommon.lean` explicitly names and unfolds
`ZipCommon.BitReader.readBits.go` through `import ZipCommon`.

Publication update (2026-09-08): the exact validated commit is now published on
[`ejgallego/lean-zip-common`, branch `feat/module-system`](https://github.com/ejgallego/lean-zip-common/tree/feat/module-system).
`git ls-remote https://github.com/ejgallego/lean-zip-common
refs/heads/feat/module-system` confirms the SHA above. The dependency agent
reports the comparison against `kim-em/main` contains exactly that one commit;
at that handoff no PR had been submitted, and the user planned to edit and
submit the PR description.
Upstream main is unchanged. Keep the consumer's eventual upstream Git pin
coordinated with the PR merge: verify the resulting upstream commit (which may
have a different SHA after squash/rebase), then update the root require revision
and both manifests together and validate them without the local override.
Submit the lean-zip PR only after the common-parts PR has merged upstream,
as requested by the user. The user subsequently requested a published consumer
branch for VIR to compile. For that branch, the root require declaration and
both manifests pin the published fork URL
`https://github.com/ejgallego/lean-zip-common` at the exact validated SHA above.
This permits ordinary Lake builds without local overrides while the upstream
merge is pending. Branch publication does not submit the lean-zip PR.

The agent reports these checks passed on the exact committed contents:
`lake clean`, `lake --no-cache build` (14 jobs), `lake --no-cache test`
(both ModuleTests modules),
`lake --no-cache build ZipCommon:static ZipForStd:static libio_ffi` (29 jobs),
`actionlint`, and `git diff --check`.

The local development override at `.local-deps/module-packages.json` points
to a separate detached checkout at `.local-deps/zipCommon-3247bd6`,
created from the dependency repository at that exact SHA. This isolates the
consumer from later edits in the agent's checkout. Run Lake with
`--packages=.local-deps/module-packages.json` from the lean-zip root to use it.
The manifest contains the checkout's absolute path, so dependency resolution
does not depend on the invocation directory. Resolution was checked
with `lake --packages=.local-deps/module-packages.json env printenv LEAN_PATH`;
both root and bench resolved the persistent checkout during the initial port
validation. The published branch uses the Git dependency by default; this local
override remains available for development. The override is a path
entry, so keep the detached checkout unchanged. Both files are stored persistently
under the gitignored `.local-deps/` directory in the lean-zip workspace.
From `bench/`, use `lake --packages=../.local-deps/module-packages.json`.
The root lakefile and both public manifests now use the published fork pin.
Switch their URL and revision together to the reviewed upstream result after
the common-parts PR merges. The setup inventory below describes the original
baseline.

One deliberate dependency export change: `Std.Tactic.BVDecide` is no longer an
umbrella re-export; `BinaryCorrect` publicly meta-imports
`Std.Tactic.BVDecide.Reflect` for generated verification code. Add explicit tactic
imports where downstream files relied on incidental availability. No
cross-package `import all` is needed. The dependency now sets
`requiresModuleSystem := true`, so legacy consumers will emit the expected Lake
warning until converted.

## Implementation and validation status

All 163 existing Lean sources outside the two lakefiles now use `module`.
The 94 shipped library modules preserve their public imports and expose their
definitions. Test, bench, and fixture-script declarations are public where
needed; both packages set `requiresModuleSystem := true`. The README example,
CI module-header check, and build cache keys have been updated.

Visibility repairs preserve the existing computations and logical statements:

- Explicit tactic imports replace incidental `bv_decide` availability;
  generated verification code receives a public meta import of
  `Std.Tactic.BVDecide.Reflect`.
- Computational helpers referenced by exposed definitions, and predicates used
  in public theorem types, are public. The chain matcher proofs reuse the
  identical `Encodable` predicate from the greedy matcher interface instead of
  their duplicate private `Enc` definitions. Public theorem names are unchanged.
- Proof arguments in exposed functions have explicit proposition types and
  tactic blocks so their private proof helpers stay private.
- `Native.Wide` uses targeted core-private imports of `Init.Data.Fin.Log2` and
  `Init.Data.UInt.Log2`; its `toNat_log2Clz` proof avoids the automatic defeq tag
  because the core bodies are private. `Archive` imports core `Init.System.ST`
  privately for its existing state-span proofs. There is no private import of
  zipCommon or a cross-package visibility opt-in.
- The bench fuzz runner's public return type `Census` is now public.
  No algorithm, FFI declaration, compiler replacement, trust assumption, or
  backward-compatibility option was added or changed.

`ZipModuleTests/PublicApi.lean`, imported by the existing test driver, checks
umbrella re-exports, binary lemmas and simp exports, `readBits.go` unfolding,
structure fields, defaults, Handle/FFI signatures, and the three end-to-end
roundtrip theorems. Its library name is deliberately distinct from zipCommon's
`ModuleTests` library to avoid Lake module-resolution collisions.

Validation logs and baseline artifacts are persistent under
`.local-deps/module-port-logs/`. Completed checks:

- Baseline root build and tests against the ported dependency.
- Full ported `Zip` library and default test executable/public API check builds.
- All bench default executables and the complete bench conformance/fuzz suite.
  miniz_oxide and libdeflate were enabled; zopfli exercised its disabled path.
  This machine needs `LIBDEFLATE_LDFLAGS=/usr/lib/x86_64-linux-gnu/libdeflate.so`
  to make the bundled Lean linker find the installed comparator. This is a
  local validation setting, not a source/build-configuration change.
- A separate module consumer importing `Zip`: 28 native/FFI roundtrips on four
  fixed inputs at levels 0, 1, 2, 6, 7, 9, and 10. Every compressed size and
  64-bit output hash matches the baseline. Five short whole-process timing
  samples showed no slowdown (baseline median 16.6 ms, port 14.7 ms); these
  small smoke timings are not a throughput benchmark or a speedup claim.
- Separate narrow imports of `Zip.Native.Gzip` and
  `Zip.Spec.DeflateRoundtripProduction`; all five fixture scripts elaborate
  without running their file-writing entry points.
- Axiom inventories for production DEFLATE, zlib, and gzip roundtrip theorems
  match the baseline: 96, 97, and 97 entries, respectively, after normalizing
  private-name print markers. These include the existing native BVDecide
  assumptions. None contains `sorryAx`.
- Temporarily changing only the proof of `inflate_deflateRaw` rebuilt just
  `Zip.Spec.DeflateRoundtripProduction`; its importers stayed cached. The
  original proof was restored and its library rebuild passed.
- Source-header check, `actionlint`, and `git diff --check` passed.

The final clean root build passed all 301 jobs in 276.93 seconds (wall time),
after cleaning the root, dependency, and bench Lake build directories. The root
test suite then passed, the clean bench build passed all 330 jobs, and the bench
test suite passed again. Logs are `final-clean-build.log`, `final-root-test.log`,
`final-bench-build.log`, and `final-bench-test.log`. Root and bench dependency
resolution was rechecked after the clean; both select the persistent detached
checkout. These clean checks used the local override before branch publication.
The public manifests now pin the same dependency contents on the published
fork, making the branch usable by VIR without local configuration. Validation
with the Git manifests is recorded below. Switching the dependency back to
upstream and submitting the consumer PR remain pending the common-parts merge.

Public Git validation for the VIR branch also passed: `lake --no-cache build`
(301 jobs) and `lake -d bench --no-cache build` (330 jobs), using the libdeflate
environment setting documented above for bench. Both ran without `--packages`
and resolved fresh Git clones at the validated dependency SHA under their own
`.lake/packages/zipCommon` directories. Logs are `published-pin-build.log` and
`published-pin-bench-build.log`. The module-header check covers all 164 sources,
including the new public API check; the staged diff check passed.

Published branch commands, from the lean-zip workspace:

```sh
lake --no-cache build
lake --no-cache test
lake -d bench --no-cache build
lake -d bench --no-cache test
```

Optional development commands using the preserved local snapshot:

```sh
lake --packages=.local-deps/module-packages.json env printenv LEAN_PATH
lake --packages=.local-deps/module-packages.json --no-cache build
lake --packages=.local-deps/module-packages.json --no-cache test
lake --packages=.local-deps/module-packages.json -d bench --no-cache build
lake --packages=.local-deps/module-packages.json -d bench --no-cache test
```

Use the libdeflate environment override above on this machine for the bench
commands. Keep development clones, manifests, consumers, and logs under
`.local-deps/`, never `/tmp`. Beam's local bundles are ignored under `.beam/`;
Beam checked core-only leaves, while Lake checked files needing the dependency
override (the installed Beam loader does not pass that override through).

For a new downstream package, declare the local zipCommon dependency explicitly
before creating its manifest: Lake's initial dependency update can discard
command-line package overrides when no manifest exists. The validation consumer
at `.local-deps/module-consumer/` has explicit absolute path dependencies on both
zipCommon and lean-zip. That validation consumer continues to use local paths;
it is separate from the public Git manifests used by VIR.

## Recommendation

Port `lean-zip-common` first, then port lean-zip in dependency order on the
existing toolchain. Preserve the current public names, definition unfolding,
module paths, and `import Zip` surface in the first pass. Tighten visibility and
imports in a separate follow-up after the compatibility port builds and tests.

The primary work is making the existing proof interfaces explicit. Moving files,
changing algorithms, and splitting the runtime and proof libraries are not
prerequisites.

## Baseline setup

| Area | Tracked Lean files | Role |
| --- | ---: | --- |
| `Zip.lean` and `Zip/` | 94 | Shipped `Zip` library |
| `ZipTest.lean` and `ZipTest/` | 33 | Library tests and executable driver |
| `bench/`, excluding its lakefile | 31 | Separate development package, comparator bindings, executables and tests |
| `scripts/` | 5 | Fixture generation programs |
| Lake configuration files | 2 | Root package and bench package |

None of these 165 files had a `module` header at the baseline. Within `Zip/`, 19
`Native` files contain 16,967 lines and 68 `Spec` files contain 51,702 lines.
The remaining six files provide zlib bindings, checksums, raw DEFLATE, gzip, tar,
and ZIP archives.

`lakefile.lean` declares `Zip`, `ZipTest`, and the default executable `test`;
`lake test` uses that executable. `Zip.lean` imports 77 modules directly,
including implementations and correctness results. Static import traversal from
`ZipTest` reaches all 93 files under `Zip/`; nevertheless, validate `Zip`
explicitly during the port so proof coverage does not depend on test imports.

The only external Lean package is `zipCommon`, pinned to
`4425bab1f9522307d77e8d485bc536149ba31c36`. That revision uses the same
Lean toolchain, but its 11 library source files are legacy files. It
provides `ZipCommon` (binary operations, bit reader, handle I/O, and proofs) and
`ZipForStd` (supporting lemmas). There is no mathlib dependency.

The root package builds five C archives: zlib, copy-within, extend-within, wide
byte operations, and fast-inflate primitives. Linux builds use LTO for the
Lean-generated code and applicable project primitives. The separate `bench`
package depends on the root through `require «lean-zip» from ".."` and owns the
Rust/miniz_oxide, libdeflate, and zopfli comparators.

Baseline CI builds and tests the root and bench packages on Ubuntu. It also
validates benchmark reporting/animation artifacts. Both Lake jobs cache build
directories and discard fallback cache restores.

## Constraints and likely failure points

1. **The dependency is a prerequisite.** The pinned Lean implementation rejects
   importing a legacy file from a `module` file (`Lean/Environment.lean`,
   `importModulesCore`). Porting leaf modules without external imports can start
   independently, but the full port requires a module-enabled zipCommon revision.

2. **Names and bodies require separate decisions.** `public` preserves a name;
   `@[expose]` preserves unfolding. Use `public import` for re-exports. Start with
   public imports and `@[expose] public section` in library files to approximate
   the existing interface, then repair individual visibility errors. Keep
   explicit private declarations under review: exposed definitions can refer to
   private helpers, so this transformation is a starting point, not a guarantee.

3. **Proofs reach inside implementations, including the external dependency.**
   `Zip/Spec/BitstreamCorrect.lean` names and unfolds
   `ZipCommon.BitReader.readBits.go`. `LZ77NativeCorrect.lean` unfolds matcher
   helpers, and `InflateFastCorrect.lean` uses generated `goCur.induct` and
   `goCurU.induct`. Audit nested definitions, equation lemmas, induction
   principles, default arguments, instances, and inferred types as well as
   top-level declarations. The zipCommon port must preserve the helper names and
   bodies its clients actually use.

4. **Directory order is not dependency order.** `Native.Inflate` imports
   `Spec.Huffman` and zipCommon bit-reader proofs. Native checksums import their
   specifications. `Native.DeflateDynamic` imports several correctness modules,
   including `Spec.DeflateFreqsFusedCorrect` and `Spec.DeflateStoredCorrect`.
   Follow the actual acyclic import graph, interleaving runtime and proof files.

5. **Package boundaries matter for private access.** Same-package proof and test
   files can use targeted `import all` when appropriate. `bench` and zipCommon
   are separate packages; private access across those boundaries requires the
   provider to opt in with `allowImportAll`. Prefer preserving the required
   public interfaces. Broad `import all` is neither a replacement for
   `public import` nor the default migration strategy.

6. **Compilation behavior needs validation.** Preserve `@[extern]`,
   `@[implemented_by]`, `@[csimp]`, and inlining attributes. In particular,
   `Native.TokenArray` and `Native.Wide` use compiler simplification theorems,
   while `Native.Deflate` has implementation replacements. Proof compilation
   alone cannot establish that these compiled paths and FFI symbols still work.
   Seven project files import `Std.Tactic.BVDecide`; check tactic availability
   and any phase errors, without marking runtime code `meta` wholesale.

The visibility and import rules above are described in the official
[module-system reference](https://lean-lang.org/doc/reference/latest/Source-Files-and-Modules/).
The dependency rejection and Lake configuration options were also checked in
the locally installed 4.33.0-rc1 sources.

## Implementation sequence

### 1. Capture the baseline

- Use an isolated checkout for the port and record the exact root and dependency
  revisions. Leave other worktrees alone.
- Run the existing root and bench build/test commands before edits. Record any
  pre-existing failures and comparator availability.
- Record representative downstream imports and theorem checks, plus a small
  fixed compression corpus and its output hashes. Include several compression
  levels and compiled FFI/packed-token paths.
- Generate a topological module list from source imports, treating `bench/` as
  its own source root. Save it with migration notes if it helps track batches.

### 2. Port and validate lean-zip-common

- Prepare a separate dependency change: `ZipForStd` support modules, basic
  `ZipCommon` operations, correctness modules, then their umbrella files.
- Preserve public declarations and exposed definitions, including the bit-reader
  nested helpers used by lean-zip proofs. Preserve handle FFI declarations and
  signatures.
- Validate the dependency's default library builds and cross-package smoke
  imports from a module-enabled consumer. In particular, check that
  `ZipCommon.BitReader.readBits.go` can still be named and unfolded.
- For development, use a controlled local dependency override. For the final
  change, pin the reviewed module-enabled revision in the root lakefile and
  regenerate both root and bench manifests. Do not ship a dependency on a local
  checkout or changes made only under `.lake/packages`.

Deliverable: independently reviewable dependency port and a reproducible pin.

### 3. Port the shipped library in dependency order

- Establish the header/visibility pattern on small leaves: `Zip.Basic`,
  `Native.CopyWithin`, `Native.ExtendWithin`, `Spec.Huffman`, and the checksum
  specifications. Include `Native.Wide` early to exercise BVDecide and FFI bodies.
- Continue through bit readers/writers, Huffman code, inflate implementations,
  token storage, and their supporting proofs in graph order.
- Continue through the deflate matcher/emitter/frequency/parse modules and
  correctness dependencies. Treat `Native.Deflate`, `Native.DeflateDynamic`,
  `Spec.DeflateFreqsFusedCorrect`, and the large inflate correctness files as
  explicit checkpoints; these are among the largest and most coupled files.
- Finish gzip/zlib framing and end-to-end proofs, tar/ZIP APIs, and remaining
  dependents. Existing signatures and theorem statements are the contract.
- Convert `Zip.lean` to a `module` with public re-exports of its existing imports.
  Check transitive exports too, since not every module appears directly in it.
- Resolve public references to private helpers explicitly. If backward
  compatibility options are needed to diagnose a batch, scope and track them;
  remove them before declaring the port complete. Avoid blanket warning
  suppression or proof workarounds that change theorem statements.

Use Beam diagnostics/probes for individual repairs and Lake builds at dependency
checkpoints. A successful single-file checkpoint does not validate importers.

Deliverable: all 94 shipped library files converted, with the existing API and
proof suite preserved.

### 4. Port all consumers and enforce the convention

- Convert the test helper modules and test entry point; declarations called from
  another file must be public. Make executable entry points explicitly public.
- Convert the bench libraries, comparator modules, tests, and all executable
  roots. Check their imports from Zip through the public interface, since bench
  cannot rely on same-package private access.
- Convert the five fixture scripts and check that they elaborate. Exercise
  generation only in disposable output locations, since these programs write
  fixtures.
- Update the README's consumer example to start with `module`.
- Keep both lakefiles as Lake configuration unless a concrete issue requires
  converting them. Source-module adoption does not require rewriting the build
  configuration itself.
- Set `requiresModuleSystem := true` for the converted code units and add a
  small CI source-header check covering library, tests, bench, and scripts.
  The Lake option produces warnings for legacy importers; it is not a substitute
  for checking that every intended source file was converted. Keep
  `allowNonModules` and cross-package `allowImportAll` at their defaults unless
  a specific compatibility requirement is documented.
- Make cache keys include the dependency manifest, umbrella files, and test
  sources; the current root key omits these. Use a fresh cache generation for
  the migration's clean validation.

### 5. Validate and measure

After merging the dependency upstream and updating the Git pins, validate clean
checkouts with the public manifests using:

```sh
lake -R build Zip
lake -R build
lake -R test
```

Then, from `bench/`:

```sh
lake -R build
lake -R test
```

Also require:

- A separate module-enabled consumer using `import Zip`, and consumers of
  representative narrow runtime and correctness modules. Check default
  arguments, structure construction, instances, and expected unfolding.
- Public checks of `Zip.Native.Deflate.inflate_deflateRaw`,
  `Zip.Native.zlib_decompressSingle_compress`, and the corresponding gzip
  theorem, plus an axiom-dependency comparison with the baseline.
- The existing FFI, wide-operation, packed-token, fast-inflate, and archive
  conformance tests. No new `sorry`, axiom, unsafe proof shortcut, or trusted
  runtime replacement introduced by the port.
- Byte-identical compressed output on the fixed corpus and matching decoded
  output. Compare a small representative native benchmark with the same
  toolchain, LTO setting, inputs, and machine; investigate regressions before
  changing optimization settings.
- Builds using the committed manifests without a preparatory `lake update`.
  Exercise benchmark comparator stubs and enabled bindings where available.
- Incremental rebuild evidence: change only a theorem proof without changing
  its statement, rebuild, and record which importers rebuild. Record cold build
  time and representative import memory/time against the baseline without
  promising a particular speedup.

## Follow-up after the compatibility port

Reduce re-exports and exposed bodies deliberately, backed by downstream tests.
Use targeted same-package `import all` for implementation proofs where hiding
the body is an intended API decision. Keep lemma interfaces public. Consider
adding a lightweight runtime umbrella while retaining `Zip` as the existing
comprehensive entry point; quantify the benefit first because some runtime
modules currently require proof modules.

The practical review sequence is: dependency port, lean-zip compatibility port
(with tests/bench/docs/CI), then optional visibility and import optimization.
The compatibility implementation and observed visibility repairs are recorded
above. Broader import/visibility reductions remain optional follow-up work.
