"""
Builds what the reasoning layer sees. Ground truth (the injected label) is deliberately absent:
the LLM gets features, baselines, ratios, test results and the reference-signature library only.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "common"))
from gate import EVIDENCE_FEATS, GATE_EXCLUDE, sd_eff  # noqa: E402

NOTES = {
    "S1": ["Accelerometer sampled at 10 kHz, so bhf (1-5 kHz) is available.",
           "Operating point codes: N09/N15 = 900/1500 rpm, M01/M07 = 0.1/0.7 N.m load torque, F04/F10 = 400/1000 N radial force."],
    "S2": ["No current or temperature sensor on this machine; sampled at 5 kHz so bhf is unavailable.",
           "Kurtosis and crest on this machine are affected by single-sample recording glitches - weigh them lightly."],
    "S3": ["Vibration is in uncalibrated sensor units: use ratios only.",
           "No labelled fault library exists for this machine - reason from physics and trends.",
           "The 3V healthy baseline was learned from the first 2 minutes after commissioning (motor still cold)."],
}


def flatten(t: dict) -> dict:
    v, s, c, te = t["vib"], t["spec"], t["cur"], t["temp"]
    cur_ok = c.get("valid", True) and c.get("cal_ok", True)
    return {
        "rms": v["rms_ms2"], "peak": v["peak_ms2"], "crest": v["crest"],
        "x_rms": v.get("x_rms"), "y_rms": v.get("y_rms"), "z_rms": v.get("z_rms"),
        "kurt": s["kurt"], "skew": s.get("skew"),
        "b0": s["b0"], "b1": s["b1"], "b2": s["b2"], "b3": s["b3"], "bhf": s.get("bhf"),
        "a1x": s.get("a1x"), "a2x": s.get("a2x"), "app": s.get("app"), "fdom": s["fdom"],
        "cur_rms": c["rms_a"] if cur_ok else None, "cur_mean": c["mean_a"] if cur_ok else None,
        "temp": te["c"] if te["valid"] else None, "rpm": t["rpm"]["avg"],
    }


def mean_feats(wins: list[dict]) -> dict:
    out = {}
    for f in EVIDENCE_FEATS:
        vals = [w[f] for w in wins if w.get(f) is not None and not (isinstance(w[f], float) and math.isnan(w[f]))]
        out[f] = sum(vals) / len(vals) if vals else None
    return out


def sig(x, n=4):
    if x is None:
        return None
    if x == 0:
        return 0.0
    return float(f"{x:.{n}g}")


def feature_table(vals: dict, base: dict | None, ref: dict | None = None) -> dict:
    """value, healthy mean, ratio and z per feature; optional ratio against a reference (other op)."""
    rows = {}
    for f in EVIDENCE_FEATS:
        v = vals.get(f)
        if v is None:
            continue
        r = {"value": sig(v)}
        b = (base or {}).get(f)
        if b and b.get("mu"):
            r["healthy_mu"] = sig(b["mu"])
            if f not in ("rpm", "fdom") and b["mu"] != 0:
                r["ratio"] = sig(v / b["mu"], 3)
            if f != "rpm":
                r["z"] = round((v - b["mu"]) / sd_eff(f, b["mu"], b["sd"]), 1)
        if ref is not None and ref.get(f) not in (None, 0) and f not in ("fdom",):
            r["vs_current_op"] = sig(v / ref[f], 3)
        rows[f] = r
    return rows


def signature_library(sigs: dict, man: dict, src: str) -> dict | None:
    if src not in sigs:
        return None
    truth = man["sources"][src]["truth"]
    return {truth[code]: {op: {f: sig(r, 3) for f, r in feats.items()} for op, feats in ops.items()}
            for code, ops in sigs[src].items()}


def build(ep, base_windows: list[dict], history: list[dict], baselines: dict, sigs: dict, man: dict,
          allowed: dict, step: int) -> str:
    src = ep.src
    s = man["sources"][src]
    now = mean_feats(base_windows)
    b_now = baselines.get(src, {}).get(ep.base_op)
    ev = {
        "episode": ep.id, "step": step, "trigger": ep.trigger,
        "machine": {"src": src, "name": s["name"], "motor": s["motor"], "sensors": s["sensors"],
                    "pole_pairs": s["pole_pairs"], "vib_unit": s["vib_unit"],
                    "operating_points": {k: v["desc"] for k, v in s["ops"].items()}, "current_op": ep.base_op},
        "gate": {"flagged_features": ep.flagged, "z_threshold": 3.0,
                 "not_gated_here": sorted(GATE_EXCLUDE.get(src, []))},
        "now": {"op": ep.base_op, "windows_averaged": len(base_windows), "features": feature_table(now, b_now)},
        "tests": [],
        "reference_signatures": signature_library(sigs, man, src),
        "allowed_tests": allowed,
        "allowed_causes": s["causes"],
        "notes": NOTES.get(src, []),
    }
    trend = [w for w in history if w["op"] == ep.base_op and not w.get("test")]
    if len(trend) >= 6:
        a, z = mean_feats(trend[:3]), mean_feats(trend[-3:])
        ev["trend"] = {"windows": len(trend), "span_min": round(len(trend) * 2 / 60, 1),
                       "first_vs_last": {f: [sig(a[f]), sig(z[f])] for f in ["rms", "b1", "b3", "temp", "cur_rms", "rpm"]
                                         if a.get(f) is not None and z.get(f) is not None}}
    for t in ep.tests:
        row = {"id": t["id"], "op": t["op"], "op_desc": s["ops"].get(t["op"], {}).get("desc", t["op"]),
               "hold_s": t["hold_s"], "status": t["status"]}
        if t["status"] == "done":
            row["windows_averaged"] = len(t["windows"])
            row["features"] = feature_table(mean_feats(t["windows"]), baselines.get(src, {}).get(t["op"]), now)
        else:
            row["detail"] = t.get("detail", "")
        ev["tests"].append(row)
    head = ("Diagnose this machine. Return the pdm.rca.v1 JSON object only. "
            f"This is reasoning step {step}; tests already run: {len(ep.tests)}.\n\nEVIDENCE\n")
    return head + json.dumps(ev, separators=(",", ":"))
