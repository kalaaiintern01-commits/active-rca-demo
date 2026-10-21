"""
Build the replay slices (GitHub Pages) and the training artefacts from data/*.csv.

    python training/build_dataset.py            # everything
    python training/build_dataset.py --eval     # only re-run the gate evaluation on existing outputs

Train / replay split (never the same recording in both):
    S1 Paderborn   reps 1-14 -> train (baselines, signatures)   reps 15-20 -> replay slices
    S2 CubeMars    LocS_Train_Clean -> train                    LocS_Val_Clean -> replay slices
    S3 CARTIF      snapshots 1-30 of the 3 V start = commissioning baseline; the run itself is
                   one machine, so its replay is the full chronological run (no held-out copy exists)

Outputs
    site/data/<src>/<cond>_<op>.bin     replay slices served by GitHub Pages
    site/data/manifest.json             what exists, for the node, bridge and dashboard
    training/out/windows.csv            one row per 2 s window (train + replay) with labels
    bridge/model/baselines.json         healthy mu/sd per (src, op, feature)
    bridge/model/signatures.json        median fault/healthy ratio per (src, cond, op, feature)
    bridge/model/manifest.json          copy of the manifest
    training/out/gate_eval.md           which replay files the gate fires on
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))
import pdmfeat as pf  # noqa: E402
from gate import Gate, GATE_FEATS  # noqa: E402

DATA = ROOT.parent / "data"
SITE = ROOT / "site" / "data"
OUT = ROOT / "training" / "out"
MODEL = ROOT / "bridge" / "model"

SOURCES = {
    "S1": {
        "name": "Paderborn KAt bearing test rig",
        "motor": "425 W PMSM, 4 pole pairs, test bearing on the drive shaft",
        "sensors": "vibration (accelerometer on bearing housing), phase current, shaft speed, torque, bearing temperature",
        "fs": 10000, "pole_pairs": 4, "channels": ["vib", "cur"], "vib_unit": "m/s2",
        "conds": {"K001": "healthy bearing", "KA01": "outer-race damage (EDM)"},
        "truth": {"K001": "healthy", "KA01": "bearing_outer_race"},
        "ops": {
            "N09_M07_F10": {"rpm": 900, "desc": "900 rpm, 0.7 N.m load, 1000 N radial"},
            "N15_M01_F10": {"rpm": 1500, "desc": "1500 rpm, 0.1 N.m load, 1000 N radial"},
            "N15_M07_F04": {"rpm": 1500, "desc": "1500 rpm, 0.7 N.m load, 400 N radial"},
            "N15_M07_F10": {"rpm": 1500, "desc": "1500 rpm, 0.7 N.m load, 1000 N radial"},
        },
        "default_op": "N09_M07_F10",
        "healthy": "K001",
        "causes": ["healthy", "bearing_outer_race", "bearing_inner_race", "bearing_rolling_element",
                   "misalignment", "unbalance", "load_change", "sensor_mounting", "unknown"],
    },
    "S2": {
        "name": "CubeMars RI60 PMSM fault rig (Zenodo 22039010)",
        "motor": "CubeMars RI60 KV120 PMSM, 14 pole pairs",
        "sensors": "tri-axial accelerometer only (no current, no temperature)",
        "fs": 5000, "pole_pairs": 14, "channels": ["ax", "ay", "az"], "vib_unit": "m/s2",
        "conds": {"NR": "normal", "BF": "bearing fault", "EF": "rotor eccentricity",
                  "MF": "magnet fault (demagnetisation)", "SF": "stator winding fault"},
        "truth": {"NR": "healthy", "BF": "bearing", "EF": "eccentricity", "MF": "magnet_demagnetisation",
                  "SF": "stator_winding"},
        "ops": {"500": {"rpm": 500, "desc": "500 rpm"}, "750": {"rpm": 750, "desc": "750 rpm"},
                "1000": {"rpm": 1000, "desc": "1000 rpm"}},
        "default_op": "500",
        "healthy": "NR",
        "causes": ["healthy", "bearing", "eccentricity", "magnet_demagnetisation", "stator_winding",
                   "unbalance", "sensor_mounting", "unknown"],
    },
    "S3": {
        "name": "CARTIF open DC-motor stress run (Zenodo 4314249)",
        "motor": "small brushed DC motor, new at start of run",
        "sensors": "vibration (uncalibrated units), armature current, supply voltage, motor and ambient temperature, speed",
        "fs": 5000, "pole_pairs": 1, "channels": ["vib", "cur"], "vib_unit": "au",
        "conds": {"NEW": "new motor, commissioning period", "RUN": "continuous stress run (warming / wear)"},
        "truth": {"NEW": "healthy", "RUN": "thermal_drift_wear"},
        "ops": {"3V": {"rpm": 7900, "desc": "3 V supply (~7900 rpm)"},
                "5V": {"rpm": 10000, "desc": "5 V supply (~9500-13000 rpm)"}},
        "default_op": "3V",
        "healthy": "NEW",
        "causes": ["healthy", "thermal_drift_wear", "bearing_or_brush_wear", "electrical_overload",
                   "cooling_failure", "sensor_mounting", "unknown"],
    },
}
WIN_S = 2


# ------------------------------------------------------------------ window generators
def s1_windows(path: Path):
    d = pd.read_csv(path, usecols=["vibration_g", "phase_current_1_a", "speed_rpm", "torque_nm", "temp_c"])
    vib = resample_poly(d.vibration_g.values, 5, 32) * pf.G          # 64 kHz -> 10 kHz, g -> m/s2
    cur = resample_poly(d.phase_current_1_a.values, 5, 32)
    n = 10000 * WIN_S
    for w in range(len(vib) // n):
        a, b = w * n, (w + 1) * n
        A, B = int(a * 6.4), int(b * 6.4)                                 # same span at 64 kHz
        hdr = pf.WinHeader(nch=2, fs=10000, n=n, rpm=float(d.speed_rpm.values[A:B].mean()),
                           temp_c=float(d.temp_c.values[A:B].mean()), aux=float(d.torque_nm.values[A:B].mean()),
                           vib_mask=0b1, cur_ch=1, flags=0b11)
        yield hdr, np.column_stack([vib[a:b], cur[a:b]])


def s2_windows(path: Path, rpm: int):
    d = pd.read_csv(path)
    xyz = d[["ax", "ay", "az"]].values * pf.G
    n = 5000 * WIN_S
    for w in range(len(xyz) // n):
        hdr = pf.WinHeader(nch=3, fs=5000, n=n, rpm=float(rpm), temp_c=float("nan"), aux=0.0,
                           vib_mask=0b111, cur_ch=0xFFFF, flags=0b01)
        yield hdr, xyz[w * n:(w + 1) * n]


def s3_window(path: Path, row):
    d = pd.read_csv(path)
    vib = resample_poly(d.vibration.values, 25, 256)                    # 51.2 kHz -> 5 kHz
    cur = resample_poly(d.current_a.values, 25, 256)
    n = 5000 * WIN_S
    hdr = pf.WinHeader(nch=2, fs=5000, n=n, rpm=float(row.speed_rpm), temp_c=float(row.temp_motor_c),
                       aux=float(row.voltage_v), vib_mask=0b1, cur_ch=1, flags=0b10)
    return hdr, np.column_stack([vib[:n], cur[:n]])


# ------------------------------------------------------------------ helpers
def feat_row(hdr, deq, src, **labels):
    f = pf.features(deq, hdr, SOURCES[src]["pole_pairs"])
    f.update(temp=hdr.temp_c if hdr.temp_valid else None, rpm=hdr.rpm, src=src, **labels)
    return f


class SliceWriter:
    def __init__(self):
        self.files = {}

    def add(self, src, cond, op, raw):
        key = (src, cond, op)
        self.files.setdefault(key, []).append(raw)

    def flush(self):
        out = {}
        for (src, cond, op), chunks in self.files.items():
            p = SITE / src / f"{cond}_{op}.bin"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"".join(chunks))
            out[f"{cond}_{op}"] = {"path": f"data/{src}/{cond}_{op}.bin", "windows": len(chunks),
                                   "bytes": p.stat().st_size, "cond": cond, "op": op}
        return out


# ------------------------------------------------------------------ build
def build():
    rows, sw = [], SliceWriter()

    # S1 -------------------------------------------------------------
    idx = pd.read_csv(DATA / "S1_index.csv")
    idx["op"] = idx.file.str.slice(0, 11)
    for i, r in enumerate(idx.itertuples()):
        split = "train" if r.repetition <= 14 else "replay"
        for w, (hdr, x) in enumerate(s1_windows(DATA / "S1_paderborn_pmsm" / r.file)):
            raw, deq = pf.pack_window(hdr, x)
            if split == "replay":
                sw.add("S1", r.bearing, r.op, raw)
            rows.append(feat_row(hdr, deq, "S1", cond=r.bearing, op=r.op, split=split, rec=r.file, win=w))
        if i % 20 == 0:
            print(f"S1 {i + 1}/{len(idx)}", flush=True)

    # S2 -------------------------------------------------------------
    idx = pd.read_csv(DATA / "S2_index.csv")
    idx = idx[idx.set.isin(["LocS_Train_Clean", "LocS_Val_Clean"])]
    for i, r in enumerate(idx.itertuples()):
        split = "train" if r.set == "LocS_Train_Clean" else "replay"
        for w, (hdr, x) in enumerate(s2_windows(DATA / "S2_cubemars_pmsm" / r.file, r.rpm)):
            raw, deq = pf.pack_window(hdr, x)
            if split == "replay":
                sw.add("S2", r.fault_class, str(r.rpm), raw)
            rows.append(feat_row(hdr, deq, "S2", cond=r.fault_class, op=str(r.rpm), split=split, rec=r.file, win=w))
    print("S2 done", flush=True)

    # S3 -------------------------------------------------------------
    idx = pd.read_csv(DATA / "S3_index.csv").sort_values("recorded_at").reset_index(drop=True)
    p1 = idx[idx.phase == "01-Start 3V"].reset_index(drop=True)
    p2 = idx[idx.phase == "02-Change 5V"].reset_index(drop=True)
    for k, r in p1.iterrows():
        hdr, x = s3_window(DATA / "S3_cartif_dc_motor" / r.file, r)
        raw, deq = pf.pack_window(hdr, x)
        sw.add("S3", "RUN", "3V", raw)
        if k < 30:
            sw.add("S3", "NEW", "3V", raw)
        rows.append(feat_row(hdr, deq, "S3", cond="NEW" if k < 30 else "RUN", op="3V",
                             split="train" if k < 30 else "replay", rec=r.file, win=k))
    for k, r in p2.iterrows():
        hdr, x = s3_window(DATA / "S3_cartif_dc_motor" / r.file, r)
        raw, deq = pf.pack_window(hdr, x)
        sw.add("S3", "RUN", "5V", raw)
        rows.append(feat_row(hdr, deq, "S3", cond="RUN", op="5V", split="replay", rec=r.file, win=k))
    print("S3 done", flush=True)

    files = sw.flush()
    OUT.mkdir(parents=True, exist_ok=True)
    win = pd.DataFrame(rows)
    win.to_csv(OUT / "windows.csv", index=False, float_format="%.6g")
    return win, files


def trimmed_stats(s: pd.Series) -> dict:
    """Mean/sd after dropping glitch windows (> 5 MAD from the median). Keeps the natural spread
    that a pure MAD estimate under-states, without letting one corrupted window widen the band."""
    s = s.dropna()
    med = s.median()
    mad = 1.4826 * (s - med).abs().median()
    keep = s[(s - med).abs() <= 5 * max(mad, 1e-12)] if mad > 0 else s
    return {"mu": float(keep.mean()), "sd": float(keep.std(ddof=1)), "n": int(keep.count()), "dropped": int(len(s) - len(keep))}


def model_from(win: pd.DataFrame):
    feats = list(GATE_FEATS) + ["peak", "x_rms", "y_rms", "z_rms", "a1x", "a2x", "app", "fdom", "cur_mean", "rpm"]
    base, sig = {}, {}
    for src, cfg in SOURCES.items():
        tr = win[(win.src == src) & (win.split == "train")]
        h = tr[tr.cond == cfg["healthy"]]
        base[src] = {}
        for op, g in h.groupby("op"):
            base[src][op] = {f: trimmed_stats(g[f]) for f in feats if f in g and g[f].notna().sum() >= 3}
        if src == "S3":
            continue                      # one run, no labelled fault classes -> no signature library
        sig[src] = {}
        for (cond, op), g in tr.groupby(["cond", "op"]):
            b = base[src].get(op, {})
            sig[src].setdefault(cond, {})[op] = {
                f: round(float(g[f].median() / b[f]["mu"]), 3)
                for f in ["rms", "crest", "kurt", "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "cur_rms"]
                if f in b and g[f].notna().any() and b[f]["mu"] not in (0, None)}
    return base, sig


def manifest(files):
    m = {"schema": "pdm.manifest.v1", "window_s": WIN_S, "sources": {}}
    for src, cfg in SOURCES.items():
        m["sources"][src] = {k: cfg[k] for k in ["name", "motor", "sensors", "fs", "pole_pairs", "channels",
                                                 "vib_unit", "conds", "truth", "ops", "default_op", "healthy",
                                                 "causes"]}
        m["sources"][src]["files"] = {k: v for k, v in files.items() if v["path"].startswith(f"data/{src}/")}
    return m


def gate_eval(base):
    """Stream every replay file through the gate at its own op; report windows-to-fire."""
    lines = ["| src | cond | op | windows | first fire (window) | top flagged features |", "|---|---|---|---|---|---|"]
    man = json.loads((SITE / "manifest.json").read_text())
    for src, s in man["sources"].items():
        for key, f in sorted(s["files"].items()):
            g = Gate(base)
            buf = (ROOT / "site" / f["path"]).read_bytes()
            fire, flags = None, {}
            for i, (hdr, x) in enumerate(pf.read_windows(buf)):
                ft = pf.features(x, hdr, s["pole_pairs"])
                ft["temp"] = hdr.temp_c if hdr.temp_valid else None
                r = g.update(src, f["op"], ft)
                for fl in r["flagged"]:
                    flags[fl] = flags.get(fl, 0) + 1
                if r["fire"] and fire is None:
                    fire = i
            top = ", ".join(f"{k}({v})" for k, v in sorted(flags.items(), key=lambda kv: -kv[1])[:4])
            lines.append(f"| {src} | {f['cond']} | {f['op']} | {f['windows']} | {'-' if fire is None else fire} | {top} |")
    (OUT / "gate_eval.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", action="store_true", help="only rebuild model + gate evaluation from windows.csv")
    a = ap.parse_args()
    if a.eval:
        win = pd.read_csv(OUT / "windows.csv")
    else:
        win, files = build()
        m = manifest(files)
        (SITE / "manifest.json").write_text(json.dumps(m, indent=1))
    base, sig = model_from(win)
    MODEL.mkdir(parents=True, exist_ok=True)
    (MODEL / "baselines.json").write_text(json.dumps(base, indent=1))
    (MODEL / "signatures.json").write_text(json.dumps(sig, indent=1))
    shutil.copy(SITE / "manifest.json", MODEL / "manifest.json")
    gate_eval(base)


if __name__ == "__main__":
    main()
