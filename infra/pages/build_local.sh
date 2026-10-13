#!/usr/bin/env bash
# Build the browser and check it, without publishing anything. Runs on the server.
#
#   bash infra/pages/build_local.sh
#
# Produces CenSV_offline.html and CenSV_locked.html at the repository root and runs every
# check that does not need Chrome. `deploy_pages.sh` sources this file and then stages and
# pushes, so the two cannot drift: there is one build, described once.
#
# Run this first. The browser checks accept a local file, and running them here - before a
# push rather than after one - is the difference between catching a broken build and
# publishing it.
#
# THE PAGE OPENED on 2026-10-13, when the preprint posted. Until then what shipped was the
# same site encrypted under a passphrase, and this script read that passphrase, built a second
# locked file and ran a ten-check crypto suite over it. All of that is retired: a publish now
# needs no secret of any kind. web/tools/build_singlefile.py keeps its --password-env path,
# and the deploy asserts the file it publishes carries no gate, so the capability cannot
# reach the page by accident. The retired checks are at f4781b3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROJECT_ROOT="$(cd "$ROOT/.." && pwd -P)"
PIXI="$HOME/.pixi/bin/pixi"
cd "$ROOT"

echo "==> data"
# Not optional, and not a convenience. `npm run build` only COPIES web/public/data, so
# an ETL fix that is not re-run here gets published as a passing build of stale numbers
# - which is exactly what happened on 2026-08-28 with the ancestry join: every crypto
# and browser check passed on a page still drawing seven samples as "unlabelled",
# because not one of them reads the data. verify_shipped_data.py below is the check
# that would have stopped it.
#
# CENSV_SKIP_ETL holds the REASON the data is not being re-derived, and is refused unless the
# payload is exactly what git holds - so what ships is a payload this script built and someone
# reviewed, never one that has drifted from the ETL. See
# results/imputation/decompose/cosine_nj/_archive/2026-09-12_chr15_chr18_regen/README.md
if [ -z "${CENSV_SKIP_ETL:-}" ]; then
  "$PIXI" run python etl/build_data.py "$PROJECT_ROOT" web/public/data 2>&1 | tail -3
else
  if [ -n "$(git status --porcelain web/public/data)" ]; then
    echo "CENSV_SKIP_ETL is set and web/public/data differs from the commit." >&2
    echo "The skip ships the committed payload, so it only holds when they are the same." >&2
    exit 2
  fi
  echo "    NOT re-derived. Reason given: $CENSV_SKIP_ETL"
  echo "    Shipping the committed payload at $(git rev-parse --short HEAD):web/public/data"
  echo "    Every check below still runs, verify_shipped_data.py included."
fi

echo "==> the browser's own LD decoder, against the published panels"
# etl/ld.py asserts this in numpy, through the code that wrote the bytes. This runs
# web/src/ld.js - the module the browser ships - over web/public/data/ld.json, and is the
# only check that reads the payload the way a reader will. It is what caught the packer
# handing the dosage matrix to a uint8 cast: every numpy assertion passed on the floats it
# was reading while the shipped bytes carried truncated ones.
( cd web && "$PIXI" run node tools/verify/verify_ld_decode.mjs 2>&1 | tail -3 )

echo "==> the loader assertions, each shown to fail"
# Twelve corruptions of the extraction - a dosage out of range, a monomorphic row, variants
# out of position order, a marked SV dropped, the substituted dosage shifted - each of which
# one of ld.load()'s assertions has to CATCH. Nine assertions all passing proves nothing until
# each is shown to fail on an input that is wrong.
#
# This cannot run in GitHub Actions: it reads the extraction under /beegfs, which is not in
# the repository. It runs here, on the machine that has it, before every publish.
"$PIXI" run python etl/checks/negative_controls_ld.py | tail -1

echo "==> front end"
# `npm ci` only when the lockfile is newer than the tree it produced, so a routine redeploy
# does not reinstall 612 files for nothing.
if [ ! -d web/node_modules ] || [ web/package-lock.json -nt web/node_modules ]; then
  ( cd web && "$PIXI" run npm ci --silent )
  echo "    dependencies installed"
else
  echo "    dependencies current"
fi
( cd web && "$PIXI" run npm run build 2>&1 | tail -4 )

echo "==> reader-visible copy"
# The caveats in this browser exist to stop a reader over-reading a figure, and they read
# best stating what to trust. This stops a denial-shaped one reaching a publish.
"$PIXI" run python web/tools/verify/scan_copy_register.py web/src/*.js web/index.html

echo "==> single-file build"
"$PIXI" run python web/tools/build_singlefile.py "$ROOT/CenSV_offline.html" | tail -1

echo "==> checking it before anything is published"
# What the file SAYS, read out of its own container the way the page reads it. This is the
# check that catches a build of stale numbers, which no browser check can see.
"$PIXI" run python web/tools/verify/verify_shipped_data.py "$ROOT/CenSV_offline.html"
# And that it opens with no gate in front of it. The builder can still produce an encrypted
# file; this is what stops one reaching the page.
"$PIXI" run python web/tools/verify/verify_open.py "$ROOT/CenSV_offline.html"

# Sourced by deploy_pages.sh, which prints its own closing instructions. Only say this when
# the script was run on its own.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo
  echo "Built, not published:"
  echo "  $ROOT/CenSV_offline.html"
  echo
  echo "Run these from a machine with Chrome, then publish with deploy_pages.sh:"
  echo "  node web/tools/verify/verify_haplotypes.mjs   $ROOT/CenSV_offline.html ."
  echo "  node web/tools/verify/verify_interactions.mjs $ROOT/CenSV_offline.html"
  echo "  node web/tools/verify/verify_dip_modes.mjs    $ROOT/CenSV_offline.html"
  echo "  node web/tools/verify/verify_ld_panel.mjs     $ROOT/CenSV_offline.html"
  echo "  node web/tools/verify/verify_arrays.mjs       $ROOT/CenSV_offline.html"
  echo "  node web/tools/verify/verify_cohort.mjs       $ROOT/CenSV_offline.html"
  echo "  node web/tools/verify/verify_methylation.mjs  $ROOT/CenSV_offline.html"
  echo
  echo "And with a visit beacon configured, build one and watch it fire:"
  echo "  CENSV_GOATCOUNTER=<code> pixi run python web/tools/build_singlefile.py /tmp/b.html"
  echo "  CENSV_GOATCOUNTER=<code> node web/tools/verify/verify_beacon.mjs /tmp/b.html"
fi
