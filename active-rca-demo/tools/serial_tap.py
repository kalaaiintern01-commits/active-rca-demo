"""
Log the node's serial output to the console and a file. Waits for the port and reconnects after
restarts or an unplugged cable.

    python tools/serial_tap.py          Wokwi for VS Code (RFC2217 on localhost:4000) -> runs/wokwi_serial.log
    python tools/serial_tap.py COM7     real ESP32 on a USB port                      -> runs/esp32_serial.log
"""
import sys
import time
from datetime import datetime
from pathlib import Path

import serial

URL = sys.argv[1] if len(sys.argv) > 1 else "rfc2217://localhost:4000"
LOG = Path(__file__).resolve().parents[1] / "runs" / ("wokwi_serial.log" if URL.startswith("rfc2217") else "esp32_serial.log")


def main():
    LOG.parent.mkdir(exist_ok=True)
    waiting = False
    while True:
        try:
            port = serial.serial_for_url(URL, baudrate=115200, timeout=1)
        except Exception:
            if not waiting:
                print(f"waiting for the simulator on {URL} ...", flush=True)
                waiting = True
            time.sleep(2)
            continue
        waiting = False
        print(f"--- connected {URL}", flush=True)
        buf = b""
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"\n--- {datetime.now():%Y-%m-%d %H:%M:%S} connected\n")
            try:
                while True:
                    chunk = port.read(512)
                    if not chunk:
                        continue
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        text = line.decode("utf-8", "replace").rstrip("\r")
                        stamp = f"{datetime.now():%H:%M:%S} {text}"
                        print(stamp, flush=True)
                        fh.write(stamp + "\n")
                        fh.flush()
            except Exception as e:
                print(f"--- disconnected ({type(e).__name__}); waiting for restart", flush=True)
                time.sleep(2)


if __name__ == "__main__":
    main()
