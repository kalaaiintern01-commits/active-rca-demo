"""Synthetic MOTOR-DEMO device: publishes realistic pdm.telemetry.v1 windows so
the monitor page can be verified without the simulator running."""
import json
import math
import random
import time

import paho.mqtt.client as mqtt

HOST, PORT = "broker.hivemq.com", 1883
DEV = "MOTOR-DEMO"
BASE = f"pdm/v1/{DEV}"

try:
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="fakedev")
except AttributeError:
    c = mqtt.Client(client_id="fakedev")
c.will_set(f"{BASE}/status", "offline", retain=True)
c.connect(HOST, PORT, 30)
c.loop_start()
c.publish(f"{BASE}/status", "online", retain=True)

label = "baseline"


def on_cmd(_cl, _u, msg):
    global label
    try:
        d = json.loads(msg.payload)
        if "label" in d:
            label = d["label"]
            print("label ->", label)
    except Exception:
        pass


c.on_message = on_cmd
c.subscribe(f"{BASE}/cmd")

seq = 0
t0 = time.time()
print(f"publishing to {BASE}/telemetry every 2 s (ctrl-c to stop)")
while True:
    seq += 1
    el = time.time() - t0
    # a slow thermal ramp, vibration with a wandering amplitude, current tracking
    # load, speed drifting - shaped so the sparklines have something to show
    temp = 31.5 + 4.0 * (1 - math.exp(-el / 90)) + random.gauss(0, 0.08)
    vib = abs(0.45 + 0.30 * math.sin(el / 17) + random.gauss(0, 0.05))
    peak = vib * random.uniform(2.6, 4.1)
    cur = abs(1.85 + 0.35 * math.sin(el / 23) + random.gauss(0, 0.04))
    rpm = 1480 + 55 * math.sin(el / 31) + random.gauss(0, 4)
    ms = 2000 + random.randint(-4, 4)
    n = int(200 * ms / 1000) - random.choice([0, 0, 0, 1, 2])
    doc = {
        "schema": "pdm.telemetry.v1", "device_id": DEV, "fw": "demo-1.0.0",
        "seq": seq,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time()*1000)%1000:03d}Z",
        "ts_synced": True, "t_edge_ms": int(time.time() * 1000),
        "uptime_s": int(el), "label": label,
        "temp": {"c": round(temp, 2), "valid": True},
        "vib": {"rms_ms2": round(vib, 3), "peak_ms2": round(peak, 3),
                "crest": round(peak / vib, 2) if vib > 0.001 else 0,
                "x_rms": round(vib * 0.6, 3), "y_rms": round(vib * 0.5, 3),
                "z_rms": round(vib * 0.7, 3), "valid": True},
        "cur": {"rms_a": round(cur, 3), "mean_a": round(cur * 0.97, 3),
                "peak_a": round(cur * 1.3, 3), "zero_mv": 1650.3, "cal_ok": True},
        "rpm": {"avg": round(rpm, 1), "inst": round(rpm + random.gauss(0, 2), 1),
                "pulses": int(rpm * 2 / 60 * ms / 1000)},
        "win": {"ms": ms, "n": n, "n_cur": n, "sample_hz": 200,
                "dropped": max(0, int(200 * ms / 1000) - n)},
        "net": {"rssi": random.randint(-72, -58), "ip": "10.13.37.2", "tls": False,
                "wifi_reconn": 0, "mqtt_reconn": 0, "publish_fails": 0},
    }
    c.publish(f"{BASE}/telemetry", json.dumps(doc), qos=0)
    print(f"seq={seq} vib={doc['vib']['rms_ms2']} cur={doc['cur']['rms_a']} rpm={doc['rpm']['avg']}")
    time.sleep(2)
