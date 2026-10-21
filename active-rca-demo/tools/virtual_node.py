"""
Virtual replay node - a Python twin of the Wokwi firmware, for testing the bridge/LLM loop
without the simulator, and as a backup if Wokwi is slow on the day.

Same slices, same feature maths (common/pdmfeat.py == firmware/src/pdm_features.h, checked by
firmware/tools/check_features.py), same pdm.telemetry.v1.1 documents, same /cmd semantics
(applied at the next window boundary).

    python tools/virtual_node.py                         # slices from the local site/data folder
    python tools/virtual_node.py --data https://<user>.github.io/<repo>/data/   # from GitHub Pages
    python tools/virtual_node.py --src S2 --cond EF --speed 3
"""
from __future__ import annotations

import argparse
import json
import queue
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))
import pdmfeat as pf  # noqa: E402

MAN = json.loads((ROOT / "site" / "data" / "manifest.json").read_text())


class Node:
    def __init__(self, a, cfg):
        self.a, self.cfg = a, cfg
        self.root = f"pccoe/arca/{cfg['site_id']}/{cfg['device_id']}"
        self.src, self.cond = a.src, a.cond or MAN["sources"][a.src]["healthy"]
        self.base_op = a.op or MAN["sources"][a.src]["default_op"]
        self.op, self.win, self.epoch, self.seq = self.base_op, 0, 1, 0
        self.test = None
        self.pend: queue.Queue = queue.Queue()
        self.cache: dict = {}
        self.ack = {"id": "", "ok": True, "msg": ""}
        self.t0 = time.time()
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"arca-vnode-{int(time.time()) % 10000}")
        b = cfg["broker"]
        if b.get("tls", True):
            c.tls_set()
        c.will_set(f"{self.root}/status", json.dumps({"online": False, "device_id": cfg["device_id"]}), 1, True)
        c.on_connect = lambda cl, u, f, r, p: (cl.subscribe(f"{self.root}/cmd", 1), self.status())
        c.on_message = lambda cl, u, m: self.on_cmd(m.payload)
        c.connect(b["host"], b["port"], 30)
        c.loop_start()
        self.c = c

    # ------------------------------------------------------------------ data
    def windows(self, op):
        key = f"{self.src}/{self.cond}_{op}.bin"
        if key not in self.cache:
            if self.a.data.startswith("http"):
                try:
                    with urllib.request.urlopen(self.a.data + key, timeout=30) as r:
                        buf = r.read()
                except Exception as e:
                    print("[http]", key, e)
                    self.cache[key] = None
                    return None
            else:
                p = Path(self.a.data) / key
                buf = p.read_bytes() if p.exists() else None
            self.cache[key] = list(pf.read_windows(buf)) if buf else None
        return self.cache[key]

    # ------------------------------------------------------------------ commands
    def on_cmd(self, payload):
        try:
            d = json.loads(payload)
        except json.JSONDecodeError:
            return self.set_ack("", False, "bad json")
        if d.get("v") != 1:
            return self.set_ack(d.get("id", ""), False, "need v:1")
        s = MAN["sources"][self.src]
        cmd, cid = d.get("cmd"), d.get("id", "")
        if cmd == "scenario":
            src = d.get("src", self.src)
            if src not in MAN["sources"]:
                return self.set_ack(cid, False, "unknown src")
            t = MAN["sources"][src]
            cond, op = d.get("cond", t["healthy"]), d.get("op", t["default_op"])
            if cond not in t["conds"] or op not in t["ops"]:
                return self.set_ack(cid, False, "unknown cond/op")
            self.pend.put(("scenario", src, cond, op))
            self.set_ack(cid, True, "scenario queued")
        elif cmd == "test":
            op = d.get("op", "")
            if not cid:
                return self.set_ack(cid, False, "test needs id")
            if self.test:
                return self.set_ack(cid, False, "busy: test running")
            if op not in s["ops"] or op == self.base_op:
                return self.set_ack(cid, False, "unknown op" if op not in s["ops"] else "op equals current op")
            hold = max(4, min(60, int(d.get("hold_s", 20))))
            self.pend.put(("test", cid, op, (hold + 1) // 2))
            self.set_ack(cid, True, "test queued")
        elif cmd == "abort":
            self.pend.put(("abort",))
            self.set_ack(cid, True, "abort queued")
        else:
            self.set_ack(cid, False, "unknown cmd")

    def set_ack(self, i, ok, msg):
        self.ack = {"id": i, "ok": ok, "msg": msg}
        print(f"[cmd] {i} {'ok' if ok else 'REJECTED'} {msg}")
        self.status()

    def status(self):
        s = MAN["sources"][self.src]
        self.c.publish(f"{self.root}/status", json.dumps({
            "online": True, "device_id": self.cfg["device_id"], "fw": "virtual-node", "src": self.src,
            "cond": self.cond, "op": self.op, "base_op": self.base_op, "scn": self.epoch,
            "test": ({"id": self.test["id"], "op": self.test["op"], "hold": self.test["hold"], "done": self.test["done"]}
                     if self.test else None),
            "replay": {"file": f"{self.src}/{self.cond}_{self.op}.bin", "win": self.win},
            "ack": self.ack, "uptime_s": int(time.time() - self.t0)}), qos=1, retain=True)

    def end_test(self, why):
        print(f"[test] {self.test['id']} {why}")
        self.op, self.win = self.base_op, self.test["resume"]
        self.test = None
        self.status()

    def apply_pending(self):
        while not self.pend.empty():
            p = self.pend.get()
            if p[0] == "scenario":
                if self.test:
                    self.end_test("cancelled by scenario change")
                _, self.src, self.cond, self.base_op = p
                self.op, self.win = self.base_op, 0
                self.epoch += 1
                print(f"[scn] #{self.epoch} {self.src} {self.cond} {self.base_op}")
            elif p[0] == "abort" and self.test:
                self.end_test("aborted")
            elif p[0] == "test" and not self.test:
                self.test = {"id": p[1], "op": p[2], "hold": p[3], "done": 0, "settle": True, "resume": self.win}
                self.op, self.win = p[2], 0
                print(f"[test] {p[1]} -> {p[2]} for {p[3]} windows")
            self.status()

    # ------------------------------------------------------------------ loop
    def run(self):
        period = 2.0 / self.a.speed
        nxt = time.time()
        while True:
            self.apply_pending()
            wins = self.windows(self.op)
            if wins is None:
                if self.test:
                    self.set_ack(self.test["id"], False, "unavailable: no recording at that op")
                    self.end_test("unavailable")
                    continue
                print("[replay] missing recording", self.src, self.cond, self.op)
                time.sleep(2)
                continue
            if self.win >= len(wins):
                self.win = 0
            hdr, x = wins[self.win]
            phase, left = None, 0
            if self.test:
                phase = "settle" if self.test["settle"] else "run"
                left = self.test["hold"] - self.test["done"] - (0 if self.test["settle"] else 1)
            f = pf.features(x, hdr, MAN["sources"][self.src]["pole_pairs"])
            time.sleep(max(0.0, nxt - time.time()))
            nxt = time.time() + period
            self.publish(hdr, f, phase, left, len(wins))
            self.win += 1
            if self.test:
                if self.test["settle"]:
                    self.test["settle"] = False
                else:
                    self.test["done"] += 1
                if self.test["done"] >= self.test["hold"]:
                    self.end_test("done")

    def publish(self, hdr, f, phase, left, total):
        self.seq += 1
        now = datetime.now(timezone.utc)
        tv = hdr.temp_valid
        doc = {
            "schema": "pdm.telemetry.v1.1", "device_id": self.cfg["device_id"], "src": self.src, "fw": "virtual-node",
            "seq": self.seq, "ts": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "ts_synced": True,
            "t_edge_ms": int(now.timestamp() * 1000), "uptime_s": int(time.time() - self.t0),
            "label": self.cond, "scn": self.epoch, "op": self.op,
            "replay": {"file": f"{self.src}/{self.cond}_{self.op}.bin", "win": self.win, "of": total},
            "temp": {"c": round(hdr.temp_c, 3) if tv else 0.0, "valid": tv},
            "vib": {"rms_ms2": f["rms"], "peak_ms2": f["peak"], "crest": f["crest"], "valid": True, "cal_ok": hdr.vib_cal},
            "spec": {k: f[k] for k in ["kurt", "skew", "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "fdom", "df", "frames"]},
            "cur": ({"rms_a": f["cur_rms"], "mean_a": f["cur_mean"], "peak_a": f["cur_peak"], "valid": True, "cal_ok": True}
                    if f["cur_rms"] is not None else {"rms_a": 0.0, "mean_a": 0.0, "peak_a": 0.0, "valid": False, "cal_ok": False}),
            "rpm": {"avg": hdr.rpm, "inst": hdr.rpm},
            "win": {"ms": 2000, "n": hdr.n, "sample_hz": hdr.fs, "dropped": 0, "t0_s": self.win * 2},
            "net": {"tls": True},
        }
        for ax in ["x_rms", "y_rms", "z_rms"]:
            if f[ax] is not None:
                doc["vib"][ax] = f[ax]
        if self.src == "S1":
            doc["rpm"]["torque_nm"] = hdr.aux
        if self.src == "S3":
            doc["rpm"]["supply_v"] = hdr.aux
        if phase:
            doc["test"] = {"id": self.test["id"], "phase": phase, "left": left}
        self.c.publish(f"{self.root}/telemetry", json.dumps(doc), qos=0)
        print(f"[pub] #{self.seq} {self.src} {self.cond} {self.op} rms={f['rms']:.4g} {phase or ''}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "bridge" / "config.json"))
    ap.add_argument("--data", default=str(ROOT / "site" / "data"))
    ap.add_argument("--src", default="S1", choices=["S1", "S2", "S3"])
    ap.add_argument("--cond")
    ap.add_argument("--op")
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed (1 = real time, 2 s per window)")
    a = ap.parse_args()
    if not a.data.startswith("http"):
        a.data = str(Path(a.data)) + "/"
    elif not a.data.endswith("/"):
        a.data += "/"
    Node(a, json.loads(Path(a.config).read_text())).run()


if __name__ == "__main__":
    main()
