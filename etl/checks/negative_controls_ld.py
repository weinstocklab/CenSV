#!/usr/bin/env python3
"""Negative controls for the LD substrate.

ld.load() asserts nine things about the extracted frames - genotype rows match variant rows,
the SNP and SV blocks share an individual set, dosages are in {0,1,2}, no row is monomorphic,
each block is in position order, no SNP is below the source's MAF filter, the SV-only set is
the one recorded, every SV with evidence is present, and r recomputed from these genotypes
reproduces the published panels on the variants they share. All nine pass, which proves
nothing until each is shown to FAIL on an input that is wrong.

  1  genotype_out_of_range   a dosage that is not 0, 1 or 2
  2  monomorphic_row         a row with no variance, whose r is undefined
  3  shuffle_positions       variants table out of position order - the matrix stays valid and
                             every column of the drawn triangle moves to the wrong place
  4  sample_mismatch         the SNP block on a different number of individuals, so SV-SNP r
                             would be computed across different people
  5  snp_below_maf           a SNP under the 1% the source filters at
  6  flank_count_disagrees   the variants table and the summary disagreeing about how
                             many SNPs a flank holds, which is what a half-finished
                             re-extraction leaves behind
  7  drop_a_marked_sv        an SV carrying evidence removed from the frame - the panel would
                             simply have nothing to say about that hit, silently
  8  break_reproduction      genotypes perturbed so r no longer matches the published panel
  9  round_the_imputation    the bug that shipped: the SNP block's mean-imputed calls rounded
                             to whole dosages, with the missing counts zeroed to match. The
                             frame stays internally consistent in every respect. Since the
                             substituted dosage stopped shipping this is caught earlier and
                             more precisely, by the ETL's assertion that it is the mean of the
                             row's observed calls, rather than only by the published panel
 10  impute_shifted          every substituted dosage moved by 0.01 - legal, consistent, and
                             a different measurement. Same: the source's column no longer
                             matches the mean of the genotypes that ship, and the ETL says so
 11  missing_count_wrong     the variants table and the genotype matrix disagreeing about
                             which calls were open
 12  packer_loses_state_3    a packer that writes the open calls away. This one corrupts the
                             PAYLOAD rather than the frames, which is where the bug actually
                             was: `_pack` was handed the dosage matrix and truncated every
                             substituted cell, so the browser downloaded a matrix that every
                             assertion in the loader had passed over while reading the floats
                             beside it

Controls 3, 7, 8 and 9 are the ones worth having. None of them makes the data malformed:
every shape agrees, every dosage is legal, every plot renders. 3 draws the right numbers in
the wrong places, 7 loses a hit without trace, 8 catches the extraction drifting away from the
measurement it is supposed to be, and 9 is that drift as it actually happened.

What NO control here can catch: frames that are internally consistent and computed on the wrong
individuals. That rests on the extractor reusing the published pipeline's own sample
intersection, not on anything in this file, and it is the honest limit of these checks.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ld                                                                  # noqa: E402
import build_data                                                          # noqa: E402

ROOT = "/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere"
WEB = os.path.join(ROOT, "cenSV_web", "web", "public", "data")
chroms = build_data.build_chromosomes(ROOT)
# The catalog ships columnar - one array per field - so it is rebuilt into rows before
# pandas sees it. Without this, pd.DataFrame() produces a frame whose columns are literally
# "columns", "rows" and "data", and every control below fails for the wrong reason.
_cat = json.load(open(os.path.join(WEB, "catalog.json")))
if not (isinstance(_cat, dict) and "columns" in _cat):
    raise SystemExit("catalog.json is not columnar - rebuild it with etl/build_data.py")
catalog = pd.DataFrame(
    [dict(zip(_cat["columns"], vals)) for vals in zip(*_cat["data"])])
if len(catalog) != _cat["rows"]:
    raise SystemExit("the columnar catalog rebuilt %d rows, not the %d it declares"
                     % (len(catalog), _cat["rows"]))

base, note = ld.load(ROOT, chroms, catalog)
if base is None:
    raise SystemExit("BASELINE FAILED, so the controls mean nothing: %s" % note)
print("baseline PASS: %s" % note)

real_load, real_read = np.load, pd.read_csv
TARGET = "chr8"
FRAME = os.path.join(ROOT, "discovery/2026-05-19_ld_plot_all_chr/output/_censv_frames",
                     TARGET)


def snp_table():
    return real_read(os.path.join(FRAME, "snp_variants.tsv"), sep="\t")


def marked_row():
    """The first row carrying evidence, read from the real file.

    Derived independently on both sides rather than handed from one patch to the other:
    ld.load() reads the genotypes BEFORE the variants table, so a hand-off in that direction
    never arrives and the control ends up tripping the row-count assertion instead of the one
    it is named for.
    """
    v = real_read(os.path.join(FRAME, "sv_variants.tsv"), sep="\t")
    hit = v.index[v["marked"] == 1]
    return int(hit[0]) if len(hit) else None


def npz_patch(kind):
    def fake(path, *a, **kw):
        z = real_load(path, *a, **kw)
        if TARGET + os.sep not in str(path) and "/%s/" % TARGET not in str(path):
            return z
        sv, snp = np.array(z["sv"], copy=True), np.array(z["snp"], copy=True)
        if kind == "drop_a_marked_sv":
            r = marked_row()
            if r is not None:
                sv = np.delete(sv, r, axis=0)
        if kind == "round_the_imputation":
            # exactly what the extractor did before 2026-08-29
            imp = snp_table()["impute"].to_numpy(float)
            snp = np.where(snp == 3, np.rint(imp)[:, None], snp).astype(snp.dtype)
        if kind == "genotype_out_of_range":
            sv[0, 0] = 3
        elif kind == "monomorphic_row":
            sv[1, :] = 1
        elif kind == "sample_mismatch":
            snp = snp[:, :-2]
        elif kind == "break_reproduction":
            # Legal dosages, right shape, wrong measurement. NOT a column swap across the whole
            # matrix - that is a relabelling of the sample order and r is invariant to it. NOT
            # one row either: the reproduction check compares only the 26 chr8 variants shared
            # with the published panel, and a single perturbed row usually falls outside them.
            # Every row permuted independently keeps allele frequencies exactly and destroys
            # every pairwise r.
            rng = np.random.default_rng(0)
            for i in range(sv.shape[0]):
                sv[i, :] = sv[i, rng.permutation(sv.shape[1])]
        return {"sv": sv, "snp": snp}
    return fake


def csv_patch(kind):
    def fake(path, *a, **kw):
        df = real_read(path, *a, **kw)
        p = str(path)
        if kind == "shuffle_positions" and p.endswith("%s/sv_variants.tsv" % TARGET):
            df = df.copy()
            df["pos"] = np.roll(df["pos"].to_numpy(), 3)
        elif kind == "snp_below_maf" and p.endswith("%s/snp_variants.tsv" % TARGET):
            df = df.copy()
            df.loc[df.index[0], "maf"] = 0.004
        elif kind == "flank_count_disagrees" and p.endswith("%s/snp_variants.tsv" % TARGET):
            # one row moved from the left flank to the right: same rows, same genotypes, and
            # the summary's per-flank counts no longer describe them
            df = df.copy()
            hit = df.index[df["side"] == "L"]
            if len(hit):
                df.loc[hit[-1], "side"] = "R"
        elif kind == "round_the_imputation" and p.endswith("%s/snp_variants.tsv" % TARGET):
            # the counts follow the matrix, so the frame stays internally consistent and only
            # the published panel can contradict it
            df = df.copy()
            df["n_missing"] = 0
        elif kind == "impute_shifted" and p.endswith("%s/snp_variants.tsv" % TARGET):
            df = df.copy()
            df["impute"] = df["impute"] + 0.01
        elif kind == "missing_count_wrong" and p.endswith("%s/snp_variants.tsv" % TARGET):
            df = df.copy()
            hit = df.index[df["n_missing"] > 0]
            if len(hit):
                df.loc[hit[0], "n_missing"] = int(df.loc[hit[0], "n_missing"]) + 1
        elif kind == "drop_a_marked_sv" and p.endswith("%s/sv_variants.tsv" % TARGET):
            df = df.copy()
            r = marked_row()
            if r is not None:
                df = df.drop(index=r).reset_index(drop=True)
        return df
    return fake


real_pack = ld._pack


def lossy_pack(a):
    """A packer that loses the fourth state - what truncation to uint8 amounts to."""
    return real_pack(np.where(a == 3, 0, a))


fails, total = 0, 0


def run(label, npz_kind=None, csv_kind=None, cat=None, patch_ld=None, patch_pack=False):
    global fails, total
    total += 1
    if patch_pack:
        ld._pack = lossy_pack
    if npz_kind:
        np.load = npz_patch(npz_kind)
        ld.np.load = np.load
    if csv_kind:
        pd.read_csv = csv_patch(csv_kind)
        ld.pd.read_csv = pd.read_csv
    saved = None
    out, why = ld.load(ROOT, chroms, cat if cat is not None else catalog)
    ld._pack = real_pack
    np.load, pd.read_csv = real_load, real_read
    ld.np.load, ld.pd.read_csv = real_load, real_read
    if out is None:
        print("  %-22s -> FAILED as required: %s" % (label, why.split(".")[0][:100]))
        fails += 1
    else:
        print("  %-22s -> STILL PASSED  <-- the assertion is not measuring what it claims"
              % label)


run("genotype_out_of_range", npz_kind="genotype_out_of_range")
run("monomorphic_row", npz_kind="monomorphic_row")
run("sample_mismatch", npz_kind="sample_mismatch")
run("break_reproduction", npz_kind="break_reproduction")
run("shuffle_positions", csv_kind="shuffle_positions")
run("snp_below_maf", csv_kind="snp_below_maf")
run("drop_a_marked_sv", csv_kind="drop_a_marked_sv", npz_kind="drop_a_marked_sv")
# a flank whose recorded size stops matching the rows it actually holds
run("flank_count_disagrees", csv_kind="flank_count_disagrees")
run("round_the_imputation", npz_kind="round_the_imputation",
    csv_kind="round_the_imputation")
run("impute_shifted", csv_kind="impute_shifted")
run("missing_count_wrong", csv_kind="missing_count_wrong")
run("packer_loses_state_3", patch_pack=True)

print("\n%d of %d controls failed the assertions." % (fails, total))
sys.exit(0 if fails == total else 1)
