module

import ZipModuleTests.PublicApi
public import ZipTest.BenchHelpers
public import ZipTest.Zlib
public import ZipTest.Gzip
public import ZipTest.RawDeflate
public import ZipTest.Checksum
public import ZipTest.Binary
public import ZipTest.Wide
public import ZipTest.ExtendWithin
public import ZipTest.Tar
public import ZipTest.Archive
public import ZipTest.ZipFixtures
public import ZipTest.TarFixtures
public import ZipTest.TarPathTruncation
public import ZipTest.CompressFixtures
public import ZipTest.Utf8Fixtures
public import ZipTest.NativeChecksum
public import ZipTest.NativeInflate
public import ZipTest.InflateFast
public import ZipTest.NativeGzip
public import ZipTest.NativeIntegration
public import ZipTest.NativeScale
public import ZipTest.NativeDeflate
public import ZipTest.NativeCompressBench
public import ZipTest.Benchmark
public import ZipTest.BoundedReadTest
public import ZipTest.InflateTable
public import ZipTest.OptimalParse
public import ZipTest.PackedTokens
public import ZipTest.PackedHeads
public import ZipTest.SizeHelpers
public import ZipTest.L7Adaptive

public section

def main : IO Unit := do
  unless ← System.FilePath.pathExists "testdata" do
    throw (IO.userError "testdata/ not found — run tests via 'lake test' from the project root")
  ZipTest.Zlib.tests
  ZipTest.Gzip.tests
  ZipTest.RawDeflate.tests
  ZipTest.Checksum.tests
  ZipTest.Binary.tests
  ZipTest.Wide.tests
  ZipTest.ExtendWithin.tests
  ZipTest.Tar.tests
  ZipTest.Archive.tests
  ZipTest.ZipFixtures.tests
  ZipTest.TarFixtures.tests
  ZipTest.TarPathTruncation.tests
  ZipTest.CompressFixtures.tests
  ZipTest.Utf8Fixtures.tests
  ZipTest.NativeChecksum.tests
  ZipTest.NativeInflate.tests
  ZipTest.InflateFast.tests
  ZipTest.InflateTable.tests
  ZipTest.InflateTable.canonicalTests
  ZipTest.InflateTable.subtableTests
  ZipTest.NativeGzip.tests
  ZipTest.NativeIntegration.tests
  ZipTest.NativeScale.tests
  ZipTest.NativeDeflate.tests
  ZipTest.OptimalParse.tests
  ZipTest.PackedTokens.tests
  ZipTest.PackedHeads.tests
  ZipTest.SizeHelpers.tests
  ZipTest.L7Adaptive.tests
  ZipTest.NativeCompressBench.tests
  ZipTest.Benchmark.tests
  ZipTest.BoundedRead.tests
  IO.println "\nAll tests passed!"
