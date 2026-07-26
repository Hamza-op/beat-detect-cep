"""Run the production native color-core test executable.

This helper deliberately contains no copy of the grading algorithm and never
installs dependencies. Build `native/color-core/tests` with CMake first.
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--executable",
        type=Path,
        default=Path("native/color-core/build/Release/autocut_color_core_tests.exe"),
    )
    args = parser.parse_args()
    executable = args.executable
    if not executable.exists():
        parser.error(f"native test executable does not exist: {executable}")
    completed = subprocess.run([str(executable)], check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
