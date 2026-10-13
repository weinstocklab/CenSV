#!/usr/bin/env python3
"""R11 layer: All of Us disease PheWAS.

Source is the vendored table the manuscript's Figure 5 is drawn from,
paper/v2/figures/data/aou_ext2/disease_hits_final.tsv (see its PROVENANCE.md; the upstream
matrices stay inside the AoU workbench and cannot be re-derived here).

The hit definition and every count below are taken from res_11_aou.tex:

    "We identified 170 SV--phecode (q < 0.05) associations involving 61 SV predictors and
     27 diseases, with another 85 associations at 0.05 <= q < 0.10 ... Chromosome 16
     contributed 134 of the 170 significant SV--phecode associations, representing 31
     correlated SV predictors and 11 phecodes. Chromosome X contributed another 10 ..."

All of those are asserted. If the vendored table is refreshed and any count moves, the
build stops rather than shipping a browser that disagrees with the section it presents.
"""
import os
import re

import pandas as pd

REL = "paper/v2/figures/data/aou_ext2/disease_hits_final.tsv"

PUBLISHED = dict(assoc=170, predictors=61, diseases=27, suggestive=85,
                 chr16_assoc=134, chr16_predictors=31, chr16_phecodes=11, chrX_assoc=10)

# Methods M11, "Predictor tiers": the four families BH is applied within, with the number of
# scored predictors in each. null_ext is the negative control - predictors that reached
# posterior inclusion below 0.01 for all 464 traits in the summary-level scan.
#
# `inline` is the mid-sentence form and is NOT derivable from `label` by lower-casing:
# "Chromosome X" becomes "chromosome x", which reads as a typo.
PREDICTOR_TIERS = {
    "signal": dict(n=3416, label="Discovery signal", inline="discovery-signal",
                   note="carries a discovery association"),
    "ext2_new": dict(n=4207, label="Newly scoreable", inline="newly-scoreable",
                     note="no discovery prior"),
    "ext2_chrX": dict(n=79, label="Chromosome X", inline="chromosome X",
                      note="chromosome-X predictors"),
    "null_ext": dict(n=3097, label="Negative control", inline="negative-control",
                     note="posterior inclusion below 0.01 for all 464 traits in the "
                          "summary-level scan, so carrying no prior signal"),
}
# step51_summary.json, the provenance of the published result: tests and q<0.05 cells per
# tier. The control tier returns 16 of 537 across the whole scan and none of the 170.
TIER_TESTS = dict(signal=8256472, ext2_new=10168319, null_ext=7485449, ext2_chrX=190943)
N_TESTS = 26101183

# sv_locus looks like chr1_sv4_INS_ori_best8_fksize500k
LOCUS = re.compile(r"^(chr[0-9XY]+)_sv(\d+)_")


def load(root, strict=True, catalog=None):
    path = os.path.join(root, REL)
    if not os.path.exists(path):
        return None, "source not found: %s" % REL

    d = pd.read_csv(path, sep="\t", dtype=str)
    d["q"] = pd.to_numeric(d["q_bh_tier"], errors="coerce")
    d["beta"] = pd.to_numeric(d["beta_final_logOR"], errors="coerce")
    d["p"] = pd.to_numeric(d["p_final"], errors="coerce")

    parsed = d.sv_locus.astype(str).str.extract(LOCUS)
    d["chrom"] = parsed[0]
    d["sv_index"] = pd.to_numeric(parsed[1], errors="coerce")
    unparsed = int(d.chrom.isna().sum())
    if unparsed:
        return None, "%d sv_locus values did not parse to (chrom, sv_index)" % unparsed

    sig = d[d.q < 0.05].copy()
    sug = d[(d.q >= 0.05) & (d.q < 0.10)]
    c16 = sig[sig.chrom == "chr16"]

    got = dict(
        assoc=len(sig),
        predictors=int(sig.sv_locus.nunique()),
        diseases=int(sig.phecode.nunique()),
        suggestive=len(sug),
        chr16_assoc=len(c16),
        chr16_predictors=int(c16.sv_locus.nunique()),
        chr16_phecodes=int(c16.phecode.nunique()),
        chrX_assoc=int((sig.chrom == "chrX").sum()),
    )
    if got != PUBLISHED:
        diff = {k: (got[k], PUBLISHED[k]) for k in PUBLISHED if got[k] != PUBLISHED[k]}
        msg = "R11 counts do not reproduce res_11_aou.tex; (got, published) = %s" % diff
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    # The predictor tier is the multiple-testing family: Methods M11 applies Benjamini-
    # Hochberg WITHIN tier, over four tiers spanning 26,101,183 tests. A q value here
    # therefore does not mean "of all All of Us tests" and the browser should not imply it.
    # null_ext is the negative-control tier, and carrying it is what lets the site state
    # that it contributes 0 of the 170 - a number that means nothing unless it is shown.
    tiers = sorted(set(d.tier.dropna()) - {""})
    unknown = [t for t in tiers if t not in PREDICTOR_TIERS]
    if unknown:
        return None, "unknown predictor tier(s) %s; the q family would be misdescribed" % unknown
    ctrl = int((sig.tier == "null_ext").sum())
    if ctrl:
        return None, ("the negative-control tier contributes %d of the significant "
                      "associations, where res_11 and step51 both record none" % ctrl)

    # Both bands are the section's own; unlike R7, R11 states the suggestive count (85), so
    # it is asserted above rather than merely recorded.
    frames = []
    for tier, band in [("primary", sig), ("suggestive", sug)]:
        b = band.copy()
        b["sv_index"] = b.sv_index.astype(int)
        frames.append(pd.DataFrame(dict(
            layer="aou",
            tier=tier,
            scope="phewas",
            chrom=b.chrom,
            sv_index=b.sv_index,
            target=b.label,
            phecode=b.phecode,
            qval=b.q,
            beta=b.beta,
            pval=b.p,
            cases=pd.to_numeric(b.cases, errors="coerce"),
            n=pd.to_numeric(b.n, errors="coerce"),
            # carried so features_aou_ancestry can join on the workbench's own key, which is
            # the full locus string and NOT (chrom, sv_index) - several predictors share an
            # sv_index across strategies and differ only in the suffix
            sv_locus=b.sv_locus,
            ptier=b.tier,
        )))
    out = pd.concat(frames, ignore_index=True)

    bytier = {t: int((sig.tier == t).sum()) for t in PREDICTOR_TIERS}
    note = ("q<0.05: %d associations over %d SV predictors and %d diseases (chr16 %d); "
            "plus the section's %d suggestive associations at 0.05<=q<0.10. One "
            "cross-ancestry model per phenotype; BH within predictor tier over %s tests, "
            "and the negative-control tier contributes %d of the %d"
            % (got["assoc"], got["predictors"], got["diseases"], got["chr16_assoc"],
               got["suggestive"], "{:,}".format(N_TESTS), bytier["null_ext"],
               got["assoc"]))
    return out, note
