import Zip.Wasm.Entry
import Zip.Wasm.CacheProbe
import Zip.Native.InflateTreeFree

/-! Native conformance checks for the backend-neutral WASM roots. -/

namespace ZipTest.WasmEntry

private def mkConstantData (size : Nat) : ByteArray :=
  ByteArray.mk (Array.replicate size 0x42)

private def mkCyclicData (size : Nat) : ByteArray := Id.run do
  let pattern : Array UInt8 := #[0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]
  let mut output := ByteArray.emptyWithCapacity size
  for i in [:size] do
    output := output.push pattern[i % pattern.size]!
  return output

private def mkPrngData (size : Nat) (seed : UInt32 := 2463534242) : ByteArray := Id.run do
  let mut state := seed
  let mut output := ByteArray.emptyWithCapacity size
  for _ in [:size] do
    state := state ^^^ (state <<< 13)
    state := state ^^^ (state >>> 17)
    state := state ^^^ (state <<< 5)
    output := output.push (state &&& 0xFF).toUInt8
  return output

private def checkInflates (label : String) (input compressed : ByteArray) : IO Unit :=
  match Zip.Native.Inflate.inflate compressed with
  | .ok output => unless output == input do
      throw (IO.userError s!"{label}: inflate output mismatch")
  | .error e => throw (IO.userError s!"{label}: inflate failed: {e}")

private def checkSmallCase (name : String) (input : ByteArray) : IO Unit := do
  let stored := Zip.Wasm.compressStored input
  unless stored == Zip.Spec.DeflateStoredCorrect.deflateStoredPure input do
    throw (IO.userError s!"{name}: compressStored differs from its native root")
  checkInflates s!"{name}/stored" input stored

  let level1 := Zip.Wasm.compressLevel1 input
  unless level1 == Zip.Native.Deflate.deflateRawL1DirectHead16 input do
    throw (IO.userError s!"{name}: compressLevel1 differs from its native root")
  checkInflates s!"{name}/level1" input level1

  for level in [0, 1, 6, 10, 11] do
    let level8 := level.toUInt8
    let compressed := Zip.Wasm.compressRaw input level8
    unless compressed == Zip.Native.Deflate.deflateRaw input level8 do
      throw (IO.userError s!"{name}/L{level}: compressRaw differs from deflateRaw")
    checkInflates s!"{name}/L{level}" input compressed

def tests : IO Unit := do
  IO.println "  WasmEntry tests..."
  -- The first eight bytes of the tracked cache-cliff fixture. Keep the expected
  -- words literal so this checks the probe contract rather than recomputing it
  -- through the same accessor.
  let cacheProbeInput := ByteArray.mk #[123, 10, 32, 32, 34, 102, 111, 114]
  let cacheProbeExpected := ByteArray.mk #[
    0x0D, 0x05, 0x1B, 0x00, 0x06, 0x02, 0x02, 0x00,
    0x0A, 0x04, 0x00, 0x00, 0x0A, 0x04, 0x00, 0x00,
    0x0A, 0x04, 0x02, 0x00, 0x0D, 0x05, 0x06, 0x00,
    0x0D, 0x05, 0x0F, 0x00, 0x0D, 0x05, 0x12, 0x00]
  unless Zip.Wasm.distanceCodeCacheProbe cacheProbeInput == cacheProbeExpected do
    throw (IO.userError "distance-code cache probe output mismatch")

  let cases : List (String × ByteArray) :=
    [("empty", ByteArray.empty),
     ("short", ByteArray.mk #[0, 1, 2, 3, 255]),
     ("repeated4K", mkConstantData 4096),
     ("windowBoundary", mkCyclicData 32769)]
  for (name, input) in cases do
    checkSmallCase name input

  -- Exercise the exact large-input branch that depends on `Float.log2` in the
  -- backend closure. Deterministic xorshift data is classified incompressible,
  -- so production `compressRaw` must choose the stored-block root byte-for-byte.
  let incompressible := mkPrngData Zip.Native.Deflate.prescanMinSize
  unless Zip.Native.Deflate.incompressiblePrescan incompressible do
    throw (IO.userError "prescan fixture was not classified incompressible")
  let stored := Zip.Wasm.compressStored incompressible
  let compressed := Zip.Wasm.compressRaw incompressible 6
  unless compressed == stored do
    throw (IO.userError "prescan path differs from the stored-block root")
  checkInflates "prescan/L6" incompressible compressed

end ZipTest.WasmEntry
