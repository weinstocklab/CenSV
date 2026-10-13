#!/usr/bin/env python3
"""R9: population differentiation, as a per-SV ATTRIBUTE rather than an evidence layer.

R9's result is that differentiation does NOT explain the associations:

    "Whether population structure could generate the QTL catalog depends on how
     differentiated centromeric SVs are, and they are barely differentiated at all."

So a high-F_ST SV is not converging evidence for anything, and colouring one as a hit would
invert the section's claim. F_ST and the super-population frequencies belong on the SV
itself, where they let a reader ask of any association: is this variant differentiated?

The per-SV table is keyed on (chrom, sv_index). That key is load-bearing - the note in
res_09_popgen.tex records that an earlier version of this analysis joined on
(chrom, pos, svtype, svlen), which is NOT a key: 1,732 coordinate keys carry 2-4 rows
because one position holds the pre-resolution parent SV alongside its haplogroup
components, and F_ST differs within a key by up to 0.404. That produced impossible results
before it was caught.
"""
import os

import pandas as pd

D = "discovery/2026-05-09_sv_imputability_features/output"
REL = D + "/v3/per_sv_features_v3_with_genome.tsv"
ANC = D + "/sv_ancestry_features.tsv"

# From res_09_popgen.tex. The catalog-wide figures are over every SV record; the imputable
# figures are over the 10,705-row per-SV feature table, which is this browser's catalog.
# Corrected 2026-09-07: Hudson's n is the number of sampled gene copies, and
# 13b_sv_ancestry.py had been passing the number of individuals, which over-subtracts the
# sampling variance and biased every estimate downward. The source column, both figures and
# res_09 moved together; these are the restated figures.
PUBLISHED = dict(
    catalog_mean=0.0164,        # "Across the full catalog the mean F_ST was 0.0164"
    catalog_pct_gt015=0.58,     # "only 0.58% exceeded F_ST > 0.15"
    catalog_max=0.580,          # "maximum F_ST = 0.580"
    imputable_mean=0.0238,      # "Imputable SVs were somewhat more differentiated (0.0238"
    imputable_pct_gt015=1.47,   # "1.47% above 0.15)"
)

# THESE FREQUENCIES ARE NOT THE CATALOG'S CARRIER FREQUENCY, and the browser must not
# present them as though they were. met_09_popgen.tex:
#
#   "from HPRC SV genotypes called by SVIM-asm, that is, directly called genotypes rather
#    than imputed dosages. SV allele frequencies were computed in the 188 HPRC training
#    individuals partitioned into five 1000 Genomes super-populations (AFR = 55, AMR = 39,
#    EAS = 39, SAS = 34, EUR = 21)."
#
# svfreq in the catalog is the IMPUTED frequency over the 1000 Genomes cohort. The two are
# different quantities on different cohorts and barely correlate (r = 0.04 over the 10,705
# SVs) - the chr8 CDR lead is 0.553 imputed and 2/376 in the assemblies. Shown side by side
# without saying so, they read as a contradiction.
#
# They are carried as frequencies and labelled with their cohort, not rendered as bars
# normalised to their own row - which would draw "2 of 68" as a full bar and invite exactly
# the reading that is wrong.
#
# Counts were the first attempt and had to be abandoned: the denominators in the methods
# (2 x 55/39/39/21/34) are only the MODE. A minority of SVs have a missing call in one or
# two assemblies, so allele number varies per SV - EAS carries 1/74 as well as 1/78, EUR
# 1/40 as well as 1/42 - and the table records no AN to divide by. Printing "2 of 68" would
# have been wrong for those. Found by asserting the denominator, which failed.
POPS = ["AFR", "AMR", "EAS", "EUR", "SAS"]
COLS = ["chrom", "sv_index", "max_FST_pair_sv", "total_af_sv"] + \
       ["af_%s_sv" % p for p in POPS]


def load(root, catalog_keys, strict=True):
    """Return (per-SV frame indexed by (chrom, sv_index), note).

    catalog_keys is the set the browser's catalog is built on. The two must be the SAME
    entity set; if they are not, one of them is built from the wrong ensembles and every
    per-SV number attached here would be attached to the wrong SVs.
    """
    path = os.path.join(root, REL)
    anc_p = os.path.join(root, ANC)
    if not os.path.exists(path):
        return None, "source not found: %s" % REL

    f = pd.read_csv(path, sep="\t", usecols=lambda c: c in COLS)
    keys = set(zip(f.chrom, f.sv_index.astype(int)))
    if keys != catalog_keys:
        only_f = len(keys - catalog_keys)
        only_c = len(catalog_keys - keys)
        msg = ("the F_ST feature table and the catalog are not the same SV set: %d rows "
               "only in the feature table, %d SVs only in the catalog" % (only_f, only_c))
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    v = f.max_FST_pair_sv.dropna()
    got = dict(
        imputable_mean=round(float(v.mean()), 4),
        imputable_pct_gt015=round(100.0 * float((v > 0.15).mean()), 2),
    )
    if os.path.exists(anc_p):
        a = pd.read_csv(anc_p, sep="\t", usecols=["max_FST_pair_sv"]).max_FST_pair_sv.dropna()
        got["catalog_mean"] = round(float(a.mean()), 4)
        got["catalog_pct_gt015"] = round(100.0 * float((a > 0.15).mean()), 2)
        got["catalog_max"] = round(float(a.max()), 3)
    else:
        return None, "source not found: %s" % ANC

    if got != PUBLISHED:
        diff = {k: (got[k], PUBLISHED[k]) for k in PUBLISHED if got[k] != PUBLISHED[k]}
        msg = "R9 numbers do not reproduce res_09_popgen.tex; (got, published) = %s" % diff
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    g = f.set_index(["chrom", "sv_index"])
    afs = g[["af_%s_sv" % p for p in POPS]]

    # The overall frequency is a sample-size-weighted mean of the five, so it must lie
    # between the smallest and the largest of them - for every SV, exactly. That holds
    # whatever the per-SV allele numbers are, which is what makes it usable here. It fails
    # if a column is mislabelled, if the join slips, or if total_af_sv is over a different
    # sample set than the five it is supposed to summarise.
    lo, hi = afs.min(axis=1), afs.max(axis=1)
    outside = (g.total_af_sv < lo - 1e-9) | (g.total_af_sv > hi + 1e-9)
    if int(outside.sum()):
        worst = (g.total_af_sv - hi).abs().idxmax()
        msg = ("%d SVs where the overall HPRC frequency is not between the smallest and "
               "largest super-population frequency, so these columns are not the parts of "
               "that whole (worst: %s)" % (int(outside.sum()), worst))
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    out = g[["max_FST_pair_sv", "total_af_sv"]].rename(
        columns=dict(max_FST_pair_sv="fst", total_af_sv="af_hprc"))
    for p in POPS:
        out["af_" + p] = g["af_%s_sv" % p]

    note = ("max pairwise F_ST on all %s SVs (%d carry a value), plus directly-called HPRC "
            "allele frequencies by super-population; catalog mean %.4f, %.2f%% above 0.15, "
            "max %.3f" % ("{:,}".format(len(out)), len(v), got["catalog_mean"],
                          got["catalog_pct_gt015"], got["catalog_max"]))
    return out, note
