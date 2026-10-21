# Objective 1 — Sensing & telemetry layer (Wokwi build)

**IoT & ML-Based Predictive Maintenance System for Rotating Machinery**
PCCoE, Nigdi · Dept. of E&TC · B.Tech MDM IoT · 2026-27
Atharva Palande (123B1C060) · Mehul Rawat (123B1C063) · Guide: Prof. Kalpana Patil

This folder is the complete deliverable for **Objective 1** of the synopsis —
synopsis objectives 1, 2 and 3 — simulated end to end in Wokwi. Nothing from
Objectives 2 and 3 (ML, rule engine, dashboard) is included by design.

| Synopsis objective | Where it is met |
| --- | --- |
| 1. Instrument a testbed so abnormal conditions can be induced safely and repeatably | MPU6050 sliders + current/speed pots in Wokwi; every window tagged with a fault `label` set over MQTT — see [Inducing faults](#inducing-faults) |
| 2. Acquire temperature, vibration, current and RPM on an ESP32 with calibration and signal conditioning | [sketch.ino](sketch.ino) — four channels, boot auto-zero, DC removal, anti-alias filter, debounced pulse counting |
| 3. Stream JSON telemetry over Wi-Fi via MQTT with a defined schema, publish interval and TLS | `pdm.telemetry.v1`, 2 s interval, `USE_TLS` build switch, LWT + backoff reconnect |

---

## 1. Run it

**On wokwi.com** — create a new *ESP32* project and add these four files:
`sketch.ino`, `config.h`, `diagram.json`, `libraries.txt`. Press play.

Wokwi's `Wokwi-GUEST` network has real internet access, so the node reaches the
public broker and NTP. Expect this on the serial monitor within ~10 s:

```
=============================================
 PdM Objective 1 - sensing & telemetry layer
 device=MOTOR-01 fw=obj1-1.0.0 schema=pdm.telemetry.v1
 sample=200 Hz  publish=2000 ms  tls=0
=============================================
[ds18b20] found, 12-bit
[mpu6050] found, +/-8g, 94 Hz DLPF
[cal] current zero = 1650.3 mV (plausible 500..3000) OK
[wifi] joining Wokwi-GUEST
[wifi] up, ip=10.13.37.2 rssi=-30
[mqtt] connecting to broker.hivemq.com:1883 ... connected
[pub] {"schema":"pdm.telemetry.v1","device_id":"MOTOR-01", ... }
```

The status LED slow-blinks while joining Wi-Fi, fast-blinks while connecting to
the broker and goes solid once telemetry is flowing.

**Proving the telemetry contract** (this is the part that earns the objective —
run it beside the simulator during the review):

```bash
pip install paho-mqtt jsonschema
python tools/mqtt_listener.py --device MOTOR-01
```

Every arriving document is validated against
[docs/telemetry-schema.json](docs/telemetry-schema.json) and printed as one
line, with sequence gaps, publish interval and sample count checked live:

```
[  12] 2026-09-07T10:14:22.031Z label=baseline       T= 32.00C vib= 0.412 m/s2 crest= 3.11  I=  1.842A rpm= 1479.6 n=398/400 drop=0 rssi=-30 | dt=2.00s
```

## 2. Circuit

| Signal | ESP32 pin | Part in `diagram.json` | Notes |
| --- | --- | --- | --- |
| Housing temperature | GPIO4 | DS18B20 + 4.7 kΩ pull-up | 1-Wire, 12-bit |
| Vibration (3-axis) | GPIO21 / GPIO22 | MPU6050 | I²C at 400 kHz |
| Motor current | GPIO34 | potentiometer (ACS712 stand-in) | ADC1, input-only pin |
| Speed command | GPIO35 | potentiometer | sets the tacho frequency |
| Tacho pulses in | GPIO27 | jumper from GPIO26 | rising-edge interrupt |
| Tacho pulses out | GPIO26 | — | LEDC square wave, simulator only |
| Status LED | GPIO2 | LED + 220 Ω | link state |

### Simulator substitutions, stated plainly

Wokwi has no ACS712, no tacho sensor and no DC motor, so three parts are
modelled rather than simulated. The **measurement code is not modelled** — it
is the code that will run on the testbed:

- **ACS712 → potentiometer on GPIO34.** The pot output is put through the real
  ACS712 transfer function (quiescent point measured at boot, 100 mV/A), so
  turning it sweeps roughly −16 A … +16 A of motor current.
- **Tacho sensor → GPIO26 jumpered to GPIO27.** The speed pot sets a hardware
  LEDC square wave whose frequency is `RPM × pulses-per-rev ÷ 60`. The firmware
  then measures RPM exactly as it will on hardware: rising-edge interrupt,
  debounce, pulse count per window plus a last-period instantaneous estimate.
- **DC motor + fault fixtures → the MPU6050 sliders.** Dragging the axis
  sliders is the fault injection in simulation.

Moving to the physical testbed: set `SIMULATE_TACHO 0` and
`CURRENT_DIVIDER_GAIN 2.0` in [config.h](config.h) (the real ACS712 runs at 5 V
behind a 2:1 divider), and wire the sensors to the same pins. No other change.

## 3. Signal conditioning and calibration

Everything here exists so the model in Objective 2 receives features, not raw
noise.

| Channel | Conditioning | Why |
| --- | --- | --- |
| Vibration | Per-axis exponential DC tracker removes gravity and sensor offset; RMS, peak and crest factor of the AC residual over the window; 94 Hz DLPF against a 200 Hz sample rate | Gravity is 9.8 m/s² of pure DC — it would swamp a vibration RMS. Crest factor is what separates impulsive bearing defects from smooth imbalance. The DLPF sits below Nyquist so out-of-band energy cannot alias into the band we keep. |
| Current | Quiescent point **measured at boot**, not taken from the datasheet; ±0.05 A deadband; true RMS from summed squares | The divider ratio and the ADC both drift; a datasheet zero bakes that error into every reading. RMS of samples, not an average of magnitudes, is what an AC-carrying line actually requires. |
| Temperature | 12-bit, asynchronous conversion, range-checked −55…125 °C, reported with a `valid` flag | A 750 ms blocking conversion would destroy the 200 Hz sample clock. A failed read is published as `valid:false` — never as 0 or −127 for the model to learn as a temperature. |
| RPM | Rising-edge ISR, debounce at ¼ of the minimum credible pulse period, count-per-window plus last-period estimate | Optical and Hall pickups both bounce. The averaged figure is what we trend; the instantaneous one reacts inside a single pulse. |
| All | 200 Hz sampling reduced to summary statistics per 2 s window, with a `dropped` sample counter | Averaging on-device removes noise before it costs bandwidth — and `dropped`/`n` gives the cloud a data-quality gate, so a degraded window can be excluded instead of silently trusted. |

## 4. Telemetry contract

- **Topics** — `pdm/v1/MOTOR-01/telemetry`, `.../status` (retained), `.../cmd`
- **Interval** — 2 s (`PUBLISH_MS`); the actual window length ships in `win.ms`
  so the cloud never has to assume it
- **Payload** — one JSON document per window, ≈540 bytes, versioned by the
  `schema` field
- **QoS 0** — telemetry is periodic and loss-tolerant; `seq` makes any loss
  visible rather than hidden
- **Last will** — the broker publishes `offline` on the retained status topic if
  this node drops, so the dashboard can show a stale device as stale
- **Reconnect** — non-blocking state machine, 1 s doubling to 30 s; sampling
  continues throughout, and window statistics are never carried across a failed
  publish (the model must not see two windows summed into one)
- **TLS** — `USE_TLS 1` switches to port 8883. In the simulator the broker is
  accepted without pinning; on the cloud broker in Objective 2 this becomes
  `setCACert(AWS_ROOT_CA1)` plus a device certificate and private key.

```json
{
  "schema": "pdm.telemetry.v1",
  "device_id": "MOTOR-01",
  "fw": "obj1-1.0.0",
  "seq": 12,
  "ts": "2026-09-07T10:14:22.031Z",
  "ts_synced": true,
  "t_edge_ms": 1788516862031,
  "uptime_s": 24,
  "label": "baseline",
  "temp": { "c": 32.0, "valid": true },
  "vib":  { "rms_ms2": 0.412, "peak_ms2": 1.281, "crest": 3.11,
            "x_rms": 0.204, "y_rms": 0.191, "z_rms": 0.298, "valid": true },
  "cur":  { "rms_a": 1.842, "mean_a": 1.79, "peak_a": 2.31,
            "zero_mv": 1650.3, "cal_ok": true },
  "rpm":  { "avg": 1479.6, "inst": 1481.2, "pulses": 49 },
  "win":  { "ms": 2000, "n": 398, "n_cur": 400, "sample_hz": 200, "dropped": 0 },
  "net":  { "rssi": -30, "ip": "10.13.37.2", "tls": false,
            "wifi_reconn": 0, "mqtt_reconn": 0, "publish_fails": 0 }
}
```

`t_edge_ms` is the publish instant in epoch milliseconds. It is carried purely
so Objective 3 can subtract it at the dashboard and report a real end-to-end
latency rather than an estimate.

## 5. Inducing faults

Data collection needs each window labelled with the condition that produced it.
The `/cmd` topic carries that annotation — and nothing that actuates:

```bash
python tools/mqtt_listener.py --send '{"label":"imbalance"}'     # tag the run
python tools/mqtt_listener.py --send '{"publish_ms":1000}'       # 500..60000 ms
python tools/mqtt_listener.py --send '{"rezero":true}'           # motor stopped
```

Suggested simulation sequence for the review — set the label, then drive the
inputs, so the captured stream is self-describing:

| Label | Wokwi action | Expected in telemetry |
| --- | --- | --- |
| `baseline` | pots mid-travel, MPU sliders at rest | low `vib.rms_ms2`, steady `rpm.avg` |
| `imbalance` | oscillate one MPU axis slider | `vib.rms_ms2` up, `crest` near 1.4 (smooth, periodic) |
| `bearing` | jerk the sliders irregularly | `vib.rms_ms2` up with `crest` well above 3 (impulsive) |
| `overload` | raise the current pot, lower the speed pot | `cur.rms_a` up while `rpm.avg` falls |
| `blocked_cooling` | raise the DS18B20 temperature in the part panel | `temp.c` climbing, other channels normal |

Those five are exactly the fault × signal combinations in the synopsis sensing
table, and they are what the rule engine in Objective 2 will be tested against.

## 6. Files

| File | Purpose |
| --- | --- |
| [sketch.ino](sketch.ino) | Firmware: acquisition, conditioning, MQTT telemetry |
| [config.h](config.h) | Every tunable — pins, interval, calibration, broker, TLS switch |
| [diagram.json](diagram.json) | Wokwi circuit |
| [libraries.txt](libraries.txt) | Wokwi library list |
| [docs/telemetry-schema.json](docs/telemetry-schema.json) | JSON Schema for `pdm.telemetry.v1`; the Objective 2 Pydantic model mirrors it |
| [tools/mqtt_listener.py](tools/mqtt_listener.py) | Subscriber + schema validator used to demonstrate the objective |
| [platformio.ini](platformio.ini) | Optional build for the physical ESP32 |
| [wokwi.toml](wokwi.toml) | Optional, for the Wokwi VS Code extension |

## 7. Known limits of this stage

- A public broker is used for the demo; device authentication and certificate
  pinning arrive with the cloud broker in Objective 2.
- Frequency-domain features (FFT, envelope analysis) are not extracted on the
  MCU. The 200 Hz sample rate and MPU6050 bandwidth bound what is available;
  RMS, peak and crest factor are the honest set at this rate.
- Wokwi does not simulate motor physics, so vibration amplitudes are operator
  driven and must not be read as calibrated machine values.
- QoS 0 with no local buffering: a window lost during a reconnect is gone, and
  visible as a `seq` gap rather than recovered.
