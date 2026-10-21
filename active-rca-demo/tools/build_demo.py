"""
Build site/data/demo-episodes.json - an offline replay of two real recorded episodes for the
dashboard's ?replay mode (presentation backup, and screenshots without a running node).

Every number in it is real: window features are computed from the replay slices with the same
extractor the node runs, gate z-scores from the trained baselines, and the reasoning steps are the
exact Claude outputs recorded in runs/episodes.jsonl from the Wokwi node runs.

    python tools/build_demo.py
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))
import pdmfeat as pf  # noqa: E402
from gate import Gate, sd_eff, zscores  # noqa: E402

MAN = json.loads((ROOT / "site/data/manifest.json").read_text())
BASE = json.loads((ROOT / "bridge/model/baselines.json").read_text())
EPISODES = [json.loads(l) for l in (ROOT / "runs/episodes.jsonl").open(encoding="utf-8")]


def windows(src, cond, op):
    buf = (ROOT / "site/data" / src / f"{cond}_{op}.bin").read_bytes()
    pp = MAN["sources"][src]["pole_pairs"]
    for hdr, x in pf.read_windows(buf):
        f = pf.features(x, hdr, pp)
        yield hdr, f


def tel(src, cond, op, hdr, f, seq, scn, ts, test=None):
    d = {
        "schema": "pdm.telemetry.v1.1", "device_id": "MOTOR-01", "src": src, "fw": "replay", "seq": seq,
        "ts": ts, "label": cond, "scn": scn, "op": op,
        "temp": {"c": round(hdr.temp_c, 2) if hdr.temp_valid else 0.0, "valid": hdr.temp_valid},
        "vib": {"rms_ms2": f["rms"], "peak_ms2": f["peak"], "crest": f["crest"], "valid": True, "cal_ok": hdr.vib_cal},
        "spec": {k: f[k] for k in ["kurt", "skew", "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "fdom"]},
        "cur": ({"rms_a": f["cur_rms"], "mean_a": f["cur_mean"], "valid": True} if f["cur_rms"] is not None
                else {"rms_a": 0.0, "mean_a": 0.0, "valid": False}),
        "rpm": {"avg": hdr.rpm}, "win": {"ms": 2000, "n": hdr.n, "sample_hz": hdr.fs},
        "replay": {"file": f"{src}/{cond}_{op}.bin"},
    }
    for ax in ["x_rms", "y_rms", "z_rms"]:
        if f[ax] is not None:
            d["vib"][ax] = f[ax]
    if test:
        d["test"] = test
    return d


def gate_msg(src, op, f, hdr, r, state, ep, seq, ts, test_id=None):
    b = BASE.get(src, {}).get(op, {})
    band = {k: [b[k]["mu"], sd_eff(k, b[k]["mu"], b[k]["sd"])] for k in ("rms", "temp", "cur_rms", "bhf", "b3") if k in b}
    return {"seq": seq, "ts": ts, "src": src, "op": op, "test": test_id,
            "z": {k: round(v, 2) for k, v in r["z"].items()}, "flagged": r["flagged"], "streak": r["streak"],
            "state": state, "episode": ep, "base": band,
            "feats": {"rms": f["rms"], "bhf": f["bhf"], "b3": f["b3"], "cur_rms": f["cur_rms"],
                      "temp": hdr.temp_c if hdr.temp_valid else None}}


def build(ep_rec, healthy_cond, n_healthy=8):
    src, base_op = ep_rec["src"], ep_rec["op"]
    cond = ep_rec["truth"]["label"]
    test = ep_rec["tests"][0]
    t0 = datetime(2026, 10, 23, 10, 0, 0, tzinfo=timezone.utc)
    clock = 0.0
    items, seq = [], 0

    def ts():
        return (t0 + timedelta(seconds=clock)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def push(kind, payload, dt):
        nonlocal clock
        items.append({"t": round(clock, 2), "topic": kind, "msg": payload})
        clock += dt

    gate = Gate(BASE)
    ep = ep_rec["episode"]

    def stream(c, op, n, state, scn, tag=None, start=0):
        nonlocal seq
        out = 0
        for i, (hdr, f) in enumerate(windows(src, c, op)):
            if i < start:
                continue
            if out >= n:
                break
            seq += 1
            feats = dict(f, temp=hdr.temp_c if hdr.temp_valid else None)
            if tag:
                z = zscores(gate.baseline(src, op), feats, src)
                r = {"z": z, "flagged": [k for k, v in z.items() if abs(v) > 3], "streak": 0}
            elif state == "monitor":
                r = gate.update(src, op, feats)
            else:
                z = zscores(gate.baseline(src, op), feats, src)
                r = {"z": z, "flagged": [k for k, v in z.items() if abs(v) > 3], "streak": 0}
            stamp = ts()
            push("telemetry", tel(src, c, op, hdr, f, seq, scn, stamp, tag(out) if tag else None), 0.0)
            push("gate", gate_msg(src, op, f, hdr, r, state if not r.get("fire") else "diagnosing",
                                  ep if state != "monitor" or r.get("fire") else None, seq, stamp,
                                  (tag(out) or {}).get("id") if tag else None), 2.0)
            out += 1
            if state == "monitor" and r.get("fire"):
                return True
        return False

    st = {"online": True, "device_id": "MOTOR-01", "fw": "replay", "src": src, "cond": healthy_cond,
          "op": base_op, "base_op": base_op, "scn": 1, "test": None, "ack": {"id": "", "ok": True, "msg": ""}}
    push("status", st, 0.0)
    push("bridge", {"online": True, "engine": ep_rec["engine"] + " (recorded)"}, 0.0)
    push("alert", {"state": "monitor", "cause": "", "p": 0, "severity": "", "ep": ""}, 0.0)
    stream(healthy_cond, base_op, n_healthy, "monitor", 1)
    push("status", dict(st, cond=cond, scn=2, ack={"id": "ui-replay", "ok": True, "msg": "scenario queued"}), 0.5)
    gate.reset()
    stream(cond, base_op, 6, "monitor", 2)          # stops on the window the gate fires
    s1, s2 = ep_rec["steps"][0], ep_rec["steps"][1]
    lat1 = min(s1["meta"].get("latency_s", 15), 18)
    stream(cond, base_op, max(1, int(lat1 // 2)), "diagnosing", 2, start=6)
    tid, top, hold = test["id"], test["op"], test.get("hold_s", 20)
    push("rca", {"schema": "pdm.rca.v1", "episode": ep, "step": 1, "ts": ts(), "trigger": "gate", "src": src,
                 "op": base_op, "engine": s1["meta"]["engine"], "latency_s": s1["meta"].get("latency_s"),
                 "diagnosis": s1["diagnosis"], "decision": {"why": "need_test", "final": False,
                                                            "test": {"id": tid, "op": top, "hold_s": hold}}}, 0.0)
    d1 = s1["diagnosis"]["causes"][0]
    push("alert", {"state": "testing", "cause": d1["cause"], "p": d1["p"], "severity": s1["diagnosis"]["severity"], "ep": ep}, 1.0)
    n_run = test["windows"]
    stream(cond, top, n_run + 1, "testing", 2,
           tag=lambda i: {"id": tid, "phase": "settle" if i == 0 else "run", "left": max(0, n_run - i)})
    lat2 = min(s2["meta"].get("latency_s", 12), 14)
    stream(cond, base_op, max(1, int(lat2 // 2)), "diagnosing", 2, start=8)
    final = {k: ep_rec[k] for k in ("schema", "episode", "step", "trigger", "src", "op", "engine", "latency_s",
                                     "diagnosis", "decision", "tests", "truth", "duration_s") if k in ep_rec}
    final["ts"] = ts()
    push("rca", final, 0.0)
    d2 = ep_rec["diagnosis"]["causes"][0]
    push("alert", {"state": "done", "cause": d2["cause"], "p": d2["p"], "severity": ep_rec["diagnosis"]["severity"], "ep": ep}, 1.0)
    stream(cond, base_op, 8, "latched", 2, start=0)
    return {"title": f"{MAN['sources'][src]['name']} - {MAN['sources'][src]['conds'][cond]}", "src": src,
            "truth": cond, "duration_s": round(clock), "items": items}


def main():
    pick = {}
    for e in EPISODES:
        if e.get("engine", "").startswith("claude") and e.get("tests") and len(e.get("steps", [])) >= 2:
            pick[e["src"]] = e                      # latest real Claude episode with a test, per machine
    out = {"note": "Replay of real recorded episodes: features from the replay slices, gate from trained "
                   "baselines, reasoning steps exactly as Claude returned them during the Wokwi runs.",
           "episodes": []}
    healthy = {"S1": "K001", "S2": "NR", "S3": "NEW"}
    for src in ("S1", "S2"):
        if src in pick:
            out["episodes"].append(build(pick[src], healthy[src]))
    p = ROOT / "site/data/demo-episodes.json"
    p.write_text(json.dumps(out, separators=(",", ":"), default=float))
    for e in out["episodes"]:
        print(e["title"], len(e["items"]), "messages,", e["duration_s"], "s")
    print("wrote", p, p.stat().st_size // 1024, "kB")


if __name__ == "__main__":
    main()
