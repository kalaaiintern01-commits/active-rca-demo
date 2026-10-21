"""
Reference implementation of the edge feature extractor and the replay-slice format.

The ESP32 firmware (firmware/src/pdm_features.h) implements the same algorithm in C++;
training (baselines, signatures) and the virtual node use this module, so the numbers the
gate compares against are produced by the same maths the edge node runs.

Replay slice file (.bin) = concatenated windows. Each window:
    48-byte little-endian header
        uint32 magic 'PDMW'   uint16 nch     uint16 flags (bit0 vib in m/s2, bit1 temp valid)
        uint32 fs_hz          uint32 n       (samples per channel)
        float  rpm            float  temp_c  float aux (S1 torque N.m, S3 supply V)
        float  scale[4]       (physical = int16 * scale)
        uint16 vib_mask       uint16 cur_ch  (0xFFFF = none)
    int16 data[n][nch], interleaved
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

MAGIC = 0x574D4450  # b"PDMW" little-endian
HDR_FMT = "<IHHIIfff4fHH"
HDR_SIZE = struct.calcsize(HDR_FMT)
assert HDR_SIZE == 48

NFFT = 1024
NBIN = NFFT // 2 + 1
HANN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NFFT) / NFFT)).astype(np.float64)
HANN_S2 = float(np.sum(HANN ** 2))
BANDS = [(0.0, 50.0), (50.0, 200.0), (200.0, 800.0), (800.0, 2500.0)]
HF_BAND = (1000.0, 5000.0)
G = 9.80665

FEATURES = ["rms", "peak", "crest", "kurt", "skew", "x_rms", "y_rms", "z_rms",
            "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "fdom",
            "cur_rms", "cur_mean", "cur_peak"]


@dataclass
class WinHeader:
    nch: int
    fs: int
    n: int
    rpm: float
    temp_c: float
    aux: float
    scale: list = field(default_factory=lambda: [0.0] * 4)
    vib_mask: int = 1
    cur_ch: int = 0xFFFF
    flags: int = 0

    @property
    def vib_idx(self):
        return [i for i in range(self.nch) if self.vib_mask >> i & 1]

    @property
    def temp_valid(self):
        return bool(self.flags & 2)

    @property
    def vib_cal(self):
        return bool(self.flags & 1)


def pack_window(hdr: WinHeader, data: np.ndarray) -> tuple[bytes, np.ndarray]:
    """Quantise float data (n, nch) to int16 and return (bytes, dequantised float64 data)."""
    assert data.shape == (hdr.n, hdr.nch)
    scale = [0.0] * 4
    q = np.empty(data.shape, dtype=np.int16)
    for c in range(hdr.nch):
        m = float(np.max(np.abs(data[:, c])))
        s = np.float32(m / 32000.0 if m > 0 else 1e-6)
        scale[c] = float(s)
        q[:, c] = np.clip(np.round(data[:, c] / s), -32767, 32767).astype(np.int16)
    hdr.scale = scale
    raw = struct.pack(HDR_FMT, MAGIC, hdr.nch, hdr.flags, hdr.fs, hdr.n,
                      hdr.rpm, hdr.temp_c, hdr.aux, *scale, hdr.vib_mask, hdr.cur_ch)
    raw += q.astype("<i2").tobytes()
    deq = q.astype(np.float64) * np.array([np.float32(s) for s in scale[:hdr.nch]], dtype=np.float64)
    return raw, deq


def read_windows(buf: bytes):
    """Yield (WinHeader, dequantised float64 data (n, nch)) for every window in a slice file."""
    off = 0
    while off + HDR_SIZE <= len(buf):
        (magic, nch, flags, fs, n, rpm, temp, aux, s0, s1, s2, s3, vmask, cur) = struct.unpack_from(HDR_FMT, buf, off)
        if magic != MAGIC:
            raise ValueError(f"bad magic at offset {off}")
        off += HDR_SIZE
        nbytes = n * nch * 2
        q = np.frombuffer(buf, dtype="<i2", count=n * nch, offset=off).reshape(n, nch)
        off += nbytes
        scale = [s0, s1, s2, s3]
        hdr = WinHeader(nch=nch, fs=fs, n=n, rpm=rpm, temp_c=temp, aux=aux, scale=scale,
                        vib_mask=vmask, cur_ch=cur, flags=flags)
        deq = q.astype(np.float64) * np.array([np.float32(s) for s in scale[:nch]], dtype=np.float64)
        yield hdr, deq


def window_bytes(nch: int, n: int) -> int:
    return HDR_SIZE + n * nch * 2


def features(x: np.ndarray, hdr: WinHeader, pole_pairs: int) -> dict:
    """Edge features for one window. x = (n, nch) physical values (vib already in m/s2 or a.u.)."""
    fs, n = hdr.fs, hdr.n
    vib = hdr.vib_idx
    out: dict = {k: None for k in FEATURES}

    # ---- time domain, from raw power sums exactly as the firmware accumulates them
    var, peak = [], 0.0
    for c in vib:
        v = x[:, c]
        m1 = v.mean(); m2 = np.mean(v * v)
        var_c = max(m2 - m1 * m1, 0.0)
        var.append(var_c)
        peak = max(peak, float(v.max() - m1), float(m1 - v.min()))
    out["rms"] = float(np.sqrt(sum(var)))
    out["peak"] = peak
    out["crest"] = peak / out["rms"] if out["rms"] > 0 else 0.0
    for name, c_var in zip(["x_rms", "y_rms", "z_rms"], var):
        out[name] = float(np.sqrt(c_var))

    p = x[:, vib[0]]
    e1, e2, e3, e4 = p.mean(), np.mean(p ** 2), np.mean(p ** 3), np.mean(p ** 4)
    mu2 = e2 - e1 ** 2
    mu3 = e3 - 3 * e1 * e2 + 2 * e1 ** 3
    mu4 = e4 - 4 * e1 * e3 + 6 * e1 ** 2 * e2 - 3 * e1 ** 4
    out["kurt"] = float(mu4 / mu2 ** 2) if mu2 > 0 else 0.0
    out["skew"] = float(mu3 / mu2 ** 1.5) if mu2 > 0 else 0.0

    # ---- Welch PSD: non-overlapping 1024-pt Hann frames, per-frame mean removed, summed over vib axes
    nfr = n // NFFT
    P = np.zeros(NBIN)
    for f in range(nfr):
        seg = x[f * NFFT:(f + 1) * NFFT]
        for c in vib:
            s = seg[:, c] - seg[:, c].mean()
            X = np.fft.rfft(s * HANN)
            P += X.real ** 2 + X.imag ** 2
    psd = P / max(nfr, 1) / (fs * HANN_S2)
    psd[1:-1] *= 2.0
    df = fs / NFFT
    k = np.arange(NBIN) * df

    def band(lo, hi):
        sel = (k >= lo) & (k < hi)
        return float(np.sum(psd[sel]) * df)

    for i, (lo, hi) in enumerate(BANDS):
        out[f"b{i}"] = band(lo, hi)
    if fs >= 2 * HF_BAND[1]:
        out["bhf"] = band(*HF_BAND)

    def amp(f0):
        k0 = int(round(f0 / df))
        if f0 <= 0 or k0 + 1 >= NBIN - 1:
            return None
        return float(np.sqrt(np.sum(psd[max(k0 - 1, 1):k0 + 2]) * df))

    fr = hdr.rpm / 60.0
    out["a1x"], out["a2x"], out["app"] = amp(fr), amp(2 * fr), amp(pole_pairs * fr)
    out["fdom"] = float((2 + int(np.argmax(psd[2:]))) * df)

    if hdr.cur_ch != 0xFFFF:
        c = x[:, hdr.cur_ch]
        out["cur_rms"] = float(np.sqrt(np.mean(c * c)))
        out["cur_mean"] = float(c.mean())
        out["cur_peak"] = float(np.max(np.abs(c)))
    out["frames"] = nfr
    out["df"] = df
    return out
