import Zip.Wasm.Entry
import Vir

/-!
# Vir adapter for the lean-zip WASM demo and benchmark

This file belongs to a Vir-enabled integration package, not lean-zip's normal
import graph. It makes the seven project accelerators use their transparent
Lean reference bodies for this package only.
-/

namespace Zip.VirBench

vir_extern_fallback ByteArray.pushUInt64LE, ByteArray.ugetUInt32LE,
  ByteArray.ugetUInt64LE, UInt64.ctzFast, ByteArray.usetUInt64LE,
  ByteArray.usetUInt32LE, UInt32.log2Clz

@[vir_export]
def compressRaw (input : ByteArray) (level : UInt8) : ByteArray :=
  Zip.Wasm.compressRaw input level

end Zip.VirBench
