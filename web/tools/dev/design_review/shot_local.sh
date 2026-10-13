#!/usr/bin/env bash
# Screenshot one route of the local static server as JPG, for the option review.
#
#   shot_local.sh <route> <out-name> [width] [height]
#
# Adapted from web/tools/dev/shot.sh, which writes into the repo's shots/ directory. These
# are review mock-ups rather than a record of the product, so they go to a scratch folder.
# The two things that script warns about hold here too: the path handed to Chrome is an
# absolute Windows path, and reduced motion is forced so the capture lands on the settled
# layout instead of inside the 160 ms entrance animation.
set -euo pipefail

ROUTE="${1:?route}"
NAME="${2:?name}"
W="${3:-1600}"
H="${4:-2000}"   # 1100 collapses the figure; 2000 renders the settled layout
PORT="${PORT:-4173}"
OUTDIR="/c/temp/shots"
mkdir -p "$OUTDIR"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PNG_MSYS="/c/temp/shots/${NAME}.png"
PNG_WIN="$(cygpath -w "$PNG_MSYS")"
rm -f "$PNG_MSYS"

MSYS_NO_PATHCONV=1 "$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-prefers-reduced-motion \
  --window-size="${W},${H}" --screenshot="$PNG_WIN" \
  --virtual-time-budget=20000 --user-data-dir=/c/temp/cdp-shot \
  "http://127.0.0.1:${PORT}/${ROUTE}" >/dev/null 2>&1

test -s "$PNG_MSYS" || { echo "FAILED: no image written for $ROUTE"; exit 1; }
python - "$PNG_WIN" "$(cygpath -w "$OUTDIR/$NAME.jpg")" <<'PY'
import os
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
crop = os.environ.get("CROP")
if crop:
    l, t, r, b = [int(v) for v in crop.split(",")]
    im = im.crop((l, t, min(r, im.width), min(b, im.height)))
im.save(dst, "JPEG", quality=90)
print("%s  %dx%d" % (dst, im.width, im.height))
im.close()
os.remove(src)
PY
