#!/usr/bin/env python3
"""Negative controls for the ancestry decomposition of the dip track.

tracks.load() splits dip density into ancestry strata and asserts that the strata partition
the haplotypes, partition the dips bin by bin, and rebuild the pooled track that is actually
shipped. Since the 2026-08-28 rewrite it also asserts that the join is TOTAL - every one of
the 188 samples resolves to a superpopulation - because it does: the browser used to draw a
7-sample "unlabelled" stratum, and those 7 were never unlabelled. They sit outside the
3,202-sample NYGC panel because that panel is a call set (2,504 unrelated + 698 relatives
completing trios), not the collection.

All of those assertions pass. That proves nothing until each is shown to FAIL on an input
that is wrong, so this corrupts the join seven ways and requires a failure from each:

  1  drop a stratum       - the commonest way a decomposition silently stops decomposing
  2  duplicate a sample   - one sample in two strata, so counts exceed the pooled total
  3  scramble the panel   - Population and Superpopulation shuffled against each other
  4  lose_one_stratum     - STRATA narrowed; haplotype counts stay complete, dips do not
  5  drop_supplements     - the regression control for the bug this file was rewritten for:
                            hide the three tables that cover the 7 samples the panel misses
  6  contradict_sources   - two tables made to disagree about one sample's population
  7  stale_hand_entry     - a hand assignment left in the file that no sample uses

Control 5 is the load-bearing one. It reproduces EXACTLY the old behaviour - 7 samples with
no row anywhere - and the old code PASSED on it, shipping them as their own stratum. If a
future edit reintroduces a fallback instead of a failure, this is what catches it.

Control 3 is the subtle one. The completeness assertions cannot catch a relabelled panel: a
wrong map is still a partition, so the counts still add up and the tracks still rebuild the
pooled one. Only the panel's own internal consistency - each fine-grained population
belonging to exactly one superpopulation - stands between this browser and confidently
mislabelled tracks.

What NO control here can catch: tables that are internally consistent, agree with each other,
and are simply wrong about who is who. Cross-source agreement narrows that - four tables now
have to be wrong the same way rather than one - but it does not close it, and the two
hand-assigned samples (HG005, NA21309) rest on their collection's documentation rather than
on anything this file can test. That is the honest limit of these checks.
"""
import os
import sys

import pandas as pd

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
tot = {p: sum(n.get(p, 0) for n in base["nhap_anc"].values()) for p in base["strata"]}
print("baseline PASS: %s" % ", ".join("%s %d" % (p, tot[p]) for p in base["strata"]))
anc = base["ancestry"]
if anc["n_unlabelled"]:
    raise SystemExit("BASELINE is already drawing an unlabelled stratum (%d samples): %s"
                     % (anc["n_unlabelled"], anc["unlabelled"]))
print("           %d samples, %d from the panel, %d assigned by hand (%s), 0 unlabelled"
      % (anc["n_samples"], anc["n_from_panel"], len(anc["outside_1kgp"]),
         ", ".join("%s=%s" % (h["sample"], h["superpop"]) for h in anc["outside_1kgp"])))

real_read = pd.read_csv


def _is(path, target):
    return os.path.abspath(str(path)) == os.path.abspath(target)


def patched(kind):
    """Return a pd.read_csv that corrupts exactly one staged table, one way."""
    def fake(path, *a, **kw):
        df = real_read(path, *a, **kw)
        if kind == "drop_supplements" and (
                _is(path, tracks.PED) or _is(path, tracks.HPRC_R2)
                or _is(path, tracks.HPRC_Y1)):
            # the tables keep their columns and lose every row, which is what a stale or
            # unstaged supplement looks like from inside load()
            return df.iloc[0:0]
        if kind == "contradict_sources" and _is(path, tracks.HPRC_R2):
            df = df.copy()
            df.loc[df.sample_id == "HG01123", "population_abbreviation"] = "YRI"
            return df
        if not _is(path, tracks.PANEL):
            return df
        if kind == "drop_stratum":
            return df[df.Superpopulation != "SAS"]
        if kind == "duplicate":
            dup = df[df.Superpopulation == "EUR"].head(40).copy()
            dup["Superpopulation"] = "AFR"
            return pd.concat([df, dup], ignore_index=True)
        if kind == "scramble":
            df = df.copy()
            df["Superpopulation"] = df["Superpopulation"].sample(
                frac=1.0, random_state=0).values
            return df
        return df
    return fake


fails, total = 0, 0


def run(kind, label, note_if_passed):
    global fails, total
    total += 1
    pd.read_csv = patched(kind)
    tracks.pd.read_csv = pd.read_csv
    out, why = tracks.load(ROOT, chroms)
    pd.read_csv = real_read
    tracks.pd.read_csv = real_read
    if out is None:
        print("  %-18s -> FAILED as required: %s" % (label, why.split(".")[0][:110]))
        fails += 1
    else:
        print("  %-18s -> STILL PASSED  <-- %s" % (label, note_if_passed))


run("drop_stratum", "drop_stratum", "the assertion is not measuring what it claims")
run("duplicate", "duplicate", "the assertion is not measuring what it claims")
run("scramble", "scramble", "the assertion is not measuring what it claims")

# The three above are all caught by the PANEL checks, which means they do not exercise the
# join at all. The rest corrupt the join itself.
#
# drop_supplements is the regression control. Emptying the three supplementary tables leaves
# exactly the 7 samples the old code drew as "unlabelled", so the OLD code passes this and
# the new code must not.
run("drop_supplements", "drop_supplements",
    "the 7 samples the panel does not cover are silently unlabelled again")
run("contradict_sources", "contradict_sources",
    "two tables can disagree about a sample and the browser picks one")

# A hand assignment nobody uses. Not a corruption of the data - a corruption of the FILE,
# and the one that rots quietly: an entry that stops applying still looks like documentation.
total += 1
real_outside = dict(tracks.OUTSIDE_1KGP_SAMPLE)
tracks.OUTSIDE_1KGP_SAMPLE = dict(real_outside, NA_NOT_A_SAMPLE=("EUR", "nobody"))
out, why = tracks.load(ROOT, chroms)
tracks.OUTSIDE_1KGP_SAMPLE = real_outside
if out is None:
    print("  %-18s -> FAILED as required: %s" % ("stale_hand_entry", why.split(".")[0][:110]))
    fails += 1
else:
    print("  %-18s -> STILL PASSED  <-- a hand assignment can sit unused and unchecked"
          % "stale_hand_entry")

# Narrowing STRATA leaves the haplotype counts complete - they are grouped from the data, not
# from this list - while the per-bin histogram loses one stratum's dips. The partition-by-
# haplotype assertion therefore passes and only the bin-by-bin one can catch it.
total += 1
real_strata = tracks.STRATA
tracks.STRATA = [p for p in real_strata if p != "EAS"]
out, why = tracks.load(ROOT, chroms)
tracks.STRATA = real_strata
if out is None:
    print("  %-18s -> FAILED as required: %s" % ("lose_one_stratum", why.split(".")[0][:110]))
    fails += 1
else:
    print("  %-18s -> STILL PASSED  <-- the stack no longer decomposes the pooled track"
          % "lose_one_stratum")

print("\n%d of %d controls failed the assertions." % (fails, total))
sys.exit(0 if fails == total else 1)
