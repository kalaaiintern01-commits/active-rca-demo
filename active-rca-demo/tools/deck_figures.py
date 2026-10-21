"""
Figures for the presentation deck, drawn from the real replay slices, trained baselines,
signature library and recorded episodes (nothing illustrative). Colours match the Canva deck.

    python tools/deck_figures.py            -> docs/deck/*.png
"""
import json
import re
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, Rectangle, Circle
from scipy.signal import welch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))
import pdmfeat as pf  # noqa: E402
from gate import sd_eff, zscores  # noqa: E402

OUT = ROOT / "docs" / "deck"
OUT.mkdir(parents=True, exist_ok=True)
MAN = json.loads((ROOT / "site/data/manifest.json").read_text())
BASE = json.loads((ROOT / "bridge/model/baselines.json").read_text())
SIG = json.loads((ROOT / "bridge/model/signatures.json").read_text())

BG, PANEL, LINE = "#1f2d3d", "#26384d", "#3a5370"
INK, MUTE = "#e9eff5", "#93a7bc"
BLUE, LIGHT = "#4891c0", "#8cc4e8"
HOT, AMBER, VIOLET, GREEN = "#ff6b4a", "#f5c542", "#a98bff", "#3fd0a4"
plt.rcParams.update({
    "font.family": "Segoe UI", "font.size": 13, "text.color": INK, "axes.labelcolor": MUTE,
    "axes.edgecolor": LINE, "xtick.color": MUTE, "ytick.color": MUTE, "axes.facecolor": BG,
    "figure.facecolor": BG, "savefig.facecolor": BG, "axes.titlecolor": INK, "axes.titleweight": "bold",
    "axes.titlesize": 14, "axes.titlelocation": "left", "axes.spines.top": False, "axes.spines.right": False,
})


def save(fig, name):
    fig.savefig(OUT / name, dpi=200, bbox_inches="tight", pad_inches=0.12)
    plt.close(fig)
    print("wrote", name)


def window(src, rec, k=0):
    buf = (ROOT / "site/data" / src / f"{rec}.bin").read_bytes()
    for i, (h, x) in enumerate(pf.read_windows(buf)):
        if i == k:
            return h, x


def feats(src, rec, k=0):
    h, x = window(src, rec, k)
    return pf.features(x, h, MAN["sources"][src]["pole_pairs"]), h


# ------------------------------------------------------------------ 1. raw signals the node replays
def fig_raw():
    rows = [("S1", "K001_N15_M07_F10", "KA01_N15_M07_F10", "S1 Paderborn PMSM · 1500 rpm · 10 kHz", "m/s²"),
            ("S2", "NR_750", "SF_750", "S2 CubeMars PMSM · 750 rpm · 5 kHz (x axis)", "m/s²"),
            ("S3", "NEW_3V", "RUN_3V", "S3 CARTIF DC motor · 3 V · 5 kHz", "sensor units")]
    labels = {"K001": "healthy", "KA01": "outer-race damage", "NR": "healthy", "SF": "stator fault",
              "NEW": "new motor", "RUN": "after stress run"}
    fig, axs = plt.subplots(3, 2, figsize=(11.5, 7.2), sharex=True)
    for r, (src, hrec, frec, title, unit) in enumerate(rows):
        hh, xh = window(src, hrec)
        hf, xf = window(src, frec, 40 if src == "S3" else 0)
        n = int(0.1 * hh.fs)
        t = np.arange(n) / hh.fs * 1000
        vi = hh.vib_idx[0]
        a, b = xh[:n, vi] - xh[:n, vi].mean(), xf[:n, vi] - xf[:n, vi].mean()
        lim = 1.1 * max(np.abs(a).max(), np.abs(b).max())
        for c, (sig, col, rec) in enumerate([(a, LIGHT, hrec), (b, HOT, frec)]):
            ax = axs[r, c]
            ax.plot(t, sig, color=col, lw=0.8)
            ax.set_ylim(-lim, lim)
            rms = np.sqrt(np.mean((xh if c == 0 else xf)[:, vi] ** 2 - 0) - np.mean((xh if c == 0 else xf)[:, vi]) ** 2)
            ax.set_title(f"{labels[rec.split('_')[0]]}   rms {rms:.3g}", color=col, fontsize=12.5)
            if c == 0:
                ax.set_ylabel(unit)
                ax.annotate(title, xy=(0, 1.32), xycoords="axes fraction", fontsize=13.5, color=INK, fontweight="bold")
            ax.grid(alpha=0.12)
    for ax in axs[-1]:
        ax.set_xlabel("time within the 2 s window (ms) - first 100 ms shown")
    fig.tight_layout(h_pad=2.2)
    save(fig, "01_raw_signals.png")


# ------------------------------------------------------------------ 2. spectrum and the bands the features measure
def fig_spectrum():
    fh, h = feats("S1", "K001_N15_M07_F10")
    ff, _ = feats("S1", "KA01_N15_M07_F10")
    fig, ax = plt.subplots(figsize=(11.5, 5.6))
    for rec, col, lab in [("K001_N15_M07_F10", LIGHT, "healthy (K001)"), ("KA01_N15_M07_F10", HOT, "outer-race damage (KA01)")]:
        hh, x = window("S1", rec)
        f, p = welch(x[:, 0], fs=hh.fs, window="hann", nperseg=1024, noverlap=0, detrend="constant")
        ax.loglog(f[1:], p[1:], color=col, lw=1.4, label=lab)
    bands = [(0.5, 50, "b0  0-50 Hz"), (50, 200, "b1  50-200"), (200, 800, "b2  200-800"), (800, 2500, "b3  800-2500")]
    for i, (lo, hi, lab) in enumerate(bands):
        ax.axvspan(max(lo, 5), hi, color=[BLUE, LIGHT][i % 2], alpha=0.07)
        ax.text(np.sqrt(max(lo, 5) * hi), 2.2e-1, lab, ha="center", color=MUTE, fontsize=11.5)
    ax.annotate("", xy=(5000, 4e-2), xytext=(1000, 4e-2), arrowprops=dict(arrowstyle="<->", color=AMBER, lw=1.4))
    ax.text(2240, 5.5e-2, "bhf  1-5 kHz (bearing band)", ha="center", color=AMBER, fontsize=11.5)
    fr = h.rpm / 60
    for mult, lab in [(1, "1x"), (2, "2x"), (4, "pole-pass")]:
        ax.axvline(mult * fr, color=GREEN, lw=1, ls="--", alpha=0.8)
        ax.text(mult * fr * 1.04, 1.5e-8, f"{lab}\n{mult * fr:.0f} Hz", color=GREEN, fontsize=10.5)
    ax.set_xlim(5, 5000)
    ax.set_ylim(1e-8, 1)
    ax.set_xlabel("frequency (Hz)")
    ax.set_ylabel("power spectral density ((m/s²)²/Hz)")
    ax.legend(frameon=False, loc=(0.01, 0.22), fontsize=12)
    ax.grid(alpha=0.12, which="both")
    r = ff["bhf"] / fh["bhf"]
    ax.set_title(f"One 2 s window, S1 at 1500 rpm: the damaged bearing lifts the 1-5 kHz band {r:.1f}x", fontsize=14)
    save(fig, "02_spectrum_bands.png")


# ------------------------------------------------------------------ 3. the exact feature list with real values
FEATURES = [
    ("rms", "vib.rms_ms2", "AC RMS over all vibration axes", "overall vibration level"),
    ("peak", "vib.peak_ms2", "largest excursion from the mean", "single impacts"),
    ("crest", "vib.crest", "peak / rms", "spikiness (sine = 1.41)"),
    ("kurt", "spec.kurt", "4th moment / sigma^4", "impacts raise it above 3"),
    ("skew", "spec.skew", "3rd moment / sigma^3", "asymmetry"),
    ("x/y/z_rms", "vib.x_rms ...", "RMS per axis (S2 has 3)", "direction of the shaking"),
    ("b0", "spec.b0", "PSD energy 0-50 Hz", "shaft-rate / looseness"),
    ("b1", "spec.b1", "PSD energy 50-200 Hz", "harmonics / pole-pass"),
    ("b2", "spec.b2", "PSD energy 200-800 Hz", "mid-band structure"),
    ("b3", "spec.b3", "PSD energy 800-2500 Hz", "early bearing / friction"),
    ("bhf", "spec.bhf", "PSD energy 1-5 kHz (fs >= 10 kHz)", "classic bearing-defect band"),
    ("a1x", "spec.a1x", "amplitude at 1x shaft speed", "unbalance, eccentricity"),
    ("a2x", "spec.a2x", "amplitude at 2x shaft speed", "misalignment, eccentricity"),
    ("app", "spec.app", "amplitude at pole-pass (pp x f_r)", "magnet faults"),
    ("fdom", "spec.fdom", "frequency of the largest PSD bin", "what dominates"),
    ("cur_rms", "cur.rms_a", "true RMS of phase / armature current", "load, electrical faults"),
    ("cur_mean", "cur.mean_a", "mean current", "load level"),
]


def fig_feature_table():
    fh, _ = feats("S1", "K001_N15_M07_F10")
    ff, _ = feats("S1", "KA01_N15_M07_F10")
    fig, ax = plt.subplots(figsize=(12.6, 7.4))
    ax.axis("off")
    cols = [0.0, 0.11, 0.25, 0.53, 0.75, 0.86, 0.95]
    heads = ["feature", "telemetry field", "how it is computed", "what it reveals", "healthy", "damaged", "ratio"]
    y = 1.0
    ax.add_patch(Rectangle((-0.01, y - 0.045), 1.03, 0.055, color=BLUE, transform=ax.transAxes, clip_on=False))
    for x, t in zip(cols, heads):
        ax.text(x, y - 0.018, t, transform=ax.transAxes, fontsize=12, fontweight="bold", color="white", va="center")
    y -= 0.055
    step = 0.94 / len(FEATURES)
    for i, (k, field, how, why) in enumerate(FEATURES):
        if i % 2 == 0:
            ax.add_patch(Rectangle((-0.01, y - step + 0.006), 1.03, step, color=PANEL, transform=ax.transAxes, clip_on=False))
        yy = y - step / 2 + 0.003
        if k == "x/y/z_rms":
            hv = fv = None
        else:
            hv, fv = fh.get(k), ff.get(k)
        r = (fv / hv) if (hv and fv is not None and k not in ("fdom", "skew", "cur_mean")) else None
        fmt = (lambda v: f"{v:.0f} Hz") if k == "fdom" else (lambda v: f"{v:.3g}")
        cells = [k, field, how, why, "-" if hv is None else fmt(hv), "-" if fv is None else fmt(fv),
                 "-" if r is None else f"{r:.2f}x"]
        for j, (x, t) in enumerate(zip(cols, cells)):
            col = INK if j in (0, 4, 5) else MUTE
            if j == 6 and r is not None:
                col = HOT if (r > 1.5 or r < 0.67) else INK
            ax.text(x, yy, t, transform=ax.transAxes, fontsize=11.5, color=col, va="center",
                    fontweight="bold" if j in (0, 6) else "normal", family="Consolas" if j == 1 else "Segoe UI")
        y -= step
    ax.text(0, -0.02, "Real values for one 2 s window of S1 at 1500 rpm, 0.7 N·m, 1000 N (K001 healthy vs KA01 outer-race damage).\n"
            "1024-point Hann FFT, Welch-averaged over 19 frames. S1 has one vibration axis, so x/y/z rms is S2 only. "
            "No ratio for signed or location features (skew, mean current, fdom).",
            transform=ax.transAxes, fontsize=10.5, color=MUTE, va="top")
    save(fig, "03_feature_table.png")


# ------------------------------------------------------------------ 4. healthy baselines and the fault fingerprint library
def fig_signatures():
    feats_ = ["rms", "kurt", "b0", "b1", "b2", "b3", "a1x", "a2x", "app"]
    codes = [("BF", "bearing"), ("EF", "eccentricity"), ("MF", "magnet"), ("SF", "stator")]
    ops = ["500", "750", "1000"]
    fig, axs = plt.subplots(1, 3, figsize=(12.6, 4.6), sharey=True)
    cmap = matplotlib.colors.LinearSegmentedColormap.from_list("d", ["#2f6e9e", PANEL, "#c4553f", HOT])
    for a, op in zip(axs, ops):
        m = np.array([[SIG["S2"][c][op].get(f, np.nan) for f in feats_] for c, _ in codes])
        a.imshow(np.log10(m), cmap=cmap, vmin=-1, vmax=3, aspect="auto")
        for i in range(m.shape[0]):
            for j in range(m.shape[1]):
                v = m[i, j]
                a.text(j, i, f"{v:.3g}" if v < 100 else f"{v:.0f}", ha="center", va="center", fontsize=9.5,
                       color="white")
        a.set_xticks(range(len(feats_)), feats_, rotation=0, fontsize=10.5)
        a.set_title(f"{op} rpm", fontsize=13)
        a.spines[:].set_visible(False)
        a.tick_params(length=0)
    axs[0].set_yticks(range(len(codes)), [n for _, n in codes], fontsize=12)
    fig.suptitle("S2 fault fingerprints = median (fault / healthy) feature ratio on the TRAINING recordings",
                 x=0.01, ha="left", fontsize=14, fontweight="bold", color=INK)
    fig.text(0.01, -0.02, "Blue < 1 (lower than healthy), red > 1 (higher). Note the stator fault: almost healthy at 500 rpm, "
             "large at 750 and 1000 rpm - a speed change separates it from eccentricity.", fontsize=11, color=MUTE)
    fig.tight_layout()
    save(fig, "04_signatures.png")


# ------------------------------------------------------------------ 5. circuit diagram (from firmware/diagram.json)
def fig_circuit():
    fig, ax = plt.subplots(figsize=(12.4, 7.0))
    ax.set_xlim(0, 124)
    ax.set_ylim(0, 70)
    ax.axis("off")

    def rbox(x, y, w, h):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4,rounding_size=1.2", fc=PANEL, ec=LINE, lw=1.6))

    def wire(pts, col):
        xs, ys = zip(*pts)
        ax.plot(xs, ys, color=col, lw=2.2, solid_capstyle="round", zorder=1)

    # ESP32
    rbox(46, 10, 32, 50)
    ax.text(62, 57.4, "ESP32 DevKit v1", ha="center", va="top", fontsize=13, fontweight="bold")
    ax.text(62, 53.6, "ESP32-WROOM-32 · Wi-Fi", ha="center", va="top", fontsize=10.5, color=MUTE)
    left = [("3V3", 50), ("GND", 45), ("D21  SDA", 40), ("D22  SCL", 35), ("D32", 26), ("D33", 20)]
    right = [("D25", 44), ("D26", 36), ("D27", 28), ("GND", 18)]
    for name, y in left:
        ax.plot([44, 46], [y, y], color=MUTE, lw=2)
        ax.text(47.5, y, name, va="center", fontsize=11, family="Consolas")
    for name, y in right:
        ax.plot([78, 80], [y, y], color=MUTE, lw=2)
        ax.text(76.5, y, name, va="center", ha="right", fontsize=11, family="Consolas")
    ax.text(62, 13, "TX0 / RX0 -> serial monitor", ha="center", fontsize=10, color=MUTE)

    # OLED: each wire turns down in its own column, so no two wires cross
    rbox(4, 40, 24, 22)
    ax.text(14, 59.4, "SSD1306 OLED", ha="center", va="top", fontsize=13, fontweight="bold")
    ax.text(14, 55.6, "128x64 · I²C 0x3C", ha="center", va="top", fontsize=10.5, color=MUTE)
    for i, (lab, y, col, py) in enumerate([("VCC", 57, HOT, 50), ("GND", 53, MUTE, 45), ("SDA", 49, BLUE, 40),
                                           ("SCL", 45, "#5fd3e6", 35)]):
        ax.text(27, y, lab, ha="right", va="center", fontsize=10.5, family="Consolas")
        vx = 41.5 - 2 * i
        wire([(28.5, y), (vx, y), (vx, py), (44, py)], col)

    # buttons (INPUT_PULLUP: pin -> button -> GND)
    for lab, col, by, py in [("FAULT", HOT, 21.5, 26), ("SOURCE", BLUE, 9.5, 20)]:
        rbox(6, by, 22, 9)
        ax.add_patch(Circle((10.5, by + 4.5), 2.0, color=col))
        ax.text(14.5, by + 4.5, f"{lab}\nbutton", va="center", fontsize=11.5, fontweight="bold", linespacing=1.1)
        mid = by + 4.5
        wire([(28.5, mid), (44, py)] if mid == py else [(28.5, mid), (36, mid), (36, py), (44, py)], AMBER)
        wire([(6, mid), (3, mid), (3, 3)], MUTE)
    ax.text(17, 33.5, "INPUT_PULLUP: idle HIGH,\npressed = LOW", ha="center", fontsize=10, color=MUTE)

    # LEDs + 220 ohm to the GND rail
    for lab, col, y in [("PUB", GREEN, 44), ("TEST", BLUE, 36), ("ALARM", HOT, 28)]:
        wire([(80, y), (88, y)], col)
        ax.add_patch(Circle((90.5, y), 2.2, color=col))
        ax.text(90.5, y + 3.4, lab, ha="center", fontsize=10.5, fontweight="bold")
        wire([(92.7, y), (96, y)], MUTE)
        ax.add_patch(Rectangle((96, y - 1.2), 7, 2.4, fc=PANEL, ec=MUTE, lw=1.4))
        ax.text(99.5, y - 4.2, "220 Ω", ha="center", fontsize=10, color=MUTE)
        wire([(103, y), (112, y)], MUTE)
    wire([(80, 18), (112, 18)], MUTE)
    wire([(112, 44), (112, 3), (3, 3)], MUTE)
    ax.text(70, 4.4, "common GND rail", ha="center", fontsize=10.5, color=MUTE)
    ax.text(114, 36, "(3.3 - 2.0) V / 220 Ω\n≈ 6 mA per LED", fontsize=10, color=MUTE, va="center")
    save(fig, "05_circuit.png")


# ------------------------------------------------------------------ 6. how a drift is caught (real replay of S1 episode)
def fig_gate():
    demo = json.loads((ROOT / "site/data/demo-episodes.json").read_text())["episodes"][0]
    gates = [it for it in demo["items"] if it["topic"] == "gate"]
    tel = {it["msg"]["seq"]: it["msg"] for it in demo["items"] if it["topic"] == "telemetry"}
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(11.8, 6.4), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    seqs = [g["msg"]["seq"] for g in gates]
    show = [("rms", LIGHT), ("kurt", AMBER), ("b0", HOT), ("b1", "#ff9e7d"), ("bhf", GREEN)]
    for k, col in show:
        z = [np.clip(g["msg"]["z"].get(k, np.nan), -12, 12) for g in gates]
        ax.plot(seqs, z, color=col, lw=1.8, marker="o", ms=3.5, label=k)
    ax.axhspan(-3, 3, color=GREEN, alpha=0.08)
    ax.axhline(3, color=GREEN, lw=1, ls="--")
    ax.axhline(-3, color=GREEN, lw=1, ls="--")
    ax.text(seqs[0], 3.5, "|z| = 3 threshold", color=GREEN, fontsize=10.5)
    test = [g["msg"]["seq"] for g in gates if g["msg"]["test"]]
    for a in (ax, ax2):
        if test:
            a.axvspan(min(test) - 0.5, max(test) + 0.5, color=VIOLET, alpha=0.12)
    if test:
        ax.text(min(test), 10.6, "AI-ordered test (1500 rpm) - scored vs the 1500 rpm baseline", color=VIOLET, fontsize=10.5)
    scn = [s for s in seqs if tel.get(s, {}).get("label") == "KA01"][0]
    fire = [g["msg"]["seq"] for g in gates if g["msg"]["state"] == "diagnosing"][0]
    for a in (ax, ax2):
        a.axvline(scn - 0.5, color=MUTE, ls=":", lw=1.2)
        a.axvline(fire, color=HOT, ls="--", lw=1.4)
    ax.text(scn - 0.7, -11.3, "fault injected", color=MUTE, fontsize=10.5, ha="right")
    ax.text(fire + 0.2, -11.3, "gate fires", color=HOT, fontsize=10.5, fontweight="bold")
    ax.set_ylim(-12.5, 12.5)
    ax.set_ylabel("z = (x - μ) / σ_eff  (clipped ±12)")
    ax.legend(ncol=5, frameon=False, loc="upper left", fontsize=11, bbox_to_anchor=(0, 1.12))
    ax.grid(alpha=0.1)
    for g in gates:
        m = g["msg"]
        s = m["seq"]
        fl = bool(m["flagged"]) and not m["test"]
        ax2.add_patch(Rectangle((s - 0.4, 0.15), 0.8, 0.7, color=HOT if fl else (VIOLET if m["test"] else PANEL)))
        if m["streak"] and not m["test"]:
            ax2.text(s, 1.15, str(m["streak"]), ha="center", fontsize=11, color=HOT if m["streak"] >= 3 else AMBER,
                     fontweight="bold")
    ax2.text(fire + 0.7, 1.15, "3 in a row -> episode starts", color=HOT, fontsize=10.5)
    latched = [g["msg"]["seq"] for g in gates if g["msg"]["state"] == "latched"]
    if latched:
        ax2.text(latched[0], 1.15, "alarm latched: the gate stays quiet until 10 clean windows", color=MUTE, fontsize=10.5)
    ax2.set_ylim(0, 1.6)
    ax2.set_yticks([])
    ax2.set_ylabel("flagged?\nstreak", rotation=0, ha="right", va="center")
    ax2.set_xlabel("window number (one window = 2 s of signal)")
    ax2.spines["left"].set_visible(False)
    save(fig, "06_gate.png")


# ------------------------------------------------------------------ 7. how a test is injected (real E4 timeline)
def fig_test():
    fig, ax = plt.subplots(figsize=(12.4, 6.8))
    ax.set_xlim(0, 124)
    ax.set_ylim(0, 70)
    ax.axis("off")
    for lab, y in [("Bridge (laptop)\ngate + Claude", 52), ("MQTT broker\nbroker.hivemq.com", 37), ("ESP32 node\n(Wokwi)", 22)]:
        ax.text(1, y, lab, va="center", fontsize=11.5, fontweight="bold")
        ax.plot([22, 122], [y, y], color=LINE, lw=1.2)

    def arrow(x0, y0, x1, y1, col):
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0), arrowprops=dict(arrowstyle="-|>", color=col, lw=1.8))

    ax.text(24, 66, "15:51:27  step 1", fontsize=11, fontweight="bold", va="top")
    ax.text(24, 62.6, "stator 55%, eccentricity 25%\nnext_test = 500 rpm", fontsize=10.2, color=MUTE, va="top")
    ax.text(70, 66, "15:52:22  test done", fontsize=11, fontweight="bold", va="top")
    ax.text(70, 62.6, "10 run windows collected\n-> step 2 with the results", fontsize=10.2, color=MUTE, va="top")
    ax.text(100, 66, "15:52:41  step 2", fontsize=11, fontweight="bold", va="top", color=GREEN)
    ax.text(100, 62.6, "stator 85%  -  correct\nstops (>= 80%)", fontsize=10.2, color=GREEN, va="top")
    arrow(26, 52, 29, 37, VIOLET)
    arrow(29, 37, 32, 22, VIOLET)
    ax.text(31, 46, 'cmd  {"cmd":"test", "id":"E4-T1",\n        "op":"500", "hold_s":20}', fontsize=10, color=VIOLET,
            family="Consolas")
    ax.text(34, 29, "applied at the next window boundary;\nnode remembers its place at 750 rpm", fontsize=10, color=MUTE)
    arrow(78, 22, 81, 37, LIGHT)
    arrow(81, 37, 84, 52, LIGHT)
    ax.text(84, 29, "telemetry, each window\ntagged test = E4-T1", fontsize=10, color=LIGHT)
    ax.text(86, 44, "bridge scores run windows\nvs the 500 rpm baseline", fontsize=10, color=MUTE)
    arrow(114, 52, 116.5, 37, GREEN)
    arrow(116.5, 37, 119, 22, GREEN)
    ax.text(113.5, 44, "rca +\nalert", fontsize=10, color=GREEN, ha="right")
    x = 36
    for i in range(12):
        col, lab = (AMBER, "settle") if i == 0 else ((VIOLET, "run") if i < 11 else (PANEL, "750"))
        ax.add_patch(Rectangle((x, 8), 6.4, 6, color=col, alpha=0.95))
        ax.text(x + 3.2, 11, lab, ha="center", va="center", fontsize=9.5, color="#111" if col != PANEL else INK)
        x += 7
    ax.text(36, 3.5, "1 settle + 10 run windows at 500 rpm (TEST LED on), then the node resumes the 750 rpm recording",
            fontsize=10, color=MUTE)
    save(fig, "07_test_sequence.png")


# ------------------------------------------------------------------ 8. what the LLM receives (real prompt, trimmed)
def fig_evidence():
    raw = (ROOT / "runs/E4-step2-prompt.txt").read_text(encoding="utf-8")
    ev = json.loads(raw[raw.index("{"):])
    inline = lambda d: "{" + ", ".join(f"{k}: {v}" for k, v in d.items()) + "}"  # noqa: E731
    pick = lambda d, ks: {k: d[k] for k in ks if k in d}  # noqa: E731
    sigs = ev["reference_signatures"]
    L = [("machine", inline(pick(ev["machine"], ["src", "current_op", "pole_pairs", "vib_unit"]))),
         ("gate", inline({"flagged": "[" + ", ".join(ev["gate"]["flagged_features"]) + "]", "z_threshold": 3.0})),
         ("now  (750 rpm, mean of 3 windows)", None)]
    for f in ["rms", "b3", "a1x"]:
        L.append(("   " + f, inline(pick(ev["now"]["features"][f], ["value", "healthy_mu", "ratio", "z"]))))
    L.append(("tests[0]  (500 rpm, 10 run windows)", None))
    for f in ["rms", "b3"]:
        L.append(("   " + f, inline(pick(ev["tests"][0]["features"][f], ["value", "ratio", "z", "vs_current_op"]))))
    L.append(("reference_signatures  (fault / healthy)", None))
    for c in ["stator_winding", "eccentricity"]:
        for op in ["500", "750"]:
            L.append((f"   {c} @ {op}", inline(pick(sigs[c][op], ["rms", "b3", "a1x"]))))
    L.append(("allowed_tests", inline(ev["allowed_tests"])))
    L.append(("allowed_causes", "[" + ", ".join(ev["allowed_causes"][:4]) + ", ...]"))
    L.append(("NOT included", "the injected label (ground truth)"))
    fig, ax = plt.subplots(figsize=(11.6, 0.34 * len(L) + 0.5))
    ax.axis("off")
    ax.add_patch(FancyBboxPatch((0, 0), 1, 1, boxstyle="round,pad=0.01,rounding_size=0.02", fc="#162231", ec=LINE,
                                transform=ax.transAxes))
    for i, (k, v) in enumerate(L):
        y = 1 - (i + 0.8) / (len(L) + 0.6)
        head = v is None or not k.startswith("   ")
        col = HOT if k == "NOT included" else (LIGHT if head else INK)
        ax.text(0.02, y, k + (":" if v is not None else ""), transform=ax.transAxes, family="Consolas", fontsize=11,
                color=col, va="center", fontweight="bold" if head else "normal")
        if v is not None:
            ax.text(0.33, y, v, transform=ax.transAxes, family="Consolas", fontsize=11,
                    color=HOT if k == "NOT included" else INK, va="center")
    save(fig, "08_evidence.png")


# ------------------------------------------------------------------ 9. inference: odds before and after the test (real E4)
def fig_inference():
    eps = [json.loads(l) for l in (ROOT / "runs/episodes.jsonl").open(encoding="utf-8")]
    e = [x for x in eps if x["episode"] == "E4" and x["src"] == "S2" and x.get("tests")][-1]
    s1, s2 = e["steps"][0]["diagnosis"]["causes"], e["steps"][1]["diagnosis"]["causes"]
    names = {"stator_winding": "stator winding", "eccentricity": "eccentricity", "magnet_demagnetisation": "magnet",
             "bearing": "bearing", "unknown": "unknown", "unbalance": "unbalance", "healthy": "healthy"}
    order = [c["cause"] for c in sorted(s1, key=lambda c: -c["p"])][:4]
    p1 = {c["cause"]: c["p"] for c in s1}
    p2 = {c["cause"]: c["p"] for c in s2}
    fig, ax = plt.subplots(figsize=(7.6, 4.4))
    y = np.arange(len(order))[::-1]
    ax.barh(y + 0.2, [p1.get(c, 0) * 100 for c in order], 0.38, color=MUTE, label="step 1 (750 rpm only)")
    ax.barh(y - 0.2, [p2.get(c, 0) * 100 for c in order], 0.38, color=[HOT if i == 0 else LIGHT for i in range(len(order))],
            label="step 2 (after the 500 rpm test)")
    for yy, c in zip(y, order):
        ax.text(p1.get(c, 0) * 100 + 1, yy + 0.2, f"{p1.get(c, 0) * 100:.0f}%", va="center", fontsize=11, color=MUTE)
        ax.text(p2.get(c, 0) * 100 + 1, yy - 0.2, f"{p2.get(c, 0) * 100:.0f}%", va="center", fontsize=11, color=INK,
                fontweight="bold")
    ax.set_yticks(y, [names.get(c, c) for c in order], fontsize=12)
    ax.set_xlim(0, 100)
    ax.set_xlabel("probability (%)")
    ax.axvline(80, color=GREEN, ls="--", lw=1)
    ax.text(81, y[0] + 0.62, "stop at 80%", color=GREEN, fontsize=10)
    ax.legend(frameon=False, loc="center right", fontsize=10.5)
    ax.set_title("Episode E4 (S2, injected stator fault)", fontsize=13)
    save(fig, "09_inference.png")


# ------------------------------------------------------------------ 10. results so far
def fig_results():
    eps = [json.loads(l) for l in (ROOT / "runs/episodes.jsonl").open(encoding="utf-8")]
    eps = [e for e in eps if str(e.get("engine", "")).startswith("claude") and e.get("steps")]
    nice = {"bearing_outer_race": "outer race", "magnet_demagnetisation": "magnet", "stator_winding": "stator",
            "eccentricity": "eccentricity", "bearing_or_brush_wear": "brush/bearing wear", "thermal_drift_wear": "thermal wear"}
    rows = []
    for e in eps:
        steps = " -> ".join(f"{s['diagnosis']['causes'][0]['p'] * 100:.0f}%" for s in e["steps"])
        tests = ", ".join(f"{MAN['sources'][e['src']]['ops'][t['op']]['rpm']} rpm" for t in e["tests"]) or "none"
        top = e["steps"][-1]["diagnosis"]["causes"][0]["cause"]
        rows.append([e["src"], f"{e['truth']['label']} ({nice.get(e['truth']['cause'], e['truth']['cause'])})",
                     f"{MAN['sources'][e['src']]['ops'][e['op']]['rpm']} rpm", tests, f"{nice.get(top, top)}  {steps}",
                     "correct" if e["truth"]["correct"] else "wrong", f"{e['duration_s']:.0f} s"])
    fig, ax = plt.subplots(figsize=(12.4, 0.42 * len(rows) + 1.2))
    ax.axis("off")
    cols = [0.0, 0.06, 0.30, 0.41, 0.53, 0.82, 0.92]
    heads = ["", "injected (hidden from AI)", "op", "test ordered", "AI answer (odds by step)", "check", "time"]
    n = len(rows) + 1
    h = 1 / n
    ax.add_patch(Rectangle((-0.01, 1 - h), 1.02, h, color=BLUE, transform=ax.transAxes, clip_on=False))
    for x, t in zip(cols, heads):
        ax.text(x, 1 - h / 2, t, transform=ax.transAxes, fontsize=12, fontweight="bold", color="white", va="center")
    for i, r in enumerate(rows):
        yy = 1 - (i + 1.5) * h
        if i % 2 == 0:
            ax.add_patch(Rectangle((-0.01, yy - h / 2), 1.02, h, color=PANEL, transform=ax.transAxes, clip_on=False))
        for j, (x, t) in enumerate(zip(cols, r)):
            col = INK
            if j == 5:
                col = GREEN if t == "correct" else HOT
            if j == 3 and t != "none":
                col = VIOLET
            ax.text(x, yy, t, transform=ax.transAxes, fontsize=11.5, color=col, va="center",
                    fontweight="bold" if j in (0, 5) else "normal")
    save(fig, "10_results.png")
    ok = sum(r[5] == "correct" for r in rows)
    print(f"results: {ok}/{len(rows)} correct, {sum(r[3] != 'none' for r in rows)} with tests")


if __name__ == "__main__":
    for f in [fig_raw, fig_spectrum, fig_feature_table, fig_signatures, fig_circuit, fig_gate, fig_test, fig_evidence,
              fig_inference, fig_results]:
        f()
