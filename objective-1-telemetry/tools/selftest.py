"""
Self-test for the verification chain - run this BEFORE the review.

It proves three things without needing the simulator or any hardware:
  1. the broker is reachable from this network (a blocked port 1883 is the
     single most likely thing to sink a live demo),
  2. docs/telemetry-schema.json is a valid schema and accepts a good document,
  3. the validator actually REJECTS bad documents - a checker that says yes to
     everything is worse than no checker at all.

It publishes to a separate MOTOR-SELFTEST topic, never to your real device
topic, and nothing is retained on the broker.

    python tools/selftest.py
"""

import json
import os
import sys
import threading
import time

HOST = "broker.hivemq.com"
PORT = 1883
DEVICE = "MOTOR-SELFTEST"
TOPIC = f"pdm/v1/{DEVICE}/telemetry"
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "docs", "telemetry-schema.json")


def good_doc(seq):
    """A document shaped exactly like the firmware's output."""
    return {
        "schema": "pdm.telemetry.v1",
        "device_id": DEVICE,
        "fw": "selftest",
        "seq": seq,
        "ts": "2026-09-07T10:14:22.031Z",
        "ts_synced": True,
        "t_edge_ms": 1788516862031,
        "uptime_s": 24,
        "label": "baseline",
        "temp": {"c": 32.0, "valid": True},
        "vib": {"rms_ms2": 0.412, "peak_ms2": 1.281, "crest": 3.11,
                "x_rms": 0.204, "y_rms": 0.191, "z_rms": 0.298, "valid": True},
        "cur": {"rms_a": 1.842, "mean_a": 1.79, "peak_a": 2.31,
                "zero_mv": 1650.3, "cal_ok": True},
        "rpm": {"avg": 1479.6, "inst": 1481.2, "pulses": 49},
        "win": {"ms": 2000, "n": 398, "n_cur": 400, "sample_hz": 200, "dropped": 0},
        "net": {"rssi": -30, "ip": "10.13.37.2", "tls": False,
                "wifi_reconn": 0, "mqtt_reconn": 0, "publish_fails": 0},
    }


# Each of these breaks the contract in a way the firmware must never produce.
BAD_CASES = [
    ("temperature out of physical range", lambda d: d["temp"].update({"c": 999.0})),
    ("negative vibration RMS", lambda d: d["vib"].update({"rms_ms2": -1.0})),
    ("required block missing", lambda d: d.pop("rpm")),
    ("wrong schema version", lambda d: d.update({"schema": "pdm.telemetry.v2"})),
    ("undeclared extra field", lambda d: d.update({"suprise_field": 1})),
]


def main():
    try:
        import paho.mqtt.client as mqtt
        from jsonschema import Draft7Validator
    except ImportError:
        sys.exit("pip install paho-mqtt jsonschema")

    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)
    Draft7Validator.check_schema(schema)          # is the schema itself legal?
    validator = Draft7Validator(schema)
    print(f"[1/3] schema loads and is a legal Draft-7 schema")

    # ---- offline half: does the validator discriminate?
    errs = list(validator.iter_errors(good_doc(1)))
    if errs:
        print("  FAIL: a correct document was rejected:")
        for e in errs:
            print(f"    {'/'.join(map(str, e.path)) or '<root>'}: {e.message}")
        sys.exit(1)
    print("  good document accepted")

    failures = 0
    for name, break_it in BAD_CASES:
        doc = good_doc(1)
        break_it(doc)
        if list(validator.iter_errors(doc)):
            print(f"  correctly rejected: {name}")
        else:
            print(f"  FAIL: accepted a bad document: {name}")
            failures += 1
    if failures:
        sys.exit(f"[2/3] validator missed {failures} bad document(s)")
    print(f"[2/3] validator rejected all {len(BAD_CASES)} bad documents")

    # ---- online half: round-trip a document through the real broker
    received = []
    done = threading.Event()

    try:                                          # paho 2.x
        sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="pdm-selftest-sub")
        pub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="pdm-selftest-pub")
    except AttributeError:                        # paho 1.x
        sub = mqtt.Client(client_id="pdm-selftest-sub")
        pub = mqtt.Client(client_id="pdm-selftest-pub")

    def on_message(_c, _u, msg):
        received.append(msg.payload)
        if len(received) >= 3:
            done.set()

    sub.on_message = on_message
    print(f"[3/3] connecting to {HOST}:{PORT} ...")
    try:
        sub.connect(HOST, PORT, 30)
        sub.subscribe(TOPIC, qos=0)
        sub.loop_start()
        pub.connect(HOST, PORT, 30)
        pub.loop_start()
    except OSError as exc:
        sys.exit(f"  FAIL: cannot reach the broker: {exc}\n"
                 f"  Port {PORT} is probably blocked on this network - try a "
                 f"mobile hotspot, or use TLS on 8883.")

    time.sleep(1.0)                               # let the subscription settle
    for seq in (1, 2, 3):
        pub.publish(TOPIC, json.dumps(good_doc(seq)), qos=0, retain=False)
        time.sleep(0.2)

    ok = done.wait(timeout=15)
    sub.loop_stop(); pub.loop_stop()
    sub.disconnect(); pub.disconnect()

    if not ok:
        sys.exit(f"  FAIL: published 3, got {len(received)} back within 15 s")

    for payload in received:
        if list(validator.iter_errors(json.loads(payload))):
            sys.exit("  FAIL: a document was corrupted in transit")
    print(f"  round-tripped {len(received)}/3 documents through the broker, "
          f"all schema-valid")
    print("\nALL CHECKS PASSED - broker reachable, schema enforced, "
          "validator discriminating.")


if __name__ == "__main__":
    main()
