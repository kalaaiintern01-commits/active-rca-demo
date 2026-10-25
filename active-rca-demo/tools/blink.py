"""
Ask the node to run its LED lamp test (green, blue, red, then all three) - for checking the wiring.

    python tools/blink.py        3 rounds
    python tools/blink.py 10     10 rounds (max 20)
"""
import json
import sys
import time
from pathlib import Path

import paho.mqtt.client as mqtt

cfg = json.loads((Path(__file__).resolve().parents[1] / "bridge" / "config.json").read_text())
root = f"pccoe/arca/{cfg['site_id']}/{cfg['device_id']}"
times = int(sys.argv[1]) if len(sys.argv) > 1 else 3
cmd = {"v": 1, "cmd": "blink", "id": f"blink-{int(time.time())}", "times": times}

acked = []


def on_message(c, u, msg):
    ack = (json.loads(msg.payload or b"{}").get("ack") or {})
    if ack.get("id") == cmd["id"]:
        acked.append(ack)


c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"arca-blink-{int(time.time()) % 100000}")
c.on_message = on_message
c.connect("broker.hivemq.com", 1883, 30)
c.subscribe(f"{root}/status")
c.loop_start()
time.sleep(1)
c.publish(f"{root}/cmd", json.dumps(cmd), qos=1)
print(f"sent blink x{times} to {root}/cmd - watch the LEDs")
for _ in range(30):
    if acked:
        print(f"node: {acked[0].get('msg')}")
        break
    time.sleep(0.5)
else:
    print("no reply from the node within 15 s - is it online?")
c.loop_stop()
