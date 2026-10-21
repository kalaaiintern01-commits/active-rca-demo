"""
Point the firmware, bridge and dashboard at the same GitHub Pages site / topic namespace.

    python tools/set_site.py --pages https://<user>.github.io/<repo>/          # data URL
    python tools/set_site.py --site-id 9f3c1a                                  # new topic namespace
    python tools/set_site.py --new-site-id                                     # random namespace

Rewrites firmware/src/config.h, bridge/config.json and site/config.js, then regenerates the
single-file Wokwi sketch. Re-run `pio run` afterwards if you use the VS Code extension.
"""
import argparse
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", help="GitHub Pages base URL that serves data/")
    ap.add_argument("--site-id")
    ap.add_argument("--new-site-id", action="store_true")
    a = ap.parse_args()
    site = secrets.token_hex(3) if a.new_site_id else a.site_id

    cfg_h = ROOT / "firmware" / "src" / "config.h"
    h = cfg_h.read_text(encoding="utf-8")
    if a.pages:
        u = urlparse(a.pages if a.pages.endswith("/") else a.pages + "/")
        h = re.sub(r'#define DATA_HOST\s+"[^"]*"', f'#define DATA_HOST         "{u.netloc}"', h)
        h = re.sub(r'#define DATA_BASE\s+"[^"]*"', f'#define DATA_BASE         "{u.path}data/"', h)
    if site:
        h = re.sub(r'#define SITE_ID\s+"[^"]*"', f'#define SITE_ID           "{site}"', h)
        bc = ROOT / "bridge" / "config.json"
        c = json.loads(bc.read_text())
        c["site_id"] = site
        bc.write_text(json.dumps(c, indent=2) + "\n")
        sj = ROOT / "site" / "config.js"
        sj.write_text(re.sub(r'site: "[^"]*"', f'site: "{site}"', sj.read_text(encoding="utf-8")), encoding="utf-8")
    cfg_h.write_text(h, encoding="utf-8")
    subprocess.run([sys.executable, str(ROOT / "firmware" / "tools" / "make_wokwi_single.py")], check=True)
    print("data :", re.search(r'DATA_HOST\s+"([^"]*)"', h)[1] + re.search(r'DATA_BASE\s+"([^"]*)"', h)[1])
    print("site :", re.search(r'SITE_ID\s+"([^"]*)"', h)[1])


if __name__ == "__main__":
    main()
