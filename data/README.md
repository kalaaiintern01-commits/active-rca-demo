# Datasets - three motors, all CSV

```
data/
  S1_index.csv             one row per S1 recording (bearing, speed, load, measured means, RMS)
  S2_index.csv             one row per S2 recording (fault class, rpm, sensor location, RMS)
  S3_index.csv             one row per S3 recording (phase, temp, current, voltage, rpm, RMS)
  S1_paderborn_pmsm/       160 CSV  - Paderborn KAt bearing dataset, K001 (healthy) + KA01 (outer-ring fault)
  S2_cubemars_pmsm/        450 CSV  - Zenodo 22039010 PMSM fault dataset
  S3_cartif_dc_motor/      377 CSV  - Zenodo 4314249 CARTIF brushed DC motor
```

Open any `*_index.csv` first - it tells you what every file is. The per-recording CSVs hold the raw signal.

| | S1 `S1_paderborn_pmsm/` | S2 `S2_cubemars_pmsm/` | S3 `S3_cartif_dc_motor/` |
|---|---|---|---|
| Motor | 425 W PMSM, 4 pole pairs | CubeMars RI60 PMSM, 14 pole pairs | brushed DC motor |
| Columns | `time_s, vibration_g, phase_current_1_a, phase_current_2_a, speed_rpm, torque_nm, force_n, temp_c` | `timestamp_s, ax, ay, az` (g) | `time_s, vibration, current_a, voltage_v` |
| Rate | 64 kHz (speed/torque/force 4 kHz, temp 1 Hz - repeated to 64 kHz) | 5 kHz | 51.2 kHz |
| Length | 4 s, 256,823 rows | 10 s, ~50,000 rows | 2 s, 102,413 rows |
| File name | `N15_M07_F10_KA01_1.csv` = 1500 rpm, 0.7 Nm, 1000 N, bearing KA01, rep 1 | `LocS_Train_Clean__EF_5khz_500rpm_1.csv` = set, fault EF, 500 rpm, rep 1 | `MOTOR-DC_2020_12_02_17_25_04.csv` = timestamp |
| Labels | K001 healthy / KA01 damaged; N09=900 rpm, N15=1500 rpm; M01=0.1 Nm, M07=0.7 Nm; F04=400 N, F10=1000 N | NR normal, BF bearing, MF magnet, SF stator, EF eccentricity; 500/750/1000 rpm; LocS train/val, LocA/B/C test (sensor moved) | phase folder 01-Start 3V .. 04-Change 5V; temp/current/voltage/rpm per file in the index |
| Used for | active test loop - same fault at two speeds and two loads | root-cause separation - five faults at three speeds | wear trend - temperature, current, rpm drift over the run |

Notes
- S1 torque label (M07 = 0.7 Nm) is nominal; the measured `torque_nm` column reads ~1.0-1.5 Nm. Use the column.
- S2 Nyquist is 2.5 kHz. Features shared across all three motors must stay below 2.4 kHz.
- S3 vibration is on the sensor's own scale (no g calibration published). `speed_rpm` comes from the lab's TSV log; blank where the log had no entry.
- Healthy vibration RMS: S1 0.40 g, S2 0.0046 g. Never compare motors against each other - each scenario has its own baseline.

Sources
- S1: https://mb.uni-paderborn.de/kat/forschung/kat-datacenter/bearing-datacenter/data-sets-and-download
  (files `https://groups.uni-paderborn.de/kat/BearingDataCenter/<bearing>.rar`). Cite Lessmeier et al., PHM Society European Conf., 2016.
- S2: https://zenodo.org/records/22039010  DOI 10.5281/zenodo.22039010
- S3: https://zenodo.org/records/4314249   DOI 10.5281/zenodo.4314249

The per-recording folders are git-ignored (several GB). The three index CSVs and this README are committed.
