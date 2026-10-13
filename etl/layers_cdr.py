#!/usr/bin/env python3
"""R8b layer: centromere dip region (CDR) position QTL.

WHAT IS DRAWN, AND WHY IT CHANGED. This layer used to draw the chromosome-8 survivors alone,
excluding chromosomes 5, 9 and 19 on the authority of a sentence res_08b_cdr.tex no longer
contains ("This analysis also eliminated candidate loci on chromosomes 5, 9, and 19"). The
current section reports those as significant and leaves their attribution open:

    "Chromosome 8's hits remains significant, while it is unclear whether the other signals
     are carried by their array's expansions or the SV genotypes"

So every study-wide-significant locus is drawn, and each one that the gates set aside carries
the reason on its own row.

THE TWO AXES, KEPT SEPARATE. They were previously conflated, which is what made the
exclusion look principled.

  TIER is significance, and nothing else. alpha = 0.05 / (11,129 loci x 8 phenotypes) =
  5.62e-07 is the section's own threshold; 2*alpha is 0.10/m, the same step as q <= 0.05
  against q <= 0.10, which is the band the e/sQTL layers already derive here. Every gate
  record falls inside 2*alpha, so adopting it drops nothing.

  THE REASON TAG is the gate verdict, which is orthogonal. A locus can be primary AND carry
  a confound tag - that is exactly what the section means when it calls chromosome 19's hits
  significant while leaving their attribution open.

WHAT THE GATE MEASURES. Each locus is checked by Spearman correlation of SV dosage against
array start, array end and array length SEPARATELY, each needing P > 0.05, then for carrier
spread across super-populations. The dip-position phenotypes are offsets measured FROM the
array landmarks, which is why the landmarks are tested. Measured over all 38 gate rows:
chr9 fails on length (7 of 7), chr5 on all three (2 of 2), chr19 on array start (9 of 11)
with length stable on every one of its rows and every row testable in one group alone.
"""
import csv
import os
import re

import numpy as np
import pandas as pd

WU = "discovery/2026-08-03_cdr_qtl_full_substrate"
CAN = "discovery/2026-06-23_cdr_qtl_corrected"
REL = WU + "/output/gates/full_hits_gate_1e7.tsv"
VARS = WU + "/geno/full_variants.tsv"
TAGS = "paper/v2/figures/data/chr8_tag_table.tsv"
PED = "resources/1000G/20130606_g1k_3202_samples_ped_population.txt"
POPS = ["AFR", "AMR", "EAS", "EUR", "SAS"]

# From res_08b_cdr.tex and the header of fig_cdr.py.
PUBLISHED = dict(
    n_substrate=11129,      # "We tested 11,129 centromeric SV loci"
    n_phenotypes=8,         # "against eight phenotypes"
    alpha=5.62e-07,         # 0.05 / (11,129 x 8), the study-wide threshold
    surv_chroms=["chr8"],   # "a single region on chromosome 8"
    lead_pos=44300221,      # "a 113-bp deletion at chr8:44,300,221"
    lead_svtype="DEL",
    lead_svlen=113,
    lead_t=-6.17,           # "(t = -6.17, P = 1.0e-7; allele frequency 0.55; n = 151)"
    lead_p=1.0e-07,
    lead_af=0.55,
    lead_n=151,
    interval_kb=213.6,      # "fell within a 213.6-kb interval at chr8:44.25-44.46 Mb"
)

PHENOTYPE = {
    "cdr_pos_offset": "Dip position, median of dips",
    "cdr_pos_offset_deepest": "Dip position, deepest dip",
    "cdr_pos_iqr": "Dip spread, IQR",
    "n_cdrs": "Dip count",
    "cdrs_per_mb": "Dip density",
    "cdr_fraction": "Hypomethylated fraction of the array",
    "median_cdr_width": "Dip width, median",
    "mean_5mC": "Array methylation level",
}

LOCUS = re.compile(r"^(chr[0-9XY]+)_sv(\d+)_")


def _superpops(root, gate):
    """Which super-populations each gate row is testable in, by the gate's own rule.

    code/gates/gate_full_hits.py admits a super-population when at least 12 of its
    individuals carry both a phenotype and a dosage and its allele frequency there sits
    strictly inside (0.05, 0.95). It records only how MANY qualified, so the names are
    recomputed here.

    THE CONTROL. Naming groups out of a pipeline only believed to be reproduced would be
    worse than leaving the tag unnamed, so this is checked two ways against the gate's own
    record - the per-locus sample count n, and the resulting n_superpops - and returns
    nothing at all if either disagrees on any row.
    """
    g = np.load(os.path.join(root, WU, "geno/full_genotypes.npz"))
    G = g[list(g.keys())[0]].astype(float)
    vt = pd.read_csv(os.path.join(root, WU, "geno/full_variants.tsv"), sep="\t",
                     usecols=["sv_locus"])
    samp = np.array(open(os.path.join(root, WU, "geno/full_samples.txt")).read().split())
    loc2row = {l: i for i, l in enumerate(vt.sv_locus)}
    ph_c = pd.read_csv(os.path.join(root, CAN,
                                    "output/per_hap_chrom_phenotypes_corrected.tsv"),
                       sep="\t")
    ph_d = pd.read_csv(os.path.join(root, CAN,
                                    "output/per_hap_chrom_phenotypes_deepest.tsv"),
                       sep="\t")
    ped = pd.read_csv(os.path.join(root, PED), sep=r"\s+")
    sc = [c for c in ped.columns if c.lower() in ("sampleid", "sample")][0]
    spc = [c for c in ped.columns if "super" in c.lower()][0]
    sp_map = ped.set_index(sc)[spc].to_dict()

    def cell(chrom, pheno):
        src = ph_d if pheno == "cdr_pos_offset_deepest" else ph_c
        s = src[src.chm13_chrom == chrom]
        if pheno not in s.columns:
            return None
        return s.groupby("sample").agg(y=(pheno, "mean"))

    out = {}
    for r in gate.itertuples():
        ag = cell(r.chrom, r.phenotype)
        if ag is None:
            return None, "phenotype %s absent for %s" % (r.phenotype, r.chrom)
        dos = pd.Series(G[loc2row[r.sv_locus], :], index=samp).replace(-1, np.nan)
        keep = sorted(set(ag.dropna(subset=["y"]).index) & set(dos.dropna().index))
        dd = dos.loc[keep].values
        sp = np.array([sp_map.get(s, "NA") for s in keep])
        ok = []
        for s in POPS:
            m = sp == s
            if m.sum() >= 12 and 0.05 < dd[m].mean() / 2 < 0.95:
                ok.append(s)
        if len(keep) != int(r.n):
            return None, ("sample count for %s %s is %d here and %d in the gate"
                          % (r.chrom, r.pos, len(keep), int(r.n)))
        if len(ok) != int(r.n_superpops):
            return None, ("%s %s is testable in %d groups here and %d in the gate"
                          % (r.chrom, r.pos, len(ok), int(r.n_superpops)))
        out[r.sv_locus] = ok
    return out, "%d rows, both controls agree with the gate" % len(gate)


def load(root, strict=True, catalog=None):
    """Return (long-form hits, note). One row per (SV, phenotype)."""
    gate_p = os.path.join(root, REL)
    vars_p = os.path.join(root, VARS)
    tags_p = os.path.join(root, TAGS)
    for p, what in [(gate_p, REL), (vars_p, VARS), (tags_p, TAGS)]:
        if not os.path.exists(p):
            return None, "source not found: %s" % what

    substrate = pd.read_csv(vars_p, sep="\t", usecols=["sv_locus", "chrom"])
    gate = pd.read_csv(gate_p, sep="\t")
    tags = pd.read_csv(tags_p, sep="\t")

    surv = gate[(gate.overall.astype(str).str.upper() == "SURVIVES")
                & gate.pass_headline].copy()
    if not len(surv):
        return None, "no row in the CDR gate both SURVIVES and passes the headline substrate"

    lead_tag = tags.loc[tags.t_alone.abs().idxmax()]
    lead_rows = surv[surv.pos == int(lead_tag.pos)]
    if not len(lead_rows):
        return None, ("the strongest chr8 tag-table row (pos %d) is absent from the "
                      "surviving gate set" % int(lead_tag.pos))
    if lead_rows.af.nunique() != 1 or lead_rows.n.nunique() != 1:
        return None, "the lead position carries more than one frequency or sample size"
    lead = lead_rows.iloc[0]

    alpha = 0.05 / (len(substrate) * len(PHENOTYPE))
    got = dict(
        n_substrate=int(len(substrate)),
        n_phenotypes=len(PHENOTYPE),
        alpha=float("%.3g" % round(alpha, 9)),
        surv_chroms=sorted(surv.chrom.unique().tolist()),
        lead_pos=int(lead_tag.pos),
        lead_svtype=str(lead_tag.svtype),
        lead_svlen=int(lead_tag.svlen),
        lead_t=round(float(lead_tag.t_alone), 2),
        lead_p=float(lead.p_best),
        lead_af=round(float(lead.af), 2),
        lead_n=int(lead.n),
        interval_kb=round((surv.pos.max() - surv.pos.min()) / 1e3, 1),
    )
    if got != PUBLISHED:
        diff = {k: (got[k], PUBLISHED[k]) for k in PUBLISHED if got[k] != PUBLISHED[k]}
        msg = "R8b counts do not reproduce res_08b_cdr.tex; (got, published) = %s" % diff
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    # Tier is significance. Every gate record must fall inside 2*alpha, or the two-band
    # scheme is describing a set it does not cover and a third band would be needed.
    if (gate.p_best > 2 * alpha).any():
        n = int((gate.p_best > 2 * alpha).sum())
        return None, ("%d gate rows sit beyond twice the study-wide threshold" % n)
    # pass_headline is exactly "P <= alpha". Asserted, because the tier is read off it.
    if ((gate.p_best <= alpha) != gate.pass_headline).any():
        return None, "pass_headline disagrees with P <= alpha"

    sp, spnote = _superpops(root, gate)
    if sp is None:
        return None, "super-population names could not be reproduced: %s" % spnote

    parsed = gate.sv_locus.astype(str).str.extract(LOCUS)
    if parsed[0].isna().any():
        return None, "%d sv_locus values did not parse" % int(parsed[0].isna().sum())
    gate = gate.assign(sv_index=parsed[1].astype(int))

    unknown = sorted(set(gate.phenotype) - set(PHENOTYPE))
    if unknown:
        return None, "CDR phenotypes not in the display map: %s" % unknown

    # One SV can appear under two decomposition strategies at the same phenotype; the
    # browser's entity is the SV, so those collapse and the stronger p wins.
    gate = gate.sort_values("p_best").drop_duplicates(["chrom", "sv_index", "phenotype"])

    missing = [r.sv_locus for r in gate.itertuples() if r.sv_locus not in sp]
    if missing:
        return None, ("%d rows have no super-population record: %s"
                      % (len(missing), missing[:3]))

    recs = []
    for r in gate.itertuples():
        fires = [n for n, p in (("array start", r.bnd_start_p), ("array end", r.bnd_end_p),
                                ("array length", r.bnd_len_p)) if p <= 0.05]
        tags_ = [f + " confound" for f in fires]
        groups = sp.get(r.sv_locus, [])
        if str(r.ancestry_verdict) != "SURVIVES_ANCESTRY":
            tags_.append((" ".join(groups) if groups else "no group") + " only")
        recs.append(dict(
            layer="cdr",
            tier="primary" if r.p_best <= alpha else "suggestive",
            scope="cdr",
            chrom=r.chrom,
            sv_index=int(r.sv_index),
            target=PHENOTYPE[r.phenotype],
            pval=float(r.p_best),
            af=float(r.af),
            n=int(r.n),
            tags=", ".join(tags_),
            groups=", ".join(groups),
            detail=("Permutation p against a study-wide threshold of %.2e over %s loci and "
                    "%d phenotypes. Array start p = %.2g, end p = %.2g, length p = %.2g; "
                    "testable in %s."
                    % (alpha, "{:,}".format(len(substrate)), len(PHENOTYPE),
                       r.bnd_start_p, r.bnd_end_p, r.bnd_len_p,
                       ", ".join(groups) or "one group")),
        ))

    out = pd.DataFrame(recs)
    clear = int((out.tags == "").sum())
    note = ("%d (SV, phenotype) records over %d SVs on %d chromosomes, every one study-wide "
            "significant at %.2e or within twice it: %d primary and %d in the second band. "
            "%d clear the array-endpoint and ancestry gates, all on %s within %.1f kb; the "
            "other %d carry the quantity their signal tracks. %s."
            % (len(out), len(set(zip(out.chrom, out.sv_index))), out.chrom.nunique(),
               alpha,
               int((out.tier == "primary").sum()), int((out.tier == "suggestive").sum()),
               clear, ", ".join(got["surv_chroms"]), got["interval_kb"],
               len(out) - clear, spnote))
    return out, note
