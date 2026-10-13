#!/usr/bin/env python3
"""R7 layer: cis expression and splicing QTL.

The hit definition is not invented here. It is copied from the filter the manuscript's own
Figure 3A applies, at paper/v2/figures/code/fig_cis_qtl.py:179 -

    cis = df[(df["cis_trans"]=="cis") & (df["qval"]<=0.05)]

over results/analysis_qtl/final_tables_cv01_maf005/all_genes_final.tsv. Any other table or
threshold produces a browser that disagrees with the paper it is meant to present. Two
earlier candidates did exactly that: genes_wide.tsv gives 120/123 and genes_by_modality.tsv
gives 118/90, against the published 86/74, because both are unions over ensembles, windows
and significance tiers.

TRANS IS DELIBERATELY EXCLUDED. R7's result is that no trans association survives
multiple-testing, cross-mappability, conditioning and the non-reference-paralog control
(46 -> 0, Supplementary Note 8). The trans rows in this table are the pre-control scan.
Drawing them as hits would have the browser assert something the paper spent a whole note
refuting.
"""
import os
import re

import pandas as pd

# The published counts, from res_07_qtl.tex: "86 eGenes and 74 sGenes at q <= 0.05
# (141 unique genes)". These are asserted, not assumed - if the upstream table changes
# shape the build stops rather than quietly shipping different numbers than the paper.
PUBLISHED = dict(egenes=86, sgenes=74, unique_genes=141)

# The suggestive band is DERIVED, not published. res_07_qtl.tex reports only q <= 0.05; it
# states no second band, so there is no manuscript number to check this against and the
# numbers below cannot be a correctness test the way PUBLISHED is - they are a drift alarm.
# What makes the band trustworthy is that it is the SAME filter, at a different threshold,
# and that filter is validated at 0.05 by PUBLISHED above. Recorded here so a future draft
# can be checked against it.
DERIVED_SUGGESTIVE = dict(rows=46, egenes=32, sgenes=16, svs=42)

BANDS = [("primary", 0.0, 0.05), ("suggestive", 0.05, 0.10)]

REL = "results/analysis_qtl/final_tables_cv01_maf005/all_genes_final.tsv"


def load(root, strict=True, catalog=None):
    """Return (long-form hits, note). One row per (SV, gene, modality)."""
    path = os.path.join(root, REL)
    if not os.path.exists(path):
        return None, "source not found: %s" % REL

    df = pd.read_csv(path, sep="\t", dtype=str)
    df["qval"] = pd.to_numeric(df["qval"], errors="coerce")

    # str.contains("cis"), NOT == "cis". One gene, NBPF20 (ENSG00000162825, sqtl,
    # q = 0.0129), is marked "cis,trans": it is a genuine cis sGene that also carries a
    # trans association. An equality test drops it and yields 73 sGenes.
    #
    # This is a real, one-gene inconsistency in the manuscript, found by this assertion:
    # fig_cis_qtl.py:179 uses == "cis", so Figure 3A plots 73 sGene triangles, while the
    # text and that figure's own caption both say 74. The browser follows the TEXT, which
    # is the claim of record. Reported to the author 2026-08-26.
    allcis = df[df["cis_trans"].str.contains("cis", na=False)].copy()
    cis = allcis[allcis["qval"] <= 0.05]
    sug = allcis[(allcis["qval"] > 0.05) & (allcis["qval"] <= 0.10)]

    # QTL is "eqtl", "sqtl", or "eqtl,sqtl" - a gene significant in both modalities
    egenes = cis[cis.QTL.str.contains("eqtl", na=False)].ENSG.nunique()
    sgenes = cis[cis.QTL.str.contains("sqtl", na=False)].ENSG.nunique()
    uniq = cis.ENSG.nunique()
    got = dict(egenes=int(egenes), sgenes=int(sgenes), unique_genes=int(uniq))

    got_sug = dict(rows=len(sug), svs=int(sug.sv_id.nunique()),
                   egenes=int(sug[sug.QTL.str.contains("eqtl", na=False)].ENSG.nunique()),
                   sgenes=int(sug[sug.QTL.str.contains("sqtl", na=False)].ENSG.nunique()))
    if got_sug != DERIVED_SUGGESTIVE:
        raise SystemExit(
            "ERROR: the derived 0.05 < q <= 0.10 band moved: got %s, last built %s.\n"
            "       This band is not in the manuscript, so nothing external pins it. A\n"
            "       change here means the upstream table changed; confirm that is intended\n"
            "       and update DERIVED_SUGGESTIVE." % (got_sug, DERIVED_SUGGESTIVE))

    if got != PUBLISHED:
        msg = ("R7 counts do not reproduce the manuscript: got %s, res_07_qtl.tex states %s"
               % (got, PUBLISHED))
        if strict:
            raise SystemExit("ERROR: " + msg + "\n"
                             "       The browser must not disagree with the paper. Either the\n"
                             "       upstream table moved or the filter at fig_cis_qtl.py:179\n"
                             "       changed; reconcile before building.")
        return None, msg

    recs = []
    for tier, lo, hi in BANDS:
        band = allcis[(allcis["qval"] > lo) & (allcis["qval"] <= hi)].copy()
        # sv_id looks like sv_278_INS; the catalog is keyed on (chrom, sv_index)
        idx = band.sv_id.astype(str).str.extract(r"^sv_(\d+)_", expand=False)
        band = band[idx.notna()].copy()
        band["sv_index"] = idx[idx.notna()].astype(int)
        for r in band.itertuples():
            for mod in str(r.QTL).split(","):
                mod = mod.strip()
                if mod not in ("eqtl", "sqtl"):
                    continue
                recs.append(dict(
                    layer=mod,
                    tier=tier,
                    scope="cis",
                    chrom=r.sv_chrom,
                    sv_index=int(r.sv_index),
                    target=(r.final_symbol if r.final_symbol and r.final_symbol != "(novel)"
                            else r.ENSG),
                    ensg=r.ENSG,
                    qval=float(r.qval),
                    sv_id_src=r.sv_id,
                ))

    out = pd.DataFrame(recs)
    note = ("cis at q<=0.05; reproduces the published %d eGenes / %d sGenes / %d unique "
            "genes, plus a derived 0.05<q<=0.10 band of %d gene-rows over %d SVs; "
            "trans-only rows excluded (0 survive the R7 controls)"
            % (egenes, sgenes, uniq, got_sug["rows"], got_sug["svs"]))
    return out, note
