import Zip.Wasm.Stored
import Zip.Wasm.Level1

/-!
# Backend-neutral WASM compression roots

These small, pure wrappers give IR/WASM backends stable entry points without
making the core library depend on a particular package generator or export
attribute. File I/O and host byte-array adaptation belong in backend-specific
drivers.

`Zip.Wasm.Stored.compressStored` and `Zip.Wasm.Level1.compressLevel1` can be
imported separately for progressively larger backend closures. `compressRaw`
is the public raw-DEFLATE target.
-/

namespace Zip.Wasm

/-- Complete production raw-DEFLATE compressor. -/
def compressRaw (input : ByteArray) (level : UInt8 := 6) : ByteArray :=
  Zip.Native.Deflate.deflateRaw input level

end Zip.Wasm
