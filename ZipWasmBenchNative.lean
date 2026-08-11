import Zip.Wasm.Entry

/-!
# Native timing peer for backend WASM benchmarks

This executable measures only repeated calls to `Zip.Wasm.compressRaw` inside
one native Lean process. Process startup, input loading, and JSON rendering are
outside the timed region. The JavaScript orchestrator owns correctness checks,
AB/BA backend ordering, artifact identity, and report aggregation.
-/

private def usage : String :=
  "usage: zip-wasm-bench-native raw <level> <warmups> <iterations> <samples> <input>"

private def parseNat (label text : String) : IO Nat := do
  let some value := text.toNat?
    | throw (IO.userError s!"invalid {label} `{text}`")
  return value

private def parseLevel (text : String) : IO UInt8 := do
  let level ← parseNat "compression level" text
  unless level < 256 do
    throw (IO.userError s!"compression level must fit UInt8, got {level}")
  return level.toUInt8

/-- Keep every compressed result observably live without traversing it. -/
@[noinline] private def outputChecksum (bytes : ByteArray) : Nat :=
  bytes.size +
    (if bytes.size == 0 then 0 else bytes[0]!.toNat) +
    (if bytes.size == 0 then 0 else bytes[bytes.size - 1]!.toNat)

private def runCalls (input : ByteArray) (level : UInt8) (iterations : Nat) : IO Nat := do
  let mut checksum := 0
  for _ in [:iterations] do
    checksum := checksum + outputChecksum (Zip.Wasm.compressRaw input level)
  return checksum

private def jsonNatArray (values : Array Nat) : String :=
  "[" ++ String.intercalate "," (values.toList.map toString) ++ "]"

def main (args : List String) : IO Unit := do
  let ["raw", levelText, warmupsText, iterationsText, samplesText, inputPath] := args
    | throw (IO.userError usage)
  let level ← parseLevel levelText
  let warmups ← parseNat "warmup count" warmupsText
  let iterations ← parseNat "iteration count" iterationsText
  let samples ← parseNat "sample count" samplesText
  unless iterations > 0 do
    throw (IO.userError "iteration count must be positive")
  unless samples > 0 do
    throw (IO.userError "sample count must be positive")
  let input ← IO.FS.readBinFile inputPath
  let reference := Zip.Wasm.compressRaw input level
  let warmupChecksum ← runCalls input level warmups
  let mut sampleNs : Array Nat := #[]
  let mut sampleChecksums : Array Nat := #[]
  for _ in [:samples] do
    let started ← IO.monoNanosNow
    let checksum ← runCalls input level iterations
    let stopped ← IO.monoNanosNow
    sampleNs := sampleNs.push ((stopped - started) / iterations)
    sampleChecksums := sampleChecksums.push checksum
  IO.println <|
    "{\"format\":\"lean-zip-wasm-native-samples\",\"version\":1" ++
    s!",\"level\":{level.toNat},\"inputBytes\":{input.size}" ++
    s!",\"outputBytes\":{reference.size},\"warmups\":{warmups}" ++
    s!",\"iterations\":{iterations},\"samples\":{samples}" ++
    s!",\"warmupChecksum\":{warmupChecksum}" ++
    s!",\"sampleNs\":{jsonNatArray sampleNs}" ++
    s!",\"sampleChecksums\":{jsonNatArray sampleChecksums}" ++
    "}"
