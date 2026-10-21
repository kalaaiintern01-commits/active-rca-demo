"""
Generate wokwi/sketch.ino - one self-contained file for the wokwi.com editor.

The wokwi.com editor makes extra source files awkward, so config.h, certs.h and pdm_features.h
are inlined into the sketch. Generated, never hand-edited: change src/ and re-run.

    python tools/make_wokwi_single.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
OUT = ROOT / "wokwi"


def strip(text: str) -> str:
    return "\n".join(l for l in text.splitlines() if l.strip() != "#pragma once")


def main():
    main_cpp = (SRC / "main.cpp").read_text(encoding="utf-8")
    for name in ["config.h", "certs.h", "pdm_features.h"]:
        body = strip((SRC / name).read_text(encoding="utf-8"))
        block = (f"// {'=' * 76}\n//  {name} - INLINED by tools/make_wokwi_single.py (edit src/{name}, not this)\n"
                 f"// {'=' * 76}\n{body}\n// {'=' * 30} end of {name} {'=' * 30}\n")
        main_cpp, n = re.subn(rf'#include "{re.escape(name)}"', lambda m: block, main_cpp)
        assert n == 1, name
    OUT.mkdir(exist_ok=True)
    (OUT / "sketch.ino").write_text(
        "// GENERATED FILE - edit firmware/src/*.cpp|h and run tools/make_wokwi_single.py\n" + main_cpp,
        encoding="utf-8")
    for f in ["diagram.json", "libraries.txt"]:
        (OUT / f).write_text((ROOT / f).read_text(encoding="utf-8"), encoding="utf-8")
    print("wrote", OUT / "sketch.ino", f"({len(main_cpp) // 1024} kB) + diagram.json + libraries.txt")


if __name__ == "__main__":
    main()
