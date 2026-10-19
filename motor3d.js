/* Cutaway motor for the dashboard's machine view. It spins at the node's shaft speed, speeds up when the
   AI orders a test, and lights the part named by the AI's top cause (amber while suspected, severity
   colour once final). three.js comes from jsDelivr through the page's import map. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const TAU = Math.PI * 2;
const HEX = { watch: 0xf5c542, alarm: 0xff6b4a, info: 0x3fd0a4, test: 0xa98bff, scan: 0xcfe3f5 };
const CSS = { watch: "#f5c542", alarm: "#ff6b4a", info: "#3fd0a4" };

// cause -> parts to light, plus how the rotor should misbehave while it is lit
const CAUSE = {
  bearing_outer_race: { parts: ["deOuter"] },
  bearing_inner_race: { parts: ["deInner"] },
  bearing_rolling_element: { parts: ["deBalls"] },
  bearing: { parts: ["deOuter", "deInner", "deBalls"] },
  eccentricity: { parts: ["rotorCore"], wobble: 0.03 },
  unbalance: { parts: ["rotorCore", "mass"], wobble: 0.025 },
  magnet_demagnetisation: { parts: ["magnets"] },
  stator_winding: { parts: ["windings"] },
  electrical_overload: { parts: ["windings"] },
  thermal_drift_wear: { parts: ["housing"] },
  cooling_failure: { parts: ["fan", "housing"] },
  sensor_mounting: { parts: ["sensor"], rattle: true },
  misalignment: { parts: ["coupling", "shaft"], tilt: 0.03 },
  load_change: { parts: ["coupling"] },
  bearing_or_brush_wear: { parts: ["brushes", "ndOuter"] },
};

export function createMotor(host) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "3D cutaway of the motor. Drag to turn it.");
  canvas.setAttribute("role", "img");
  host.prepend(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) {
    canvas.remove();
    throw e;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;

  const camera = new THREE.PerspectiveCamera(27, 1, 0.1, 60);
  camera.position.set(4.7, 2.5, 6.3);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0.6, -0.12, 0);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.minPolarAngle = 0.6;
  controls.maxPolarAngle = 1.5;
  controls.enabled = !matchMedia("(pointer: coarse)").matches;   // let touch scroll the page instead
  controls.update();
  const baseDist = camera.position.distanceTo(controls.target);

  scene.add(new THREE.HemisphereLight(0xa8ccf0, 0x0b1a2e, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fa8ff, 1.8);
  rim.position.set(-5, 2.5, -4);
  scene.add(rim);
  const glow = new THREE.PointLight(HEX.alarm, 0, 3.4, 1.4);
  scene.add(glow);

  // ---------------------------------------------------------------- geometry helpers (shaft along world X)
  const M = (color, metalness, roughness, o = {}) => new THREE.MeshStandardMaterial({ color, metalness, roughness, ...o });
  const add = (parent, obj) => (parent.add(obj), obj);
  // annular sector extruded along X; shape angle a maps to world direction (0, sin a, -cos a)
  function ringGeo(rOut, rIn, len, a0 = 0, a1 = TAU, seg = 48) {
    const s = new THREE.Shape();
    if (a1 - a0 >= TAU - 1e-6) {
      s.absarc(0, 0, rOut, 0, TAU, false);
      const h = new THREE.Path();
      h.absarc(0, 0, rIn, 0, TAU, true);
      s.holes.push(h);
    } else {
      s.moveTo(Math.cos(a0) * rOut, Math.sin(a0) * rOut);
      s.absarc(0, 0, rOut, a0, a1, false);
      s.lineTo(Math.cos(a1) * rIn, Math.sin(a1) * rIn);
      s.absarc(0, 0, rIn, a1, a0, true);
      s.closePath();
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: seg });
    g.translate(0, 0, -len / 2);
    g.rotateY(Math.PI / 2);
    g.computeVertexNormals();
    return g;
  }
  const cylX = (r, len, seg = 40) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);
  const dir = (a, r, x = 0) => new THREE.Vector3(x, Math.sin(a) * r, -Math.cos(a) * r);
  const at = (mesh, x, y = 0, z = 0) => (mesh.position.set(x, y, z), mesh);

  const parts = {};
  function reg(keyName, mesh) {
    const p = (parts[keyName] ||= { mats: new Set(), anchor: null });
    p.mats.add(mesh.material);
    return mesh;
  }
  function anchor(keyName, parent, pos) {
    const o = new THREE.Object3D();
    o.position.copy(pos);
    parent.add(o);
    (parts[keyName] ||= { mats: new Set(), anchor: null }).anchor = o;
  }

  // the cutaway removes the top-front quadrant so the inside faces the camera
  const A0 = THREE.MathUtils.degToRad(206), A1 = THREE.MathUtils.degToRad(434);
  const MID = THREE.MathUtils.degToRad(140);   // middle of the opening

  const machine = add(scene, new THREE.Group());
  const shake = add(machine, new THREE.Group());

  // ---------------------------------------------------------------- frame: housing, fins, bells, feet
  const mHousing = M(0x3a5f86, 0.55, 0.36, { side: THREE.DoubleSide });
  const mCast = M(0x2d4b6c, 0.5, 0.45, { side: THREE.DoubleSide });
  const mFeet = M(0x2a4562, 0.5, 0.5);
  reg("housing", add(shake, new THREE.Mesh(ringGeo(1.0, 0.93, 2.0, A0, A1, 64), mHousing)));
  const fins = add(shake, new THREE.Group());
  const finGeo = new THREE.BoxGeometry(1.84, 0.12, 0.034);
  for (let a = A0 + 0.1; a <= A1 - 0.1; a += 0.2) {
    const f = add(fins, new THREE.Mesh(finGeo, mHousing));
    f.position.copy(dir(a, 1.05));
    f.rotation.x = a - Math.PI / 2;
  }
  for (const x of [-1.1, 1.1]) {
    reg("housing", add(shake, at(new THREE.Mesh(ringGeo(1.03, 0.36, 0.2, A0, A1, 64), mHousing), x)));
    add(shake, at(new THREE.Mesh(ringGeo(0.43, 0.33, 0.34, A0, A1), mCast), x));
  }
  for (const x of [-0.62, 0.62]) add(shake, at(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 1.5), mFeet), x, -1.07));
  const tbox = add(shake, new THREE.Group());
  tbox.position.copy(dir(THREE.MathUtils.degToRad(58), 1.06, -0.2));
  tbox.rotation.x = THREE.MathUtils.degToRad(58) - Math.PI / 2;
  add(tbox, new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.26, 0.46), mCast));
  add(tbox, at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 16).rotateZ(Math.PI / 2), mFeet), 0.36, 0, 0));
  anchor("housing", shake, dir(THREE.MathUtils.degToRad(250), 1.08, -0.4));

  // soft contact shadow under the frame
  const sh = document.createElement("canvas");
  sh.width = sh.height = 128;
  const sg = sh.getContext("2d");
  const grad = sg.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 128, 128);
  const shadow = add(machine, new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.6),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.3, -1.25, 0);

  // ---------------------------------------------------------------- stator and windings
  const mStator = M(0x60738a, 0.75, 0.42, { side: THREE.DoubleSide });
  add(shake, new THREE.Mesh(ringGeo(0.92, 0.63, 1.3, A0, A1, 64), mStator));
  const mCopper = M(0xc8783a, 1, 0.3);
  const endTurn = new THREE.TorusGeometry(0.775, 0.1, 18, 80).rotateY(Math.PI / 2);
  for (const x of [-0.74, 0.74]) reg("windings", add(shake, at(new THREE.Mesh(endTurn, mCopper), x)));
  anchor("windings", shake, dir(MID, 0.8, 0.74));

  // ---------------------------------------------------------------- rotor assembly (spins about X)
  const pivot = add(shake, new THREE.Group());        // eccentric wobble and misalignment tilt
  const rotor = add(pivot, new THREE.Group());
  const mRotor = M(0x6f7d8e, 0.75, 0.38);
  reg("rotorCore", add(rotor, new THREE.Mesh(cylX(0.55, 1.26, 48), mRotor)));
  anchor("rotorCore", pivot, dir(MID, 0.56, -0.35));
  const magnets = add(rotor, new THREE.Group());
  const mMagA = M(0x2c3a4b, 0.5, 0.35), mMagB = M(0x4a5d74, 0.5, 0.35);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.05;
    reg("magnets", add(magnets, new THREE.Mesh(ringGeo(0.6, 0.552, 1.2, a, a + TAU / 8 - 0.1, 10), i % 2 ? mMagA : mMagB)));
  }
  anchor("magnets", pivot, dir(MID, 0.6, 0.25));
  const mSteel = M(0xb7c2cc, 1, 0.22);
  reg("shaft", add(rotor, at(new THREE.Mesh(cylX(0.11, 3.6, 28), mSteel), 0.17)));
  anchor("shaft", pivot, new THREE.Vector3(1.62, 0.12, 0));
  const mCoup = M(0x7d8b99, 0.9, 0.3), mSpider = M(0x1e2a36, 0.1, 0.8);
  reg("coupling", add(rotor, at(new THREE.Mesh(cylX(0.27, 0.26, 40), mCoup), 2.0)));
  reg("coupling", add(rotor, at(new THREE.Mesh(cylX(0.23, 0.07, 32), mSpider), 2.165)));
  reg("coupling", add(rotor, at(new THREE.Mesh(cylX(0.27, 0.26, 40), mCoup), 2.33)));
  add(rotor, at(new THREE.Mesh(cylX(0.11, 0.3, 24), mSteel), 2.6));
  // load drum on the output shaft, with a torque ring whose brightness and spin follow the load
  const drum = add(rotor, at(new THREE.Group(), 2.9));
  add(drum, new THREE.Mesh(cylX(0.4, 0.32, 48), M(0x26384c, 0.7, 0.35)));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    add(drum, at(new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.05, 0.05), M(0x8fa3b6, 0.9, 0.3)), 0, Math.sin(a) * 0.4, Math.cos(a) * 0.4));
  }
  const torqueMat = new THREE.MeshBasicMaterial({ color: 0xffd8a8, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending });
  const torque = add(shake, at(new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.016, 8, 80, 4.4).rotateY(Math.PI / 2), torqueMat), 2.9));
  const torque2 = add(shake, at(new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.01, 8, 80, 3.2).rotateY(Math.PI / 2), torqueMat), 2.9));
  anchor("coupling", pivot, new THREE.Vector3(2.165, 0.28, 0.05));
  const mMass = M(0xdfe6ec, 1, 0.25);
  const mass = reg("mass", add(rotor, at(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.14), mMass), 0.67, 0.36)));
  mass.visible = false;
  anchor("mass", pivot, new THREE.Vector3(0.67, 0.42, 0.1));
  // fan inside the rear cowl
  const mFan = M(0x4c6684, 0.6, 0.45, { side: THREE.DoubleSide });
  const fan = add(rotor, at(new THREE.Group(), -1.48));
  for (let i = 0; i < 7; i++) {
    const b = add(fan, new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.025), mFan));
    const a = (i / 7) * TAU;
    b.position.set(0, Math.sin(a) * 0.48, Math.cos(a) * 0.48);
    b.rotation.x = -a;
    b.rotation.y = 0.5;
    reg("fan", b);
  }
  const mCowl = M(0x33557a, 0.5, 0.45, { side: THREE.DoubleSide });
  reg("fan", add(shake, at(new THREE.Mesh(ringGeo(1.0, 0.95, 0.46, A0, A1, 64), mCowl), -1.45)));
  anchor("fan", shake, dir(MID, 0.7, -1.48));

  // ---------------------------------------------------------------- bearings (outer race static, inner race on the shaft)
  function bearing(x, pre) {
    const outer = M(0xd6dee6, 1, 0.14), inner = M(0xd6dee6, 1, 0.14), ball = M(0xeef2f6, 1, 0.08);
    reg(pre + "Outer", add(shake, at(new THREE.Mesh(ringGeo(0.31, 0.255, 0.14, 0, TAU, 40), outer), x)));
    reg(pre + "Inner", add(rotor, at(new THREE.Mesh(ringGeo(0.165, 0.11, 0.14, 0, TAU, 40), inner), x)));
    const cage = add(shake, at(new THREE.Group(), x));
    const bg = new THREE.SphereGeometry(0.043, 20, 14);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      reg(pre + "Balls", add(cage, at(new THREE.Mesh(bg, ball), 0, Math.sin(a) * 0.21, Math.cos(a) * 0.21)));
    }
    anchor(pre + "Outer", shake, dir(MID, 0.29, x));
    anchor(pre + "Inner", shake, dir(MID, 0.15, x));
    anchor(pre + "Balls", shake, dir(MID, 0.21, x));
    return cage;
  }
  const cages = [bearing(1.1, "de"), bearing(-1.1, "nd")];

  // ---------------------------------------------------------------- commutator and brushes (brushed DC machine only)
  const comm = add(rotor, at(new THREE.Group(), -0.86));
  add(comm, new THREE.Mesh(cylX(0.2, 0.26, 36), M(0xb8733c, 1, 0.28)));
  const mGap = M(0x1a1f26, 0.2, 0.8);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    add(comm, at(new THREE.Mesh(new THREE.BoxGeometry(0.262, 0.012, 0.03), mGap), 0, Math.sin(a) * 0.2, Math.cos(a) * 0.2)).rotation.x = -a;
  }
  const brushes = add(shake, new THREE.Group());
  const mCarbon = M(0x2b2f35, 0.15, 0.85), mHolder = M(0x8c99a6, 0.9, 0.35);
  for (const s of [1, -1]) {
    reg("brushes", add(brushes, at(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.1), mCarbon), -0.86, s * 0.3)));
    add(brushes, at(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.14), mHolder), -0.86, s * 0.43));
  }
  anchor("brushes", shake, new THREE.Vector3(-0.86, 0.32, 0.05));

  // ---------------------------------------------------------------- accelerometer on the drive-end frame, with its cable
  const aS = THREE.MathUtils.degToRad(222);
  const sensor = add(shake, new THREE.Group());
  sensor.position.copy(dir(aS, 1.08, 0.78));
  sensor.rotation.x = aS - Math.PI / 2;
  const mSensor = M(0x1e2b3a, 0.4, 0.5), mCap = M(0xd9e1e8, 0.9, 0.25);
  reg("sensor", add(sensor, new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.15, 0.17), mSensor)));
  reg("sensor", add(sensor, at(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 16), mCap), 0, 0.1)));
  anchor("sensor", sensor, new THREE.Vector3(0, 0.1, 0));
  const p0 = dir(aS, 1.22, 0.78);
  const cable = new THREE.CatmullRomCurve3([p0, dir(aS, 1.5, 0.95), new THREE.Vector3(1.25, -1.15, 1.25), new THREE.Vector3(1.7, -1.22, 1.55)]);
  add(shake, new THREE.Mesh(new THREE.TubeGeometry(cable, 40, 0.017, 8), M(0x101924, 0.2, 0.7)));

  // ---------------------------------------------------------------- scan ring (diagnosing: pale, test: violet)
  const ringMat = new THREE.MeshBasicMaterial({ color: HEX.scan, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = add(shake, new THREE.Mesh(new THREE.TorusGeometry(1.17, 0.012, 8, 120).rotateY(Math.PI / 2), ringMat));
  ring.visible = false;

  // ---------------------------------------------------------------- callout (HTML label with a leader line)
  const NS = "http://www.w3.org/2000/svg";
  const lead = document.createElementNS(NS, "svg");
  lead.setAttribute("class", "m3-lead");
  lead.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS(NS, "polyline");
  const dot = document.createElementNS(NS, "circle");
  const halo = document.createElementNS(NS, "circle");
  dot.setAttribute("r", "3.5");
  halo.setAttribute("r", "5");
  halo.setAttribute("class", "halo");
  lead.append(poly, halo, dot);
  const tag = document.createElement("div");
  tag.className = "m3-tag";
  tag.hidden = true;
  tag.setAttribute("aria-live", "polite");
  host.append(lead, tag);

  // ---------------------------------------------------------------- state
  const S = {
    src: null, target: 0, vis: 0, angle: 0, t: 0, load: 0, loadS: 0, state: "monitor", test: false, level: 0, levelS: 0,
    hl: [], col: new THREE.Color(HEX.watch), css: CSS.watch, final: false, hlT: 0, wob: 0, tilt: 0, rattle: false, diagKey: "", tagKey: "",
  };
  const visSpeed = (rpm) => (Math.min(Math.max(rpm || 0, 0), 3000) / 1500) * 0.85 * TAU;

  function setMachine(src) {
    const dc = src === "S3", pancake = src === "S2";
    magnets.visible = !dc;
    comm.visible = dc;
    brushes.visible = dc;
    fins.visible = !pancake;
    shake.scale.set(pancake ? 0.72 : dc ? 0.86 : 1, pancake ? 1.06 : dc ? 0.84 : 1, pancake ? 1.06 : dc ? 0.84 : 1);
  }

  function applyDiag(d) {
    for (const p of Object.values(parts)) for (const m of p.mats) { m.emissive.setHex(0); m.emissiveIntensity = 0; }
    const spec = d && CAUSE[d.cause];
    S.hl = spec ? spec.parts.filter((k) => parts[k] && parts[k].mats.size) : [];
    S.wob = spec?.wobble || 0;
    S.tilt = spec?.tilt || 0;
    S.rattle = !!spec?.rattle;
    mass.visible = d?.cause === "unbalance";
    const sev = d && d.final ? (d.severity === "alarm" ? "alarm" : d.severity === "info" ? "info" : "watch") : "watch";
    S.col.setHex(HEX[sev]);
    S.css = CSS[sev];
    S.final = !!d?.final;
    S.hlT = 0;
  }

  function update(o) {
    if (o.src && o.src !== S.src) { S.src = o.src; setMachine(o.src); }
    S.target = visSpeed(o.rpm);
    S.state = o.state || "monitor";
    S.test = !!o.test;
    S.level = Math.min(1, Math.max(0, o.level || 0));
    S.load = Math.min(1, Math.max(0, o.load || 0));
    const d = o.diag;
    const k = d ? `${d.cause}|${d.final}|${d.severity}` : "";
    if (k !== S.diagKey) { S.diagKey = k; applyDiag(d); }
    const tk = d && S.hl.length ? `${d.label}|${Math.round(d.p * 100)}|${d.final}` : "";
    if (tk !== S.tagKey) {
      S.tagKey = tk;
      if (tk) {
        tag.innerHTML = "";
        const b = document.createElement("b");
        b.textContent = d.label;
        const s = document.createElement("span");
        s.textContent = `${Math.round(d.p * 100)}% · ${d.final ? "final" : "suspect"}`;
        tag.append(b, s);
      }
      tag.hidden = !tk;
      host.style.setProperty("--c", S.css);
    }
  }

  // ---------------------------------------------------------------- frame loop
  const v = new THREE.Vector3();
  const clock = new THREE.Clock();
  function placeCallout() {
    if (!S.hl.length || tag.hidden) { lead.style.opacity = 0; glow.intensity = 0; return; }
    parts[S.hl[0]].anchor.getWorldPosition(v);
    glow.position.copy(v);
    v.project(camera);
    const w = host.clientWidth, h = host.clientHeight;
    const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
    const tx = tag.offsetLeft + tag.offsetWidth, ty = tag.offsetTop + tag.offsetHeight / 2;
    const ex = Math.max(tx + 14, Math.min(px - 18, tx + 40));
    poly.setAttribute("points", `${tx},${ty} ${ex},${ty} ${px},${py}`);
    for (const c of [dot, halo]) { c.setAttribute("cx", px); c.setAttribute("cy", py); }
    lead.style.opacity = 1;
  }
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    S.t += dt;
    const k = reduce ? 0.25 : 1;
    S.vis += (S.target - S.vis) * (1 - Math.exp(-dt * 1.4));          // smooth spin-up and spin-down
    S.angle += S.vis * k * dt;
    rotor.rotation.x = S.angle;
    for (const c of cages) c.rotation.x = S.angle * 0.4;

    if (S.wob && !reduce) pivot.position.set(0, Math.sin(S.angle) * S.wob, Math.cos(S.angle) * S.wob);
    else pivot.position.set(0, 0, 0);
    pivot.rotation.z = S.tilt;
    sensor.rotation.z = S.rattle && !reduce ? Math.sin(S.t * 38) * 0.07 : 0;

    S.levelS += (S.level - S.levelS) * (1 - Math.exp(-dt * 3));
    if (!reduce) {
      const a = 0.014 * S.levelS;
      shake.position.set(0, Math.sin(S.t * 61) * a + Math.sin(S.t * 37) * a * 0.5, Math.cos(S.t * 53) * a);
      machine.rotation.y = Math.sin(S.t * 0.13) * 0.1;
    }

    if (S.hl.length) {
      S.hlT += dt;
      const fade = Math.min(1, S.hlT / 0.9);
      const pulse = reduce ? 0.85 : 0.6 + 0.4 * Math.sin(S.t * (S.final ? 3.4 : 2.2));
      const I = (S.final ? 1.5 : 1.0) * pulse * fade;
      for (const kk of S.hl) for (const m of parts[kk].mats) { m.emissive.copy(S.col); m.emissiveIntensity = I; }
      glow.color.copy(S.col);
      glow.intensity = 5 * pulse * fade;
    }

    S.loadS += (S.load - S.loadS) * (1 - Math.exp(-dt * 2));
    torqueMat.opacity = 0.12 + 0.75 * S.loadS;
    torque.rotation.x -= dt * (0.6 + 2.5 * S.loadS) * k;
    torque2.rotation.x += dt * (0.4 + 1.6 * S.loadS) * k;
    const scanning = S.state === "diagnosing" || S.test;
    const want = scanning ? (S.test ? 0.95 : 0.6) : 0;
    ringMat.opacity += (want - ringMat.opacity) * (1 - Math.exp(-dt * 4));
    ringMat.color.setHex(S.test ? HEX.test : HEX.scan);
    ring.position.x = reduce ? 0 : Math.sin(S.t * 1.15) * 1.02;
    ring.visible = ringMat.opacity > 0.01;

    controls.update();
    renderer.render(scene, camera);
    placeCallout();
  }

  // ---------------------------------------------------------------- size, visibility
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const d = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(d, baseDist * 1.08 * Math.max(1, 1.45 / camera.aspect));
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  let onScreen = true;
  const run = () => {
    const go = onScreen && document.visibilityState === "visible";
    renderer.setAnimationLoop(go ? frame : null);
    if (go) clock.getDelta();
  };
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); });
  io.observe(host);
  document.addEventListener("visibilitychange", run);
  run();

  return {
    update,
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", run);
      renderer.dispose();
    },
  };
}
