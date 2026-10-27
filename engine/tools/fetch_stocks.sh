#!/usr/bin/env bash
# Build engine stock files from the manufacturers' public datasheets.
#
# The datasheet PDFs and the curves digitized from them are NOT committed (Kodak Alaris website
# terms restrict redistribution of site content); this script downloads them from the original URLs,
# checks the sha256 recorded in tools/datasheets/spec.json, digitizes and builds data/stocks.
#
# Usage: tools/fetch_stocks.sh [cache-dir]     (default: data/cache)
# Needs: curl, python3 + numpy, pdftocairo (poppler-utils).
set -euo pipefail
cd "$(dirname "$0")/.."
cache="${1:-data/cache}"
mkdir -p "$cache/pdf" data/datasheets data/stocks
python3 - "$cache/pdf" <<'PY'
import hashlib, json, os, subprocess, sys
pdf_dir = sys.argv[1]
for key, doc in json.load(open("tools/datasheets/spec.json")).items():
    path = os.path.join(pdf_dir, doc["pdf"])
    if not os.path.exists(path):
        subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", path, doc["url"]], check=True)
    sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if sha != doc["sha256"]:
        os.remove(path)
        sys.exit(f"{doc['pdf']}: sha256 {sha} != expected {doc['sha256']} (datasheet revised? re-check calibration)")
    print(f"{doc['pdf']}: ok")
PY
python3 tools/datasheets/digitize.py "$cache/pdf" data/datasheets
python3 tools/stocks/build_stocks.py data/datasheets data/stocks
