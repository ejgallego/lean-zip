/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/

import Zip.Native.DeflateDynamic
import Vir

namespace VirLeanZipStageProbe

open Zip.Native.Deflate

vir_extern_fallback ByteArray.pushUInt64LE, ByteArray.ugetUInt32LE,
  ByteArray.ugetUInt64LE, UInt64.ctzFast, ByteArray.usetUInt64LE,
  ByteArray.usetUInt32LE, UInt32.log2Clz

private def tokenArray? (packedTokens : ByteArray) : Option TokenArray :=
  if h : packedTokens.size % 4 = 0 then
    some { bytes := packedTokens, aligned := h }
  else
    none

private def bumpRefLitFreqLinear
    (frequencies : {a : Array Nat // a.size = 286}) (w : UInt32) :
    {a : Array Nat // a.size = 286} :=
  match findLengthCode (((w >>> 16) &&& 0x7FFF).toNat) with
  | none => frequencies
  | some (idx, _, _) =>
      let values := frequencies.val
      ⟨values.set! (idx + 257) (values.getD (idx + 257) 0 + 1),
        by rw [Array.size_set!]; exact frequencies.property⟩

private def bumpRefDistFreqLinear
    (frequencies : {a : Array Nat // a.size = 30}) (w : UInt32) :
    {a : Array Nat // a.size = 30} :=
  match findDistCode ((w &&& 0xFFFF).toNat) with
  | none => frequencies
  | some (idx, _, _) =>
      let values := frequencies.val
      ⟨values.set! idx (values.getD idx 0 + 1),
        by rw [Array.size_set!]; exact frequencies.property⟩

private def tokenFreqsLinear (tokens : TokenArray) : Array Nat × Array Nat :=
  go tokens
    ⟨(Array.replicate 286 0).set! 256 1,
      by rw [Array.size_set!, Array.size_replicate]⟩
    ⟨Array.replicate 30 0, by rw [Array.size_replicate]⟩ 0
where
  go (tokens : TokenArray) (litLenFreqs : {a : Array Nat // a.size = 286})
      (distFreqs : {a : Array Nat // a.size = 30}) (i : Nat) : Array Nat × Array Nat :=
    if h : i < tokens.size then
      let w := tokens.get i h
      if w &&& ((1 : UInt32) <<< 31) = 0 then
        go tokens (bumpLitFreqP litLenFreqs w) distFreqs (i + 1)
      else
        go tokens (bumpRefLitFreqLinear litLenFreqs w)
          (bumpRefDistFreqLinear distFreqs w) (i + 1)
    else (litLenFreqs.val, distFreqs.val)
  termination_by tokens.size - i

@[vir_export]
def profileEmptyHistograms : Nat :=
  let literalLengths : Array Nat := Array.replicate 286 0
  let distances : Array Nat := Array.replicate 30 0
  literalLengths[0]! + literalLengths[256]! + distances[0]!

@[vir_export]
def profileNatLoop (count : Nat) : Nat :=
  go count 0
where
  go (remaining acc : Nat) : Nat :=
    if remaining = 0 then acc
    else go (remaining - 1) (acc + 1)
  termination_by remaining

@[vir_export]
def profileTokenReads (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens => go tokens 0 0
where
  go (tokens : TokenArray) (i acc : Nat) : Nat :=
    if h : i < tokens.size then
      go tokens (i + 1) (acc + (tokens.get i h).toNat)
    else acc
  termination_by tokens.size - i

@[vir_export]
def profileLiteralBumps (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := go tokens
        ⟨Array.replicate 286 0, by rw [Array.size_replicate]⟩ 0
      frequencies.val.getD 0 0 + frequencies.val.getD 255 0
where
  go (tokens : TokenArray) (frequencies : {a : Array Nat // a.size = 286})
      (i : Nat) : {a : Array Nat // a.size = 286} :=
    if h : i < tokens.size then
      go tokens (bumpLitFreqP frequencies (tokens.get i h)) (i + 1)
    else frequencies
  termination_by tokens.size - i

@[vir_export]
def profileLengthCodeWords (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens => go tokens 0 0
where
  go (tokens : TokenArray) (i acc : Nat) : Nat :=
    if h : i < tokens.size then
      let w := tokens.get i h
      let acc := if w &&& ((1 : UInt32) <<< 31) = 0 then acc
        else acc + codeIdx (lenCodeWord (((w >>> 16) &&& 0x7FFF).toNat))
      go tokens (i + 1) acc
    else acc
  termination_by tokens.size - i

@[vir_export]
def profileDistanceCodeWords (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens => go tokens 0 0
where
  go (tokens : TokenArray) (i acc : Nat) : Nat :=
    if h : i < tokens.size then
      let w := tokens.get i h
      let acc := if w &&& ((1 : UInt32) <<< 31) = 0 then acc
        else acc + codeIdx (distCodeWord ((w &&& 0xFFFF).toNat))
      go tokens (i + 1) acc
    else acc
  termination_by tokens.size - i

@[vir_export]
def profileLinearCodeWords (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens => go tokens 0 0
where
  go (tokens : TokenArray) (i acc : Nat) : Nat :=
    if h : i < tokens.size then
      let w := tokens.get i h
      let acc := if w &&& ((1 : UInt32) <<< 31) = 0 then acc else
        let length := ((w >>> 16) &&& 0x7FFF).toNat
        let distance := (w &&& 0xFFFF).toNat
        acc + codeIdx (packCode (findLengthCode length)) +
          codeIdx (packCode (findDistCode distance))
      go tokens (i + 1) acc
    else acc
  termination_by tokens.size - i

@[vir_export]
def profileLinearFrequencies (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsLinear tokens
      frequencies.1[0]! + frequencies.1[256]! + frequencies.2[0]!

@[vir_export]
def profileLinearCandidateSizes (data packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsLinear tokens
      let lengths := dynamicCodeLengths frequencies.1 frequencies.2
      let plan := dynHeaderCodes lengths.1 lengths.2
      have hcl : plan.clCodes.size ≥ 19 :=
        Nat.le_of_eq (dynHeaderCodes_clCodes_size lengths.1 lengths.2).symm
      data.size + fixedBlockBytes frequencies.1 frequencies.2 +
        dynBlockBytesWith frequencies.1 frequencies.2 lengths.1 lengths.2 plan hcl

@[vir_export]
def profileFrequencies (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsPTA tokens
      frequencies.1[0]! + frequencies.1[256]! + frequencies.2[0]!

@[vir_export]
def profileCodeLengths (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsPTA tokens
      let lengths := dynamicCodeLengths frequencies.1 frequencies.2
      lengths.1.getD 0 0 + lengths.1.getD 256 0 + lengths.2.getD 0 0

@[vir_export]
def profileHeaderPlan (packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsPTA tokens
      let lengths := dynamicCodeLengths frequencies.1 frequencies.2
      let plan := dynHeaderCodes lengths.1 lengths.2
      have hcodes : 0 < plan.clCodes.size := by
        rw [dynHeaderCodes_clCodes_size lengths.1 lengths.2]
        omega
      plan.clEntries.length + plan.clLens.getD 0 0 + plan.clCodes[0].1.toNat +
        plan.numCodeLen

@[vir_export]
def profileCandidateSizes (data packedTokens : ByteArray) : Nat :=
  match tokenArray? packedTokens with
  | none => 0
  | some tokens =>
      let frequencies := tokenFreqsPTA tokens
      let lengths := dynamicCodeLengths frequencies.1 frequencies.2
      let plan := dynHeaderCodes lengths.1 lengths.2
      have hcl : plan.clCodes.size ≥ 19 :=
        Nat.le_of_eq (dynHeaderCodes_clCodes_size lengths.1 lengths.2).symm
      data.size + fixedBlockBytes frequencies.1 frequencies.2 +
        dynBlockBytesWith frequencies.1 frequencies.2 lengths.1 lengths.2 plan hcl

end VirLeanZipStageProbe
