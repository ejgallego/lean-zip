import Zip.Native.Deflate

/-!
# WASM lazy-constant cache probe

This backend-neutral diagnostic root isolates the production distance-code
table accessor.  FIR and other whole-program backends can capture it without
also running the matcher or emitter, making lazy-constant initialization and
retention regressions cheap to reproduce.

Each input byte `b` selects the valid DEFLATE distance `b + 1`; its packed
distance code is appended to the output as four little-endian bytes.  Repeated
input bytes intentionally repeat the same production cache access.  This is a
diagnostic entry point, not an alternate compressor implementation.
-/

namespace Zip.Wasm

/-- Exercise one production `distCodeWordBytes` access per input byte. -/
def distanceCodeCacheProbe (input : ByteArray) : ByteArray :=
  input.foldl (init := ByteArray.emptyWithCapacity (4 * input.size)) fun output byte =>
    output.pushUInt32LE
      (Zip.Native.Deflate.distCodeWordBytesImpl (byte.toNat + 1))

end Zip.Wasm
