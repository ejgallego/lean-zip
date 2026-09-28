module

public import ZipTest.WasmEntry

public section

def main : IO Unit :=
  ZipTest.WasmEntry.tests
