# Active-RCA — working demo

**IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis**
PCCoE E&TC · B.Tech MDM IoT · Mehul Rawat, Atharva Palande · Guide: Prof. Kalpana Patil

A simulated ESP32 (Wokwi) replays real recordings of three motors from GitHub Pages, computes 18
features per 2 s window and publishes them over MQTT. A bridge on your laptop gates the stream
against healthy baselines learned from training data; when the machine leaves its envelope it asks
Claude — **through your Claude subscription, no API key** — for a root cause. Claude may order an
active test (run at another speed/load); the node switches recordings, the bridge feeds the result
back, and Claude commits to a diagnosis that the dashboard scores against the injected fault.

```
 Wokwi ESP32 (MOTOR-01, VS Code)              HiveMQ public broker            laptop: bridge/arca_bridge.py
 ┌────────────────────────────┐  telemetry    ┌──────────────┐  telemetry   ┌───────────────────────────────┐
 │ HTTPS Range GET, 1 window  │ ────────────▶ │ pccoe/arca/  │ ───────────▶ │ schema check → drift gate      │
 │ per 2 s from GitHub Pages  │   MQTT        │ add1f2/      │              │ (3 windows > 3σ) → episode     │
 │ 18 features (same maths as │               │ MOTOR-01/... │  cmd (test)  │ evidence → claude -p (your     │
 │ training), OLED, buttons   │ ◀──────────── │              │ ◀─────────── │ subscription) → rca / test     │
 └────────────────────────────┘   cmd / alert └──────────────┘  rca, gate   └───────────────────────────────┘
          ▲ data/*.bin                              │ WSS :8884
 GitHub Pages ─────────────────────────────── live dashboard (same site)
```

| | Link |
|---|---|
| Live dashboard | https://kalaaiintern01-commits.github.io/active-rca-demo/ |
| Replay data + dashboard repo | https://github.com/kalaaiintern01-commits/active-rca-demo |
| Topic namespace | `pccoe/arca/add1f2/MOTOR-01/{telemetry,status,cmd,gate,rca,alert,ctl,bridge}` |

---

## 1. Run it

### a) Bridge — the reasoning layer

```powershell
pip install paho-mqtt jsonschema numpy scipy pandas pyserial
claude            # once: /login with your Claude subscription, then /exit
python bridge/arca_bridge.py
```

Expect `engine = claude-subscription:opus` and `[mqtt] connected ... root=pccoe/arca/add1f2/MOTOR-01`.
`--model sonnet` is faster; `--engine mock` is an offline rule-based stand-in (*not* an LLM, and
labelled that way on the dashboard) for testing without using your plan.

### b) Edge node — Wokwi for VS Code (recommended)

```powershell
cd firmware
pio run                      # builds .pio/build/esp32dev/firmware.bin (already built)
```

In VS Code: **F1 → Wokwi: Select Config File → `active-rca-demo/firmware/wokwi.toml`**, then
**F1 → Wokwi: Start Simulator**. Keep the simulator tab visible (split editor): VS Code freezes hidden
webviews, and the node falls silent while its tab is hidden. Measured boot on this PC:

```
00:44:02 [wifi] joining Wokwi-GUEST. up            (+1 s)
00:44:32 [mqtt] connecting broker.hivemq.com:1883 plain ... connected
00:44:49 [http] connected to kalaaiintern01-commits.github.io, keep-alive range requests
00:45:02 [pub] #1 S1 K001 N09_M07_F10 rms=1.467m/s2  len=954 heap=147k
          ... then one window every ~5 s
```

`python tools/serial_tap.py` mirrors the serial monitor to `runs/wokwi_serial.log` (the extension
exposes it on RFC2217 port 4000, see `wokwi.toml`).

**Build profiles** (`firmware/src/config.h`):

| `WOKWI_BUILD` | Telemetry | Replay data | Use |
|---|---|---|---|
| `1` (default) | plain MQTT, port 1883 | HTTPS Range requests to GitHub Pages, one keep-alive connection, ISRG Root X1 pinned | simulator — every TLS handshake is emulated instruction by instruction, so the node does only one |
| `0` | MQTT over TLS, port 8883, Amazon Root CA 1 pinned | same | real ESP32 hardware |

**wokwi.com instead of VS Code** works but is slower: paste `firmware/wokwi/sketch.ino` and
`firmware/wokwi/diagram.json`, add the five libraries in `firmware/libraries.txt`, press ▶. If the
free build queue reports *Build Servers Busy*, press F1 → *Upload Firmware and Start Simulation* and
pick `firmware/wokwi/prebuilt/merged-flash.bin`. There the first GitHub handshake can take several
retries (`-0x0050` resets) before data flows.

**Backup node without a simulator** — the Python twin publishes identical telemetry:
`python tools/virtual_node.py --data https://kalaaiintern01-commits.github.io/active-rca-demo/data/`.
Run only one node at a time; they share topics.

### c) Dashboard

Open the live dashboard. Chips show broker, node and bridge. Left: inject a condition (machine,
fault, operating point), *Diagnose now*, *Reset episode*. Centre: vibration RMS with the healthy band
for the current operating point, the high-frequency band, temperature or per-axis RMS, and the gate's
z-scores. Right: current diagnosis and Claude's reasoning log with cited evidence and ordered tests.
The injected label is shown as ground truth but never reaches the LLM.

On this network the page's secure WebSocket to the public broker takes **10–20 s to open**, and
the broker delivers retained status (node, bridge, last diagnosis) about 10 s after that — the
broker chip counts "connecting… N s" meanwhile. Open the dashboard a minute before you present.

## 2. Demo script

| # | Do | What happens |
|---|---|---|
| 1 | Start on **S1 · K001 healthy · 900 rpm** | RMS inside the green band; pill `monitor`. |
| 2 | Inject **S1 · KA01 outer race · 900 rpm** (dashboard or the FAULT button) | Vibration *drops* — the fault hides at low speed. Gate fires on window 3. Claude: outer race ~75 %, orders a **1500 rpm test**; TEST LED on, purple test points on the chart; Claude: **outer race 90 %, alarm**, correct. Measured on the Wokwi node: 101 s, 1 test. |
| 3 | Inject **S2 · EF eccentricity · 500 rpm** | RMS jumps ~17σ; diagnosed from the multi-feature signature. |
| 4 | Inject **S2 · SF stator · 500 rpm** | Gate stays silent — the stator fault has no signature at 500 rpm. Press **Diagnose now** to make the reasoner look; a test at 750 rpm is where it shows (3× normal). |
| 5 | Inject **S3 · RUN · 3V** | The DC motor warms; temperature leaves its band around window 42 (~3 min of recording) while current stays put → thermal drift / wear. |

The alarm **latches** after a diagnosis — no new episode or subscription call while the fault
persists. It re-arms after 10 clean windows, a new injected condition, or *Diagnose now*. Injecting
a new condition mid-episode aborts that episode (its in-flight Claude call is discarded).

## 3. The LLM: your Claude subscription, not an API key

`bridge/llm.py` runs the installed Claude Code CLI headless:

```
claude -p --safe-mode --tools "" --no-session-persistence --model opus --effort medium
       --output-format json --json-schema <pdm.rca.v1 schema built for this call>
       --system-prompt <bridge/prompts/system.md>          (evidence JSON on stdin)
```

- Uses the subscription you logged into with `/login`; `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
  are stripped from the child environment so it cannot fall back to API billing.
- `--safe-mode --tools ""` = a bare model call: no CLAUDE.md, MCP servers, plugins, hooks or tools.
- `--json-schema` forces `pdm.rca.v1`; enums are rebuilt per call, so Claude can only name causes of
  that machine and only order operating points it has not tested yet.
- One call per reasoning step, at most 4 per episode. Measured: 11–18 s per step with Opus at medium
  effort, ~5–6 k input tokens; this counts against your plan's usage limits.
- Every prompt is saved to `runs/E<n>-step<k>-prompt.txt`, every finished episode to
  `runs/episodes.jsonl`.

## 4. Training data

`python training/build_dataset.py` (≈ 5 min) turns `../data/*.csv` into:

| Output | What it is |
|---|---|
| `site/data/<src>/<cond>_<op>.bin` | replay slices served by GitHub Pages (39 MB) |
| `training/out/windows.csv` | every 2 s window with its 18 features and labels |
| `bridge/model/baselines.json` | healthy mean/σ per machine × operating point × feature (outlier-trimmed) |
| `bridge/model/signatures.json` | median fault/healthy ratios — the reference library Claude reasons with |
| `training/out/gate_eval.md` | the gate replayed over every slice |

**Split — no recording in both:** S1 reps 1–14 train / 15–20 replay; S2 `LocS_Train_Clean` train /
`LocS_Val_Clean` replay; S3 is one run, so its first 30 snapshots are the commissioning baseline.

**Gate on held-out replay data:** 0 false alarms on all 15 healthy files; 22 of 23 fault files fire
on their 3rd window; the miss is S2 stator @ 500 rpm, which has no signature at that speed; S3's wear
run fires at window 42.

## 5. What was verified

| Check | Result |
|---|---|
| Firmware feature extractor (C++) vs Python reference | 232 windows × 17 features, worst relative error 7×10⁻⁵ |
| Firmware build | both profiles compile; RAM 27 %, flash 32 % |
| **Wokwi for VS Code** | boot → MQTT → GitHub Pages HTTPS on first attempt (17 s) → steady windows; rms identical to Python; scenario command switched recordings; active test ran 1 settle + N run windows at the new speed and resumed the base recording; a second test while busy was rejected |
| **End to end, Wokwi node + Claude Opus (subscription)** | S1 KA01 @ 900 rpm: gate → outer race 75 % → 1500 rpm test executed by the Wokwi node → outer race 90 %, correct, 101 s |
| GitHub Pages | slices byte-identical; `Range` → `206` exact window with keep-alive; past end → `416`; uncompressed for the ESP32 |
| Dashboard | live over WSS: charts with healthy band, gate z-bars, fault injection, reasoning feed, latched alarm |

## 6. Files

```
active-rca-demo/
  common/pdmfeat.py          feature extractor + slice format (reference implementation)
  common/gate.py             drift gate shared by training and the bridge
  training/build_dataset.py  slices, baselines, signatures, gate evaluation
  firmware/src/              main.cpp, config.h, certs.h (pinned roots), pdm_features.h
  firmware/wokwi.toml        Wokwi for VS Code config (+ diagram.json alongside)
  firmware/wokwi/            single-file sketch + prebuilt image for wokwi.com
  firmware/tools/            make_wokwi_single.py, check_features.py
  bridge/arca_bridge.py      gate → episode → Claude → test loop
  bridge/llm.py              Claude-subscription engine + mock engine
  bridge/evidence.py         what the LLM sees (never the label)
  bridge/schemas/            pdm.telemetry.v1.1, pdm.cmd.v1
  bridge/prompts/system.md   the reasoning instructions
  site/                      GitHub Pages content (dashboard + data) — its own git repo
  tools/virtual_node.py      Python twin of the node
  tools/serial_tap.py        log the VS Code simulator's serial port
  tools/set_site.py          point firmware, bridge and dashboard at a new Pages URL / topic id
```

## 7. Limits, stated plainly

- **Public broker.** Anyone who knows the topic id can read the stream or send node commands (the node
  accepts only whitelisted, validated commands). For a private run use a HiveMQ Cloud cluster with a
  credential limited to this topic root (`WOKWI_BUILD 0`, TLS) and `python tools/set_site.py --new-site-id`.
- **Plain MQTT in the simulator.** The simulator profile sends telemetry unencrypted to save a TLS
  handshake; the hardware profile uses TLS with a pinned root.
- **Signature library.** S1/S2 diagnoses lean on fault signatures from separate training recordings of
  the same machines; a real machine would start with physics-only reasoning (as S3 does).
- **S3** is a single stress run, so its baseline and replay come from the same motor.
- **GitHub Pages speed from this network is low (~18 kB/s per connection)**, which is why the node
  runs at roughly one window per 5 s rather than per 2 s.
