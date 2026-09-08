module

import Zip

/-! Check the public API through the umbrella, without private imports. -/

example (br : ZipCommon.BitReader) (acc : UInt32) (shift : Nat) :
    ZipCommon.BitReader.readBits.go br acc shift 0 = .ok (acc, br) := rfl

example (v : UInt64) : Binary.readUInt64LE (Binary.writeUInt64LE v) 0 = v :=
  Binary.readUInt64LE_writeUInt64LE v

example (v : UInt32) : (Binary.writeUInt32LE v).size = 4 := by simp

example (data : ByteArray) : data.copyWithin 0 0 = data ++ data.extract 0 0 := rfl

-- Default arguments and structure fields must remain available to consumers.
example (data : ByteArray) : ByteArray := Zip.Native.GzipEncode.compress data
example (data : ByteArray) : ZipCommon.BitReader :=
  { data, pos := 0, bitOff := 0 }

example (data : ByteArray) (level : UInt8) (cap : Nat) (h : data.size ≤ cap) :
    Zip.Native.Inflate.inflate (Zip.Native.Deflate.deflateRaw data level) cap = .ok data :=
  Zip.Native.Deflate.inflate_deflateRaw data level cap h

example (data : ByteArray) (level : UInt8) (cap : Nat) (h : data.size ≤ cap) :
    Zip.Native.ZlibDecode.decompressSingle (Zip.Native.ZlibEncode.compress data level) cap =
      .ok data :=
  Zip.Native.zlib_decompressSingle_compress data level cap h

example (data : ByteArray) (level : UInt8) (cap : Nat) (h : data.size ≤ cap) :
    Zip.Native.GzipDecode.decompressSingle (Zip.Native.GzipEncode.compress data level) cap =
      .ok data :=
  Zip.Native.gzip_decompressSingle_compress data level cap h
