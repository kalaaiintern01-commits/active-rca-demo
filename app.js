/* Active-RCA live dashboard - talks to the broker directly over MQTT/WSS.
   With ?replay it plays a recorded episode (data/demo-episodes.json) through the same handlers instead. */
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
  const MAXPTS = 120;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? "—" : Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v).toPrecision(d));
  const pretty = (c) => String(c || "").replace(/_/g, " ");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // names for the verdict (long), the forecast rows (short) and the part the 3D view lights
  const NAMES = {
    healthy: "Healthy", unknown: "Unknown cause", bearing_outer_race: "Outer-race bearing", bearing_inner_race: "Inner-race bearing",
    bearing_rolling_element: "Rolling-element bearing", bearing: "Bearing fault", eccentricity: "Rotor eccentricity", unbalance: "Unbalance",
    misalignment: "Misalignment", load_change: "Load change", sensor_mounting: "Sensor mounting", magnet_demagnetisation: "Magnet demagnetisation",
    stator_winding: "Stator winding", thermal_drift_wear: "Thermal drift and wear", bearing_or_brush_wear: "Bearing or brush wear",
    electrical_overload: "Electrical overload", cooling_failure: "Cooling failure",
  };
  const SHORT = {
    bearing_outer_race: "Outer race", bearing_inner_race: "Inner race", bearing_rolling_element: "Rolling element", bearing: "Bearing",
    magnet_demagnetisation: "Magnets", eccentricity: "Eccentricity", sensor_mounting: "Sensor mount", thermal_drift_wear: "Thermal drift", bearing_or_brush_wear: "Bearing / brush",
    electrical_overload: "Overload", stator_winding: "Stator winding", unknown: "Unknown",
  };
  const PART = {
    bearing_outer_race: "Drive-end bearing, outer race", bearing_inner_race: "Drive-end bearing, inner race",
    bearing_rolling_element: "Drive-end bearing, rolling elements", bearing: "Drive-end bearing", eccentricity: "Rotor, eccentric air gap",
    unbalance: "Rotor, unbalanced mass", magnet_demagnetisation: "Rotor magnets", stator_winding: "Stator winding",
    electrical_overload: "Stator winding, overload", thermal_drift_wear: "Frame, running hot", cooling_failure: "Fan and frame, cooling",
    sensor_mounting: "Accelerometer mount", misalignment: "Shaft and coupling, misaligned", load_change: "Coupling, load side",
    bearing_or_brush_wear: "Brushes and rear bearing",
  };
  const causeName = (c) => NAMES[c] || pretty(c);
  const causeShort = (c) => SHORT[c] || causeName(c);
  const sevClass = (s) => (s === "alarm" ? "alarm" : s === "info" ? "ok" : "watch");

  $("devName").textContent = CFG.device;
  $("topicRoot").textContent = REPLAY ? " · recorded replay, no broker" : ` · topics ${ROOT}/…`;

  let MAN = null;
  let node = {};
  let scn = null, curSrc = null, curOp = null;
  let lastEp = null;
  let nodeSeen = 0;
  let gateState = null;
  let markNext = null;
  const testPhase = new Map();      // seq -> telemetry test tag, so gate windows can be split into settle / run

  // ------------------------------------------------------------------ 3D machine view (optional - the page works without it)
  let motor = null;
  const mstate = { src: null, rpm: 0, state: "monitor", test: null, diag: null, level: 0, load: 0 };
  function setMotor(patch) {
    Object.assign(mstate, patch);
    if (motor) motor.update(mstate);
    const mt = $("motorTest");
    mt.hidden = !mstate.test;
    if (mstate.test) mt.textContent = `AI test · ${Math.round(mstate.test.rpm)} rpm`;
  }
  // three live gauges on the machine view: speed, vibration (x healthy), load (current x healthy, or torque)
  function gauge(id, frac, text, tone = "") {
    const g = $(id);
    g.className = "g " + tone;
    g.querySelector(".fl").style.strokeDasharray = `${Math.round(Math.max(0, Math.min(1, frac || 0)) * 100)} 100`;
    g.querySelector("b").textContent = text;
  }
  function maxRpm(src) { const o = srcInfo(src)?.ops || {}; return Math.max(1000, ...Object.values(o).map((x) => x.rpm || 0)) * 1.15; }
  import("./motor3d.js")
    .then((m) => { motor = m.createMotor($("motor")); motor.update(mstate); })
    .catch((e) => { console.warn("3D view unavailable:", e && e.message); $("motor").classList.add("no3d"); });

  // ------------------------------------------------------------------ charts
  const COL = { ink: "#e8f1f8", mute: "#8fb0cc", ok: "#3fd0a4", hot: "#ff6b4a", test: "#a98bff", sky2: "#7fb6e0", sky3: "#5b8db9" };
  Chart.defaults.color = COL.mute;
  Chart.defaults.font.family = "'Barlow Condensed', Barlow, system-ui, sans-serif";
  Chart.defaults.font.size = 13;
  Chart.defaults.font.weight = 600;
  const grid = { color: "rgba(150,200,240,.07)" };

  // violet shading over AI-test windows and dashed markers (gate fired, new scenario) drawn behind the lines
  const zones = {
    id: "zones",
    beforeDatasetsDraw(c) {
      const meta = c.$meta || [];
      const { ctx, chartArea: a, scales: { x } } = c;
      if (!a || !meta.length) return;
      const step = meta.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 12;
      const big = !c.$small;
      ctx.save();
      for (let i = 0; i < meta.length;) {
        if (!meta[i]?.test) { i++; continue; }
        let j = i;
        while (j + 1 < meta.length && meta[j + 1]?.test) j++;
        const x0 = Math.max(a.left, x.getPixelForValue(i) - step / 2), x1 = Math.min(a.right, x.getPixelForValue(j) + step / 2);
        ctx.fillStyle = "rgba(169,139,255,.11)";
        ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
        ctx.fillStyle = "rgba(169,139,255,.7)";
        ctx.fillRect(x0, a.top, x1 - x0, 2);
        if (big && x1 - x0 > 70) {
          ctx.fillStyle = COL.test;
          ctx.font = "700 14px 'Barlow Condensed'";
          ctx.fillText(`TEST ${meta[i].test}`.toUpperCase(), x0 + 7, a.top + 18);
        }
        i = j + 1;
      }
      meta.forEach((m, k) => {
        if (!m?.mark) return;
        const px = Math.max(a.left + 1, x.getPixelForValue(k));
        ctx.strokeStyle = m.mark.color;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
        ctx.setLineDash([]);
        if (big && c.width > 560) {
          ctx.fillStyle = m.mark.color;
          ctx.font = "700 14px 'Barlow Condensed'";
          const w = ctx.measureText(m.mark.text).width;
          const tx = px + 6 + w > a.right ? px - 6 - w : px + 6;
          ctx.fillText(m.mark.text, tx, a.top + (m.mark.row || 2) * 18);
        }
      });
      ctx.restore();
    },
    // a soft glow under the live line so it reads on a projector
    beforeDatasetDraw(c, { index }) {
      if (index === 2 && !c.$small) { c.ctx.save(); c.ctx.shadowColor = "rgba(232,241,248,.35)"; c.ctx.shadowBlur = 8; }
    },
    afterDatasetDraw(c, { index }) { if (index === 2 && !c.$small) c.ctx.restore(); },
  };
  Chart.register(zones);

  const isTestSeg = (s) => !!s.chart.$meta?.[s.p1DataIndex]?.test;
  function mkChart(el, sets, small) {
    const c = new Chart($(el), {
      type: "line",
      data: { labels: [], datasets: sets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, spanGaps: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(11,26,46,.94)", borderColor: "#2b5680", borderWidth: 1, padding: 10, titleColor: COL.ink, bodyColor: "#c4d6e6",
            bodyFont: { family: "Barlow", weight: 500, size: 13 }, callbacks: { title: (it) => `window #${it[0]?.label ?? ""}`, label: (c) => (c.raw == null ? null : `${c.dataset.label}: ${fmt(c.raw, 4)}`) },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: "rgba(150,200,240,.18)" }, ticks: { maxTicksLimit: small ? 5 : 8, callback(v) { return "#" + this.getLabelForValue(v); } } },
          y: { grid, border: { display: false }, ticks: { maxTicksLimit: small ? 4 : 6 } },
        },
        elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.3, capBezierPoints: true } },
      },
    });
    c.$meta = [];
    c.$small = !!small;
    return c;
  }
  const bandSets = (label) => [
    { label: "healthy +3σ", data: [], borderColor: "rgba(63,208,164,.42)", borderWidth: 1, backgroundColor: "rgba(63,208,164,.11)", fill: "+1", pointRadius: 0 },
    { label: "healthy −3σ", data: [], borderColor: "rgba(63,208,164,.42)", borderWidth: 1, fill: false, pointRadius: 0 },
    { label, data: [], borderColor: COL.ink, borderWidth: 2.4, fill: false, segment: { borderColor: (s) => (isTestSeg(s) ? COL.test : undefined) } },
  ];
  const cRms = mkChart("cRms", bandSets("rms"));
  const cHf = mkChart("cHf", bandSets("band energy"), true);
  const cAux = mkChart("cAux", [
    { label: "a", data: [], borderColor: COL.ink, fill: false },
    { label: "b", data: [], borderColor: COL.sky2, fill: false },
    { label: "c", data: [], borderColor: COL.sky3, fill: false },
  ], true);
  const charts = [cRms, cHf, cAux];

  function clearCharts() {
    for (const c of charts) { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); c.$meta = []; c.update("none"); }
  }
  function push(c, seq, vals, meta) {
    c.data.labels.push(seq);
    c.data.datasets.forEach((d, i) => d.data.push(vals[i] ?? null));
    c.$meta.push(meta);
    if (c.data.labels.length > MAXPTS) { c.data.labels.shift(); c.data.datasets.forEach((d) => d.data.shift()); c.$meta.shift(); }
  }
  function setAt(c, seq, i, v) {
    const k = c.data.labels.indexOf(seq);
    if (k >= 0) c.data.datasets[i].data[k] = v;
  }
  function markAt(seq, mark) {
    for (const c of charts) {
      const k = c.data.labels.indexOf(seq);
      if (k >= 0) c.$meta[k] = { ...(c.$meta[k] || {}), mark };
      c.update("none");
    }
  }

  // ------------------------------------------------------------------ manifest + controls
  fetch("data/manifest.json").then((r) => r.json()).then((m) => { MAN = m; fillSrc(); setMotor({}); }).catch(() => {
    hint("data/manifest.json not found - controls disabled", "err");
  });
  function fillSrc() {
    const s = $("selSrc");
    s.innerHTML = Object.entries(MAN.sources).map(([k, v]) => `<option value="${k}">${k} · ${esc(v.name)}</option>`).join("");
    s.onchange = fillCondOp;
    fillCondOp();
  }
  function fillCondOp() {
    const src = MAN.sources[$("selSrc").value];
    $("machineDesc").textContent = `${src.motor}. Sensors: ${src.sensors}.`;
    const files = src.files;
    $("selCond").innerHTML = Object.entries(src.conds).map(([k, v]) => `<option value="${k}">${k} · ${esc(v)}</option>`).join("");
    const fillOps = () => {
      const cond = $("selCond").value;
      const healthy = Object.keys(src.truth || {}).find((c) => src.truth[c] === "healthy");
      $("selOp").innerHTML = Object.entries(src.ops).map(([k, v]) => {
        const has = files[`${cond}_${k}`];
        const scored = !healthy || files[`${healthy}_${k}`];
        return `<option value="${k}" ${has ? "" : "disabled"}>${esc(v.desc)}${has ? (scored ? "" : " (no baseline - manual diagnose)") : " (no recording)"}</option>`;
      }).join("");
      $("selOp").value = files[`${cond}_${src.default_op}`] ? src.default_op : Object.keys(src.ops).find((k) => files[`${cond}_${k}`]);
    };
    $("selCond").onchange = fillOps;
    fillOps();
  }
  function hint(t, cls = "") { const h = $("cmdHint"); h.textContent = t; h.className = "hint " + cls; }

  let client = null;
  function send(leaf, obj) {
    if (!client) { hint("Controls are off in replay.", "err"); return false; }
    client.publish(`${ROOT}/${leaf}`, JSON.stringify(obj), { qos: 1 });
    return true;
  }
  let deployTimer = 0;
  function deployDone() { clearTimeout(deployTimer); const b = $("btnDeploy"); b.disabled = !client; b.textContent = "Deploy"; }
  $("btnDeploy").onclick = () => {
    const cmd = { v: 1, cmd: "scenario", id: "ui-" + Date.now().toString(36), src: $("selSrc").value, cond: $("selCond").value, op: $("selOp").value };
    if (!send("cmd", cmd)) return;
    hint(`Sent ${cmd.src} ${cmd.cond}… waiting for the node`);
    const b = $("btnDeploy");
    b.disabled = true; b.textContent = "Sending…";
    clearTimeout(deployTimer);
    deployTimer = setTimeout(deployDone, 20000);
  };
  $("btnDiagnose").onclick = () => { if (send("ctl", { cmd: "diagnose" })) hint("Diagnosis requested."); };
  $("btnReset").onclick = () => { if (send("ctl", { cmd: "reset" })) hint("Reset requested."); };

  const chip = (id, state, text) => { const c = $(id); c.className = "chip " + (state === true ? "on" : state === false ? "off" : state); c.lastChild.textContent = text; };
  let gotTel = false;
  const empty = (text) => { const e = $("emptyMsg"); e.textContent = text; e.hidden = !text; };

  function dispatch(leaf, m) {
    if (leaf === "telemetry") onTel(m);
    else if (leaf === "gate") onGate(m);
    else if (leaf === "rca") onRca(m);
    else if (leaf === "status") onStatus(m);
    else if (leaf === "alert") onAlert(m);
    else if (leaf === "bridge") chip("chipBridge", m.online, m.online ? String(m.engine || "AI").replace("claude-subscription:", "claude ").replace(" (recorded)", "") : "AI offline");
  }

  // ------------------------------------------------------------------ live: mqtt
  function startLive() {
    // The secure WebSocket to the public broker can take 10-20 s to open on some networks, so give
    // each attempt 45 s and say what is happening instead of showing empty charts.
    client = mqtt.connect(CFG.broker, { clientId: "arca-ui-" + Math.random().toString(16).slice(2, 8), clean: true, reconnectPeriod: 2000, connectTimeout: 45000, keepalive: 30 });
    let connected = false, connectStart = Date.now(), connectedAt = 0;
    client.on("connect", () => {
      connected = true; connectedAt = Date.now();
      chip("chipBroker", true, "broker");
      client.subscribe(`${ROOT}/#`, { qos: 0 });
      if (!gotTel) empty("Waiting for the node…");
    });
    client.on("reconnect", () => { connectStart = Date.now(); });
    client.on("close", () => { if (connected) chip("chipBroker", false, "broker"); connected = false; });
    client.on("error", (e) => console.warn("mqtt", e && e.message));
    setInterval(() => {
      if (!connected) {
        const s = Math.round((Date.now() - connectStart) / 1000);
        chip("chipBroker", "wait", `broker ${s} s`);
        if (!gotTel) empty(`Connecting… ${s} s`);
      } else if (!gotTel && Date.now() - connectedAt > 20000) {
        empty("No data yet. Is the Wokwi simulator running and visible?");
      }
    }, 1000);
    client.on("message", (topic, buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      dispatch(topic.slice(ROOT.length + 1), m);
    });
    // The public broker delivers with jitter (gaps of 13-15 s between 5 s windows are normal), so the
    // node only counts as silent after 4x its usual interval (at least 25 s).
    setInterval(() => {
      if (!nodeSeen) return;
      const quiet = Date.now() - nodeSeen;
      if (quiet > silenceLimit()) {
        chip("chipNode", "wait", `node ${Math.round(quiet / 1000)} s`);
        empty(`Node silent ${Math.round(quiet / 1000)} s. Keep the Wokwi tab visible.`);
        silentShown = true;
      }
    }, 2000);
  }
  const arrivals = [];
  let silentShown = false;
  function silenceLimit() {
    if (arrivals.length < 4) return 25000;
    const d = arrivals.slice(1).map((t, i) => t - arrivals[i]).sort((a, b) => a - b);
    return Math.min(90000, Math.max(25000, 4 * d[Math.floor(d.length / 2)]));
  }

  // ------------------------------------------------------------------ replay: a recorded episode through the same handlers
  function startReplay() {
    document.body.classList.add("is-replay");
    $("replayBox").hidden = false;
    $("replayBadge").hidden = false;
    const ml = $("modeLink"); ml.textContent = "Back to live"; ml.href = "./";
    chip("chipBroker", true, "recorded");
    ["btnDeploy", "btnDiagnose", "btnReset"].forEach((id) => ($(id).disabled = true));
    empty("Loading…");
    const R = { eps: [], ep: null, i: 0, t: 0, speed: 1, playing: false, last: 0 };
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const ui = () => {
      const d = R.ep ? R.ep.duration_s : 0;
      $("repBar").style.width = d ? `${Math.min(100, (R.t / d) * 100)}%` : "0";
      $("repPlay").textContent = R.playing ? "Pause" : R.ep && R.i >= R.ep.items.length ? "Play again" : "Play";
      $("repTime").textContent = R.ep ? `${mmss(Math.min(R.t, d))} / ${mmss(d)}` : "";
    };
    const play = (k) => {
      resetView();
      R.ep = R.eps[k]; R.i = 0; R.t = 0; R.playing = true; R.last = performance.now();
      ui();
    };
    fetch("data/demo-episodes.json").then((r) => r.json()).then((D) => {
      R.eps = D.episodes;
      const sel = $("repEp");
      sel.innerHTML = R.eps.map((e, i) => `<option value="${i}">${esc(e.src)} · ${esc(e.title.split(" - ").pop())}</option>`).join("");
      const want = R.eps.findIndex((e) => e.src === qs.get("replay"));
      sel.value = String(want >= 0 ? want : 0);
      sel.onchange = () => play(+sel.value);
      play(+sel.value);
    }).catch(() => empty("data/demo-episodes.json could not be loaded."));
    $("repPlay").onclick = () => {
      if (!R.ep) return;
      if (R.i >= R.ep.items.length) { play(R.eps.indexOf(R.ep)); return; }
      R.playing = !R.playing; R.last = performance.now(); ui();
    };
    $("repRestart").onclick = () => { if (R.ep) play(R.eps.indexOf(R.ep)); };
    document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
      R.speed = +b.dataset.speed;
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
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
    $("feed").innerHTML = "";
    EPS.clear();
    lastEp = null; scn = null; curSrc = null; curOp = null; gateState = null; markNext = null; synced = false; gotTel = false;
    lastPct = null;
    testPhase.clear();
    verdictIdle("No diagnosis yet.");
    storyReset();
    base = {};
    $("forecast").hidden = true; $("forecast").innerHTML = ""; $("forecastEmpty").hidden = false;
    $("zbars").innerHTML = "";
    $("topEp").textContent = "";
    const st = $("statePill"); st.textContent = "waiting"; st.className = "pill";
    setMotor({ diag: null, test: null, state: "monitor", level: 0 });
  }

  // ------------------------------------------------------------------ handlers
  function srcInfo(src) { return MAN?.sources?.[src]; }
  function opDesc(src, op) { return srcInfo(src)?.ops?.[op]?.desc || op; }
  function rpmOf(src, op) { return srcInfo(src)?.ops?.[op]?.rpm; }

  let synced = false, touched = false;
  ["selSrc", "selCond", "selOp"].forEach((id) => $(id).addEventListener("change", () => (touched = true)));
  function syncControls(t) {               // start the inject panel on whatever the node is running
    if (synced || touched || !MAN) return;
    synced = true;
    $("selSrc").value = t.src; fillCondOp();
    $("selCond").value = t.label; $("selCond").onchange();
    if (srcInfo(t.src)?.ops?.[t.op]) $("selOp").value = t.op;
  }

  function onTel(t) {
    nodeSeen = Date.now();
    arrivals.push(nodeSeen); if (arrivals.length > 20) arrivals.shift();
    if (!gotTel || silentShown) { gotTel = true; silentShown = false; empty(""); }
    if (!t.test) syncControls(t);
    chip("chipNode", true, `node · ${t.fw || ""}`);
    // a new machine or a new base operating point gets a fresh plot; test windows (temporary op) do not
    if (t.src !== curSrc || (!t.test && curOp !== null && t.op !== curOp)) clearCharts();
    curSrc = t.src;
    if (!t.test) curOp = t.op;
    if (scn !== null && t.scn !== scn) { markNext = { color: COL.mute, text: "NEW SCENARIO", row: 1 }; clearEpisode(); }
    scn = t.scn;
    if (t.test) { testPhase.set(t.seq, t.test); if (testPhase.size > 60) testPhase.delete(testPhase.keys().next().value); }
    const s = srcInfo(t.src);
    const unit = t.vib.cal_ok ? "m/s²" : "units";
    $("rmsUnit").textContent = `rms ${unit}`;
    const hasHf = t.spec.bhf != null;
    $("hfTitle").textContent = hasHf ? "Bearing band 1–5 kHz" : "Band 0.8–2.5 kHz";
    const hf = hasHf ? t.spec.bhf : t.spec.b3;
    const rpm = rpmOf(t.src, t.op) || Math.round(t.rpm.avg);
    const meta = { test: t.test ? `${t.test.id} · ${rpm} rpm` : null };
    if (markNext) { meta.mark = markNext; markNext = null; }
    push(cRms, t.seq, [null, null, t.vib.rms_ms2], meta);
    push(cHf, t.seq, [null, null, hf], { ...meta, mark: undefined });
    cHf.data.datasets[2].label = hasHf ? "bhf" : "b3";
    let aux;
    if (t.temp.valid) {
      $("auxTitle").textContent = "Temperature °C";
      aux = [t.temp.c, null, null];
      cAux.data.datasets[0].label = "temp °C";
    } else {
      $("auxTitle").textContent = "Axes x · y · z";
      aux = [t.vib.x_rms, t.vib.y_rms, t.vib.z_rms];
      cAux.data.datasets[0].label = "x"; cAux.data.datasets[1].label = "y"; cAux.data.datasets[2].label = "z";
    }
    push(cAux, t.seq, aux, { test: meta.test });
    charts.forEach((c) => c.update("none"));
    node.lastTel = t;

    $("topMachine").textContent = t.src;
    $("topOp").textContent = `${rpm} rpm`;
    gauge("gSpeed", t.rpm.avg / maxRpm(t.src), String(Math.round(t.rpm.avg)), t.test ? "tst" : "");
    if (!t.cur.valid) {
      const tq = /([\d.]+) N\.m/.exec(opDesc(t.src, t.op));
      gauge("gLoad", tq ? +tq[1] / 1 : 0, tq ? `${tq[1]} N·m` : "n/a", tq ? "" : "off");
      if (tq) setMotor({ load: Math.min(1, +tq[1]) });
    }

    $("kvSrc").textContent = s ? `${t.src} · ${s.name}` : t.src;
    $("kvCond").innerHTML = `<span class="truth">${esc(t.label)}</span> ${esc(s?.conds?.[t.label] || "")}<span class="dim">hidden from the AI</span>`;
    $("kvOp").textContent = `${t.op} · ${opDesc(t.src, t.op)} · ${fmt(t.rpm.avg, 4)} rpm`;
    $("kvTest").textContent = t.test ? `${t.test.id} · ${t.test.phase} · ${t.test.left} left` : "—";
    $("kvReplay").textContent = t.replay ? `${(t.replay.file || "").split("/").pop()}${t.replay.win != null ? ` · window ${t.replay.win + 1}/${t.replay.of || "?"}` : ""}` : "—";
    $("kvFw").textContent = `${t.fw || "?"} · ${t.win.sample_hz} Hz · seq ${t.seq}`;
    setMotor({ src: t.src, rpm: t.rpm.avg, test: t.test ? { rpm: t.rpm.avg } : null });
  }

  // ------------------------------------------------------------------ the episode story: drift caught -> AI step -> test -> diagnosis
  let storyEp = null;
  function stage(id, state, v, sub) {
    const el = $(id);
    el.className = "stage" + (id === "stTest" ? " test" : "") + (state ? " " + state : "");
    if (v != null) el.querySelector(".v").textContent = v;
    if (sub != null) el.querySelector(".s").textContent = sub;
  }
  function storyReset() {
    storyEp = null;
    stage("stDrift", "", "Watching", "");
    $("stStep").querySelector(".k").textContent = "AI step 1";
    stage("stStep", "", "—", "");
    stage("stTest", "", "—", "");
    stage("stDiag", "", "—", "");
  }
  storyReset();
  const topLine = (d) => { const c = d.causes.slice().sort((a, b) => b.p - a.p)[0]; return [c, `${causeShort(c.cause)} ${Math.round(c.p * 100)}%`]; };

  const STATE_TEXT = { monitor: "monitoring", diagnosing: "AI thinking", testing: "AI test", latched: "alarm" };
  let base = {};
  function onGate(g) {
    const b = g.base || {};
    const band = (k) => (b[k] ? [b[k][0] + 3 * b[k][1], Math.max(0, b[k][0] - 3 * b[k][1])] : [null, null]);
    const [ru, rl] = band("rms");
    setAt(cRms, g.seq, 0, ru); setAt(cRms, g.seq, 1, rl);
    const hfKey = b.bhf ? "bhf" : "b3";
    const [hu, hl] = band(hfKey);
    setAt(cHf, g.seq, 0, hu); setAt(cHf, g.seq, 1, hl);
    cRms.update("none"); cHf.update("none");

    const fired = g.state !== "monitor" && gateState === "monitor" && g.episode;
    if (fired) {
      markAt(g.seq, { color: COL.hot, text: `DRIFT CAUGHT · ${g.episode}`, row: 2 });
      storyEp = g.episode;
      stage("stDrift", "done hot", `Window #${g.seq}`, (g.flagged || []).slice(0, 3).join(" · ") || "manual start");
      stage("stStep", "live", "Thinking…", "");
    }
    if (g.state === "monitor" && !g.episode && storyEp) storyReset();     // re-armed
    gateState = g.state;
    const st = $("statePill"); st.textContent = STATE_TEXT[g.state] || g.state; st.className = "pill " + g.state;
    $("topEp").textContent = g.episode || "";

    if (!storyEp && g.state === "monitor") {
      const n = Math.min(3, g.streak || 0);
      if (!b.rms) stage("stDrift", "warm", "No baseline", "use Diagnose");
      else stage("stDrift", n ? "warm" : "", n ? "Rising" : "Watching", null);
      if (b.rms) $("streak").innerHTML = `<i class="pip ${n > 0 ? "on" : ""}"></i><i class="pip ${n > 1 ? "on" : ""}"></i><i class="pip ${n > 2 ? "on" : ""}"></i>`;
    }

    const z = g.z || {};
    $("zbars").innerHTML = Object.entries(z).map(([k, v]) => {
      const cl = Math.max(-12, Math.min(12, v));
      const w = (Math.abs(cl) / 12) * 50;
      const left = cl >= 0 ? 50 : 50 - w;
      const tone = g.test ? "tst" : Math.abs(v) > 6 ? "hot" : Math.abs(v) > 3 ? "warm" : "";
      return `<span class="n">${esc(k.replace("_rms", ""))}</span><div class="zt"><span class="mid"></span><span class="lim" style="left:${50 - 12.5}%"></span><span class="lim" style="left:${50 + 12.5}%"></span><span class="bar ${tone}" style="left:${left}%;width:${w}%"></span></div><span class="v ${tone}">${v > 0 ? "+" : ""}${v.toFixed(1)}</span>`;
    }).join("");

    // gauges: vibration and load as multiples of healthy at the operating point the window ran at
    const f = g.feats || {};
    const zr = Math.abs(z.rms || 0);
    if (b.rms && f.rms != null) {
      const r = f.rms / b.rms[0];
      gauge("gVib", Math.min(1, r / 3), `×${r.toFixed(2)}`, g.test ? "tst" : zr > 6 ? "hot" : zr > 3 ? "warm" : "ok");
    }
    if (b.cur_rms && f.cur_rms != null) {
      const r = f.cur_rms / b.cur_rms[0];
      gauge("gLoad", Math.min(1, r / 2), `×${r.toFixed(2)}`, g.test ? "tst" : Math.abs(r - 1) > 0.25 ? "warm" : "");
      setMotor({ load: Math.min(1, r / 2) });
    }
    if (g.test) onTestWindow(g, hfKey);
    let zmax = 0;
    for (const v of Object.values(z)) zmax = Math.max(zmax, Math.abs(v));
    setMotor({ state: g.state, level: Math.min(1, zmax / 10) });
  }

  // average the test windows against the healthy baseline at the test's own operating point
  function onTestWindow(g, hfKey) {
    const E = epRec(g.episode || lastEp);
    if (!E) return;
    const T = E.tests[g.test] || (E.tests[g.test] = { id: g.test, op: g.op, hold_s: null, n: 0, sum: {}, done: false });
    T.op = g.op;
    const tag = testPhase.get(g.seq);
    const b = g.base || {}, f = g.feats || {};
    if (!tag || tag.phase === "run") {
      T.n++;
      for (const [k, key] of [["hf", hfKey], ["rms", "rms"], ["cur", "cur_rms"]]) {
        if (b[key] && f[key] != null && b[key][0]) T.sum[k] = (T.sum[k] || 0) + f[key] / b[key][0];
      }
      T.hfKey = hfKey;
    }
    const total = T.hold_s ? Math.round(T.hold_s / 2) : null;
    stage("stTest", "live", null, T.n ? `window ${T.n}${total ? ` / ${total}` : ""}` : "settling");
    updateObs(E, T);
  }

  function onStatus(s) {
    if (s.online === false) { chip("chipNode", false, "node"); return; }
    nodeSeen = Date.now();
    if (s.ack && s.ack.id && s.ack.id.startsWith("ui-")) deployDone();
    if (s.ack && s.ack.id && s.ack.id.startsWith("ui-")) hint(`${s.ack.ok ? "Accepted" : "Rejected"}: ${s.ack.msg}`, s.ack.ok ? "ok" : "err");
    $("kvAck").textContent = s.ack?.id ? `${s.ack.id} · ${s.ack.ok ? "ok" : "rejected"} · ${s.ack.msg}` : "—";
    if (s.test) $("kvTest").textContent = `${s.test.id} → ${s.test.op} · ${s.test.done}/${s.test.hold}`;
  }

  // retained summary of the last finished episode - keeps the verdict on screen after a page refresh
  // drop the previous episode's result from the story line, verdict, forecast and 3D highlight (the log keeps it)
  function clearEpisode() {
    lastEp = null; lastPct = null;
    EPS.clear();
    storyReset();
    verdictIdle("No diagnosis yet.");
    $("forecast").hidden = true; $("forecast").innerHTML = ""; $("forecastEmpty").hidden = false;
    setMotor({ diag: null });
  }
  function onAlert(a) {
    if (!a) return;
    if (a.state === "monitor" && !a.cause) {
      if (lastEp || mstate.diag || $("verdict").className !== "verdict") clearEpisode();
      return;
    }
    if (lastEp || !a.cause) return;
    const final = a.state === "done";
    setMotor({ diag: { cause: a.cause, p: a.p || 0, severity: a.severity, final, label: PART[a.cause] || causeName(a.cause) } });
    const sev = sevClass(a.severity);
    if (final) stage("stDiag", `done sev-${sev}`, `${causeShort(a.cause)} ${Math.round((a.p || 0) * 100)}%`, `last result · ${a.ep}`);
    $("verdict").className = `verdict sev-${sev}`;
    $("verdictBody").innerHTML = `
      <div class="v-top"><b class="v-pct">${Math.round((a.p || 0) * 100)}<small>%</small></b>
        <div class="v-side"><span class="sev ${sev}">${esc(a.severity)}</span><span class="v-state">${final ? "last result" : "test running"} · ${esc(a.ep)}</span></div></div>
      <h3 class="v-cause">${esc(causeName(a.cause))}</h3>`;
  }

  // ------------------------------------------------------------------ episodes: forecast strip and verdict
  const EPS = new Map();
  function epRec(id) {
    if (!id) return null;
    if (!EPS.has(id)) EPS.set(id, { id, src: curSrc, op: curOp, steps: [], tests: {}, shown: 0 });
    return EPS.get(id);
  }
  const pmap = (s) => Object.fromEntries((s?.causes || []).map((c) => [c.cause, c.p]));
  const top4 = (s) => s.causes.slice().sort((a, b) => b.p - a.p).slice(0, 4);

  function stepCol(E, s, i) {
    const prev = i > 0 ? E.steps[i - 1] : null;
    const pm = pmap(prev);
    const rows = top4(s);
    let moved = null;
    if (prev) moved = rows.reduce((m, c) => (Math.abs(c.p - (pm[c.cause] ?? 0)) > Math.abs(m.p - (pm[m.cause] ?? 0)) ? c : m), rows[0]).cause;
    const rpm = rpmOf(E.src, s.op);
    const head = i === 0 ? `Step 1${rpm ? ` · ${rpm} rpm` : ""}` : `Step ${s.step}`;
    return `<div class="fc-col fc-step sev-${sevClass(s.severity)}" data-step="${i}"><h4>${head}</h4>${rows.map((c, k) => {
      const p = Math.round(c.p * 100);
      const d = prev ? p - Math.round((pm[c.cause] ?? 0) * 100) : 0;
      return `<div class="fc-row ${k === 0 ? "lead" : ""} ${c.cause === moved ? "lit" : ""}" data-cause="${esc(c.cause)}" title="${esc(causeName(c.cause))}">
        <span class="fc-n">${esc(causeShort(c.cause))}</span><span class="fc-p"><b data-to="${p}">${p}</b>${prev && d ? `<em>${d > 0 ? "+" : "−"}${Math.abs(d)}</em>` : ""}</span>
        <span class="fc-bar"><i style="--w:${p}%"></i></span></div>`;
    }).join("")}</div>`;
  }
  function obsCol(E, T) {
    const rpm = rpmOf(E.src, T.op) || "—";
    const avg = (k) => (T.n && T.sum[k] ? (T.sum[k] / T.n).toFixed(2) : null);
    const hf = avg("hf"), rms = avg("rms");
    return `<div class="fc-col fc-obs ${T.done ? "" : "live"}" id="obs-${esc(T.id)}"><h4>Test</h4>
      <b class="fc-rpm">${rpm}</b><span class="fc-u">rpm</span>
      <div class="fc-ratio">${hf ? `<span>${T.hfKey === "bhf" ? "hf" : "b3"} ×${hf}</span>` : ""}${rms ? `<span>rms ×${rms}</span>` : ""}</div></div>`;
  }
  const waitCol = (n) => `<div class="fc-col fc-wait"><h4>Step ${n}</h4><p>waiting…</p></div>`;

  function renderStrip(E) {
    const host = $("forecast");
    const cols = [], tpl = [];
    E.steps.forEach((s, i) => {
      cols.push(stepCol(E, s, i)); tpl.push("minmax(120px, 1fr)");
      if (s.test && E.tests[s.test.id]) {
        cols.push(obsCol(E, E.tests[s.test.id])); tpl.push("minmax(80px, 92px)");
        if (i === E.steps.length - 1 && !s.final) { cols.push(waitCol(s.step + 1)); tpl.push("minmax(120px, 1fr)"); }
      }
    });
    host.style.gridTemplateColumns = tpl.join(" ");
    host.innerHTML = cols.join("");
    host.hidden = false;
    $("forecastEmpty").hidden = true;
    if (E.steps.length > E.shown) {
      const k = E.steps.length - 1;
      E.shown = E.steps.length;
      const col = host.querySelector(`[data-step="${k}"]`);
      if (k > 0) rerank(col, E.steps[k - 1]);
      else if (!reduceMotion) col.classList.add("enter");
    }
    if (host.scrollWidth > host.clientWidth + 2) host.scrollLeft = host.scrollWidth;
  }
  function updateObs(E, T) {
    const el = document.getElementById(`obs-${T.id}`);
    if (el) el.outerHTML = obsCol(E, T);
  }
  // the signature moment: the new step starts from the previous odds and order, then settles into the revision
  function rerank(col, prev) {
    if (!col || reduceMotion) return;
    const rows = [...col.querySelectorAll(".fc-row")];
    if (!rows.length) return;
    const pm = pmap(prev);
    const order = top4(prev).map((c) => c.cause);
    const h = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : rows[0].offsetHeight;
    rows.forEach((row, n) => {
      const c = row.dataset.cause;
      const oi = order.indexOf(c);
      row.style.transition = "none";
      row.style.transform = `translateY(${((oi >= 0 ? oi : rows.length) - n) * h}px)`;
      if (oi < 0) row.style.opacity = "0";
      const bar = row.querySelector(".fc-bar i");
      bar.style.transition = "none";
      bar.style.setProperty("--w", `${Math.round((pm[c] ?? 0) * 100)}%`);
      const num = row.querySelector(".fc-p b");
      countUp(num, Math.round((pm[c] ?? 0) * 100), +num.dataset.to, 1100, 200);
    });
    void col.offsetHeight;
    requestAnimationFrame(() => rows.forEach((row) => {
      row.style.transition = ""; row.style.transform = ""; row.style.opacity = "";
      const bar = row.querySelector(".fc-bar i");
      bar.style.transition = "";
      bar.style.setProperty("--w", `${row.querySelector(".fc-p b").dataset.to}%`);
    }));
  }
  function countUp(el, from, to, ms = 900, delay = 0) {
    if (!el) return;
    if (reduceMotion || from == null || from === to) { el.textContent = to; return; }
    el.textContent = from;
    const t0 = performance.now() + delay;
    const tick = (now) => {
      const k = Math.max(0, Math.min(1, (now - t0) / ms));
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 4)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function causesHtml(causes) {
    return (causes || []).slice(0, 4).map((c) => `<div class="cause"><span>${esc(causeName(c.cause))}</span><span class="pv">${Math.round(c.p * 100)}%</span><span class="pb"><i style="width:${Math.round(c.p * 100)}%"></i></span></div>`).join("");
  }

  function onRca(r) {
    const feed = $("feed");
    if (r.episode !== lastEp) {
      lastEp = r.episode;
      const sep = document.createElement("div");
      sep.className = "epsep";
      sep.textContent = `Episode ${r.episode} · ${r.src || ""} @ ${r.op ? opDesc(r.src, r.op) : ""}`;
      feed.prepend(sep);
    }
    const d = r.diagnosis;
    const dec = r.decision || {};
    const el = document.createElement("div");
    el.className = "step" + (dec.final ? " final" : "");
    if (!d) {
      el.innerHTML = `<div class="meta"><span>${esc(r.episode)} · ${esc(dec.why)}</span></div><p>${esc(dec.error || "")}</p>`;
    } else {
      const test = dec.test ? `<div class="nexttest"><b>Test ordered</b> ${esc(opDesc(r.src, dec.test.op))} for ${dec.test.hold_s} s<br><span class="dim">${esc(d.test_rationale)}</span></div>` : "";
      el.innerHTML = `<div class="meta"><span>Step ${r.step} · ${esc(r.engine)}</span><span>${r.latency_s ?? "?"} s</span></div>
        <p>${esc(d.summary)}</p>${causesHtml(d.causes)}
        <details><summary>Evidence</summary><ul>${d.causes.map((c) => `<li><b>${esc(causeName(c.cause))}</b>: ${esc(c.evidence)}</li>`).join("")}</ul></details>
        ${test}`;
    }
    const sepEl = feed.querySelector(".epsep");
    sepEl ? sepEl.after(el) : feed.prepend(el);
    if (!d) return;

    const E = epRec(r.episode);
    E.src = r.src || E.src; E.op = r.op || E.op;
    const prevStep = E.steps[E.steps.length - 1];
    const prevTest = prevStep?.test && E.tests[prevStep.test.id];
    if (prevTest) prevTest.done = true;
    const st = { step: r.step, causes: d.causes, severity: d.severity, test: dec.test || null, final: !!dec.final, op: r.op };
    const at = E.steps.findIndex((x) => x.step === r.step);
    if (at >= 0) E.steps[at] = st; else E.steps.push(st);
    if (dec.test) {
      const T = E.tests[dec.test.id] || (E.tests[dec.test.id] = { id: dec.test.id, n: 0, sum: {}, done: false });
      T.op = dec.test.op; T.hold_s = dec.test.hold_s;
    }
    renderStrip(E);
    renderVerdict(r, E);
    const pill = $("statePill");
    const ps = dec.final ? "latched" : dec.test ? "testing" : "diagnosing";
    pill.textContent = STATE_TEXT[ps]; pill.className = "pill " + ps;

    // story
    if (storyEp !== r.episode) { storyEp = r.episode; stage("stDrift", "done hot", "Episode " + r.episode, r.trigger === "gate" ? "" : "manual start"); }
    const [, line] = topLine(d);
    $("stStep").querySelector(".k").textContent = `AI step ${r.step}`;
    stage("stStep", "done", line, `${r.latency_s ?? "?"} s`);
    if (prevTest) {
      const hf = prevTest.n && prevTest.sum.hf ? `${prevTest.hfKey === "bhf" ? "hf" : "b3"} ×${(prevTest.sum.hf / prevTest.n).toFixed(2)}` : "done";
      stage("stTest", "done", null, hf);
    }
    if (dec.test) stage("stTest", "live", `${rpmOf(r.src, dec.test.op) || dec.test.op} rpm · ${dec.test.hold_s} s`, "starting");
    if (dec.final) {
      const sev = sevClass(d.severity);
      stage("stDiag", `done sev-${sev}`, line, r.truth ? (r.truth.correct ? `truth ${r.truth.label} · match` : `truth ${r.truth.label} · differs`) : d.severity);
      if (!r.tests?.length && !prevTest) stage("stTest", "skip", "None needed", "");
    } else stage("stDiag", "live", "Pending", "");
  }

  let lastPct = null;
  function verdictIdle(text) {
    $("verdict").className = "verdict";
    $("verdictBody").innerHTML = `<p class="idle">${esc(text)}</p>`;
  }
  function renderVerdict(r, E) {
    const d = r.diagnosis, dec = r.decision || {}, top = d.causes.slice().sort((a, b) => b.p - a.p)[0];
    const sev = sevClass(d.severity);
    const pct = Math.round(top.p * 100);
    const prev = E.steps.length > 1 ? E.steps[E.steps.length - 2] : null;
    const prevP = prev ? pmap(prev)[top.cause] : null;
    const truth = r.truth;
    $("verdict").className = `verdict sev-${sev}`;
    const body = $("verdictBody");
    body.innerHTML = `
      <div class="v-top"><b class="v-pct"><span id="vNum">${pct}</span><small>%</small></b>
        <div class="v-side"><span class="sev ${sev}">${esc(d.severity)}</span><span class="v-state">${dec.final ? "final" : "provisional"}</span></div></div>
      <h3 class="v-cause">${esc(causeName(top.cause))}</h3>
      <p class="v-meta">${prevP != null ? `<span class="v-move">${Math.round(prevP * 100)}% → ${pct}% after the test</span>` : `<span>testing before it commits</span>`}${truth ? `<span class="${truth.correct ? "ok" : "no"}">truth ${esc(truth.label)} · ${truth.correct ? "match" : "differs"}</span>` : ""}</p>
      <p class="v-action" title="${esc(d.action)}">${esc(d.action)}</p>`;
    if (!reduceMotion) { body.classList.remove("enter"); void body.offsetWidth; body.classList.add("enter"); }
    countUp($("vNum"), prevP != null ? Math.round(prevP * 100) : lastPct, pct, 1100, 200);
    lastPct = pct;
    setMotor({ diag: { cause: top.cause, p: top.p, severity: d.severity, final: !!dec.final, label: PART[top.cause] || causeName(top.cause) } });
  }

  setMotor({});
  if (REPLAY) startReplay(); else startLive();
})();
