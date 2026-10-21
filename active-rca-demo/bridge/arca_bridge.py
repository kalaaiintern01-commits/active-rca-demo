"""
Active-RCA bridge - runs on your laptop next to the simulator.

    telemetry --> schema check --> drift gate --(3 windows out of band)--> episode
    episode:  evidence -> reasoning engine (Claude via your subscription) -> ranked causes
              -> optional active test on /cmd -> evidence + test result -> ... (<= max_tests)
              -> final diagnosis on /rca and /alert, logged to runs/episodes.jsonl

    python bridge/arca_bridge.py                 # Claude via the logged-in subscription
    python bridge/arca_bridge.py --engine mock   # offline rule-based stand-in (not an LLM)

Topics under pccoe/arca/<site_id>/<device_id>/
    telemetry (in)  status (in, retained)  ctl (in: {"cmd":"diagnose"|"reset"})
    cmd (out)  gate (out, per window)  rca (out, per reasoning step)  alert (out, retained)  bridge (out, retained)
"""
from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import paho.mqtt.client as mqtt

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))
import evidence  # noqa: E402
from gate import Gate, sd_eff, zscores  # noqa: E402
from llm import ClaudeSubscription, MockEngine, rca_schema  # noqa: E402


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


class Episode:
    def __init__(self, n, trigger, src, base_op, scn, truth, flagged):
        self.id = f"E{n}"
        self.trigger, self.src, self.base_op, self.scn = trigger, src, base_op, scn
        self.truth, self.flagged = truth, flagged
        self.started = now_iso()
        self.t0 = time.time()
        self.steps, self.tests = [], []
        self.base_windows: list[dict] = []
        self.test = None          # running test dict
        self.final = None


class Bridge:
    def __init__(self, cfg: dict, engine_name: str):
        self.cfg = cfg
        self.root = f"pccoe/arca/{cfg['site_id']}/{cfg['device_id']}"
        model = HERE / "model"
        self.baselines = json.loads((model / "baselines.json").read_text())
        self.sigs = json.loads((model / "signatures.json").read_text())
        self.man = json.loads((model / "manifest.json").read_text())
        self.tel_schema = json.loads((HERE / "schemas" / "telemetry.v1.1.json").read_text())
        self.mock = MockEngine(self.sigs, self.man)
        lc = cfg["llm"]
        self.engine = (ClaudeSubscription(lc["model"], lc["effort"], lc["timeout_s"])
                       if engine_name == "claude" else self.mock)
        self.ec = cfg["episode"]
        self.gate = Gate(self.baselines)
        self.q: queue.Queue = queue.Queue()
        self.state = "monitor"
        self.scn = None
        self.hist: deque = deque(maxlen=120)
        self.ep: Episode | None = None
        self.ep_n = 0
        self.cooldown = 0
        self.last_label = None
        self.runs = HERE.parent / "runs"
        self.runs.mkdir(exist_ok=True)
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id=f"arca-bridge-{cfg['site_id']}-{int(time.time()) % 10000}",
                                  protocol=mqtt.MQTTv311)
        b = cfg["broker"]
        if b.get("username"):
            self.client.username_pw_set(b["username"], b.get("password"))
        if b.get("tls", True):
            self.client.tls_set()
        self.client.will_set(f"{self.root}/bridge", json.dumps({"online": False}), qos=1, retain=True)
        self.client.on_connect = self.on_connect
        self.client.on_message = lambda c, u, m: self.q.put(("mqtt", m.topic, m.payload))

    # ------------------------------------------------------------------ mqtt
    def on_connect(self, client, userdata, flags, reason, props):
        log(f"[mqtt] connected to {self.cfg['broker']['host']} ({reason}) root={self.root}")
        for leaf in ("telemetry", "status", "ctl"):
            client.subscribe(f"{self.root}/{leaf}", qos=1)
        self.pub("bridge", {"online": True, "engine": self.engine.label, "started": now_iso(),
                            "max_tests": self.ec["max_tests"], "p_stop": self.ec["p_stop"]}, retain=True)

    def pub(self, leaf, obj, retain=False, qos=1):
        self.client.publish(f"{self.root}/{leaf}", json.dumps(obj, separators=(",", ":")), qos=qos, retain=retain)

    def alert(self, state, cause="", p=0.0, severity=""):
        self.pub("alert", {"state": state, "cause": cause, "p": round(p, 2), "severity": severity,
                           "ep": self.ep.id if self.ep else ""}, retain=True)

    # ------------------------------------------------------------------ main loop
    def run(self):
        b = self.cfg["broker"]
        self.client.connect(b["host"], b["port"], keepalive=30)
        self.client.loop_start()
        self.alert("monitor")
        log(f"[bridge] engine = {self.engine.label}")
        while True:
            try:
                item = self.q.get(timeout=1.0)
            except queue.Empty:
                self.tick()
                continue
            try:
                if item[0] == "mqtt":
                    self.on_mqtt(item[1], item[2])
                elif item[0] == "llm":
                    self.on_llm(*item[1:])
            except Exception as e:  # keep the bridge alive through a bad message
                log(f"[error] {type(e).__name__}: {e}")
            self.tick()

    def tick(self):
        ep = self.ep
        if ep and ep.test and self.state == "testing" and time.time() > ep.test["deadline"]:
            self.pub("cmd", {"v": 1, "cmd": "abort", "id": ep.test["id"]})
            self.finish_test("timeout", "no test windows within the timeout")

    def on_mqtt(self, topic, payload):
        leaf = topic.rsplit("/", 1)[-1]
        try:
            msg = json.loads(payload)
        except json.JSONDecodeError:
            log(f"[{leaf}] not JSON - dropped")
            return
        if leaf == "telemetry":
            self.on_telemetry(msg)
        elif leaf == "status":
            self.on_status(msg)
        elif leaf == "ctl":
            cmd = msg.get("cmd")
            if cmd == "diagnose" and self.state in ("monitor", "latched"):
                self.start_episode("manual", [])
            elif cmd == "reset":
                self.abort_episode("reset by operator")

    # ------------------------------------------------------------------ telemetry
    def on_telemetry(self, t):
        try:
            jsonschema.validate(t, self.tel_schema)
        except jsonschema.ValidationError as e:
            log(f"[schema] REJECTED seq={t.get('seq')}: {e.message[:120]}")
            return
        if t["scn"] != self.scn:
            if self.scn is not None:
                log(f"[scn] new scenario #{t['scn']} on {t['src']} op={t['op']}")
                self.abort_episode("new scenario injected")
            self.scn = t["scn"]
            self.hist.clear()
            self.gate.reset()
            self.state, self.cooldown = "monitor", 0
            self.alert("monitor")
        self.last_label = t.get("label")
        f = evidence.flatten(t)
        tag = t.get("test")
        w = dict(f, op=t["op"], seq=t["seq"], ts=t["ts"], test=tag["id"] if tag else None)
        self.hist.append(w)

        ep = self.ep
        if tag:                                   # active-test window: score against that op, never gate
            z = zscores(self.gate.baseline(t["src"], t["op"]), f, t["src"])
            r = {"z": z, "flagged": [k for k, v in z.items() if abs(v) > 3], "streak": 0}
            if ep and ep.test and tag["id"] == ep.test["id"]:
                ep.test["seen"] = True
                if tag["phase"] == "run":
                    ep.test["windows"].append(f)
                if tag.get("left", 1) == 0 and tag["phase"] == "run":
                    self.finish_test("done")
        else:
            if ep and ep.test and ep.test.get("seen"):   # node already back on the base op
                self.finish_test("done" if ep.test["windows"] else "unavailable", "test ended early")
            if self.state == "monitor":
                r = self.gate.update(t["src"], t["op"], f)
                if r["fire"]:
                    recent = [x for x in self.hist if not x.get("test") and x["op"] == t["op"]][-3:]
                    self.start_episode("gate", r["flagged"], recent)
            else:
                z = zscores(self.gate.baseline(t["src"], t["op"]), f, t["src"])
                r = {"z": z, "flagged": [k for k, v in z.items() if abs(v) > 3], "streak": 0}
                if self.state == "latched":
                    # alarm stays latched while the condition persists; re-arm only after the machine
                    # reads clean for cooldown_windows in a row (or a new scenario / operator request)
                    self.cooldown = self.cooldown - 1 if not r["flagged"] else self.ec["cooldown_windows"]
                    if self.cooldown <= 0:
                        self.state = "monitor"
                        self.gate.reset()
                        self.alert("monitor")
                        log("[gate] machine clean again - re-armed")
        self.publish_gate(t, f, r)

    def publish_gate(self, t, f, r):
        b = self.gate.baseline(t["src"], t["op"]) or {}
        band = {k: [evidence.sig(b[k]["mu"]), evidence.sig(sd_eff(k, b[k]["mu"], b[k]["sd"]))]
                for k in ("rms", "temp", "cur_rms", "bhf", "b3") if k in b}
        self.pub("gate", {
            "seq": t["seq"], "ts": t["ts"], "src": t["src"], "op": t["op"], "scn": t["scn"],
            "test": (t.get("test") or {}).get("id"),
            "z": {k: round(v, 2) for k, v in r["z"].items()}, "flagged": r["flagged"], "streak": r["streak"],
            "state": self.state, "episode": self.ep.id if self.ep else None, "base": band,
            "feats": {k: evidence.sig(f.get(k)) for k in ("rms", "temp", "cur_rms", "bhf", "b3", "kurt")},
        }, qos=0)
        flag = ",".join(r["flagged"][:4]) or "-"
        log(f"[win] #{t['seq']} {t['src']} {t.get('label', '?')} op={t['op']} rms={f['rms']:.4g} "
            f"{'test=' + t['test']['id'] + ':' + t['test']['phase'] if t.get('test') else ''} "
            f"streak={r['streak']} flagged={flag} state={self.state}")

    def on_status(self, s):
        if not s.get("online", True) and self.ep:
            self.abort_episode("node went offline")
            return
        ack = s.get("ack") or {}
        ep = self.ep
        if ep and ep.test and ack.get("id") == ep.test["id"] and ack.get("ok") is False:
            self.finish_test("unavailable", ack.get("msg", "rejected by node"))

    # ------------------------------------------------------------------ episodes
    def start_episode(self, trigger, flagged, recent=None):
        last = self.hist[-1] if self.hist else None
        if not last:
            log("[episode] no telemetry yet - nothing to diagnose")
            return
        src = self.man_src(last)
        self.ep_n += 1
        ep = Episode(self.ep_n, trigger, src, last["op"], self.scn, self.last_label, flagged)
        ep.base_windows = recent or [x for x in self.hist if not x.get("test") and x["op"] == last["op"]][-3:]
        self.ep = ep
        log(f"[episode] {ep.id} started by {trigger} on {src} op={ep.base_op} flagged={flagged}")
        self.reason()

    def man_src(self, w):
        for src, s in self.man["sources"].items():
            if w["op"] in s["ops"]:
                return src
        raise ValueError(f"unknown op {w['op']}")

    def allowed_tests(self, ep):
        ops = self.man["sources"][ep.src]["ops"]
        done = {t["op"] for t in ep.tests}
        return {op: v["desc"] for op, v in ops.items() if op != ep.base_op and op not in done}

    def reason(self):
        ep = self.ep
        self.state = "diagnosing"
        self.alert("diagnosing")
        allowed = self.allowed_tests(ep)
        if len(ep.tests) >= self.ec["max_tests"]:
            allowed = {}
        step = len(ep.steps) + 1
        prompt = evidence.build(ep, ep.base_windows, list(self.hist), self.baselines, self.sigs, self.man, allowed, step)
        schema = rca_schema(self.man["sources"][ep.src]["causes"], list(allowed))
        (self.runs / f"{ep.id}-step{step}-prompt.txt").write_text(prompt, encoding="utf-8")
        log(f"[llm] {ep.id} step {step} -> {self.engine.label} ({len(prompt)} chars, {len(allowed)} tests allowed)")
        eng = self.engine

        def work():
            try:
                out, meta = eng.diagnose(prompt, schema)
                self.q.put(("llm", ep.id, step, out, meta, None))
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                if eng is not self.mock and self.cfg["llm"].get("fallback_to_mock"):
                    out, meta = self.mock.diagnose(prompt, schema)
                    meta["fallback_from"] = err[:200]
                    self.q.put(("llm", ep.id, step, out, meta, None))
                else:
                    self.q.put(("llm", ep.id, step, None, {}, err))
        threading.Thread(target=work, daemon=True).start()

    def on_llm(self, ep_id, step, out, meta, err):
        ep = self.ep
        if not ep or ep.id != ep_id:
            log(f"[llm] stale result for {ep_id} ignored")
            return
        if err:
            log(f"[llm] {ep_id} FAILED: {err}")
            self.finalize(None, "engine_error", err)
            return
        causes = out["causes"]
        tot = sum(max(c["p"], 0) for c in causes) or 1.0
        for c in causes:
            c["p"] = round(max(c["p"], 0) / tot, 3)
        causes.sort(key=lambda c: -c["p"])
        top = causes[0]
        ep.steps.append({"step": step, "diagnosis": out, "meta": meta})
        log(f"[llm] {ep_id} step {step} ({meta.get('latency_s')} s, {meta.get('engine')}): "
            + ", ".join(f"{c['cause']} {c['p']:.0%}" for c in causes[:3]) + f" | next={out['next_test']}")

        nt = out["next_test"]
        allowed = self.allowed_tests(ep)
        why = None
        if top["p"] >= self.ec["p_stop"]:
            why = "confident"
        elif nt == "none":
            why = out["stop_reason"] if out["stop_reason"] != "need_test" else "no_useful_test"
        elif len(ep.tests) >= self.ec["max_tests"]:
            why = "test_budget_spent"
        elif nt not in allowed:
            why = "no_useful_test"
        if why:
            self.finalize(out, why)
            return
        tid = f"{ep.id}-T{len(ep.tests) + 1}"
        hold = int(self.ec["hold_s"])
        ep.test = {"id": tid, "op": nt, "hold_s": hold, "status": "running", "windows": [], "seen": False,
                   "deadline": time.time() + self.ec["test_timeout_s"]}
        self.publish_rca(out, meta, final=False, decision={"why": "need_test", "test": {"id": tid, "op": nt, "hold_s": hold}})
        self.pub("cmd", {"v": 1, "cmd": "test", "id": tid, "op": nt, "hold_s": hold})
        self.state = "testing"
        self.alert("testing", top["cause"], top["p"], out["severity"])
        log(f"[test] {tid} -> op {nt} for {hold} s ({out['test_rationale'][:100]})")

    def finish_test(self, status, detail=""):
        ep = self.ep
        if not ep or not ep.test:
            return
        t = ep.test
        t["status"] = status if (status != "done" or t["windows"]) else "unavailable"
        t["detail"] = detail
        ep.tests.append(t)
        ep.test = None
        log(f"[test] {t['id']} {t['status']} ({len(t['windows'])} windows) {detail}")
        self.reason()

    def publish_rca(self, out, meta, final, decision):
        ep = self.ep
        msg = {"schema": "pdm.rca.v1", "device_id": self.cfg["device_id"], "episode": ep.id,
               "step": len(ep.steps), "ts": now_iso(), "trigger": ep.trigger, "src": ep.src, "op": ep.base_op,
               "engine": meta.get("engine"), "latency_s": meta.get("latency_s"), "meta": meta,
               "diagnosis": out, "decision": dict(decision, final=final),
               "tests": [{k: t[k] for k in ("id", "op", "hold_s", "status")} | {"windows": len(t["windows"])}
                         for t in ep.tests]}
        if final:
            truth = self.man["sources"][ep.src]["truth"].get(ep.truth or "", None)
            top = out["causes"][0]["cause"] if out else None
            msg["truth"] = {"label": ep.truth, "cause": truth, "correct": (top == truth) if truth else None,
                            "note": "ground truth from the injected scenario - never shown to the reasoning layer"}
            msg["duration_s"] = round(time.time() - ep.t0, 1)
        self.pub("rca", msg)
        return msg

    def finalize(self, out, why, err=""):
        ep = self.ep
        meta = ep.steps[-1]["meta"] if ep.steps else {}
        msg = self.publish_rca(out, meta, final=True, decision={"why": why, "error": err})
        top = out["causes"][0] if out else {"cause": "unknown", "p": 0}
        self.alert("done", top["cause"], top["p"], out["severity"] if out else "watch")
        with (self.runs / "episodes.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({**msg, "steps": ep.steps, "test_windows": {t["id"]: t["windows"] for t in ep.tests}},
                                default=str) + "\n")
        log(f"[episode] {ep.id} DONE ({why}) -> {top['cause']} {top['p']:.0%} | truth={msg['truth']['cause']} "
            f"correct={msg['truth']['correct']} | {len(ep.tests)} tests, {msg['duration_s']} s")
        self.ep = None
        self.state, self.cooldown = "latched", self.ec["cooldown_windows"]

    def abort_episode(self, why):
        if not self.ep:
            return
        if self.ep.test:
            self.pub("cmd", {"v": 1, "cmd": "abort", "id": self.ep.test["id"]})
        self.pub("rca", {"schema": "pdm.rca.v1", "device_id": self.cfg["device_id"], "episode": self.ep.id,
                         "ts": now_iso(), "decision": {"final": True, "why": "aborted", "error": why}})
        log(f"[episode] {self.ep.id} aborted: {why}")
        self.ep = None
        self.state = "monitor"
        self.alert("monitor")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--engine", choices=["claude", "mock"], help="override llm.engine from the config")
    ap.add_argument("--model", help="override llm.model (opus, sonnet, fable, haiku or a full model id)")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text())
    if a.model:
        cfg["llm"]["model"] = a.model
    Bridge(cfg, a.engine or cfg["llm"]["engine"]).run()


if __name__ == "__main__":
    main()
