module

public import Zip.Native.DeflateDynamic

public section

/-! # Level-1 WASM bring-up root -/

namespace Zip.Wasm

/-- Level-1 vertical slice: exercise the first production matcher/emitter. -/
def compressLevel1 (input : ByteArray) : ByteArray :=
  Zip.Native.Deflate.deflateRawL1DirectHead16 input

end Zip.Wasm
