# Active-RCA live demo — GitHub Pages content

This repository is the static half of the PCCoE MDM IoT capstone demo
*IoT & LLM-based Predictive Maintenance with Active Root-Cause Analysis*
(Mehul Rawat, Atharva Palande · guide Prof. Kalpana Patil).

- `index.html`, `app.js`, `style.css`, `config.js` — the live dashboard. It connects to the MQTT
  broker over secure WebSockets and shows telemetry, the drift gate and the LLM's reasoning.
- `data/<src>/<condition>_<operating point>.bin` — replay slices that the simulated ESP32 node
  (Wokwi) streams over HTTPS, two seconds at a time.
- `data/manifest.json` — what each slice contains.

## Slice format

Concatenated windows; each window is a 48-byte little-endian header
(`'PDMW'`, channels, flags, sample rate, samples, rpm, temperature, aux, 4 × int16 scale, vibration mask,
current channel) followed by `int16[n][channels]` interleaved samples.

## Data sources and attribution

The slices are decimated, quantised excerpts of three public datasets, used here for a
non-commercial academic demonstration. See each source for its licence and cite it if you reuse them.

| Folder | Source |
|---|---|
| `data/S1` | Paderborn University KAt Bearing DataCenter — C. Lessmeier, J. K. Kimotho, D. Zimmer, W. Sextro, *Condition Monitoring of Bearing Damage in Electromechanical Drive Systems…*, PHM Society European Conference 2016. Bearings K001 (healthy) and KA01 (outer-race damage). |
| `data/S2` | Multi-condition PMSM vibration fault dataset (CubeMars RI60), Zenodo, doi:10.5281/zenodo.22039010 (validation split). |
| `data/S3` | CARTIF open DC-motor dataset, Zenodo, doi:10.5281/zenodo.4314249. |
