"""
Prove the firmware feature extractor matches the Python reference used for training.

Builds test/host_features.cpp with any host C++ compiler (zig c++, g++, clang++), runs it over
one slice file per source and compares every feature with common/pdmfeat.py.

    python tools/check_features.py --cxx "C:/path/to/zig.exe c++"
"""
import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT.parent
sys.path.insert(0, str(DEMO / "common"))
import pdmfeat as pf  # noqa: E402

FILES = [("S1/KA01_N15_M07_F10.bin", 4), ("S1/K001_N09_M07_F10.bin", 4), ("S2/EF_750.bin", 14),
         ("S2/NR_500.bin", 14), ("S3/RUN_3V.bin", 1)]
KEYS = ["rms", "peak", "crest", "kurt", "skew", "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app",
        "fdom", "cur_rms", "cur_mean", "x_rms"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cxx", default="g++")
    a = ap.parse_args()
    exe = ROOT / "test" / "host_features.exe"
    cmd = shlex.split(a.cxx, posix=False) + ["-O2", "-std=c++17", "-D_USE_MATH_DEFINES", f"-I{ROOT / 'src'}",
                                             str(ROOT / "test" / "host_features.cpp"), "-o", str(exe)]
    subprocess.run(cmd, check=True)
    worst = {}
    total = 0
    for rel, pp in FILES:
        path = DEMO / "site" / "data" / rel
        cpp = [json.loads(l) for l in subprocess.run([str(exe), str(path), str(pp)], capture_output=True,
                                                      text=True, check=True).stdout.splitlines()]
        py = [pf.features(x, h, pp) for h, x in pf.read_windows(path.read_bytes())]
        assert len(cpp) == len(py), (rel, len(cpp), len(py))
        for c, p in zip(cpp, py):
            for k in KEYS:
                if p[k] is None or c[k] is None:
                    assert p[k] is None and c[k] is None, (rel, k, p[k], c[k])
                    continue
                err = abs(c[k] - p[k]) / max(abs(p[k]), 1e-9)
                worst[k] = max(worst.get(k, 0.0), err)
            total += 1
    print(f"compared {total} windows x {len(KEYS)} features")
    for k in KEYS:
        print(f"  {k:9s} worst relative error {worst.get(k, 0):.2e}")
    bad = {k: v for k, v in worst.items() if v > 1e-3}
    print("PASS" if not bad else f"FAIL {bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
