import Zip.Wasm.Entry

/-!
# Lean C/Emscripten bridge root

This is deliberately a one-line logical facade over the same production
dispatcher used by the native, VIR, and FIR-native benchmark lanes. The
`@[export]` name is the stable C ABI consumed by `runtime/lean-zip-bridge.c`.
-/

@[export fir_lean_zip_c_compress_raw]
def firLeanZipCCompressRaw (input : ByteArray) (level : UInt8) : ByteArray :=
  Zip.Wasm.compressRaw input level
