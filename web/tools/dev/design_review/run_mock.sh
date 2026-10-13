#!/usr/bin/env bash
# Render one option mock-up from the real browser.
#
#   run_mock.sh <name> <label> <tier> <ribbon>
#
# The patch is written locally, uploaded and built on the server, because node_modules under
# the mount was installed for Linux. Only dist/ comes back.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NAME="$1"; L="$2"; T="$3"; R="$4"
REMOTE=/home/ydon268/weinstocklab/projects/ydon268/Project1_Centromere/cenSV_web
LOCAL_WEB="Z:/Project1_Centromere/cenSV_web/web"

python patch_mock.py "$L" "$T" "$R" "${5:-full}"
ssh hgcc "cat > $REMOTE/web/src/haplo.js" < out_mock/haplo.js
ssh hgcc "cat > $REMOTE/web/src/_mock_opts.js" < out_mock/_mock_opts.js
ssh hgcc "bash ~/build_remote.sh" 2>&1 | tail -1
rclone rc vfs/refresh dir=Project1_Centromere/cenSV_web/web/dist recursive=true >/dev/null
cp "$LOCAL_WEB/dist/index.html" /c/temp/censv_dist/
cp -r "$LOCAL_WEB/dist/assets/." /c/temp/censv_dist/assets/

CROP=195,240,1410,985 bash ../mock/shot_local.sh '#/chr5/haplotypes/193' "${NAME}_tight" 1600 3200
CROP=195,240,1410,985 bash ../mock/shot_local.sh '#/chr16/haplotypes/1031' "${NAME}_three"  1600 3200
echo "=== $NAME done ==="
