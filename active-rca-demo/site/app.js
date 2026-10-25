/* Active-RCA condition monitor - talks to the broker directly over MQTT/WSS.
   ?replay  plays a recorded episode (data/demo-episodes.json) through the same handlers.
   ?inject  (or /inject/) opens the fallback Inject tab, for when the node's buttons are unavailable. */
(() => {
  "use strict";
  const qs = new URLSearchParams(location.search);
  const CFG = {
    site: qs.get("site") || window.ARCA.site,
    device: qs.get("device") || window.ARCA.device,
    broker: qs.get("broker") || window.ARCA.broker,
  };
  const ROOT = `pccoe/arca/${CFG.site}/${CFG.device}`;
  const REPLAY = qs.has("replay");
  const INJECT = qs.has("inject") || location.hash === "#inject";
  const MAXPTS = 150;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? "—" : Math.abs(v) >= 1000 ? Number(v).toFixed(0) : Number(Number(v).toPrecision(d)).toString());
  const pretty = (c) => String(c || "").replace(/_/g, " ");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const C = { ink: "#1d2733", mute: "#66768a", grid: "#e6eaee", ok: "#2e9e44", warn: "#e0a800", alarm: "#d2342b", test: "#1f6fd6", neutral: "#8fa0b2", sky: "#6b8fb3", sky2: "#a7bccf" };

  const NAMES = {
    healthy: "Healthy", unknown: "Unknown cause", bearing_outer_race: "Outer-race bearing defect", bearing_inner_race: "Inner-race bearing defect",
    bearing_rolling_element: "Rolling-element defect", bearing: "Bearing fault", eccentricity: "Rotor eccentricity", unbalance: "Unbalance",
    misalignment: "Misalignment", load_change: "Load change", sensor_mounting: "Sensor mounting", magnet_demagnetisation: "Magnet demagnetisation",
    stator_winding: "Stator winding fault", thermal_drift_wear: "Thermal drift / wear", bearing_or_brush_wear: "Bearing or brush wear",
    electrical_overload: "Electrical overload", cooling_failure: "Cooling failure",
  };
  const PART = {
    bearing_outer_race: "Drive-end bearing, outer race", bearing_inner_race: "Drive-end bearing, inner race",
    bearing_rolling_element: "Drive-end bearing, rolling elements", bearing: "Drive-end bearing", eccentricity: "Rotor, eccentric air gap",
    unbalance: "Rotor, unbalanced mass", magnet_demagnetisation: "Rotor magnets", stator_winding: "Stator winding",
    electrical_overload: "Stator winding, overload", thermal_drift_wear: "Frame, running hot", cooling_failure: "Fan and frame, cooling",
    sensor_mounting: "Accelerometer mount", misalignment: "Shaft and coupling", load_change: "Coupling, load side",
    bearing_or_brush_wear: "Brushes and rear bearing",
  };
  const causeName = (c) => NAMES[c] || pretty(c);
  const sevClass = (s) => (s === "alarm" ? "alarm" : s === "info" ? "ok" : "watch");
  const level = (z) => (z == null || Number.isNaN(z) ? "na" : Math.abs(z) > 6 ? "alarm" : Math.abs(z) > 3 ? "warn" : "ok");
  const LEVEL_TEXT = { ok: "Healthy", warn: "Warning", alarm: "Alarm", na: "n/a", test: "Test" };
  const clockTime = (d = new Date()) => d.toLocaleTimeString("en-GB");

  $("devName").textContent = CFG.device;
  $("topicRoot").textContent = REPLAY ? " · recorded replay" : ` · ${ROOT}`;
  const tick = () => ($("clock").textContent = clockTime());
  tick(); setInterval(tick, 1000);

  let MAN = null;
  let scn = null, curSrc = null, curOp = null, gateState = null, markNext = null, lastEp = null, nodeSeen = 0, lastTel = null;
  const testPhase = new Map();

  // ------------------------------------------------------------------ tabs (+ ?inject fallback)
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
    if (name !== "inject") requestAnimationFrame(() => charts.forEach((c) => { c.resize(); c.update("none"); }));
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  if (INJECT) { $("injectTab").hidden = false; showTab("inject"); }

  // ------------------------------------------------------------------ 3D motor
  let motor = null;
  const mstate = { src: null, rpm: 0, state: "monitor", test: null, diag: null, level: 0, load: 0 };
  function setMotor(patch) {
    Object.assign(mstate, patch);
    if (motor) motor.update(mstate);
    const mt = $("motorTest");
    mt.hidden = !mstate.test;
    if (mstate.test) mt.textContent = `AI TEST · ${Math.round(mstate.test.rpm)} rpm`;
  }
  import("./motor3d.js")
    .then((m) => { motor = m.createMotor($("motor")); motor.update(mstate); })
    .catch((e) => { console.warn("3D view unavailable:", e && e.message); $("motor").classList.add("no3d"); });

  // ------------------------------------------------------------------ round gauges (SVG)
  const GA = 120;                                    // sweep runs from -GA to +GA degrees around 12 o'clock
  const pt = (a, r) => [100 + r * Math.sin((a * Math.PI) / 180), 100 - r * Math.cos((a * Math.PI) / 180)];
  const arc = (a0, a1, r) => {
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const tickLabel = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toPrecision(2))));
  function makeGauge(id, label) {
    const el = $(id);
    el.innerHTML = `<svg viewBox="0 0 200 154" role="img" aria-label="${esc(label)}"><circle class="face" cx="100" cy="100" r="92"/>
      <path class="track" d="${arc(-GA, GA, 78)}"/><g class="zones"></g><g class="ticks"></g>
      <line class="needle" x1="100" y1="100" x2="100" y2="34"/><circle class="hub" cx="100" cy="100" r="6"/>
      <text class="val" x="100" y="130">—</text><text class="un" x="100" y="147"></text></svg><figcaption>${esc(label)}</figcaption>`;
    const svg = el.querySelector("svg"), needle = svg.querySelector(".needle"), val = svg.querySelector(".val"), un = svg.querySelector(".un");
    let key = "", ang = null;
    return {
      set({ min = 0, max = 1, zones = [], value = null, text, unit = "", na = false }) {
        el.classList.toggle("na", na);
        if (na) { val.textContent = "no sensor"; un.textContent = "on this machine"; return; }
        const k = `${min}|${max}|${zones.map((z) => `${z.from.toFixed(3)}-${z.to.toFixed(3)}${z.c}`).join()}`;
        if (k !== key) {
          key = k;
          ang = (v) => -GA + (2 * GA * (Math.min(max, Math.max(min, v)) - min)) / (max - min || 1);
          svg.querySelector(".zones").innerHTML = zones.filter((z) => z.to > z.from).map((z) => `<path class="zone" stroke="${z.c}" d="${arc(ang(z.from), ang(z.to), 78)}"/>`).join("");
          let t = "";
          for (let i = 0; i <= 5; i++) {
            const v = min + ((max - min) * i) / 5, a = ang(v);
            const [x0, y0] = pt(a, 68), [x1, y1] = pt(a, 86), [xl, yl] = pt(a, 55);
            t += `<line class="tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/><text class="tl" x="${xl.toFixed(1)}" y="${(yl + 3).toFixed(1)}">${tickLabel(v)}</text>`;
          }
          svg.querySelector(".ticks").innerHTML = t;
        }
        needle.style.transform = `rotate(${value == null ? -GA : ang(value)}deg)`;
        val.textContent = text ?? fmt(value);
        un.textContent = unit;
      },
    };
  }
  const gSpeed = makeGauge("gSpeed", "Shaft speed"), gVib = makeGauge("gVib", "Vibration"), gTemp = makeGauge("gTemp", "Temperature"), gCur = makeGauge("gCur", "Phase current");
  [gSpeed, gVib, gTemp, gCur].forEach((g) => g.set({ value: null, text: "—" }));
  // green inside the healthy μ±3σ band, amber out to 6σ, red beyond - same thresholds as the drift gate
  function bandZones(mu, sd, min, max) {
    const z = [], lo = Math.max(min, mu - 3 * sd), hi = Math.min(max, mu + 3 * sd), hi6 = Math.min(max, mu + 6 * sd), lo6 = Math.max(min, mu - 6 * sd);
    if (lo6 > min) z.push({ from: min, to: lo6, c: C.alarm });
    if (lo > lo6) z.push({ from: lo6, to: lo, c: C.warn });
    z.push({ from: lo, to: hi, c: C.ok });
    if (hi6 > hi) z.push({ from: hi, to: hi6, c: C.warn });
    if (max > hi6) z.push({ from: hi6, to: max, c: C.alarm });
    return z;
  }
  const nice = (v) => Number(v.toPrecision(2));
  function maxRpm(src) { const o = MAN?.sources?.[src]?.ops || {}; return Math.max(1000, ...Object.values(o).map((x) => x.rpm || 0)) * 1.15; }

  // ------------------------------------------------------------------ charts
  Chart.defaults.color = C.mute;
  Chart.defaults.font.family = "'IBM Plex Sans', 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11.5;
  const grid = { color: C.grid };
  const tooltip = { backgroundColor: "#1c2633", titleFont: { weight: 600 }, padding: 8, cornerRadius: 3 };
  // test windows shaded blue, event marks as dashed lines ("DRIFT CAUGHT", "NEW CONDITION")
  Chart.register({
    id: "zones",
    beforeDatasetsDraw(c) {
      const meta = c.$meta;
      if (!meta || !meta.length || !c.chartArea) return;
      const { ctx, chartArea: a, scales: { x } } = c;
      const step = meta.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 10;
      ctx.save();
      for (let i = 0; i < meta.length;) {
        if (!meta[i]?.test) { i++; continue; }
        let j = i;
        while (j + 1 < meta.length && meta[j + 1]?.test) j++;
        const x0 = Math.max(a.left, x.getPixelForValue(i) - step / 2), x1 = Math.min(a.right, x.getPixelForValue(j) + step / 2);
        ctx.fillStyle = "rgba(31,111,214,.09)";
        ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
        ctx.fillStyle = C.test;
        ctx.fillRect(x0, a.top, x1 - x0, 2);
        if (x1 - x0 > 90) { ctx.font = "600 11px 'IBM Plex Sans'"; ctx.fillText(`AI TEST ${meta[i].test}`, x0 + 5, a.top + 14); }
        i = j + 1;
      }
      meta.forEach((m, k) => {
        if (!m?.mark) return;
        const px = Math.max(a.left + 1, x.getPixelForValue(k));
        ctx.strokeStyle = m.mark.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
        if (c.width > 380) {
          ctx.fillStyle = m.mark.color; ctx.font = "600 11px 'IBM Plex Sans'";
          const w = ctx.measureText(m.mark.text).width;
          ctx.fillText(m.mark.text, px + 5 + w > a.right ? px - 5 - w : px + 5, a.top + 14 + (m.mark.row || 0) * 13);
        }
      });
      ctx.restore();
    },
  });
  const isTestSeg = (s) => !!s.chart.$meta?.[s.p1DataIndex]?.test;
  function lineChart(id, sets) {
    const c = new Chart($(id), {
      type: "line",
      data: { labels: [], datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, spanGaps: true,
        // new points slide in along x only, so the trace scrolls rather than morphing
        animation: reduceMotion ? false : { duration: 650, easing: "easeOutQuart" },
        animations: { y: { duration: 0 }, colors: false, numbers: { properties: ["x"] } },
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => `window #${it[0]?.label}`, label: (k) => (k.raw == null ? null : `${k.dataset.label}: ${fmt(k.raw, 4)}`) } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback(v) { return "#" + this.getLabelForValue(v); } } }, y: { grid, ticks: { maxTicksLimit: 6 } } },
        elements: { point: { radius: 0, hoverRadius: 3 }, line: { borderWidth: 1.8, tension: 0.25 } },
      },
    });
    c.$meta = [];
    return c;
  }
  const bandSets = (label) => [
    { label: "healthy +3σ", data: [], borderColor: "rgba(46,158,68,.5)", borderWidth: 1, backgroundColor: "rgba(46,158,68,.11)", fill: "+1", pointRadius: 0 },
    { label: "healthy −3σ", data: [], borderColor: "rgba(46,158,68,.5)", borderWidth: 1, fill: false, pointRadius: 0 },
    { label, data: [], borderColor: C.ink, borderWidth: 2, fill: false, segment: { borderColor: (s) => (isTestSeg(s) ? C.test : undefined) } },
  ];
  const cRms = lineChart("cRms", bandSets("rms"));
  const cRms2 = lineChart("cRms2", bandSets("rms"));
  const cHf = lineChart("cHf", bandSets("band"));
  const cAux = lineChart("cAux", [
    { label: "a", data: [], borderColor: C.ink, fill: false },
    { label: "b", data: [], borderColor: C.sky, fill: false },
    { label: "c", data: [], borderColor: C.sky2, fill: false },
  ]);
  // current gets its own right-hand axis next to temperature (A vs °C)
  cAux.options.scales.y1 = { position: "right", display: false, grid: { display: false }, ticks: { maxTicksLimit: 6, color: C.sky } };
  const lines = [cRms, cRms2, cHf, cAux];
  const cDev = new Chart($("cDev"), {
    type: "bar",
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 2, barPercentage: 0.78, categoryPercentage: 0.9 }] },
    options: {
      indexAxis: "y", animation: reduceMotion ? false : { duration: 400 }, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (k) => `|z| ${Number(k.raw).toFixed(1)}` } } },
      scales: {
        x: { grid, beginAtZero: true, suggestedMax: 8, ticks: { stepSize: 3 }, title: { display: true, text: "|z|  ·  3 warning  ·  6 alarm", font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { autoSkip: false, font: { family: "'IBM Plex Mono', monospace", size: 11 } } },
      },
    },
  });
  const cBands = new Chart($("cBands"), {
    type: "bar",
    data: { labels: ["0–50 Hz", "50–200 Hz", "200–800 Hz", "0.8–2.5 kHz", "1–5 kHz"], datasets: [{ data: [], backgroundColor: C.sky, borderRadius: 2 }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip }, scales: { y: { type: "logarithmic", grid }, x: { grid: { display: false } } } },
  });
  const charts = [...lines, cDev, cBands];

  function clearCharts() { for (const c of lines) { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); c.$meta = []; c.update("none"); } }
  function push(c, seq, vals, meta) {
    c.data.labels.push(seq);
    c.data.datasets.forEach((d, i) => d.data.push(vals[i] ?? null));
    c.$meta.push(meta);
    if (c.data.labels.length > MAXPTS) { c.data.labels.shift(); c.data.datasets.forEach((d) => d.data.shift()); c.$meta.shift(); }
  }
  function setAt(c, seq, i, v) { const k = c.data.labels.indexOf(seq); if (k >= 0) c.data.datasets[i].data[k] = v; }
  function markAt(seq, mark) { for (const c of lines) { const k = c.data.labels.indexOf(seq); if (k >= 0) c.$meta[k] = { ...(c.$meta[k] || {}), mark }; c.update("none"); } }

  // ------------------------------------------------------------------ manifest + the fallback inject form
  fetch("data/manifest.json").then((r) => r.json()).then((m) => { MAN = m; fillSrc(); }).catch(() => hint("data/manifest.json could not be loaded.", "err"));
  const srcInfo = (src) => MAN?.sources?.[src];
  const opDesc = (src, op) => srcInfo(src)?.ops?.[op]?.desc || op;
  const rpmOf = (src, op) => srcInfo(src)?.ops?.[op]?.rpm;
  let touched = false, synced = false;
  function fillSrc() {
    const s = $("selSrc");
    s.innerHTML = Object.entries(MAN.sources).map(([k, v]) => `<option value="${k}">${k} · ${esc(v.name)}</option>`).join("");
    s.onchange = () => { touched = true; fillCondOp(); };
    fillCondOp();
  }
  function fillCondOp() {
    const src = MAN.sources[$("selSrc").value];
    $("machineDesc").textContent = `${src.motor}. Sensors: ${src.sensors}.`;
    $("selCond").innerHTML = Object.entries(src.conds).map(([k, v]) => `<option value="${k}">${k} · ${esc(v)}</option>`).join("");
    const healthy = Object.keys(src.truth || {}).find((c) => src.truth[c] === "healthy");
    $("selCond").onchange = (e) => {
      if (e) touched = true;
      const cond = $("selCond").value;
      $("selOp").innerHTML = Object.entries(src.ops).map(([k, v]) => {
        const has = src.files[`${cond}_${k}`], scored = !healthy || src.files[`${healthy}_${k}`];
        return `<option value="${k}" ${has ? "" : "disabled"}>${esc(v.desc)}${has ? (scored ? "" : " (no baseline - manual diagnose)") : " (no recording)"}</option>`;
      }).join("");
      $("selOp").value = src.files[`${cond}_${src.default_op}`] ? src.default_op : Object.keys(src.ops).find((k) => src.files[`${cond}_${k}`]);
    };
    $("selOp").onchange = () => (touched = true);
    $("selCond").onchange();
  }
  // the form follows whatever the node is running until the operator changes it
  function syncControls(t) {
    if (synced || touched || !MAN || !srcInfo(t.src)) return;
    synced = true;
    $("selSrc").value = t.src; fillCondOp();
    $("selCond").value = t.label; $("selCond").onchange();
    if (srcInfo(t.src).ops?.[t.op]) $("selOp").value = t.op;
  }
  function hint(t, cls = "") { const h = $("cmdHint"); h.textContent = t; h.className = "hint " + cls; }
  let client = null, deployTimer = 0;
  function send(leaf, obj) {
    if (!client) { hint("Controls are off while a recording plays.", "err"); return false; }
    client.publish(`${ROOT}/${leaf}`, JSON.stringify(obj), { qos: 1 });
    return true;
  }
  function deployDone() { clearTimeout(deployTimer); $("btnDeploy").disabled = false; }
  $("btnDeploy").onclick = () => {
    const cmd = { v: 1, cmd: "scenario", id: "ui-" + Date.now().toString(36), src: $("selSrc").value, cond: $("selCond").value, op: $("selOp").value };
    if (!send("cmd", cmd)) return;
    hint(`Sent ${cmd.src} ${cmd.cond} at ${opDesc(cmd.src, cmd.op)}. Waiting for the node…`);
    $("btnDeploy").disabled = true;
    deployTimer = setTimeout(() => { deployDone(); hint("No reply from the node in 20 s. Is it online?", "err"); }, 20000);
  };
  $("btnDiagnose").onclick = () => { if (send("ctl", { cmd: "diagnose" })) hint("Diagnosis requested."); };
  $("btnReset").onclick = () => { if (send("ctl", { cmd: "reset" })) hint("Reset requested."); };
  if (REPLAY) [$("btnDeploy"), $("btnDiagnose"), $("btnReset")].forEach((b) => (b.disabled = true));

  // ------------------------------------------------------------------ links + transport
  const link = (id, state, text) => { const c = $(id); c.className = "link " + (state === true ? "on" : state === false ? "off" : state); c.lastElementChild.textContent = text; };
  let gotTel = false;
  const empty = (text) => { const e = $("emptyMsg"); e.textContent = text; e.hidden = !text; };
  function dispatch(leaf, m) {
    if (leaf === "telemetry") onTel(m);
    else if (leaf === "gate") onGate(m);
    else if (leaf === "rca") onRca(m);
    else if (leaf === "status") onStatus(m);
    else if (leaf === "alert") onAlert(m);
    else if (leaf === "bridge") link("chipBridge", !!m.online, m.online ? "AI · " + String(m.engine || "").replace("claude-subscription:", "Claude ").replace(" (recorded)", "") : "AI offline");
  }

  function startLive() {
    client = mqtt.connect(CFG.broker, { clientId: "arca-ui-" + Math.random().toString(16).slice(2, 8), clean: true, reconnectPeriod: 2000, connectTimeout: 45000, keepalive: 30 });
    let connected = false, connectStart = Date.now(), connectedAt = 0;
    const arrivals = [];
    client.on("connect", () => { connected = true; connectedAt = Date.now(); link("chipBroker", true, "Broker"); client.subscribe(`${ROOT}/#`, { qos: 0 }); if (!gotTel) empty("Waiting for the node…"); });
    client.on("reconnect", () => (connectStart = Date.now()));
    client.on("close", () => { if (connected) link("chipBroker", false, "Broker"); connected = false; });
    client.on("message", (topic, buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      const leaf = topic.slice(ROOT.length + 1);
      if (leaf === "telemetry") { arrivals.push(Date.now()); if (arrivals.length > 20) arrivals.shift(); }
      dispatch(leaf, m);
    });
    setInterval(() => {
      if (!connected) {
        const s = Math.round((Date.now() - connectStart) / 1000);
        link("chipBroker", "wait", `Broker ${s}s`);
        if (!gotTel) empty(`Connecting to the broker… ${s} s`);
        return;
      }
      if (!gotTel && Date.now() - connectedAt > 20000) empty("No data yet. Is the node powered and on Wi-Fi?");
      // silent for much longer than its usual cadence: say so instead of showing a frozen plot as live
      const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]).sort((a, b) => a - b);
      const limit = Math.min(90000, Math.max(25000, 4 * (gaps[gaps.length >> 1] || 2000)));
      if (nodeSeen && Date.now() - nodeSeen > limit) {
        const s = Math.round((Date.now() - nodeSeen) / 1000);
        link("chipNode", "wait", `Node silent ${s}s`);
        empty(`No data from the node for ${s} s. Check its power and Wi-Fi.`);
      }
    }, 1000);
  }

  function startReplay() {
    $("replayBox").hidden = false;
    const ml = $("modeLink"); ml.textContent = "Back to live"; ml.href = "./";
    link("chipBroker", true, "Recorded");
    empty("Loading the recording…");
    const R = { eps: [], ep: null, i: 0, t: 0, speed: 1, playing: false, last: 0 };
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const ui = () => {
      const d = R.ep ? R.ep.duration_s : 0;
      $("repPlay").textContent = R.playing ? "Pause" : R.ep && R.i >= R.ep.items.length ? "Play again" : "Play";
      $("repTime").textContent = R.ep ? `${mmss(Math.min(R.t, d))} / ${mmss(d)}` : "";
    };
    const play = (k) => { resetView(); R.ep = R.eps[k]; R.i = 0; R.t = 0; R.playing = true; R.last = performance.now(); ui(); };
    fetch("data/demo-episodes.json").then((r) => r.json()).then((D) => {
      R.eps = D.episodes;
      const sel = $("repEp");
      sel.innerHTML = R.eps.map((e, i) => `<option value="${i}">${esc(e.src)} · ${esc(e.title.split(" - ").pop())}</option>`).join("");
      const want = R.eps.findIndex((e) => e.src === qs.get("replay"));
      sel.value = String(want >= 0 ? want : 0);
      sel.onchange = () => play(+sel.value);
      play(+sel.value);
    }).catch(() => empty("data/demo-episodes.json could not be loaded."));
    $("repPlay").onclick = () => { if (!R.ep) return; if (R.i >= R.ep.items.length) return play(R.eps.indexOf(R.ep)); R.playing = !R.playing; R.last = performance.now(); ui(); };
    $("repRestart").onclick = () => R.ep && play(R.eps.indexOf(R.ep));
    document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { R.speed = +b.dataset.speed; document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); }));
    setInterval(() => {
      const now = performance.now();
      if (R.playing && R.ep) {
        R.t += (Math.min(now - R.last, 500) / 1000) * R.speed;   // a throttled background tab pauses, not jumps
        const it = R.ep.items;
        while (R.i < it.length && it[R.i].t <= R.t) { dispatch(it[R.i].topic, it[R.i].msg); R.i++; }
        if (R.i >= it.length) R.playing = false;
        ui();
      }
      R.last = now;
    }, 100);
  }

  function resetView() {
    clearCharts();
    scn = null; curSrc = null; curOp = null; gateState = null; markNext = null; gotTel = false; lastTel = null;
    testPhase.clear();
    hist.length = 0;
    $("histRows").innerHTML = `<tr><td colspan="10" class="idle">No episodes yet.</td></tr>`;
    $("evCount").hidden = true;
    $("feed").innerHTML = `<p class="idle">Appears when a diagnosis starts.</p>`;
    clearEpisode();
    setMotor({ test: null, state: "monitor", level: 0 });
  }

  // ------------------------------------------------------------------ telemetry
  function onTel(t) {
    nodeSeen = Date.now();
    if (!gotTel || !$("emptyMsg").hidden) { gotTel = true; empty(""); }
    if (!t.test) syncControls(t);
    link("chipNode", true, `Node · ${t.fw || ""}`);
    // only a different machine gets a fresh plot; a new condition on the same motor continues the trace
    if (curSrc !== null && t.src !== curSrc) clearCharts();
    curSrc = t.src;
    if (!t.test) curOp = t.op;
    if (scn !== null && t.scn !== scn) { markNext = { color: C.mute, text: "NEW CONDITION", row: 0 }; clearEpisode(); }
    scn = t.scn;
    if (t.test) { testPhase.set(t.seq, t.test); if (testPhase.size > 80) testPhase.delete(testPhase.keys().next().value); }
    lastTel = t;
    const s = srcInfo(t.src);
    const rpm = rpmOf(t.src, t.op) || Math.round(t.rpm.avg);
    const hasHf = t.spec.bhf != null;
    const meta = { test: t.test ? `${t.test.id} · ${rpm} rpm` : null };
    if (markNext) { meta.mark = markNext; markNext = null; }
    push(cRms, t.seq, [null, null, t.vib.rms_ms2], meta);
    push(cRms2, t.seq, [null, null, t.vib.rms_ms2], meta);
    push(cHf, t.seq, [null, null, hasHf ? t.spec.bhf : t.spec.b3], { test: meta.test });
    $("hfTitle").textContent = hasHf ? "Bearing band 1–5 kHz" : "Band 0.8–2.5 kHz";
    if (t.temp.valid || t.cur.valid) {
      push(cAux, t.seq, [t.temp.valid ? t.temp.c : null, t.cur.valid ? t.cur.rms_a : null, null], { test: meta.test });
      cAux.data.datasets[0].label = "temp °C"; cAux.data.datasets[1].label = "current A";
      cAux.data.datasets[1].yAxisID = "y1"; cAux.options.scales.y1.display = !!t.cur.valid;
      $("auxTitle").textContent = "Temperature °C · current A";
    } else {
      push(cAux, t.seq, [t.vib.x_rms, t.vib.y_rms, t.vib.z_rms], { test: meta.test });
      ["x", "y", "z"].forEach((a, i) => (cAux.data.datasets[i].label = a + " rms"));
      cAux.data.datasets[1].yAxisID = "y"; cAux.options.scales.y1.display = false;
      $("auxTitle").textContent = "Vibration per axis (x · y · z rms)";
    }
    lines.forEach((c) => c.update(c.canvas.offsetParent ? undefined : "none"));   // charts on a hidden tab skip the slide-in
    cBands.data.datasets[0].data = [t.spec.b0, t.spec.b1, t.spec.b2, t.spec.b3, hasHf ? t.spec.bhf : null];
    cBands.update("none");

    $("rmsUnit").textContent = `rms ${t.vib.cal_ok ? "m/s²" : "units"}`;
    $("topOp").textContent = `${t.src} · ${rpm} rpm${t.test ? " · AI test" : ""}`;
    $("assetSrc").textContent = s ? `${t.src} · ${s.name}` : t.src;
    $("aMachine").textContent = s?.motor || t.src;
    $("aOp").textContent = `${opDesc(t.src, t.op)}${t.test ? " (AI test)" : ""}`;
    $("aSensors").textContent = s?.sensors || "—";
    $("kvCond").innerHTML = `<b>${esc(t.label)}</b> ${esc(s?.conds?.[t.label] || "")}`;
    $("kvFw").textContent = t.fw || "—";
    if (t.net?.rssi != null) $("kvRssi").textContent = `${t.net.rssi} dBm`;
    if (t.uptime_s != null) $("kvUp").textContent = upText(t.uptime_s);
    $("kvWin").textContent = `#${t.seq} · ${t.win.sample_hz / 1000} kHz`;
    $("kvReplay").textContent = t.replay ? (t.replay.file || "").split("/").pop().replace(/\.bin$/, "") : "—";
    document.querySelectorAll("#assetTree .src").forEach((li) => li.classList.toggle("active", li.dataset.src === t.src));
    const top = nice(maxRpm(t.src));
    gSpeed.set({ min: 0, max: top, zones: [{ from: 0, to: top, c: t.test ? C.test : C.neutral }], value: t.rpm.avg, text: String(Math.round(t.rpm.avg)), unit: t.test ? "rpm · AI test" : "rpm" });
    setMotor({ src: t.src, rpm: t.rpm.avg, test: t.test ? { rpm: t.rpm.avg } : null });
  }
  const upText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min ${s % 60} s`);

  // ------------------------------------------------------------------ gate: health bars, gauges, conditions, deviation
  const STATE_TEXT = { monitor: "MONITORING", diagnosing: "DIAGNOSING", testing: "AI TEST RUNNING", latched: "ALARM LATCHED" };
  const maxAbs = (...v) => { const f = v.filter((x) => x != null); return f.length ? f.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m)) : null; };
  const HEALTH = [
    { name: "Vibration level", get: (z) => z.rms },
    { name: "Bearing band", get: (z) => z.bhf ?? z.b3 },
    { name: "Impacts", get: (z) => maxAbs(z.kurt, z.crest) },
    { name: "Low frequency", get: (z) => maxAbs(z.b0, z.b1) },
    { name: "Mid band", get: (z) => z.b2 },
    { name: "Motor current", get: (z) => z.cur_rms },
    { name: "Temperature", get: (z) => z.temp },
  ];
  // bar length: each third of the track is one zone (0-3σ healthy, 3-6σ warning, 6σ+ alarm)
  const zw = (z) => { const a = Math.abs(z); return a <= 3 ? (a / 3) * 33.3 : a <= 6 ? 33.3 + ((a - 3) / 3) * 33.3 : Math.min(100, 66.6 + ((a - 6) / 6) * 33.4); };
  const TAGS = [
    { k: "rms", tag: "VIB.RMS", d: "Vibration RMS", v: (t) => t.vib.rms_ms2, mu: "rms" },
    { k: "crest", tag: "VIB.CREST", d: "Crest factor", v: (t) => t.vib.crest },
    { k: "kurt", tag: "VIB.KURT", d: "Kurtosis", v: (t) => t.spec.kurt },
    { k: "b0", tag: "SPEC.B0", d: "Band 0–50 Hz", v: (t) => t.spec.b0 },
    { k: "b1", tag: "SPEC.B1", d: "Band 50–200 Hz", v: (t) => t.spec.b1 },
    { k: "b2", tag: "SPEC.B2", d: "Band 200–800 Hz", v: (t) => t.spec.b2 },
    { k: "b3", tag: "SPEC.B3", d: "Band 0.8–2.5 kHz", v: (t) => t.spec.b3, mu: "b3" },
    { k: "bhf", tag: "SPEC.BHF", d: "Bearing band 1–5 kHz", v: (t) => t.spec.bhf, mu: "bhf" },
    { k: "cur_rms", tag: "CUR.RMS", d: "Phase current (A)", v: (t) => (t.cur.valid ? t.cur.rms_a : null), mu: "cur_rms" },
    { k: "temp", tag: "TEMP", d: "Motor temperature (°C)", v: (t) => (t.temp.valid ? t.temp.c : null), mu: "temp" },
    { k: null, tag: "SPEED", d: "Shaft speed (rpm)", v: (t) => t.rpm.avg },
  ];
  const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);

  function onGate(g) {
    const b = g.base || {}, z = g.z || {}, f = g.feats || {};
    const band = (k) => (b[k] ? [b[k][0] + 3 * b[k][1], Math.max(0, b[k][0] - 3 * b[k][1])] : [null, null]);
    const [ru, rl] = band("rms");
    for (const c of [cRms, cRms2]) { setAt(c, g.seq, 0, ru); setAt(c, g.seq, 1, rl); c.update("none"); }
    const [hu, hl] = band(b.bhf ? "bhf" : "b3");
    setAt(cHf, g.seq, 0, hu); setAt(cHf, g.seq, 1, hl); cHf.update("none");

    if (g.state !== "monitor" && gateState === "monitor" && g.episode) markAt(g.seq, { color: C.alarm, text: `DRIFT CAUGHT · ${g.episode}`, row: 1 });
    gateState = g.state;
    const st = $("statePill"); st.textContent = STATE_TEXT[g.state] || String(g.state).toUpperCase(); st.className = "state " + g.state;
    const dotCls = g.state === "latched" ? "alarm" : g.state === "testing" ? "test" : g.state === "diagnosing" ? "warn" : "ok";
    $("treeDot").className = "dot " + dotCls;
    document.querySelectorAll("#assetTree .src").forEach((li) => (li.querySelector(".dot").className = "dot" + (li.classList.contains("active") ? " " + dotCls : "")));
    $("streak").textContent = g.test ? `AI test window · ${g.test}` : g.state === "monitor" ? `gate streak ${Math.min(3, g.streak || 0)} / 3` : `episode ${g.episode || ""}`;

    $("healthRows").innerHTML = HEALTH.map((h) => {
      const v = h.get(z);
      if (v == null) return `<div class="hrow na"><span class="hn">${h.name}</span><div class="seg3"><i></i><i></i><i></i></div><span class="zv">n/a</span></div>`;
      const lv = g.test ? "test" : level(v);
      return `<div class="hrow" title="${h.name}: ${LEVEL_TEXT[level(v)]}"><span class="hn">${h.name}</span><div class="seg3"><i></i><i></i><i></i><span class="fill ${lv}" style="width:${Math.max(2, zw(v)).toFixed(1)}%"></span></div><span class="zv">${sgn(v)}</span></div>`;
    }).join("");

    // gauges scaled around the healthy baseline at the current speed
    const vibUnit = lastTel?.vib?.cal_ok === false ? "rms units" : "m/s² rms";
    if (b.rms && f.rms != null) {
      const [mu, sd] = b.rms, max = nice(Math.max(mu + 9 * sd, f.rms * 1.15, mu * 1.6));
      gVib.set({ min: 0, max, zones: bandZones(mu, sd, 0, max), value: f.rms, text: fmt(f.rms), unit: vibUnit });
    } else if (f.rms != null) gVib.set({ min: 0, max: nice(f.rms * 2), value: f.rms, text: fmt(f.rms), unit: `${vibUnit} · no baseline` });
    if (f.temp != null && b.temp) {
      const [mu, sd] = b.temp, lo = Math.floor(mu - 15), hi = Math.ceil(Math.max(mu + 25, f.temp + 3));
      gTemp.set({ min: lo, max: hi, zones: bandZones(mu, sd, lo, hi), value: f.temp, text: f.temp.toFixed(1), unit: "°C" });
    } else gTemp.set({ na: true });
    if (f.cur_rms != null && b.cur_rms) {
      const [mu, sd] = b.cur_rms, hi = nice(Math.max(mu * 2, f.cur_rms * 1.2));
      gCur.set({ min: 0, max: hi, zones: bandZones(mu, sd, 0, hi), value: f.cur_rms, text: fmt(f.cur_rms), unit: "A rms" });
      setMotor({ load: Math.min(1, f.cur_rms / (2 * mu)) });
    } else gCur.set({ na: true });
    $("gaugeMeta").textContent = `window #${g.seq}${g.test ? " · AI test" : ""}`;

    const t = lastTel;
    if (t) {
      $("condRows").innerHTML = TAGS.map((r) => {
        const val = r.v(t), zz = r.k ? z[r.k] : null, mu = r.mu && b[r.mu] ? b[r.mu][0] : null;
        if (val == null && zz == null) return "";
        const lv = r.k == null ? "na" : g.test && zz != null ? "test" : level(zz);
        const chip = `<span class="chip ${lv}">${r.k == null ? "info" : LEVEL_TEXT[lv]}</span>`;
        return `<tr><td class="tagc">${esc(CFG.device)}.${r.tag}</td><td>${r.d}</td><td class="n">${fmt(val, 4)}</td><td class="n">${fmt(mu, 4)}</td><td class="n">${zz == null ? "—" : sgn(zz)}</td><td>${chip}</td></tr>`;
      }).join("");
      $("condMeta").textContent = `${clockTime()} · window #${g.seq}`;
    }

    const ent = Object.entries(z).filter(([, v]) => v != null).map(([k, v]) => [k, Math.abs(v)]).sort((a, c) => c[1] - a[1]);
    cDev.data.labels = ent.map((e) => e[0]);
    cDev.data.datasets[0].data = ent.map((e) => +e[1].toFixed(2));
    cDev.data.datasets[0].backgroundColor = ent.map((e) => (g.test ? C.test : e[1] > 6 ? C.alarm : e[1] > 3 ? C.warn : C.ok));
    cDev.update();

    if (g.test) onTestWindow(g, b.bhf ? "bhf" : "b3");
    let zmax = 0;
    for (const v of Object.values(z)) if (v != null) zmax = Math.max(zmax, Math.abs(v));
    setMotor({ state: g.state, level: Math.min(1, zmax / 10) });
  }

  // test observations as ratios against the healthy baseline at the test speed
  function onTestWindow(g, hfKey) {
    const E = epRec(g.episode || lastEp);
    if (!E) return;
    const T = E.tests[g.test] || (E.tests[g.test] = { id: g.test, op: g.op, hold_s: null, n: 0, sum: {}, done: false });
    T.op = g.op;
    const tag = testPhase.get(g.seq), b = g.base || {}, f = g.feats || {};
    if (!tag || tag.phase === "run") {
      T.n++;
      for (const [k, key] of [["hf", hfKey], ["rms", "rms"]]) if (b[key] && f[key] != null && b[key][0]) T.sum[k] = (T.sum[k] || 0) + f[key] / b[key][0];
      T.hfKey = hfKey;
    }
    renderTestBar(E, T);
  }
  function renderTestBar(E, T) {
    const total = T.hold_s ? Math.round(T.hold_s / 2) : 10;
    const rpm = rpmOf(E.src, T.op);
    const avg = (k) => (T.n && T.sum[k] ? (T.sum[k] / T.n).toFixed(2) : null);
    const bar = $("testBar");
    bar.hidden = false;
    bar.innerHTML = `<div><b>AI-ordered test ${esc(T.id)}</b> · ${rpm ? `${rpm} rpm` : esc(T.op)}${T.hold_s ? ` for ${T.hold_s} s` : ""} · ${T.done ? "done" : T.n ? `window ${Math.min(T.n, total)} of ${total}` : "settling"}${avg("rms") ? ` · rms ×${avg("rms")}` : ""}${avg("hf") ? ` · ${T.hfKey === "bhf" ? "bearing band" : "b3"} ×${avg("hf")}` : ""}</div>
      <div class="tprog"><i style="width:${T.done ? 100 : Math.min(100, (T.n / total) * 100)}%"></i></div>`;
  }

  function onStatus(s) {
    if (s.online === false) { link("chipNode", false, "Node offline"); return; }
    nodeSeen = Date.now();
    if (s.ack && s.ack.id && s.ack.id.startsWith("ui-")) { deployDone(); hint(`${s.ack.ok ? "Node accepted" : "Node rejected"}: ${s.ack.msg}`, s.ack.ok ? "ok" : "err"); }
    if (s.ack?.id) $("kvAck").textContent = `${s.ack.id} · ${s.ack.ok ? "ok" : "rejected"}`;
    if (s.rssi != null) $("kvRssi").textContent = `${s.rssi} dBm`;
    if (s.uptime_s != null) $("kvUp").textContent = upText(s.uptime_s);
    if (s.fw) $("kvFw").textContent = s.fw;
  }

  // retained summary of the last episode - keeps the verdict on screen after a page refresh
  function onAlert(a) {
    if (!a) return;
    if (a.state === "monitor" && !a.cause) { if (lastEp || mstate.diag) clearEpisode(); return; }
    if (lastEp || !a.cause) return;
    const final = a.state === "done", sev = sevClass(a.severity);
    setMotor({ diag: { cause: a.cause, p: a.p || 0, severity: a.severity, final, label: PART[a.cause] || causeName(a.cause) } });
    $("verdict").innerHTML = `<div class="vrow"><div class="vbig">${Math.round((a.p || 0) * 100)}<small>%</small></div><div class="vmain">
      <div class="vcause">${esc(causeName(a.cause))}</div><div class="vsub"><span class="sevb ${sev}">${esc(a.severity)}</span> ${final ? "last result" : "test running"} · ${esc(a.ep)}</div></div></div>`;
    $("diagMeta").textContent = a.ep || "—";
  }

  // ------------------------------------------------------------------ episodes: verdict, ranking, history, log
  const EPS = new Map();
  const hist = [];
  function epRec(id) { if (!id) return null; if (!EPS.has(id)) EPS.set(id, { id, src: curSrc, op: curOp, steps: [], tests: {} }); return EPS.get(id); }
  function clearEpisode() {
    lastEp = null;
    EPS.clear();
    $("verdict").innerHTML = `<p class="idle">No diagnosis. The machine is being monitored.</p>`;
    $("rank").innerHTML = `<p class="idle">Appears when a diagnosis starts.</p>`;
    $("testBar").hidden = true;
    $("diagMeta").textContent = "—";
    setMotor({ diag: null });
  }

  function onRca(r) {
    const d = r.diagnosis, dec = r.decision || {};
    const feed = $("feed");
    if (feed.querySelector(".idle")) feed.innerHTML = "";
    if (r.episode !== lastEp) {
      lastEp = r.episode;
      const sep = document.createElement("div");
      sep.className = "epsep";
      sep.textContent = `${clockTime()} · Episode ${r.episode} · ${r.src || ""} at ${r.op ? opDesc(r.src, r.op) : "?"} · trigger: ${r.trigger || "?"}`;
      feed.prepend(sep);
    }
    const el = document.createElement("div");
    el.className = "step";
    if (!d) el.innerHTML = `<div class="meta"><span><b>${esc(r.episode)}</b> · ${esc(dec.why)}</span></div><p>${esc(dec.error || "")}</p>`;
    else {
      el.innerHTML = `<div class="meta"><span><b>Step ${r.step}</b> · ${esc(String(r.engine || "").replace("claude-subscription:", "Claude "))}</span><span>${r.latency_s ?? "?"} s</span></div><p>${esc(d.summary)}</p>
        <details><summary>Evidence cited</summary><ul>${d.causes.map((c) => `<li><b>${esc(causeName(c.cause))} ${Math.round(c.p * 100)}%</b>: ${esc(c.evidence)}</li>`).join("")}</ul></details>
        ${dec.test ? `<div class="nexttest"><b>Test ordered:</b> ${esc(opDesc(r.src, dec.test.op))} for ${dec.test.hold_s} s. ${esc(d.test_rationale)}</div>` : ""}`;
    }
    const sepEl = feed.querySelector(".epsep");
    sepEl ? sepEl.after(el) : feed.prepend(el);
    if (!d) return;

    const E = epRec(r.episode);
    E.src = r.src || E.src; E.op = r.op || E.op;
    const prevStep = E.steps[E.steps.length - 1];
    const prevTest = prevStep?.test && E.tests[prevStep.test.id];
    if (prevTest) { prevTest.done = true; renderTestBar(E, prevTest); }
    const st = { step: r.step, causes: d.causes.slice().sort((a, b) => b.p - a.p), severity: d.severity, test: dec.test || null, final: !!dec.final };
    const at = E.steps.findIndex((x) => x.step === r.step);
    if (at >= 0) E.steps[at] = st; else E.steps.push(st);
    if (dec.test) {
      const T = E.tests[dec.test.id] || (E.tests[dec.test.id] = { id: dec.test.id, n: 0, sum: {}, done: false });
      T.op = dec.test.op; T.hold_s = dec.test.hold_s;
      renderTestBar(E, T);
    }

    const top = st.causes[0], sev = sevClass(d.severity), pct = Math.round(top.p * 100);
    const idx = E.steps.indexOf(st);
    const prev = idx > 0 ? E.steps[idx - 1] : null;
    const prevP = prev ? (prev.causes.find((c) => c.cause === top.cause)?.p ?? 0) : null;
    const truth = r.truth;
    $("verdict").innerHTML = `<div class="vrow"><div class="vbig">${pct}<small>%</small></div><div class="vmain">
        <div class="vcause">${esc(causeName(top.cause))}</div>
        <div class="vsub"><span class="sevb ${sev}">${esc(d.severity)}</span> ${dec.final ? "final" : "provisional, test running"}${prevP != null ? ` · ${Math.round(prevP * 100)}% → ${pct}% after the test` : ""}</div></div></div>
      ${d.action ? `<p class="vaction">${esc(d.action)}</p>` : ""}
      ${truth ? `<p class="vtruth">Injected <b>${esc(truth.label)}</b> (${esc(causeName(truth.cause))}): ${truth.correct ? '<span class="ok">diagnosis correct</span>' : '<span class="no">diagnosis differs</span>'}</p>` : ""}`;
    $("diagMeta").textContent = `${r.episode} · step ${r.step} · ${r.latency_s ?? "?"} s`;

    // previous step drawn as a ghost bar behind the current one
    const pm = Object.fromEntries((prev?.causes || []).map((c) => [c.cause, c.p]));
    $("rank").innerHTML = st.causes.slice(0, 5).map((c, k) => `<div class="rk ${k === 0 ? "top " + sev : ""}"><span class="rn" title="${esc(causeName(c.cause))}">${esc(causeName(c.cause))}</span>
        <span class="rb">${prev ? `<i class="prev" style="width:${Math.round((pm[c.cause] || 0) * 100)}%"></i>` : ""}<i class="now" style="width:${Math.round(c.p * 100)}%"></i></span>
        <span class="rp">${Math.round(c.p * 100)}%</span></div>`).join("")
      + (prev ? `<div class="rkey"><span><i style="background:#c9d2db"></i>step ${prev.step}</span><span><i style="background:var(--sel)"></i>step ${st.step}</span></div>` : "");

    setMotor({ diag: { cause: top.cause, p: top.p, severity: d.severity, final: !!dec.final, label: PART[top.cause] || causeName(top.cause) } });

    if (dec.final) {
      hist.unshift({ t: new Date(), r, top, sev });
      $("evCount").hidden = false; $("evCount").textContent = hist.length;
      $("histRows").innerHTML = hist.map(({ t, r: x, top: tp, sev: sv }) => {
        const tests = (x.tests || []).map((tt) => `${rpmOf(x.src, tt.op) || tt.op} rpm`).join(", ") || "none";
        const tr = x.truth;
        return `<tr><td class="n">${clockTime(t)}</td><td>${esc(x.episode)}</td><td>${esc(x.src)} · ${rpmOf(x.src, x.op) || esc(x.op)} rpm</td><td>${esc(x.trigger || "")}</td>
          <td>${tests}</td><td>${esc(causeName(tp.cause))}</td><td class="n">${Math.round(tp.p * 100)}%</td><td><span class="chip ${sv === "watch" ? "warn" : sv}">${esc(x.diagnosis.severity)}</span></td>
          <td>${tr ? `${esc(tr.label)} <span class="chip ${tr.correct ? "ok" : "alarm"}">${tr.correct ? "match" : "differs"}</span>` : "—"}</td><td class="n">${x.duration_s ?? "?"} s</td></tr>`;
      }).join("");
    }
  }

  if (REPLAY) startReplay(); else startLive();
})();
