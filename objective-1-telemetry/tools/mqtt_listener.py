"""
Objective 1 verification listener.

Subscribes to the topics the ESP32 publishes, validates every telemetry
document against docs/telemetry-schema.json, and prints a one-line summary
per window plus a running check on interval, sample count and sequence gaps.
This is what we run beside Wokwi during the review: it proves the telemetry
contract holds, not just that bytes arrive.

    pip install paho-mqtt jsonschema
    python tools/mqtt_listener.py                       # defaults below
    python tools/mqtt_listener.py --device MOTOR-01 --host broker.hivemq.com

Send a command back (fault annotation / interval) while it runs:
    python tools/mqtt_listener.py --send '{"label":"imbalance"}'
"""

import argparse
import json
import os
import statistics
import sys
import time

DEFAULT_HOST = "broker.hivemq.com"
DEFAULT_PORT = 1883
DEFAULT_DEVICE = "MOTOR-01"
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "telemetry-schema.json")


def load_validator():
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        print("[warn] jsonschema not installed - schema checking disabled")
        return None
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return Draft7Validator(json.load(fh))


class Stats:
    def __init__(self):
        self.count = 0
        self.last_seq = None
        self.gaps = 0
        self.invalid = 0
        self.arrivals = []

    def note(self, seq):
        now = time.time()
        self.arrivals.append(now)
        self.count += 1
        if self.last_seq is not None and seq != self.last_seq + 1:
            self.gaps += 1
        self.last_seq = seq

    def interval(self):
        if len(self.arrivals) < 2:
            return None
        deltas = [b - a for a, b in zip(self.arrivals[-11:], self.arrivals[-10:])]
        return statistics.mean(deltas) if deltas else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--device", default=DEFAULT_DEVICE)
    ap.add_argument("--send", metavar="JSON", help="publish this to <device>/cmd and exit")
    args = ap.parse_args()

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        sys.exit("pip install paho-mqtt")

    base = f"pdm/v1/{args.device}"
    validator = load_validator()
    stats = Stats()

    try:                                    # paho 2.x
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    except AttributeError:                  # paho 1.x
        client = mqtt.Client()

    if args.send:
        client.connect(args.host, args.port, 30)
        client.publish(f"{base}/cmd", args.send, qos=0)
        client.loop(2.0)
        print(f"[cmd] -> {base}/cmd  {args.send}")
        return

    def on_connect(cli, _u, _f, rc):
        print(f"[mqtt] connected rc={rc}, subscribing to {base}/#")
        cli.subscribe(f"{base}/telemetry", qos=0)
        cli.subscribe(f"{base}/status", qos=0)

    def on_message(_c, _u, msg):
        if msg.topic.endswith("/status"):
            print(f"[status] {msg.payload.decode(errors='replace')}")
            return

        try:
            doc = json.loads(msg.payload)
        except json.JSONDecodeError as exc:
            stats.invalid += 1
            print(f"[REJECT] not JSON: {exc}")
            return

        errors = sorted(validator.iter_errors(doc), key=lambda e: e.path) if validator else []
        if errors:
            stats.invalid += 1
            print(f"[REJECT] seq={doc.get('seq')} schema violations:")
            for err in errors[:5]:
                print(f"         {'/'.join(map(str, err.path)) or '<root>'}: {err.message}")
            return

        stats.note(doc["seq"])
        interval = stats.interval()
        expected_n = doc["win"]["sample_hz"] * doc["win"]["ms"] / 1000

        print(
            f"[{doc['seq']:>4}] {doc['ts']} label={doc['label']:<14} "
            f"T={doc['temp']['c']:>6.2f}C{'' if doc['temp']['valid'] else '!'} "
            f"vib={doc['vib']['rms_ms2']:>6.3f} m/s2 crest={doc['vib'].get('crest', 0):>5.2f} "
            f"I={doc['cur']['rms_a']:>7.3f}A "
            f"rpm={doc['rpm']['avg']:>7.1f} "
            f"n={doc['win']['n']}/{expected_n:.0f} drop={doc['win']['dropped']} "
            f"rssi={doc.get('net', {}).get('rssi', 0)}"
            + (f" | dt={interval:.2f}s" if interval else "")
        )

        if stats.count % 10 == 0:
            mean_dt = f"{interval:.3f}s" if interval else "n/a"
            print(
                f"       -- {stats.count} windows, seq gaps={stats.gaps}, "
                f"rejected={stats.invalid}, mean interval={mean_dt}"
            )

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(args.host, args.port, 30)
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print(
            f"\n[summary] {stats.count} windows accepted, {stats.invalid} rejected, "
            f"{stats.gaps} sequence gaps"
        )


if __name__ == "__main__":
    main()
