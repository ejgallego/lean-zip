#!/usr/bin/env python3
"""Require the module header in tracked Lean sources, excluding Lake configs."""

from pathlib import Path
import subprocess
import sys


root = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(
    ["git", "ls-files", "-z", "--", "*.lean"], cwd=root
).decode().split("\0")
missing = []
checked = 0
for name in paths:
    if not name or Path(name).name == "lakefile.lean":
        continue
    checked += 1
    lines = (root / name).read_text().splitlines()
    if not lines or lines[0].strip() != "module":
        missing.append(name)

if missing:
    print("Lean sources must start with 'module':", file=sys.stderr)
    print("\n".join(missing), file=sys.stderr)
    sys.exit(1)
print(f"Checked module headers in {checked} Lean sources.")
