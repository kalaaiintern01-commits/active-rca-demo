// Builds Abhiyantrix26_Active_RCA_Paper.docx (IEEE-style, A4, two columns) from figures/*.png
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType,
  HeadingLevel, SectionType, BorderStyle, ShadingType, VerticalAlign, TabStopType, LevelFormat,
} = require("docx");

const FIG = path.join(__dirname, "figures");
const FONT = "Times New Roman";
const COL_PX = 313, FULL_PX = 650;           // 3.26 in and 6.77 in at 96 dpi
const COL_DXA = 4694, FULL_DXA = 9746;

function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function img(file, widthPx) {
  const p = path.join(FIG, file); const { w, h } = pngSize(p);
  return new ImageRun({ type: "png", data: fs.readFileSync(p), transformation: { width: widthPx, height: Math.round(widthPx * h / w) } });
}
const t = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 20, bold: o.bold, italics: o.italics, smallCaps: o.smallCaps, superScript: o.sup });
const body = (...runs) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 0, line: 240 }, indent: { firstLine: 288 }, children: runs.map(r => typeof r === "string" ? t(r) : r) });
const bodyNoIndent = (...runs) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 0, line: 240 }, children: runs.map(r => typeof r === "string" ? t(r) : r) });
const i = (s) => t(s, { italics: true });
const b = (s) => t(s, { bold: true });
const mono = (s) => new TextRun({ text: s, font: "Consolas", size: 15 });
const H1 = (s) => new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 200, after: 80 }, children: [t(s, { smallCaps: true, size: 20 })] });
const H2 = (s) => new Paragraph({ alignment: AlignmentType.LEFT, keepNext: true, spacing: { before: 120, after: 40 }, children: [t(s, { italics: true, size: 20 })] });
const caption = (s) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { before: 60, after: 160 }, children: [t(s, { size: 16 })] });
const tcap = (label, title) => [
  new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 0 }, children: [t(label, { smallCaps: true, size: 16 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { after: 60 }, children: [t(title, { smallCaps: true, size: 16 })] }),
];
const figure = (file, widthPx, cap) => [
  new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 0 }, children: [img(file, widthPx)] }),
  caption(cap),
];
const codeLines = (lines) => lines.map(l => new Paragraph({ spacing: { after: 0, line: 200 }, indent: { left: 144 }, children: [mono(l)] }));

const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const noB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
function table(widths, header, rows, fontSize = 15) {
  const total = widths.reduce((a, c) => a + c, 0);
  const cell = (txt, w, isHead, keep, align = AlignmentType.LEFT) => new TableCell({
    width: { size: w, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
    borders: { top: isHead ? border : noB, bottom: isHead ? border : noB, left: noB, right: noB },
    shading: isHead ? { type: ShadingType.CLEAR, fill: "EDEDED", color: "auto" } : undefined,
    margins: { top: 30, bottom: 30, left: 60, right: 60 },
    children: [new Paragraph({ alignment: align, keepNext: keep, spacing: { after: 0, line: 220 }, children: [t(String(txt), { size: fontSize, bold: isHead })] })],
  });
  const tr = new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, k) => cell(h, widths[k], true, true)) });
  const trs = rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, k) => cell(c, widths[k], false, ri < rows.length - 1)) }));
  // bottom rule on last row
  const last = trs[trs.length - 1];
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, rows: [tr, ...trs],
    borders: { top: border, bottom: border, left: noB, right: noB, insideHorizontal: noB, insideVertical: noB } });
}

// ------------------------------------------------------------------ content
const title = new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 }, children: [
  t("From Alarm to Cause: An ESP32–MQTT–LLM Pipeline That Orders Its Own Diagnostic Tests, Validated on Three Public Motor Datasets", { size: 44 })] });
const authors = new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [
  t("Mehul Rawat", { size: 22 }), t("1", { size: 22, sup: true }), t(",  Atharva Palande", { size: 22 }), t("1", { size: 22, sup: true }), t(",  Kalpana Patil", { size: 22 }), t("2", { size: 22, sup: true })] });
const affil = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [t("1", { size: 20, sup: true }), i("Student, Multidisciplinary Minor in IoT, Pimpri Chinchwad College of Engineering, Pune, India")] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [t("2", { size: 20, sup: true }), i("Project Guide, Pimpri Chinchwad College of Engineering, Pune, India")] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [t("{author1.email}@pccoepune.org,  {author2.email}@pccoepune.org,  {guide.email}@pccoepune.org", { size: 18 })] }),
];

const abstract = [
  bodyNoIndent(b("Abstract— "), i("Most predictive-maintenance deployments stop at an alarm: a threshold trips and a technician is dispatched to discover why. This paper describes and validates a low-cost IoT pipeline in which the diagnostic step is closed by a large language model (LLM) that does not merely interpret a snapshot but requests additional operating points from the machine before committing to a root cause. An ESP32 edge node computes eighteen vibration, current and thermal features per two-second window and publishes them over MQTT/TLS; a per-machine drift gate (healthy mean + 3σ over three consecutive windows) decides when the reasoning layer is consulted; the LLM returns a schema-constrained ranked cause list and may issue a bounded speed or load test through a command topic. Because no single public dataset offers several fault classes, several operating points and multi-sensor wear trends together, the design is evaluated offline on three complementary open datasets replayed through the same simulated node: the Paderborn bearing benchmark (PMSM, 7 channels), a five-class PMSM vibration set (CubeMars RI60) and the CARTIF brushed-DC wear run. The measurements motivate the active loop directly: an outer-ring bearing fault lowers vibration RMS by 37% at 900 rpm yet raises it by 33% and the 1–5 kHz band power by 6.8× at 1500 rpm; eccentricity and magnet faults are indistinguishable at 500 rpm (ratio to normal 2.1× vs 1.9×) but separate with a clean margin at 750 rpm (4.1× vs 2.1×, 20 of 20 recordings); on the DC motor, temperature and vibration leave their healthy bands 2.9 and 3.0 minutes into a 35-minute stress run while current never does. A per-speed 3σ vibration threshold fitted on the training split reaches 88% anomaly-detection accuracy on the held-out validation split, with every miss belonging to the stator-fault class at a speed where its signature is absent — precisely the case a second operating point is needed for. We report the telemetry and diagnosis contracts, feature budget (68 kB of 520 kB SRAM), safety constraints, and limitations of the current simulation-based evaluation.")),
  bodyNoIndent(b("Keywords— "), i("predictive maintenance, root cause analysis, large language models, ESP32, MQTT, vibration analysis, PMSM, DC motor, active diagnosis")),
];

const intro = [
  H1("I. Introduction"),
  body("Condition monitoring of rotating machines has matured from scheduled inspection to sensor-driven anomaly detection, and a growing body of work applies machine learning to the resulting streams [3], [4], [11], [12]. In practice, however, the output of most deployed systems is a single bit of information — ", i("something is wrong"), " — attached to a time stamp. Turning that bit into a cause still depends on a person who walks to the machine, listens, changes its speed or load, and reasons from what changes. That human step is slow, expensive and unevenly skilled, and for equipment installed in shafts, ceilings or remote sites it is often the dominant maintenance cost."),
  body("The reasoning the technician performs is not mysterious. A bearing defect excites broadband high-frequency energy whose visibility grows with shaft speed [2]; rotor eccentricity rides on the shaft frequency and its second harmonic; a weakened magnet alters the pole-pass component; a warm winding shows up as a slow current-and-temperature drift rather than a spectral line. Each of these signatures answers differently to a change of operating point, so a well-chosen ", i("test"), " — run at a second speed, add a load, hold for thirty seconds — is frequently worth more than another hour of passive listening at the same speed."),
  body("This paper asks whether that test-and-reason step can be automated with commodity parts. We describe a three-layer pipeline: an ESP32 edge node that reduces raw signals to eighteen features per window, an MQTT broker that carries telemetry in one direction and bounded commands in the other, and a reasoning layer built on a large language model constrained to a strict JSON diagnosis contract. The LLM is consulted only when a statistical drift gate fires, and it may spend at most three tests before it must commit or declare the cause unavailable."),
  body("Our contributions are: (1) a concrete, reproducible design — telemetry contract, feature set, gate, and diagnosis contract — sized for a 520 kB-SRAM microcontroller; (2) a validation strategy that replays three open datasets with different motors, sensors and fault families through the same node, each scored against its own healthy baseline and never fused; (3) measured evidence that the operating-point dependence the active loop relies on is real and large in all three datasets; and (4) an honest account of what has and has not yet been demonstrated, since the LLM layer is specified and exercised on recorded episodes but not yet benchmarked at scale."),
  H1("II. Related Work"),
  body("Bearing diagnostics has a long analytical tradition; Randall and Antoni's tutorial [2] remains the standard account of why defect signatures are amplitude-modulated, why envelope and band-power features work, and why speed matters. The Paderborn bearing data centre [1] made this tradition testable with motor-current and vibration recordings of 32 bearings under four operating points, and it has since become a common benchmark for data-driven classifiers [3], [4]. Surveys of predictive maintenance in Industry 4.0 settings [11], [12] note that most published systems remain detection-oriented and that explanation of the detected condition is rarely automated."),
  body("Large language models have recently been applied to reasoning tasks through step-wise prompting [7] and, on current platforms, through schema-enforced structured outputs that make their answers machine-consumable [10]. A title-and-abstract search of the OpenAlex index in September 2026 for LLM-based root-cause analysis on rotating machinery returned 32 works; to our knowledge none of them closes the loop by letting the model change the machine's operating point and observe the result, which is the step this paper adds. Elevator-specific predictive maintenance is similarly thin (122 indexed works), and the one public elevator dataset we located is access-restricted, which motivated the multi-dataset strategy described next."),
];

const datasets = [
  H1("III. Datasets"),
  body("No open dataset we found contains, at once, several fault classes, several operating points and multi-sensor slow-drift channels. We therefore combine three, each supplying one of these properties (Table I, Fig. 1). All were downloaded from their public records, converted to flat per-recording CSV files with a uniform time column, and indexed so that every file carries its labels and summary statistics."),
  body(b("S1 — Paderborn KAt bearing benchmark [1]."), " A 425 W permanent-magnet synchronous motor (four pole pairs) drives a test bearing under four operating points: 900 or 1500 rpm, 0.1 or 0.7 N·m load torque and 400 or 1000 N radial force. Each 4 s recording holds vibration and two phase currents at 64 kHz, shaft speed, torque and radial force at 4 kHz, and bearing-module temperature at 1 Hz. We use the healthy bearing K001 and the artificially damaged outer-ring bearing KA01 — 20 repetitions per operating point, 160 recordings in total. Because the same fault is recorded at two speeds and two loads, S1 is the dataset that tests the ", i("active"), " premise."),
  body(b("S2 — Five-class PMSM vibration set [5]."), " A CubeMars RI60 PMSM (14 pole pairs) is recorded with a tri-axial accelerometer at 5 kHz in five conditions — normal (NR), bearing (BF), magnet (MF), stator (SF) and eccentricity (EF) fault — at 500, 750 and 1000 rpm, with the sensor at a reference location (LocS, train/validation) and three alternative locations (LocA/B/C, test), in clean and deliberately noisy variants: 450 recordings of about 10 s. S2 supplies ", i("different"), " faults at ", i("different"), " speeds, which is what root-cause separation needs. Its 2.5 kHz Nyquist limit caps any feature shared across all three motors at 2.4 kHz."),
  body(b("S3 — CARTIF open DC-motor run [6]."), " A new brushed DC motor is stressed for about 35 minutes: 3 V start-up, step to 5 V, restart at 3 V, step to 5 V again. Each of the 377 HDF5 snapshots (converted to CSV) holds 2 s of vibration, current and voltage at 51.2 kHz, with motor temperature, ambient temperature and, from the laboratory log, shaft speed attached to each file. S3 is the only genuinely DC machine in the set and the only one with a slow thermal/electrical trend, so it exercises the drift gate."),
  body("The three healthy baselines differ by more than an order of magnitude (vibration RMS 0.40 g for S1 versus 0.015 g for S2, and an uncalibrated scale for S3), so all comparisons in this paper are ratios against the same machine's own normal condition at the same operating point. The datasets are never merged into one training set."),
];

const datasetTable = [
  ...tcap("TABLE I", "The Three Datasets Replayed Through the Node"),
  table([1100, 1900, 2300, 2050, 2396],
    ["Source", "Machine", "Channels and rate", "Conditions", "Role in this work"],
    [
      ["S1  Paderborn KAt [1]", "425 W PMSM, 4 pole pairs, test bearing", "vibration, 2× phase current @ 64 kHz; speed, torque, radial force @ 4 kHz; bearing temp @ 1 Hz", "K001 healthy, KA01 outer-ring fault; 900/1500 rpm × 0.1/0.7 N·m × 400/1000 N; 160 × 4 s", "same fault at two speeds and two loads → active test premise"],
      ["S2  Zenodo 22039010 [5]", "CubeMars RI60 PMSM, 14 pole pairs", "tri-axial vibration @ 5 kHz (g)", "NR, BF, MF, SF, EF × 500/750/1000 rpm; LocS train/val, LocA/B/C test; clean/noisy; 450 × 10 s", "five faults at three speeds → root-cause separation"],
      ["S3  CARTIF, Zenodo 4314249 [6]", "brushed DC motor, new", "vibration, current, voltage @ 51.2 kHz; motor and ambient temperature; speed from log", "3 V → 5 V → 3 V → 5 V stress run over 35 min; 377 × 2 s", "thermal and electrical drift → gate"],
    ]),
  ...figure("fig6_dataset_samples.png", 560, "Fig. 1.  First rows of one converted CSV per source, exactly as the replay node reads them; only the time base and channel set differ."),
];

const design = [
  H1("IV. System Design"),
  H2("A. Layers and data flow"),
  body("Fig. 2 shows the pipeline. Layer 1 is an ESP32-WROOM-32 [9] running in the Wokwi simulator; in place of physical sensors it streams two-second slices of the three datasets from static hosting, using the file time base rather than the simulator clock so that replay speed does not distort features. Layer 2 is a managed MQTT v5 broker [8] reached over TLS on port 8883 with QoS 1; a Python bridge subscribes, validates every message against a JSON Schema, and writes accepted messages to a time-series store behind a dashboard. Layer 3 is the reasoning service, which receives a bundle of recent windows only when the drift gate fires, calls the LLM with a fixed system prompt, and may publish a bounded command back to the node."),
  H2("B. Telemetry contract"),
  body("Every window is published as one JSON object, schema ", mono("pdm.telemetry.v1.1"), ", with ", mono("additionalProperties: false"), " so that unknown fields are rejected at the bridge. Beyond the identifiers (", mono("device_id"), ", ", mono("src"), " ∈ {S1, S2, S3}, ", mono("seq"), ", ", mono("ts"), ") each block carries its own validity flag: ", mono("temp.valid"), ", ", mono("vib.valid"), ", ", mono("cur.cal_ok"), ", ", mono("win.dropped"), ". The ", mono("src"), " field is what lets one node stand in for three machines while keeping their baselines apart. A representative message follows."),
  ...codeLines([
    '{"schema": "pdm.telemetry.v1.1",',
    ' "device_id": "MOTOR-01", "src": "S1", "seq": 1284,',
    ' "ts": "2026-09-17T10:14:22.031Z",',
    ' "label": "KA01:N15_M07_F10",',
    ' "temp": {"c": 46.3, "valid": true},',
    ' "vib":  {"rms_ms2": 5.29, "peak_ms2": 41.2,',
    '          "crest": 7.79, "valid": true},',
    ' "cur":  {"rms_a": 1.797, "mean_a": 0.00,',
    '          "peak_a": 2.88, "cal_ok": true},',
    ' "rpm":  {"avg": 1499.6, "inst": 1499.8},',
    ' "win":  {"ms": 2000, "n": 128000,',
    '          "sample_hz": 64000, "dropped": 0},',
    ' "net":  {"rssi": -61, "tls": true, "mqtt_reconn": 0}}',
  ]),
  new Paragraph({ spacing: { after: 60 }, children: [] }),
  H2("C. Feature budget"),
  body("Eighteen scalar features are computed per two-second window (Table II). Time-domain statistics are computed in a single pass; spectral features use a 1024-point Hann-windowed FFT, Welch-averaged over nine frames, giving 4.88 Hz bins at 5 kHz. Band edges are 0–50, 50–200, 200–800 and 800–2500 Hz so that the same four bands exist for all three motors; the 1–5 kHz band that proves so discriminative for S1 (Section VI) is therefore an S1/S3-only extra, not a shared feature. The raw window (10 000 samples × 3 axes × 2 bytes) plus FFT buffers occupy about 68 kB of the ESP32's 520 kB SRAM."),
  ...tcap("TABLE II", "Per-Window Feature Set (18 Scalars)"),
  table([1500, 500, 1300, 1394],
    ["Feature", "n", "Definition", "Why it is there"],
    [
      ["RMS, peak, crest", "3", "√mean x², max|x|, peak/RMS", "level; impulsiveness"],
      ["Kurtosis, skewness", "2", "standardised 4th, 3rd moment", "impacts raise kurtosis above 3"],
      ["RMS per axis x,y,z", "3", "per-channel RMS", "directional eccentricity"],
      ["Band energy", "4", "Σ|X(f)|² in four bands", "shared spectral shape"],
      ["Amplitude at 1×, 2×, pole-pass", "3", "FFT bin magnitude", "fault-family fingerprints"],
      ["Dominant frequency", "1", "argmax |X(f)|", "what leads the spectrum"],
      ["Current RMS, mean", "2", "phase or DC current", "load level; confirms a test ran"],
    ]),
  H2("D. Drift gate"),
  body("For each ", mono("src"), " and each feature, a healthy baseline (mean μ and standard deviation σ) is learned from labelled normal recordings at the same operating point. A window is flagged when a feature exceeds μ + 3σ, and the reasoning layer is woken only when three consecutive windows are flagged. Requiring persistence suppresses single-sample spikes — which we did observe in a few S2 files, where kurtosis briefly exceeds 10⁴ — without adding latency beyond six seconds."),
  H2("E. Reasoning layer and active loop"),
  body("The LLM (Claude, model ", mono("claude-opus-5"), ", called with structured output so that the response is guaranteed to parse [10]) receives the last twelve windows, the per-", mono("src"), " baseline, and the list of tests it is permitted to order. It returns a ", mono("pdm.rca.v1"), " object: a ranked list of candidate causes with probabilities, the evidence cited for each, an optional ", mono("next_test"), ", and a ", mono("stop_reason"), ". Permitted tests are a speed change to a listed rpm and a load change to a listed level, each with a hold time of at most 30 s. The loop terminates when the top probability exceeds 0.8, after three tests, or when the model reports that the cause is unavailable from the permitted evidence. Commands travel on a separate ", mono("/cmd"), " topic and are executed by the node only after schema validation; the API key never leaves the bridge, since the simulated node is on a public gateway."),
];

const method = [
  H1("V. Offline Validation Method"),
  body("The pipeline components were implemented and exercised on recorded episodes; the quantitative results below concern the measurable premises of the design rather than the end-to-end accuracy of the LLM, which is left for the hardware phase (Section VII). Three questions were posed to the data. (Q1) Does a fault signature change with operating point strongly enough that a second test is informative? (Q2) Do fault classes that overlap at one speed separate at another? (Q3) Does the 3σ gate fire early and for the right channels on a genuine wear trend, and where does it mislead?"),
  body("For S1, vibration RMS was computed for all 160 recordings and 1–5 kHz band power (Welch, 4096-point) for five recordings per bearing and operating point. For S2, AC-coupled tri-axial magnitude RMS was computed for the LocS clean training and validation splits; a per-speed anomaly threshold μ_NR + 3σ_NR was fitted on the training normals and applied unchanged to the 75 validation recordings. For S3, the first 30 snapshots (about two minutes at 3 V) define the healthy band for temperature, current and vibration, and the time at which each channel first leaves its band is recorded."),
];

const results = [
  H1("VI. Results"),
  H2("A. S1 — the same fault at two speeds (Q1)"),
  body("Fig. 3 and Table III summarise the Paderborn recordings. The healthy bearing is remarkably stable: 0.36–0.41 g RMS across every operating point, with the twenty repetitions spanning less than 0.02 g. The outer-ring fault raises RMS to 0.51–0.54 g at 1500 rpm — a 30% rise with no overlap, so a fixed threshold of 0.45 g separates all 120 recordings at that speed — but at 900 rpm the same bearing reads 0.22–0.23 g, ", i("37% below"), " the healthy value. An upper-bound alarm learned at 1500 rpm therefore misses all twenty faulty recordings at 900 rpm, and a naïve reading would call the faulty bearing the quieter one."),
  body("The band-power view explains why. At 1500 rpm the faulty bearing carries 3.5–7.0× the healthy energy in the 1–5 kHz band (Fig. 4 shows the broad hump near 3.5 kHz that produces it), while at 900 rpm the two bearings are indistinguishable in that band. Phase-current RMS rises by only 2–3% with the fault at any operating point, well inside repetition scatter; current instead tracks load faithfully (0.90 A at 0.1 N·m, 1.77 A at 0.7 N·m), which is what makes it useful as confirmation that a commanded load test actually took effect."),
  ...figure("fig3_s1_psd.png", COL_PX, "Fig. 4.  Welch power spectral density of one healthy (K001) and one faulty (KA01) recording at 1500 rpm, 0.7 N·m, 1000 N. The fault adds a broad hump inside the 1–5 kHz band and reshapes the spectrum above 10 kHz; both bearings share the 6, 7.7 and 9.9 kHz structural lines."),
  ...tcap("TABLE III", "S1 Vibration RMS (g), Mean of 20 Recordings"),
  table([1900, 900, 900, 994],
    ["Operating point", "K001", "KA01", "ratio"],
    [
      ["900 rpm, 0.7 N·m, 1000 N", "0.364", "0.230", "0.63"],
      ["1500 rpm, 0.1 N·m, 1000 N", "0.401", "0.530", "1.32"],
      ["1500 rpm, 0.7 N·m, 400 N", "0.396", "0.519", "1.31"],
      ["1500 rpm, 0.7 N·m, 1000 N", "0.403", "0.539", "1.34"],
    ]),
  H2("B. S2 — separating look-alike faults (Q2)"),
  body("Fig. 5 gives each fault's vibration RMS as a multiple of the normal recordings at the same speed. Bearing damage is unambiguous everywhere (13–36×). The other three classes behave differently with speed. Eccentricity and magnet faults both sit near 2× at 500 rpm — 2.1× and 1.9×, with the individual recordings overlapping (EF 0.027–0.034 g, MF 0.024–0.032 g) — but at 750 rpm eccentricity doubles to 4.1× while the magnet fault stays at 2.1×, and the two classes separate with a gap of 0.024 g between the lowest EF and the highest MF recording across all twenty. The stator fault is invisible at 500 rpm (1.1×) and appears only at 750 rpm (3.1×)."),
  body("The per-speed 3σ threshold fitted on the training normals classifies 66 of the 75 validation recordings correctly (88%). Every error is a stator-fault recording — five of five missed at 500 rpm and four of five at 1000 rpm — while all other classes, and all normals, are classified correctly at every speed (Table IV). In other words, the detector fails exactly where the signature does not exist at that speed, and the remedy is not a better threshold but another operating point."),
  ...figure("fig4_s2_heatmap.png", COL_PX, "Fig. 5.  S2 vibration RMS relative to the normal class at the same speed (LocS clean training split, five recordings per cell). Eccentricity and magnet faults are indistinguishable at 500 rpm and separate at 750 rpm; the stator fault has no signature at 500 rpm."),
  ...tcap("TABLE IV", "S2 Per-Speed 3σ Detector on the Validation Split (n = 75)"),
  table([900, 1200, 2594],
    ["Speed", "Threshold (g)", "Correct / total by class (NR, BF, EF, MF, SF)"],
    [
      ["500 rpm", "0.0158", "5/5, 5/5, 5/5, 5/5, 0/5"],
      ["750 rpm", "0.0174", "5/5, 5/5, 5/5, 5/5, 5/5"],
      ["1000 rpm", "0.0515", "5/5, 5/5, 5/5, 5/5, 1/5"],
    ]),
  H2("C. S3 — drift on a real wear run (Q3)"),
  body("Fig. 6 traces the DC motor over the 35-minute run against the healthy band learned from its first two minutes (temperature 27.6 ± 1.4 °C, current 1.56 ± 0.20 A, speed 7921 ± 42 rpm, vibration 0.93 ± 0.04). Temperature crosses its 3σ limit of 31.6 °C at 2.9 minutes and vibration crosses 1.045 at 3.0 minutes, both while the supply is still 3 V and speed is unchanged — a genuine warming and loosening trend, not a change of operating point. Current never leaves its band during the 3 V phase, so a current-only monitor would have stayed silent."),
  body("When the supply steps to 5 V the picture changes character: temperature climbs to 71.5 °C, current to 3.2 A, speed to 13 000 rpm and vibration to ten times baseline; at the hottest point current falls to zero while speed is still logged, consistent with the motor cutting out. These excursions are huge (over 50σ) but partly legitimate — the operating point moved — which is the trap the per-operating-point baseline exists to avoid. A gate that compared the 5 V phase against the 3 V baseline would flood the reasoning layer; one that also knows the supply voltage would not."),
  ...figure("fig5_s3_drift.png", COL_PX, "Fig. 6.  S3 motor temperature, current and vibration RMS over the stress run. Grey band: healthy mean ± 3σ from the first 30 snapshots; dashed line: the upper limit; yellow: 5 V phases. Temperature and vibration leave the band within three minutes at constant supply; current does not."),
];

const discussion = [
  H1("VII. Discussion and Limitations"),
  body("Taken together the three datasets support the central design choice. A single passive threshold cannot serve S1 across speeds (the fault sign flips), cannot serve S2 for two of its classes at 500 rpm (no signature), and would drown in false alarms on S3 when the operating point changes. In every one of those cases the informative action is the same: change the operating point and measure again. That action is cheap on a machine that already has a drive, it is bounded in time, and its outcome is a quantity — a ratio between two windows — that a language model can be asked to reason over with far less room for hallucination than a free-text description of a spectrum."),
  body("Several limitations are real and stated plainly. First, the edge node is simulated and the sensors are replayed; the ADC noise, mounting resonances and Wi-Fi drop-outs of a physical installation are not represented. Second, the LLM layer has been specified, connected and run on recorded episodes, but we have not yet measured its end-to-end diagnostic accuracy on a held-out episode set, and we do not report one. Third, the S1 fault studied is artificial (EDM) and from a single bearing; the benchmark also contains accelerated-lifetime bearings that we have not yet processed. Fourth, S2's 5 kHz rate removes the very band that is most informative on S1, so a common feature set is weaker than a per-machine one. Fifth, S3's vibration is on an uncalibrated scale and its stress schedule conflates wear with supply changes; we mitigate but do not eliminate this by baselining per phase."),
  body("Cost and safety were considered from the start. Because the gate rather than a timer wakes the LLM, calls are rare — on the order of one per anomaly episode plus one per test — and at current list prices amount to a few rupees per episode with prompt caching. Commands are restricted to a whitelist with hold-time caps; the node ignores anything that fails schema validation; and credentials stay with the bridge, never in firmware that runs on a public simulator."),
];

const conclusion = [
  H1("VIII. Conclusion and Future Work"),
  body("We presented a three-layer predictive-maintenance pipeline whose distinguishing feature is that the diagnostic reasoner may order bounded operating-point tests instead of interpreting a single snapshot, and we validated its premises offline on three open datasets with different motors, sensors and fault families. The measurements are unambiguous: fault visibility depends on speed and load strongly enough that one operating point is often insufficient (S1: RMS ratio 0.63 at 900 rpm vs 1.34 at 1500 rpm), classes that overlap at one speed separate at another (S2: eccentricity vs magnet, 20/20 separable at 750 rpm), and a per-machine 3σ gate detects genuine thermal drift within three minutes while a current-only monitor stays silent (S3)."),
  body("Next steps are, in order: benchmark the reasoning layer on a labelled episode set drawn from all three sources, reporting top-1 cause accuracy and number of tests used; extend S1 to the accelerated-lifetime bearings; replace the simulated node with an ESP32 and a low-cost accelerometer on a bench motor to measure the loop's real latency and false-alarm rate; and publish the converted datasets, indices and contracts so that the results here can be reproduced directly from the CSV files."),
  H1("Acknowledgment"),
  bodyNoIndent("The authors thank the Paderborn KAt Bearing DataCentre, the authors of Zenodo record 22039010, and CARTIF for releasing their recordings openly, and the Department of Electronics and Telecommunication, PCCoE, for hosting Abhiyantrix '26."),
];

const refs = [
  "[1] C. Lessmeier, J. K. Kimotho, D. Zimmer and W. Sextro, \"Condition monitoring of bearing damage in electromechanical drive systems by using motor current signals of electric motors: A benchmark data set for data-driven classification,\" in Proc. European Conf. of the PHM Society, Bilbao, Spain, 2016.",
  "[2] R. B. Randall and J. Antoni, \"Rolling element bearing diagnostics—A tutorial,\" Mechanical Systems and Signal Processing, vol. 25, no. 2, pp. 485–520, 2011.",
  "[3] Y. Lei, B. Yang, X. Jiang, F. Jia, N. Li and A. K. Nandi, \"Applications of machine learning to machine fault diagnosis: A review and roadmap,\" Mechanical Systems and Signal Processing, vol. 138, art. 106587, 2020.",
  "[4] R. Zhao, R. Yan, Z. Chen, K. Mao, P. Wang and R. X. Gao, \"Deep learning and its applications to machine health monitoring,\" Mechanical Systems and Signal Processing, vol. 115, pp. 213–237, 2019.",
  "[5] \"Multi-condition PMSM vibration fault dataset (CubeMars RI60),\" Zenodo record 22039010, doi:10.5281/zenodo.22039010.",
  "[6] CARTIF, \"Open DC motor dataset,\" Zenodo record 4314249, 2020, doi:10.5281/zenodo.4314249.",
  "[7] J. Wei et al., \"Chain-of-thought prompting elicits reasoning in large language models,\" in Advances in Neural Information Processing Systems 35 (NeurIPS), 2022.",
  "[8] OASIS, \"MQTT Version 5.0,\" OASIS Standard, Mar. 2019.",
  "[9] Espressif Systems, \"ESP32 Series Datasheet,\" v4.x, 2023.",
  "[10] Anthropic, \"Claude Developer Platform documentation: structured outputs and prompt caching,\" 2026. [Online]. Available: https://docs.anthropic.com",
  "[11] W. Zhang, D. Yang and H. Wang, \"Data-driven methods for predictive maintenance of industrial equipment: A survey,\" IEEE Systems Journal, vol. 13, no. 3, pp. 2213–2227, 2019.",
  "[12] T. Zonta, C. A. da Costa, R. da Rosa Righi, M. J. de Lima, E. S. da Trindade and G. P. Li, \"Predictive maintenance in the Industry 4.0: A systematic literature review,\" Computers & Industrial Engineering, vol. 150, art. 106889, 2020.",
].map(r => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 20, line: 220 }, indent: { left: 360, hanging: 360 }, children: [t(r, { size: 16 })] }));

const wideFigs = [
  ...figure("fig1_architecture.png", FULL_PX, "Fig. 2.  Pipeline. Telemetry flows left to right; the drift gate wakes the reasoning layer only on a sustained excursion; the reasoning layer may publish one bounded test command back to the edge node and stops after three tests, at p > 0.8, or when it reports the cause as unavailable."),
  ...figure("fig2_s1_speed_dependence.png", FULL_PX, "Fig. 3.  S1 outer-ring fault versus healthy bearing across the four operating points. (a) Vibration RMS, 20 recordings per bar with min–max whiskers: the fault is quieter than healthy at 900 rpm and 30% louder at 1500 rpm. (b) 1–5 kHz band power: 3.5–7× at 1500 rpm, no difference at 900 rpm."),
];

const page = { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } };
const sec = (children, cols, first = false, newPage = false) => ({
  properties: { page, type: first ? undefined : (newPage ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS), column: cols === 2 ? { count: 2, space: 360, equalWidth: true } : { count: 1 } },
  children,
});

const doc = new Document({
  creator: "Mehul Rawat", title: "From Alarm to Cause: Active Root-Cause Diagnosis for Motors",
  styles: { default: { document: { run: { font: FONT, size: 20 } } } },
  sections: [
    sec([title, authors, ...affil], 1, true),
    sec([...abstract, ...intro, ...datasets], 2),
    sec(datasetTable, 1),
    sec(wideFigs, 1, false, true),
    sec([...design, ...method, ...results, ...discussion, ...conclusion, H1("References"), ...refs], 2),
  ],
});

const out = path.join(__dirname, "Abhiyantrix26_Active_RCA_Paper.docx");
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log("wrote", out, buf.length, "bytes"); });
