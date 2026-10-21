/*
 * pdm_features.h - edge feature extractor (portable C++, no Arduino dependency).
 *
 * Mirrors common/pdmfeat.py line for line, so the healthy baselines learned in training are
 * computed by the same maths the node runs. Streaming: samples are pushed as they arrive from
 * the network, so the node never holds a whole 2 s window in RAM - only one 1024-sample frame
 * per vibration axis (12 kB) plus the FFT work arrays.
 *
 *   time domain   AC RMS (vector over vib axes), peak, crest, kurtosis/skewness of the primary axis,
 *                 per-axis RMS - from raw power sums in double precision
 *   frequency     Welch PSD: non-overlapping 1024-pt Hann frames, per-frame mean removed,
 *                 summed over vib axes; band energy 0-50/50-200/200-800/800-2500 Hz,
 *                 1-5 kHz when fs >= 10 kHz; amplitude at 1x, 2x and pole-pass; dominant frequency
 *   current       true RMS, mean, peak
 */
#pragma once
#include <stdint.h>
#include <math.h>
#include <string.h>

namespace pdm {

static const int NFFT   = 1024;
static const int NBIN   = NFFT / 2 + 1;
static const int MAXCH  = 4;
static const int MAXVIB = 3;

struct Features {
  float rms, peak, crest, kurt, skew;
  float axRms[MAXVIB];
  uint8_t nAx;
  float band[4];
  float bhf;  bool hasBhf;
  float a1x;  bool hasA1x;
  float a2x;  bool hasA2x;
  float app;  bool hasApp;
  float fdom, df;
  int   frames;
  bool  hasCur;
  float curRms, curMean, curPeak;
};

class Extractor {
 public:
  Extractor() { initTables(); }

  void begin(uint32_t fs, uint32_t n, uint8_t nch, uint16_t vibMask, int curCh, const float *scale) {
    fs_ = fs; n_ = n; nch_ = nch > MAXCH ? MAXCH : nch; curCh_ = curCh;
    nvib_ = 0;
    for (uint8_t c = 0; c < nch_; c++) {
      scale_[c] = scale[c];
      if ((vibMask >> c) & 1 && nvib_ < MAXVIB) vibCh_[nvib_++] = c;
      s1_[c] = s2_[c] = 0.0;
      mn_[c] = 1e30f; mx_[c] = -1e30f;
    }
    s3p_ = s4p_ = 0.0;
    count_ = 0; pos_ = 0; frames_ = 0;
    memset(psd_, 0, sizeof(psd_));
  }

  // count sample-frames, each nch interleaved int16
  void push(const int16_t *q, uint32_t count) {
    for (uint32_t i = 0; i < count; i++, q += nch_) {
      for (uint8_t c = 0; c < nch_; c++) {
        float x = (float)q[c] * scale_[c];
        double xd = x;
        s1_[c] += xd; s2_[c] += xd * xd;
        if (x < mn_[c]) mn_[c] = x;
        if (x > mx_[c]) mx_[c] = x;
      }
      if (nvib_) {
        double p = (float)q[vibCh_[0]] * scale_[vibCh_[0]];
        double p2 = p * p;
        s3p_ += p2 * p; s4p_ += p2 * p2;
        for (uint8_t v = 0; v < nvib_; v++) frame_[v][pos_] = (float)q[vibCh_[v]] * scale_[vibCh_[v]];
        if (++pos_ == NFFT) { processFrame(); pos_ = 0; frames_++; }
      }
      count_++;
    }
  }

  void finish(float rpm, int polePairs, Features &f) {
    memset(&f, 0, sizeof(f));
    const double N = count_ ? (double)count_ : 1.0;

    double varSum = 0.0, peak = 0.0;
    f.nAx = nvib_;
    for (uint8_t v = 0; v < nvib_; v++) {
      uint8_t c = vibCh_[v];
      double m1 = s1_[c] / N, m2 = s2_[c] / N;
      double var = m2 - m1 * m1; if (var < 0) var = 0;
      varSum += var;
      f.axRms[v] = (float)sqrt(var);
      double up = mx_[c] - m1, dn = m1 - mn_[c];
      if (up > peak) peak = up;
      if (dn > peak) peak = dn;
    }
    f.rms = (float)sqrt(varSum);
    f.peak = (float)peak;
    f.crest = f.rms > 0 ? (float)(peak / f.rms) : 0.0f;

    if (nvib_) {
      uint8_t c = vibCh_[0];
      double e1 = s1_[c] / N, e2 = s2_[c] / N, e3 = s3p_ / N, e4 = s4p_ / N;
      double mu2 = e2 - e1 * e1;
      double mu3 = e3 - 3 * e1 * e2 + 2 * e1 * e1 * e1;
      double mu4 = e4 - 4 * e1 * e3 + 6 * e1 * e1 * e2 - 3 * e1 * e1 * e1 * e1;
      f.kurt = mu2 > 0 ? (float)(mu4 / (mu2 * mu2)) : 0.0f;
      f.skew = mu2 > 0 ? (float)(mu3 / pow(mu2, 1.5)) : 0.0f;
    }

    // one-sided PSD, averaged over frames
    const double norm = 1.0 / ((frames_ ? frames_ : 1) * (double)fs_ * hannS2_);
    const double df = (double)fs_ / NFFT;
    for (int k = 0; k < NBIN; k++) {
      psd_[k] *= norm;
      if (k > 0 && k < NBIN - 1) psd_[k] *= 2.0;
    }
    static const float BANDS[4][2] = {{0, 50}, {50, 200}, {200, 800}, {800, 2500}};
    for (int b = 0; b < 4; b++) f.band[b] = band(BANDS[b][0], BANDS[b][1], df);
    f.hasBhf = fs_ >= 10000;
    if (f.hasBhf) f.bhf = band(1000, 5000, df);

    double fr = rpm / 60.0;
    f.hasA1x = amp(fr, df, f.a1x);
    f.hasA2x = amp(2 * fr, df, f.a2x);
    f.hasApp = amp(polePairs * fr, df, f.app);

    int kmax = 2;
    for (int k = 3; k < NBIN; k++) if (psd_[k] > psd_[kmax]) kmax = k;
    f.fdom = (float)(kmax * df);
    f.df = (float)df;
    f.frames = frames_;

    f.hasCur = curCh_ >= 0 && curCh_ < nch_;
    if (f.hasCur) {
      f.curRms = (float)sqrt(s2_[curCh_] / N);
      f.curMean = (float)(s1_[curCh_] / N);
      f.curPeak = fabsf(mx_[curCh_]) > fabsf(mn_[curCh_]) ? fabsf(mx_[curCh_]) : fabsf(mn_[curCh_]);
    }
  }

 private:
  uint32_t fs_ = 0, n_ = 0, count_ = 0;
  uint8_t nch_ = 0, nvib_ = 0, vibCh_[MAXVIB] = {0};
  int curCh_ = -1, pos_ = 0, frames_ = 0;
  float scale_[MAXCH] = {0}, mn_[MAXCH] = {0}, mx_[MAXCH] = {0};
  double s1_[MAXCH] = {0}, s2_[MAXCH] = {0}, s3p_ = 0, s4p_ = 0;
  float frame_[MAXVIB][NFFT];
  double psd_[NBIN];
  float re_[NFFT], im_[NFFT];

  static float hann_[NFFT];
  static float cos_[NFFT / 2], sin_[NFFT / 2];
  static double hannS2_;
  static bool tables_;

  static void initTables() {
    if (tables_) return;
    hannS2_ = 0.0;
    for (int i = 0; i < NFFT; i++) {
      hann_[i] = (float)(0.5 - 0.5 * cos(2.0 * M_PI * i / NFFT));
      hannS2_ += (double)hann_[i] * hann_[i];
    }
    for (int i = 0; i < NFFT / 2; i++) {
      cos_[i] = (float)cos(2.0 * M_PI * i / NFFT);
      sin_[i] = (float)sin(2.0 * M_PI * i / NFFT);
    }
    tables_ = true;
  }

  float band(double lo, double hi, double df) const {
    double s = 0.0;
    for (int k = 0; k < NBIN; k++) {
      double fk = k * df;
      if (fk >= lo && fk < hi) s += psd_[k];
    }
    return (float)(s * df);
  }

  bool amp(double f0, double df, float &out) const {
    long k0 = lround(f0 / df);
    if (f0 <= 0 || k0 + 1 >= NBIN - 1) return false;
    double s = 0.0;
    for (long k = (k0 - 1 < 1 ? 1 : k0 - 1); k <= k0 + 1; k++) s += psd_[k];
    out = (float)sqrt(s * df);
    return true;
  }

  void processFrame() {
    for (uint8_t v = 0; v < nvib_; v++) {
      double mean = 0.0;
      for (int i = 0; i < NFFT; i++) mean += frame_[v][i];
      mean /= NFFT;
      for (int i = 0; i < NFFT; i++) {
        re_[i] = (float)((frame_[v][i] - mean) * hann_[i]);
        im_[i] = 0.0f;
      }
      fft();
      for (int k = 0; k < NBIN; k++) psd_[k] += (double)re_[k] * re_[k] + (double)im_[k] * im_[k];
    }
  }

  // iterative radix-2 Cooley-Tukey, in place on re_/im_
  void fft() {
    for (int i = 1, j = 0; i < NFFT; i++) {
      int bit = NFFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        float t = re_[i]; re_[i] = re_[j]; re_[j] = t;
        t = im_[i]; im_[i] = im_[j]; im_[j] = t;
      }
    }
    for (int len = 2; len <= NFFT; len <<= 1) {
      int half = len >> 1, step = NFFT / len;
      for (int i = 0; i < NFFT; i += len) {
        for (int k = 0; k < half; k++) {
          float wr = cos_[k * step], wi = -sin_[k * step];
          int a = i + k, b = a + half;
          float tr = re_[b] * wr - im_[b] * wi;
          float ti = re_[b] * wi + im_[b] * wr;
          re_[b] = re_[a] - tr; im_[b] = im_[a] - ti;
          re_[a] += tr;         im_[a] += ti;
        }
      }
    }
  }
};

float  Extractor::hann_[NFFT];
float  Extractor::cos_[NFFT / 2];
float  Extractor::sin_[NFFT / 2];
double Extractor::hannS2_ = 0.0;
bool   Extractor::tables_ = false;

}  // namespace pdm
