"""
Drift gate: per-source, per-operating-point healthy baseline; a window is flagged when any gate
feature leaves mu +/- Z_TH * sd_eff; the reasoning layer is woken after STREAK consecutive
flagged windows. sd_eff has a floor (relative or absolute) so a very tight training baseline
does not turn ordinary replay-to-replay scatter into alarms.

Shared by training/build_dataset.py (offline evaluation) and bridge/arca_bridge.py (live).
"""
from __future__ import annotations

import math

Z_TH = 3.0
STREAK = 3

# floor on the baseline spread: rel = fraction of |mu|, abs = absolute units
GATE_FEATS = {
    "rms":     {"rel": 0.05},
    "crest":   {"rel": 0.12},
    "kurt":    {"rel": 0.20},
    "b0":      {"rel": 0.20},
    "b1":      {"rel": 0.20},
    "b2":      {"rel": 0.20},
    "b3":      {"rel": 0.20},
    "bhf":     {"rel": 0.20},
    "cur_rms": {"rel": 0.04},
    "temp":    {"abs": 0.6},
}

# S2 recordings contain single-sample glitches (kurtosis up to ~9000 in training files) and its
# kurtosis shifts between recording sessions (healthy 500 rpm: 3.1 train vs 6.8 validation), so the
# peak-driven statistics are kept as evidence but never used to raise the S2 gate.
GATE_EXCLUDE = {"S2": {"kurt", "crest"}}

# features shown to the reasoning layer (superset of the gate set)
EVIDENCE_FEATS = ["rms", "peak", "crest", "kurt", "x_rms", "y_rms", "z_rms",
                  "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "fdom",
                  "cur_rms", "temp", "rpm"]


def sd_eff(feat: str, mu: float, sd: float) -> float:
    rule = GATE_FEATS.get(feat, {"rel": 0.1})
    floor = rule.get("abs", 0.0) + rule.get("rel", 0.0) * abs(mu)
    return max(sd, floor, 1e-12)


def zscores(baseline: dict | None, feats: dict, src: str = "") -> dict:
    """z for every gate feature present in both the window and the baseline."""
    z = {}
    if not baseline:
        return z
    skip = GATE_EXCLUDE.get(src, set())
    for f in GATE_FEATS:
        if f in skip:
            continue
        v, b = feats.get(f), baseline.get(f)
        if v is None or b is None or b.get("mu") is None:
            continue
        if isinstance(v, float) and math.isnan(v):
            continue
        z[f] = (v - b["mu"]) / sd_eff(f, b["mu"], b["sd"])
    return z


class Gate:
    """Streaming gate for one device. Call update() once per telemetry window."""

    def __init__(self, baselines: dict, z_th: float = Z_TH, streak: int = STREAK):
        self.baselines = baselines
        self.z_th = z_th
        self.need = streak
        self.streak = 0

    def baseline(self, src: str, op: str) -> dict | None:
        return self.baselines.get(src, {}).get(op)

    def reset(self):
        self.streak = 0

    def update(self, src: str, op: str, feats: dict) -> dict:
        b = self.baseline(src, op)
        z = zscores(b, feats, src)
        flagged = sorted([f for f, v in z.items() if abs(v) > self.z_th], key=lambda f: -abs(z[f]))
        self.streak = self.streak + 1 if flagged else 0
        return {"z": z, "flagged": flagged, "streak": self.streak,
                "fire": self.streak >= self.need, "has_baseline": b is not None}
