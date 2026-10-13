#!/usr/bin/env python3
"""Negative controls for the one track check that is not structural.

tracks.load() passes with median r = -0.93 between methylation and dip density. A check that
passes proves nothing until it is shown to fail on a version that is wrong, so this feeds it
three corrupted inputs and requires a failure from each:

  1  density reversed along the axis        - the frame flipped
  2  density shuffled across chromosomes    - the join broken
  3  density replaced by noise              - no relationship at all

If any of these still passes, the check is measuring something other than what it claims.
"""
import os
import sys

import numpy as np

# The loaders live one level up, in etl/. This file sits in etl/checks/ because the
# build pipeline never imports it - it exists to break the pipeline on purpose.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tracks                                                              # noqa: E402
import build_data                                                          # noqa: E402

ROOT = "/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere"
chroms = build_data.build_chromosomes(ROOT)

base, note = tracks.load(ROOT, chroms)
if base is None:
    raise SystemExit("BASELINE FAILED, so the controls mean nothing: %s" % note)
print("baseline PASS, median r = %.3f" % base["median_corr"])

real_hist = np.histogram


def patched(kind, seed=0):
    rng = np.random.default_rng(seed)
    order = None

    def fake(values, bins=None, **kw):
        cnt, edges = real_hist(values, bins=bins, **kw)
        if kind == "reverse":
            return cnt[::-1], edges
        if kind == "shuffle":
            return rng.permutation(cnt), edges
        if kind == "noise":
            return rng.integers(0, max(1, int(cnt.max()) + 1), size=len(cnt)), edges
        return cnt, edges

    return fake


fails = 0
for kind in ("reverse", "shuffle", "noise"):
    tracks.np.histogram = patched(kind)
    out, why = tracks.load(ROOT, chroms)
    tracks.np.histogram = real_hist
    if out is None:
        print("  %-8s -> FAILED as required: %s" % (kind, why.split(".")[0]))
        fails += 1
    else:
        print("  %-8s -> STILL PASSED at median r = %.3f  <-- the check is not measuring "
              "what it claims" % (kind, out["median_corr"]))

print("\n%d of 3 controls failed the check." % fails)
sys.exit(0 if fails == 3 else 1)
