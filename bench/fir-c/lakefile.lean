import Lake

open Lake DSL

package «LeanZipFirC»

/-- The lean-zip source tree compiled by the pinned FIR C toolchain. -/
def leanZipRoot : String :=
  get_config? leanZipRoot |>.getD "../.."

/-- The source checkout of lean-zip's pinned zipCommon dependency. -/
def zipCommonRoot : String :=
  get_config? zipCommonRoot |>.getD "../../.lake/packages/zipCommon"

lean_lib «ZipForStdSource» where
  srcDir := System.FilePath.mk zipCommonRoot
  globs := #[.submodules `ZipForStd]

lean_lib «ZipCommonSource» where
  srcDir := System.FilePath.mk zipCommonRoot
  globs := #[.submodules `ZipCommon]

lean_lib «LeanZipSource» where
  srcDir := System.FilePath.mk leanZipRoot
  globs := #[.submodules `Zip]

@[default_target]
lean_lib «LeanZipFirC»
