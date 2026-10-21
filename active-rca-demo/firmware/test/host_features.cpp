// Host-side check: run the firmware's pdm_features.h over a replay slice file and print one JSON
// line per window. tools/check_features.py compares this with common/pdmfeat.py.
//   zig c++ -O2 -std=c++17 -D_USE_MATH_DEFINES -I../src host_features.cpp -o host_features.exe
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "pdm_features.h"

#pragma pack(push, 1)
struct WinHdr { uint32_t magic; uint16_t nch, flags; uint32_t fs, n; float rpm, temp, aux; float scale[4]; uint16_t vibMask, curCh; };
#pragma pack(pop)

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: host_features <file.bin> <pole_pairs>\n"); return 2; }
  FILE *f = fopen(argv[1], "rb");
  if (!f) { perror("open"); return 1; }
  int pp = atoi(argv[2]);
  static pdm::Extractor ext;
  pdm::Features ft;
  WinHdr h;
  std::vector<int16_t> buf;
  while (fread(&h, sizeof(h), 1, f) == 1) {
    buf.resize((size_t)h.n * h.nch);
    if (fread(buf.data(), 2, buf.size(), f) != buf.size()) break;
    ext.begin(h.fs, h.n, h.nch, h.vibMask, h.curCh == 0xFFFF ? -1 : h.curCh, h.scale);
    for (uint32_t i = 0; i < h.n; i += 512) {            // same 512-sample chunks as the node
      uint32_t take = h.n - i < 512 ? h.n - i : 512;
      ext.push(buf.data() + (size_t)i * h.nch, take);
    }
    ext.finish(h.rpm, pp, ft);
    printf("{\"rms\":%.9g,\"peak\":%.9g,\"crest\":%.9g,\"kurt\":%.9g,\"skew\":%.9g,\"b0\":%.9g,\"b1\":%.9g,\"b2\":%.9g,"
           "\"b3\":%.9g,\"bhf\":%s,\"a1x\":%s,\"a2x\":%s,\"app\":%s,\"fdom\":%.9g,\"cur_rms\":%s,\"cur_mean\":%s,\"x_rms\":%.9g}\n",
           ft.rms, ft.peak, ft.crest, ft.kurt, ft.skew, ft.band[0], ft.band[1], ft.band[2], ft.band[3],
           ft.hasBhf ? std::to_string(ft.bhf).c_str() : "null",
           ft.hasA1x ? std::to_string(ft.a1x).c_str() : "null",
           ft.hasA2x ? std::to_string(ft.a2x).c_str() : "null",
           ft.hasApp ? std::to_string(ft.app).c_str() : "null",
           ft.fdom,
           ft.hasCur ? std::to_string(ft.curRms).c_str() : "null",
           ft.hasCur ? std::to_string(ft.curMean).c_str() : "null",
           ft.axRms[0]);
  }
  fclose(f);
  return 0;
}
