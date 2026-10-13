#!/usr/bin/env bash
# Screenshot one route of the running preview server, as JPG.
#
#   web/tools/dev/shot.sh <route> <out-name> [width] [height]
#   web/tools/dev/shot.sh "#/chr8" chr8_tracks 1500 2200
#
# Two things here are not incidental:
#
#   * the PNG path passed to Chrome is ABSOLUTE. A relative --screenshot path fails on
#     Windows with "Access is denied" and writes nothing, while the surrounding shell
#     reports success - so a missing shot looks like a passing one.
#   * the output is converted to JPG, because that is the only format these get read in.
#
# And one thing to remember when reading the result: headless Chrome clamps its window to
# roughly 500 px wide. A render below that is NOT the responsive layout at that width, it is
# a 500 px layout cropped. Half an hour went into a CSS bug that did not exist because of it.
set -euo pipefail

ROUTE="${1:-#/}"
NAME="${2:-shot}"
W="${3:-1500}"
H="${4:-1400}"
PORT="${PORT:-4173}"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
OUTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../shots/current" && pwd)"
PNG="$(cygpath -w "/tmp/${NAME}.png" 2>/dev/null || echo "/tmp/${NAME}.png")"

rm -f "/tmp/${NAME}.png"
# --force-prefers-reduced-motion is not cosmetic. The record panel has a 160 ms entrance
# animation, and under a virtual time budget the capture lands INSIDE it: the panel comes
# out at opacity .4 with the page showing through, which reads as a translucency bug that
# does not exist. Forcing reduced motion trips the site's own prefers-reduced-motion rule
# and the capture is of the settled layout.
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-prefers-reduced-motion \
  --window-size="${W},${H}" --screenshot="$PNG" \
  --virtual-time-budget=6000 --user-data-dir=/tmp/cdp-shot \
  "http://localhost:${PORT}/${ROUTE}" >/dev/null 2>&1

test -s "/tmp/${NAME}.png" || { echo "FAILED: no PNG written for $ROUTE"; exit 1; }
# The interpreter here is a WINDOWS python, so it is handed Windows paths. Passing the
# MSYS "/tmp/..." form gets FileNotFoundError on a file that plainly exists.
python - "$PNG" "$(cygpath -w "$OUTDIR/$NAME.jpg")" <<'PY'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
im.save(dst, "JPEG", quality=88)
print("%s  %dx%d" % (dst, im.width, im.height))
PY
