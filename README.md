# IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis

B.Tech MDM IoT capstone, PCCoE (E&TC) · Mehul Rawat, Atharva Palande · Guide: Prof. Kalpana Patil

An ESP32 edge node (Wokwi) replays real motor recordings, computes vibration and current features every
2 s and publishes them over MQTT. A drift gate catches departures from the healthy baseline, and Claude
reasons over the evidence, orders its own diagnostic test (a speed change) when it is unsure, and names
the root cause. Live dashboard: https://kalaaiintern01-commits.github.io/active-rca-demo/

| Folder | Contents |
|---|---|
| `active-rca-demo/` | The working system - see [its README](active-rca-demo/README.md) for running it |
| `active-rca-demo/firmware/` | ESP32 firmware (PlatformIO), Wokwi circuit and config, prebuilt image |
| `active-rca-demo/bridge/` | Drift gate, episode loop, Claude reasoning layer, trained baselines and fault signatures |
| `active-rca-demo/common/`, `training/` | Feature extractor and gate shared by training and live; dataset and model builder |
| `active-rca-demo/site/` | Dashboard and replay slices, published to GitHub Pages by `.github/workflows/pages.yml` |
| `active-rca-demo/tools/`, `docs/` | Serial tap, demo replay builder, presentation figures |
| `active-rca-demo/runs/` | Recorded episodes (`episodes.jsonl`) and logs from real runs |
| `data/` | The three source datasets as CSV (4.7 GB) - sources and licences in [data/README.md](data/README.md) |
| `objective-1-telemetry/` | Objective 1: telemetry node and schema work |
| `paper/` | Research paper |
