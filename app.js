/* Active-RCA live dashboard - talks to the broker directly over MQTT/WSS. */
(() => {
  "use strict";
  const qs = new URLSearchParams(location.search);
  const CFG = {
    site: qs.get("site") || window.ARCA.site,
    device: qs.get("device") || window.ARCA.device,
    broker: qs.get("broker") || window.ARCA.broker,
  };
  const ROOT = `pccoe/arca/${CFG.site}/${CFG.device}`;
  const MAXPTS = 120;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? "—" : Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v).toPrecision(d));
  const pretty = (c) => String(c || "").replace(/_/g, " ");

  $("devName").textContent = CFG.device;
  $("topicRoot").textContent = ` · topics ${ROOT}/…`;

  let MAN = null;
  let node = {};
  let scn = null;
  let lastEp = null;
  let nodeSeen = 0;

  // ------------------------------------------------------------------ charts
  Chart.defaults.color = "#93a7bc";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  const grid = { color: "rgba(147,167,188,.12)" };
  function mkChart(el, sets, yTitle) {
    return new Chart($(el), {
      type: "line",
      data: { labels: [], datasets: sets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, spanGaps: true,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw == null ? null : `${c.dataset.label}: ${fmt(c.raw, 4)}` } } },
        scales: {
          x: { grid, ticks: { maxTicksLimit: 8 }, title: { display: true, text: "window #" } },
          y: { grid, title: { display: !!yTitle, text: yTitle } },
        },
        elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.15 } },
      },
    });
  }
  const bandSets = (label) => [
    { label: "healthy +3σ", data: [], borderColor: "rgba(63,178,127,.55)", borderWidth: 1, backgroundColor: "rgba(63,178,127,.14)", fill: "+1", pointRadius: 0 },
    { label: "healthy −3σ", data: [], borderColor: "rgba(63,178,127,.55)", borderWidth: 1, fill: false, pointRadius: 0 },
    { label, data: [], borderColor: "#6fb3df", fill: false },
    { label: "test window", data: [], borderColor: "#b48ae8", backgroundColor: "#b48ae8", showLine: false, pointRadius: 4 },
  ];
  const cRms = mkChart("cRms", bandSets("rms"));
  const cHf = mkChart("cHf", bandSets("band energy"));
  const cAux = mkChart("cAux", [
    { label: "a", data: [], borderColor: "#e3a63b", fill: false },
    { label: "b", data: [], borderColor: "#6fb3df", fill: false },
    { label: "c", data: [], borderColor: "#b48ae8", fill: false },
  ]);
  const charts = [cRms, cHf, cAux];
  const seqIdx = new Map();

  function clearCharts() {
    for (const c of charts) { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); c.update(); }
    seqIdx.clear();
  }
  function push(c, seq, vals) {
    c.data.labels.push(seq);
    c.data.datasets.forEach((d, i) => d.data.push(vals[i] ?? null));
    if (c.data.labels.length > MAXPTS) { c.data.labels.shift(); c.data.datasets.forEach((d) => d.data.shift()); }
  }
  function setAt(c, seq, i, v) {
    const k = c.data.labels.indexOf(seq);
    if (k >= 0) c.data.datasets[i].data[k] = v;
  }

  // ------------------------------------------------------------------ manifest + controls
  fetch("data/manifest.json").then((r) => r.json()).then((m) => { MAN = m; fillSrc(); }).catch(() => {
    $("cmdHint").textContent = "data/manifest.json not found - controls disabled";
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
      $("selOp").innerHTML = Object.entries(src.ops).map(([k, v]) => {
        const has = files[`${cond}_${k}`];
        return `<option value="${k}" ${has ? "" : "disabled"}>${esc(v.desc)}${has ? "" : " (no recording)"}</option>`;
      }).join("");
      $("selOp").value = files[`${cond}_${src.default_op}`] ? src.default_op : Object.keys(src.ops).find((k) => files[`${cond}_${k}`]);
    };
    $("selCond").onchange = fillOps;
    fillOps();
  }
  function hint(t, cls = "") { const h = $("cmdHint"); h.textContent = t; h.className = "hint " + cls; }
  $("btnDeploy").onclick = () => {
    const cmd = { v: 1, cmd: "scenario", id: "ui-" + Date.now().toString(36), src: $("selSrc").value, cond: $("selCond").value, op: $("selOp").value };
    client.publish(`${ROOT}/cmd`, JSON.stringify(cmd), { qos: 1 });
    hint(`Sent: ${cmd.src} ${cmd.cond} @ ${cmd.op} - waiting for the node…`);
  };
  $("btnDiagnose").onclick = () => { client.publish(`${ROOT}/ctl`, JSON.stringify({ cmd: "diagnose" }), { qos: 1 }); hint("Asked the bridge to start a diagnosis."); };
  $("btnReset").onclick = () => { client.publish(`${ROOT}/ctl`, JSON.stringify({ cmd: "reset" }), { qos: 1 }); hint("Episode reset requested."); };

  // ------------------------------------------------------------------ mqtt
  const client = mqtt.connect(CFG.broker, { clientId: "arca-ui-" + Math.random().toString(16).slice(2, 8), clean: true, reconnectPeriod: 3000, connectTimeout: 10000 });
  const chip = (id, on, text) => { const c = $(id); c.className = "chip " + (on ? "on" : "off"); c.lastChild.textContent = text; };
  client.on("connect", () => { chip("chipBroker", true, "broker"); client.subscribe(`${ROOT}/#`, { qos: 0 }); });
  client.on("close", () => chip("chipBroker", false, "broker offline"));
  client.on("message", (topic, buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const leaf = topic.slice(ROOT.length + 1);
    if (leaf === "telemetry") onTel(m);
    else if (leaf === "gate") onGate(m);
    else if (leaf === "rca") onRca(m);
    else if (leaf === "status") onStatus(m);
    else if (leaf === "bridge") chip("chipBridge", m.online, m.online ? `bridge · ${m.engine}` : "bridge offline");
  });
  setInterval(() => { if (nodeSeen && Date.now() - nodeSeen > 15000) chip("chipNode", false, "node silent"); }, 5000);

  // ------------------------------------------------------------------ handlers
  function srcInfo(src) { return MAN?.sources?.[src]; }
  function opDesc(src, op) { return srcInfo(src)?.ops?.[op]?.desc || op; }

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
    if (!t.test) syncControls(t);
    chip("chipNode", true, `node · ${t.fw || ""}`);
    if (t.scn !== scn) { scn = t.scn; clearCharts(); }
    const s = srcInfo(t.src);
    $("rmsUnit").textContent = t.vib.cal_ok ? "(m/s²)" : "(sensor units)";
    const hasHf = t.spec.bhf != null;
    $("hfTitle").textContent = hasHf ? "1–5 kHz bearing band (bhf)" : "800–2500 Hz band (b3)";
    const hf = hasHf ? t.spec.bhf : t.spec.b3;
    const isTest = !!t.test;
    push(cRms, t.seq, [null, null, t.vib.rms_ms2, isTest ? t.vib.rms_ms2 : null]);
    push(cHf, t.seq, [null, null, hf, isTest ? hf : null]);
    cHf.data.datasets[2].label = hasHf ? "bhf" : "b3";
    let aux;
    if (t.temp.valid) {
      $("auxTitle").innerHTML = "Temperature (°C)" + (t.cur.valid ? ` <span class="dim">· current now ${fmt(t.cur.rms_a, 3)} A</span>` : "");
      aux = [t.temp.c, null, null];
      cAux.data.datasets[0].label = "temp °C";
    } else {
      $("auxTitle").textContent = "Per-axis vibration RMS (no temperature sensor)";
      aux = [t.vib.x_rms, t.vib.y_rms, t.vib.z_rms];
      cAux.data.datasets[0].label = "x"; cAux.data.datasets[1].label = "y"; cAux.data.datasets[2].label = "z";
    }
    push(cAux, t.seq, aux);
    charts.forEach((c) => c.update("none"));
    node.lastTel = t;
    $("kvSrc").textContent = s ? `${t.src} · ${s.name}` : t.src;
    $("kvCond").innerHTML = `<span class="truth">${esc(t.label)}</span> <span class="dim">${esc(s?.conds?.[t.label] || "")} (ground truth - hidden from the LLM)</span>`;
    $("kvOp").textContent = `${t.op} · ${opDesc(t.src, t.op)} · ${fmt(t.rpm.avg, 4)} rpm`;
    $("kvTest").textContent = t.test ? `${t.test.id} · ${t.test.phase} · ${t.test.left} left` : "—";
    $("kvReplay").textContent = t.replay ? `${(t.replay.file || "").split("/").pop()} · window ${t.replay.win + 1}/${t.replay.of || "?"}` : "—";
    $("kvFw").textContent = `${t.fw || "?"} · ${t.win.sample_hz} Hz · seq ${t.seq}`;
  }

  function onGate(g) {
    const b = g.base || {};
    const band = (k) => (b[k] ? [b[k][0] + 3 * b[k][1], Math.max(0, b[k][0] - 3 * b[k][1])] : [null, null]);
    const [ru, rl] = band("rms");
    setAt(cRms, g.seq, 0, ru); setAt(cRms, g.seq, 1, rl);
    const [hu, hl] = band(b.bhf ? "bhf" : "b3");
    setAt(cHf, g.seq, 0, hu); setAt(cHf, g.seq, 1, hl);
    cRms.update("none"); cHf.update("none");
    const st = $("statePill"); st.textContent = g.state + (g.episode ? ` · ${g.episode}` : ""); st.className = "pill " + g.state;
    $("streak").textContent = g.test ? `test window (${g.test})` : `streak ${g.streak} / 3`;
    const z = g.z || {};
    $("zbars").innerHTML = Object.entries(z).map(([k, v]) => {
      const cl = Math.max(-12, Math.min(12, v));
      const w = (Math.abs(cl) / 12) * 50;
      const left = cl >= 0 ? 50 : 50 - w;
      const hot = Math.abs(v) > 3;
      return `<span class="n">${esc(k)}</span><div class="zt"><span class="mid"></span><span class="lim" style="left:${50 - 12.5}%"></span><span class="lim" style="left:${50 + 12.5}%"></span><span class="bar ${hot ? "hot" : ""}" style="left:${left}%;width:${w}%"></span></div><span class="v">${v > 0 ? "+" : ""}${v.toFixed(1)}</span>`;
    }).join("") || `<span class="dim" style="grid-column:1/-1">No healthy baseline for this operating point - the gate cannot score it.</span>`;
  }

  function onStatus(s) {
    if (s.online === false) { chip("chipNode", false, "node offline"); return; }
    nodeSeen = Date.now();
    if (s.ack && s.ack.id && s.ack.id.startsWith("ui-")) hint(`${s.ack.ok ? "Node accepted" : "Node rejected"}: ${s.ack.msg}`, s.ack.ok ? "ok" : "err");
    $("kvAck").textContent = s.ack?.id ? `${s.ack.id} · ${s.ack.ok ? "ok" : "rejected"} · ${s.ack.msg}` : "—";
    if (s.test) $("kvTest").textContent = `${s.test.id} → ${s.test.op} · ${s.test.done}/${s.test.hold}`;
  }

  function causesHtml(causes) {
    return (causes || []).slice(0, 4).map((c) => `<div class="cause"><span>${esc(pretty(c.cause))}</span><span class="pv">${Math.round(c.p * 100)}%</span><span class="pb"><i style="width:${Math.round(c.p * 100)}%"></i></span></div>`).join("");
  }

  function onRca(r) {
    const feed = $("feed");
    if (r.episode !== lastEp) {
      lastEp = r.episode;
      const sep = document.createElement("div");
      sep.className = "epsep";
      sep.textContent = `Episode ${r.episode} · ${r.trigger || ""} · ${r.src || ""} @ ${r.op ? opDesc(r.src, r.op) : ""}`;
      feed.prepend(sep);
    }
    const d = r.diagnosis;
    const dec = r.decision || {};
    const el = document.createElement("div");
    el.className = "step" + (dec.final ? " final" : "");
    if (!d) {
      el.innerHTML = `<div class="meta"><span>${esc(r.episode)} · ${esc(dec.why)}</span></div><p>${esc(dec.error || "")}</p>`;
    } else {
      const test = dec.test ? `<div class="nexttest"><b>Test ordered:</b> ${esc(opDesc(r.src, dec.test.op))} for ${dec.test.hold_s} s<br><span class="dim">${esc(d.test_rationale)}</span></div>` : "";
      const fin = dec.final ? `<p class="dim">Stopped: ${esc(pretty(dec.why))} · ${r.tests?.length || 0} test(s) · ${r.duration_s ?? "?"} s total</p>` : "";
      el.innerHTML = `<div class="meta"><span>${esc(r.episode)} · step ${r.step} · ${esc(r.engine)}</span><span>${r.latency_s ?? "?"} s</span></div>
        <p>${esc(d.summary)}</p>${causesHtml(d.causes)}
        <details><summary>evidence cited</summary><ul>${d.causes.map((c) => `<li><b>${esc(pretty(c.cause))}</b>: ${esc(c.evidence)}</li>`).join("")}</ul></details>
        ${test}${fin}`;
    }
    const sepEl = feed.querySelector(".epsep");
    sepEl ? sepEl.after(el) : feed.prepend(el);
    if (d) renderVerdict(r);
  }

  function renderVerdict(r) {
    const d = r.diagnosis, dec = r.decision || {}, top = d.causes[0];
    const truth = r.truth;
    $("verdictBody").innerHTML = `
      <div class="vhead"><span class="vcause">${esc(pretty(top.cause))}</span><span class="vp">${Math.round(top.p * 100)}%</span></div>
      <p style="margin:6px 0"><span class="sev ${esc(d.severity)}">${esc(d.severity)}</span>
        <span class="dim"> ${dec.final ? "final" : "provisional - test running"} · ${esc(r.episode)} · ${esc(r.engine)}</span></p>
      <p class="vaction">${esc(d.action)}</p>
      ${truth ? `<p class="vtruth">Injected: <b>${esc(truth.label)}</b> (${esc(pretty(truth.cause))}) → ${truth.correct ? '<b class="ok">diagnosis correct</b>' : '<b class="no">diagnosis differs</b>'}</p>` : ""}`;
  }
})();
