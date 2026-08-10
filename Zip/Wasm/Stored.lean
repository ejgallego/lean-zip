import Zip.Spec.DeflateStoredCorrect

/-! # Minimal stored-block WASM root -/

namespace Zip.Wasm

/-- Level-0 vertical slice: emit proved stored DEFLATE blocks. -/
def compressStored (input : ByteArray) : ByteArray :=
  Zip.Spec.DeflateStoredCorrect.deflateStoredPure input

end Zip.Wasm
