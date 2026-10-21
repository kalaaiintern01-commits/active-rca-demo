"""Generate all figures and result numbers for the Abhiyantrix '26 paper from data/*.csv."""
import numpy as np, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from scipy.signal import welch
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
FIG = Path(__file__).resolve().parent / "figures"; FIG.mkdir(exist_ok=True)
BLUE, ORANGE, AQUA, YELLOW, VIOLET = "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#4a3aa7"
INK, INK2, MUTED, GRID = "#0b0b0b", "#52514e", "#898781", "#e1e0d9"
plt.rcParams.update({"font.family": "serif", "font.size": 8, "axes.edgecolor": MUTED, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.5, "axes.axisbelow": True,
                     "figure.dpi": 200, "savefig.bbox": "tight", "savefig.facecolor": "white"})
OUT = {}

# ----------------------------------------------------------------- Fig 1 architecture
def fig_arch():
    fig, ax = plt.subplots(figsize=(6.8, 3.0)); ax.axis("off"); ax.set_xlim(0, 100); ax.set_ylim(0, 44)
    def box(x, y, w, h, title, sub, fc="#f4f7fa", ec=BLUE):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4,rounding_size=1.2", fc=fc, ec=ec, lw=1))
        ax.text(x + w / 2, y + h - 3.0, title, ha="center", va="center", fontsize=7, weight="bold", color=INK)
        ax.text(x + w / 2, y + h / 2 - 2.6, sub, ha="center", va="center", fontsize=5.8, color=INK2, linespacing=1.35)
    def arrow(x1, y1, x2, y2, color=INK2, style="-|>"):
        ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle=style, mutation_scale=8, color=color, lw=0.9))
    # top row: four boxes with 4-unit gaps
    box(1, 28, 20, 16, "1  Edge node", "ESP32-WROOM-32\n(Wokwi simulator)\nreplays S1 / S2 / S3\n18 features per 2 s")
    box(25, 28, 20, 16, "2  MQTT broker", "HiveMQ Cloud\nMQTT v5, TLS :8883\nQoS 1\nretained status")
    box(49, 28, 20, 16, "Bridge + store", "Python paho-mqtt\njsonschema v1.1\nInfluxDB\nGrafana")
    box(73, 28, 26, 16, "3  Reasoning (LLM)", "Claude, claude-opus-5\nstructured pdm.rca.v1\nranks causes\norders bounded tests", fc="#fff4ee", ec=ORANGE)
    box(25, 2, 44, 12, "Drift gate", "per-source baseline = healthy mean + 3 sigma\n3 consecutive windows out of band  ->  wake", fc="#f1faf6", ec=AQUA)
    arrow(21, 36, 25, 36); arrow(45, 36, 49, 36); arrow(69, 36, 73, 36)
    ax.text(50, 45.5, "telemetry  (pdm.telemetry.v1.1, one JSON object per 2 s window)", ha="center", fontsize=5.6, color=INK2)
    # store -> gate (down), gate -> reasoning (wake), reasoning -> edge (command, routed under the row)
    arrow(59, 28, 59, 14.5)
    arrow(69, 8, 86, 27.5, color=AQUA); ax.text(73.5, 14.5, "wake", ha="center", fontsize=5.6, color=AQUA)
    ax.plot([86, 86, 11, 11], [27.5, 21, 21, 24], color=ORANGE, lw=0.9); arrow(11, 24, 11, 27.5, color=ORANGE)
    ax.text(48.5, 22.4, "/cmd  {\"test\": \"speed\", \"rpm\": 1500, \"hold_s\": 30}", ha="center", fontsize=5.6, color=ORANGE)
    ax.text(92, 15.5, "stop: p > 0.8,\n3 tests, or\n'unavailable'", ha="center", va="center", fontsize=5.4, color=ORANGE, linespacing=1.3)
    fig.savefig(FIG / "fig1_architecture.png"); plt.close(fig)

# ----------------------------------------------------------------- S1
s1 = pd.read_csv(DATA / "S1_index.csv")
s1["op"] = s1.rpm_nominal.astype(str) + " rpm\n" + s1.torque_nominal_nm.astype(str) + " Nm\n" + s1.radial_force_nominal_n.astype(str) + " N"
ops = ["900 rpm\n0.7 Nm\n1000 N", "1500 rpm\n0.1 Nm\n1000 N", "1500 rpm\n0.7 Nm\n400 N", "1500 rpm\n0.7 Nm\n1000 N"]

def band_energy(files, lo, hi, n=5):
    out = []
    for f in files[:n]:
        v = pd.read_csv(DATA / "S1_paderborn_pmsm" / f, usecols=["vibration_g"]).vibration_g.values
        fr, P = welch(v, fs=64000, nperseg=4096); out.append(P[(fr >= lo) & (fr < hi)].sum())
    return np.array(out)

def fig_s1():
    fig, axes = plt.subplots(1, 2, figsize=(6.8, 2.4))
    g = s1.groupby(["op", "bearing"]).vibration_rms_g
    m, lo, hi = g.mean().unstack(), g.min().unstack(), g.max().unstack()
    x = np.arange(len(ops)); w = 0.36
    for i, (b, c) in enumerate([("K001", BLUE), ("KA01", ORANGE)]):
        vals = m.loc[ops, b].values
        axes[0].bar(x + (i - 0.5) * w, vals, w * 0.94, color=c, label=f"{b} ({'healthy' if b=='K001' else 'outer-ring fault'})")
        axes[0].errorbar(x + (i - 0.5) * w, vals, yerr=[vals - lo.loc[ops, b].values, hi.loc[ops, b].values - vals], fmt="none", ecolor=INK, lw=0.7, capsize=2)
    axes[0].set_xticks(x); axes[0].set_xticklabels(ops, fontsize=6); axes[0].set_ylabel("Vibration RMS (g)"); axes[0].set_ylim(0, 0.7)
    axes[0].set_title("(a) RMS, 20 recordings per bar (min-max)", fontsize=7.5, loc="left"); axes[0].legend(frameon=False, fontsize=6, loc="upper left", ncol=1)
    be = {}
    for op in ops:
        for b in ["K001", "KA01"]:
            be[(op, b)] = band_energy(s1[(s1.op == op) & (s1.bearing == b)].file.tolist(), 1000, 5000)
    for i, (b, c) in enumerate([("K001", BLUE), ("KA01", ORANGE)]):
        vals = np.array([be[(op, b)].mean() for op in ops]) * 1e3
        axes[1].bar(x + (i - 0.5) * w, vals, w * 0.94, color=c)
    axes[1].set_xticks(x); axes[1].set_xticklabels(ops, fontsize=6); axes[1].set_ylabel("1-5 kHz band power (x1e-3 g$^2$)")
    axes[1].set_title("(b) Band power, 5 recordings per bar", fontsize=7.5, loc="left")
    fig.savefig(FIG / "fig2_s1_speed_dependence.png"); plt.close(fig)
    OUT["s1_rms"] = m.loc[ops]; OUT["s1_rms_minmax"] = (lo.loc[ops], hi.loc[ops])
    OUT["s1_band"] = {k: v.mean() for k, v in be.items()}

def fig_s1_psd():
    fig, ax = plt.subplots(figsize=(3.3, 2.3))
    for b, c, lab in [("K001", BLUE, "K001 healthy"), ("KA01", ORANGE, "KA01 outer-ring fault")]:
        f = s1[(s1.bearing == b) & (s1.op == ops[3])].file.iloc[0]
        v = pd.read_csv(DATA / "S1_paderborn_pmsm" / f, usecols=["vibration_g"]).vibration_g.values
        fr, P = welch(v, fs=64000, nperseg=8192); ax.semilogy(fr / 1000, P, color=c, lw=0.8, label=lab)
    ax.set_xlim(0, 12); ax.set_xlabel("Frequency (kHz)"); ax.set_ylabel("PSD (g$^2$/Hz)"); ax.legend(frameon=False, fontsize=6)
    ax.axvspan(1, 5, color=YELLOW, alpha=0.12, lw=0); ax.text(3, ax.get_ylim()[1] * 0.5, "1-5 kHz band", ha="center", fontsize=6, color=INK2)
    fig.savefig(FIG / "fig3_s1_psd.png"); plt.close(fig)

# ----------------------------------------------------------------- S2
s2 = pd.read_csv(DATA / "S2_index.csv")
def s2_features(df):
    rows = []
    for _, r in df.iterrows():
        d = pd.read_csv(DATA / "S2_cubemars_pmsm" / r.file)
        ac = d[["ax", "ay", "az"]] - d[["ax", "ay", "az"]].mean()
        rows.append(dict(file=r.file, set=r.set, fault=r.fault_class, rpm=r.rpm, mag_rms=float(np.sqrt((ac ** 2).sum(axis=1).mean()))))
    return pd.DataFrame(rows)

def fig_s2():
    tr = s2_features(s2[s2.set == "LocS_Train_Clean"]); va = s2_features(s2[s2.set == "LocS_Val_Clean"])
    nr = tr[tr.fault == "NR"].groupby("rpm").mag_rms.agg(["mean", "std", "max"])
    ratio = tr.groupby(["fault", "rpm"]).mag_rms.mean().unstack() / nr["mean"]
    ratio = ratio.loc[["BF", "EF", "MF", "SF", "NR"]]
    fig, ax = plt.subplots(figsize=(3.3, 2.3))
    im = ax.imshow(np.log10(ratio.values), cmap=matplotlib.colors.LinearSegmentedColormap.from_list("blue", ["#cde2fb", "#2a78d6", "#0d366b"]), aspect="auto")
    ax.set_xticks(range(3)); ax.set_xticklabels([f"{r} rpm" for r in ratio.columns]); ax.set_yticks(range(5))
    ax.set_yticklabels(["Bearing (BF)", "Eccentricity (EF)", "Magnet (MF)", "Stator (SF)", "Normal (NR)"]); ax.grid(False)
    for i in range(5):
        for j in range(3):
            v = ratio.values[i, j]; ax.text(j, i, f"{v:.1f}x", ha="center", va="center", fontsize=7, color="white" if v > 3 else INK)
    ax.set_title("Vibration RMS relative to Normal at same speed", fontsize=7.5, loc="left")
    fig.savefig(FIG / "fig4_s2_heatmap.png"); plt.close(fig)
    # threshold classifier: anomaly if mag_rms > NR mean + 3 sigma (per speed), fitted on train, tested on val
    thr = nr["mean"] + 3 * nr["std"]
    va["pred_anom"] = va.apply(lambda r: r.mag_rms > thr[r.rpm], axis=1); va["is_anom"] = va.fault != "NR"
    acc = (va.pred_anom == va.is_anom).mean()
    by = va.groupby(["rpm", "fault"]).apply(lambda g: (g.pred_anom == g.is_anom).mean()).unstack()
    OUT["s2_ratio"] = ratio; OUT["s2_thr"] = thr; OUT["s2_val_acc"] = acc; OUT["s2_val_by"] = by; OUT["s2_nr"] = nr
    OUT["s2_val_n"] = len(va)
    # EF vs MF separability at each speed (train+val)
    both = pd.concat([tr, va])
    sep = {}
    for rpm in [500, 750, 1000]:
        ef = both[(both.fault == "EF") & (both.rpm == rpm)].mag_rms; mf = both[(both.fault == "MF") & (both.rpm == rpm)].mag_rms
        sep[rpm] = dict(ef_min=ef.min(), ef_max=ef.max(), mf_min=mf.min(), mf_max=mf.max(), gap=ef.min() - mf.max(), n=len(ef) + len(mf))
    OUT["s2_efmf"] = sep

# ----------------------------------------------------------------- S3
def fig_s3():
    s3 = pd.read_csv(DATA / "S3_index.csv").sort_values("recorded_at").reset_index(drop=True)
    t = pd.to_datetime(s3.recorded_at); s3["min"] = (t - t.min()).dt.total_seconds() / 60
    base = s3.head(30)
    fig, axes = plt.subplots(3, 1, figsize=(3.3, 3.6), sharex=True)
    for ax, col, lab, c in [(axes[0], "temp_motor_c", "Motor temp (°C)", ORANGE), (axes[1], "current_a", "Current (A)", BLUE), (axes[2], "vibration_rms", "Vibration RMS (a.u.)", VIOLET)]:
        ax.plot(s3["min"], s3[col], color=c, lw=0.9); ax.set_ylabel(lab, fontsize=7)
        mu, sd = base[col].mean(), base[col].std(); ax.axhspan(mu - 3 * sd, mu + 3 * sd, color=GRID, alpha=0.8, lw=0)
        ax.axhline(mu + 3 * sd, color=MUTED, lw=0.6, ls="--")
    for ax in axes:
        for x0, x1 in [(11.8, 18.4), (29.2, 35.6)]: ax.axvspan(x0, x1, color=YELLOW, alpha=0.10, lw=0)
    axes[2].set_yscale("log"); axes[2].set_xlabel("Minutes since first recording"); axes[0].set_title("Grey band = healthy mean ± 3σ (first 30 files); yellow = 5 V phases", fontsize=6.5, loc="left")
    fig.savefig(FIG / "fig5_s3_drift.png"); plt.close(fig)
    first = {}
    for col in ["temp_motor_c", "current_a", "vibration_rms"]:
        mu, sd = base[col].mean(), base[col].std()
        hit = s3[(s3[col] > mu + 3 * sd) & (s3.phase == "01-Start 3V")]
        first[col] = dict(thr=mu + 3 * sd, first_min=(hit["min"].iloc[0] if len(hit) else None), mu=mu, sd=sd)
    OUT["s3_first"] = first; OUT["s3_phase"] = s3.groupby("phase")[["temp_motor_c", "current_a", "speed_rpm", "vibration_rms"]].agg(["min", "max"])
    OUT["s3_base"] = base[["temp_motor_c", "current_a", "speed_rpm", "vibration_rms"]].agg(["mean", "std", "min", "max"])

# ----------------------------------------------------------------- Fig 6 dataset sample "screenshots"
def fig_samples():
    fig, axes = plt.subplots(3, 1, figsize=(6.8, 2.75));
    specs = [("S1_paderborn_pmsm/N15_M07_F10_KA01_1.csv", "S1  Paderborn  -  N15_M07_F10_KA01_1.csv  (64 kHz; first 3 of 256,823 rows)"),
             ("S2_cubemars_pmsm/LocS_Train_Clean__EF_5khz_500rpm_1.csv", "S2  CubeMars PMSM  -  LocS_Train_Clean__EF_5khz_500rpm_1.csv  (5 kHz; first 3 of ~50,000 rows)"),
             ("S3_cartif_dc_motor/MOTOR-DC_2020_12_02_17_25_04.csv", "S3  CARTIF DC motor  -  MOTOR-DC_2020_12_02_17_25_04.csv  (51.2 kHz; first 3 of 102,413 rows)")]
    for ax, (f, title) in zip(axes, specs):
        d = pd.read_csv(DATA / f, nrows=3); ax.axis("off")
        cell = [[(f"{v:.6f}" if c.startswith("time") else f"{v:.5g}") if isinstance(v, float) else str(v) for c, v in zip(d.columns, row)] for row in d.values]
        tb = ax.table(cellText=cell, colLabels=list(d.columns), loc="center", cellLoc="center")
        tb.auto_set_font_size(False); tb.set_fontsize(5.2 if "S1_" in f else 6); tb.scale(1, 1.05)
        for (r, c), cl in tb.get_celld().items():
            cl.set_edgecolor(GRID); cl.set_linewidth(0.4)
            if r == 0: cl.set_facecolor(BLUE); cl.get_text().set_color("white"); cl.get_text().set_weight("bold")
            elif r % 2 == 0: cl.set_facecolor("#f4f7fa")
        ax.set_title(title, fontsize=6.5, loc="left", color=INK)
    fig.subplots_adjust(hspace=0.7)
    fig.savefig(FIG / "fig6_dataset_samples.png"); plt.close(fig)

if __name__ == "__main__":
    fig_arch(); fig_s1(); fig_s1_psd(); fig_s2(); fig_s3(); fig_samples()
    pd.set_option("display.width", 200)
    for k, v in OUT.items(): print(f"\n== {k} ==\n{v}")
