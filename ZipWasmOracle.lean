import Zip.Wasm.Entry

/-!
# `zip-wasm-oracle`

A binary-safe native oracle for WASM backend conformance. It deliberately uses
files rather than terminal strings, JSON, or base64 so large arbitrary inputs
and outputs cross no text encoding boundary.

Usage:

```text
zip-wasm-oracle stored <input> <output>
zip-wasm-oracle level1 <input> <output>
zip-wasm-oracle raw <level> <input> <output>
```
-/

private def usage : String :=
  "usage: zip-wasm-oracle stored <input> <output>\n" ++
  "       zip-wasm-oracle level1 <input> <output>\n" ++
  "       zip-wasm-oracle raw <level> <input> <output>"

private def parseLevel (text : String) : IO UInt8 := do
  let some level := text.toNat?
    | throw (IO.userError s!"invalid compression level `{text}`")
  unless level < 256 do
    throw (IO.userError s!"compression level must fit UInt8, got {level}")
  return level.toUInt8

private def compressFile (inputPath outputPath : String)
    (compress : ByteArray → ByteArray) : IO Unit := do
  let input ← IO.FS.readBinFile inputPath
  IO.FS.writeBinFile outputPath (compress input)

def main (args : List String) : IO Unit := do
  match args with
  | ["stored", inputPath, outputPath] =>
      compressFile inputPath outputPath Zip.Wasm.compressStored
  | ["level1", inputPath, outputPath] =>
      compressFile inputPath outputPath Zip.Wasm.compressLevel1
  | ["raw", levelText, inputPath, outputPath] =>
      let level ← parseLevel levelText
      compressFile inputPath outputPath (Zip.Wasm.compressRaw · level)
  | _ => throw (IO.userError usage)
