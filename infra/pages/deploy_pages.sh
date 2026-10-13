#!/usr/bin/env bash
# Publish the encrypted single-file browser to GitHub Pages. Runs on the server.
#
#   bash infra/pages/build_local.sh     # build and check, no publish - run the browser
#                                       # suites against what it leaves at the repo root
#   bash infra/pages/deploy_pages.sh    # then this
#
# The build lives in build_local.sh and is sourced, not duplicated: this script stages the
# publishable files, pushes, waits for Pages to serve the NEW bytes rather than any bytes,
# then downloads and verifies that copy.
#
# Publishing is deliberately manual: an unattended republish would put out a page that no
# browser check had seen. This script prints the browser commands at the end for the record;
# build_local.sh prints them at a point where running them still changes what gets published.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Sourced, so ROOT and PIXI carry over and there is exactly one description of the build. It
# sets -euo pipefail and cds to the repository root.
source "$HERE/build_local.sh"

STAGE="$HOME/censv_pages"
URL="https://yikaidong-git.github.io/CenSV/"

WANT=$(md5sum < "$ROOT/CenSV_offline.html" | cut -d' ' -f1)
echo "==> built $WANT"

echo "==> staging and pushing"
mkdir -p "$STAGE"
cp "$ROOT/CenSV_offline.html" "$STAGE/index.html"
cp "$ROOT/infra/pages/README_pages.md" "$STAGE/README.md"
cp "$ROOT/infra/pages/LICENSE" "$STAGE/LICENSE"
# EMPTIED, rather than written over. $STAGE is a checkout that survives between deploys, so a
# figure this deploy stops carrying would otherwise sit there and be published forever. That
# is what happened on the first open deploy: docs/screenshot.jpg, the picture of the password
# prompt, survived the copy below and the allowlist refused the publish - which is the
# allowlist doing its job, and this doing the job it should not have had.
rm -rf "$STAGE/docs"
mkdir -p "$STAGE/docs"
# The two figures the front page carries. They are rendered from the build being published,
# by web/tools/dev/shot_singlefile.mjs, so the page shows the site a visitor will meet.
cp "$ROOT/infra/pages/assets/fig1_workflow.jpg" "$STAGE/docs/fig1_workflow.jpg"
cp "$ROOT/infra/pages/assets/overview.jpg" "$STAGE/docs/overview.jpg"
cp "$ROOT/infra/pages/assets/record.jpg" "$STAGE/docs/record.jpg"
touch "$STAGE/.nojekyll"
cd "$STAGE"
git config user.name "Yikai.Dong"
git config user.email "yikai.dong19@gmail.com"
git add -A
# A published-file allowlist, because this repository is PUBLIC and the source repository it
# is built from is not. Anything unexpected here is a leak, so the deploy stops rather than
# publishing it.
UNEXPECTED=$(git -C "$STAGE" ls-files | grep -vxE 'index\.html|README\.md|LICENSE|\.nojekyll|docs/fig1_workflow\.jpg|docs/overview\.jpg|docs/record\.jpg' || true)
if [ -n "$UNEXPECTED" ]; then
  echo "    REFUSING TO PUBLISH - unexpected files staged:"
  echo "$UNEXPECTED" | sed 's/^/      /'
  exit 1
fi
# ONE COMMIT, ALWAYS. This repository is an artefact rather than a record: before the page
# opened it had accumulated 63 commits, every one of them titled "The browser, encrypted" and
# every one a full 2.5 MB snapshot of a site nobody could read. What a visitor wants from it
# is the file it is serving now. So each deploy builds the history from nothing - an orphan
# branch, one commit - and force-pushes it, which keeps the public repository at exactly one
# commit and one copy of the site however many times it is republished.
#
# Safe here and nowhere else: nothing depends on these hashes. The source repository
# weinstocklab/CenSV carries the development record, and that history is append-only.
git checkout -q --orphan _publish
git add -A
git commit -q -F - <<MSG
CenSV, the published browser

Interactive browser for centromeric structural variation, on T2T-CHM13 v2.0.
One self-contained page: https://yikaidong-git.github.io/CenSV/

Dong Y, Cutler D, Weinstock JS. Common centromeric variation associates with
molecular and complex traits in humans. medRxiv 2026.
https://doi.org/10.64898/2026.10.09.26365154

Source, data pipeline and deployment: https://github.com/weinstocklab/CenSV
MSG
git branch -M _publish main
# Checked as STORED, not as written: git with core.autocrlf set would rewrite the file on the
# way in, silently and only in a browser.
printf "    blob as stored: "
git cat-file blob HEAD:index.html | md5sum | cut -d' ' -f1
git branch -f gh-pages HEAD
git push -q -f origin main
git push -q -f origin gh-pages
echo "    pushed, one commit"

echo "==> waiting for Pages to serve the NEW bytes"
for i in $(seq 1 30); do
  GOT=$(curl -sS -L --compressed "$URL" 2>/dev/null | md5sum | cut -d' ' -f1)
  [ "$GOT" = "$WANT" ] && { echo "    live after $((i * 10))s"; break; }
  [ "$i" -eq 30 ] && { echo "    TIMED OUT - served $GOT, wanted $WANT"; exit 1; }
  sleep 10
done

echo "==> verifying what is actually being served"
# Back to the repo: the push above left us in $STAGE, which has no pixi.toml, and `pixi run`
# resolves its manifest from the working directory rather than from the script's location.
cd "$ROOT"
curl -sS -L --compressed -o /tmp/censv_published.html "$URL"
# Three questions about the copy a reader downloads, in order of what each can catch: is it
# byte-for-byte the file the browser suites passed, does it carry the numbers it should, and
# does it open with nothing in front of it.
cmp "$ROOT/CenSV_offline.html" /tmp/censv_published.html \
  && echo "    served bytes identical to the build that was checked"
"$PIXI" run python "$ROOT/web/tools/verify/verify_shipped_data.py" /tmp/censv_published.html
"$PIXI" run python "$ROOT/web/tools/verify/verify_open.py" /tmp/censv_published.html
rm -f /tmp/censv_published.html

echo
echo "URL: $URL"
echo
echo "The published copy, re-checked in a browser - this script cannot run these:"
echo "  node web/tools/verify/verify_interactions.mjs $URL"
echo "  node web/tools/verify/verify_dip_modes.mjs    $URL"
echo "  node web/tools/verify/verify_arrays.mjs       $URL"
