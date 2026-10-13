#!/usr/bin/env python3
"""Build the CenSV browser's data files from the Project1_Centromere results tree.

Runs on hgcc, where the results live. Emits JSON into web/public/data/, which is COPYed
into the container image at build time - so the image tag is the data version.

Design rule: a layer that cannot be built is an ERROR, not an omission. Every layer
declares where it reads from and how many rows it expects to contribute; the run prints a
PRESENT/MISSING table and exits non-zero if any layer registered as required is missing.
A browser that silently shows seven of ten analyses is worse than one that refuses to build.

Outputs
  chromosomes.json  23 entries: active alpha-satellite HOR array bounds (CenSat v2.1),
                    which are the x-axis of every per-chromosome view
  catalog.json      every imputed centromeric SV: position, class, length, frequency,
                    imputation quality, resolution status, and its max pairwise F_ST
                    and super-population frequencies (R9, an attribute not a layer)
  layers.json       per-SV hits, one record per (sv, layer, target); every record
                    carries a significance tier - primary or suggestive
  meta.json         provenance: source commit, build time, per-layer row counts

Usage:
  python3 build_data.py <PROJECT_ROOT> <OUT_DIR> [--allow-missing]
"""
import argparse
import json
import math
import os
import subprocess
import sys
from collections import defaultdict

import pandas as pd

import features_aou_ancestry
import features_fst
import layers_aou
import layers_cdr
import layers_meth
import layers_qtl
import ld
import tracks

TIERS = ["primary", "suggestive"]

SUF = "mapq20_minsvlen10_maxpart10_partdist1000_maxedit200_maxsv500000_qgap200_rgap200"

# The UNION of both imputation ensembles, which is what the paper analysed - Supplementary
# Note 8 counts "the union of the two imputation ensembles". best6 alone is not enough: on
# chr6 it holds 61 SVs against best8's 293, and two published cis sQTL hits (PRIM2 sv_931,
# LINC00680 sv_597) exist only in best8. Building on best6 silently orphaned them.
ENSEMBLES = ["best8", "best6"]
CHROMS = ["chr%d" % i for i in range(1, 23)] + ["chrX"]

# ---------------------------------------------------------------------------------------
# layer registry
# ---------------------------------------------------------------------------------------
# Each layer is one manuscript result section. `required` layers abort the build when their
# source is absent; optional ones warn. `key` is what the front end toggles.

# `exposure` is what the scan actually regressed on, taken from each section's own
# Methods sentence, because a reader cannot otherwise tell an imputed dosage from a called
# genotype and the browser shows one cv r2 beside both:
#   met_07  "$g_i$ the imputed SV dosage"
#   met_08  "124 also carry observed long-read genotypes, and those 124 constitute the scan;
#            the observed-dosage scan is treated as primary because its exposure is measured
#            rather than imputed"
#   met_08b "This analysis genotypes SVs directly from the assemblies"
#   R11     predictors scored from tag SNPs inside All of Us
LAYERS = [
    dict(key="eqtl", section="R7", label="Expression QTL", exposure="imputed",
         path=layers_qtl.REL, required=True),
    dict(key="sqtl", section="R7", label="Splicing QTL", exposure="imputed",
         path=layers_qtl.REL, required=True),
    dict(key="mqtl", section="R8", label="Methylation QTL", exposure="direct",
         path=layers_meth.REL, required=True),
    dict(key="cdr", section="R8b", label="Centromere dip region", exposure="direct",
         path=layers_cdr.REL, required=True),
    dict(key="aou", section="R11", label="All of Us disease PheWAS", exposure="imputed",
         path=layers_aou.REL, required=True),
]

# NOT layers, on purpose:
#   R9 population differentiation - F_ST is a property of an SV, not evidence about it, and
#     the section's finding is that differentiation does NOT explain the associations. It is
#     attached to the catalog by features_fst.py instead.
#   R10 cTWAS - dropped from the browser by the author on 2026-08-26.
#   R7 trans - 46 candidates, 0 survive the section's controls (Supplementary Note 8).
#   R8 trans - the focused off-chromosome scan has no row in the MAC8 outputs the
#     rewritten section describes, and the section reports no trans result.
#   R8b chr5/chr9/chr19 - reached study-wide significance, then eliminated by the
#     array-length gate.
# Each of these would have the browser assert something its section refutes.


def sh(cmd, cwd=None):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd).stdout.strip()


def die(msg):
    print("ERROR: %s" % msg, file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------------------
# chromosomes: the active HOR array is the x-axis
# ---------------------------------------------------------------------------------------
def build_chromosomes(root):
    """Active alpha-satellite array bounds per chromosome, from CenSat v2.1.

    A chromosome can carry more than one active HOR record; the browser's axis is the
    union span, and the individual records are kept so the array structure can be drawn.
    """
    bed = os.path.join(root, "resources", "chm13v2.0_censat_v2.1.active.bed")
    if not os.path.exists(bed):
        die("CenSat active bed not found: %s" % bed)
    df = pd.read_csv(bed, sep="\t", header=None, usecols=[0, 1, 2, 3],
                     names=["chrom", "start", "end", "name"])
    df = df[df.chrom.isin(CHROMS)]
    out = []
    for c in CHROMS:
        d = df[df.chrom == c]
        if not len(d):
            die("no active HOR array for %s in CenSat - the axis would be undefined" % c)
        out.append(dict(
            chrom=c,
            hor_start=int(d.start.min()),
            hor_end=int(d.end.max()),
            arrays=[dict(start=int(r.start), end=int(r.end), name=str(r.name))
                    for r in d.itertuples()],
        ))
    return out


# The two permissions. CEN_STRATS reach inside the centromere; FLANK_STRATS cannot.
CEN_STRATS = ["midpoint500", "midpoint1000"]
FLANK_STRATS = ["edge500", "edge1000", "edge2000",
                "fksize100k", "fksize200k", "fksize500k"]


def _families(sel):
    """Per SV, the best model of each family and its cv r2.

    Ties are broken the pipeline's way. 280 rows carry two strategies at an identical cv r2 -
    chr1 sv3 has edge500 and fksize500k both at 0.869932 - and `best_strategy_by_cvr2` names
    one of them. A plain argmax picks by column order instead and would print a different
    model name for the same number, disagreeing with every other table in the project.
    """
    out = {"sv_index": sel.sv_index}
    for tag, fam in (("cen", CEN_STRATS), ("flank", FLANK_STRATS)):
        cols = ["cv_r2_" + s for s in fam if "cv_r2_" + s in sel.columns]
        if not cols:
            continue
        sub = sel[cols]
        best = sub.max(axis=1)
        name = sub.idxmax(axis=1).str.replace("^cv_r2_", "", regex=True)
        # where the pipeline's own winner sits in this family AND ties the family maximum,
        # prefer its name
        w = sel.best_strategy_by_cvr2
        wv = pd.Series([sel.at[i, "cv_r2_" + v] if ("cv_r2_" + v) in sel.columns else float("nan")
                        for i, v in w.items()], index=sel.index)
        pref = w.isin(fam) & (wv - best).abs().le(1e-12)
        name = name.mask(pref, w)
        out["cv_r2_" + tag] = best
        out["strategy_" + tag] = name
    return pd.DataFrame(out)


# ---------------------------------------------------------------------------------------
# catalog
# ---------------------------------------------------------------------------------------
# The full SVIM-asm call set, which res_01_landscape.tex reports as 188,589 and calls "this
# catalog". The browser's own unit is a subset of it, so the overview says which is which.
CALLED_REL = "paper/v2/figures/data/catalog/per_chrom_svtype.tsv"
CALLED_PUBLISHED = 188589


def n_called(root):
    """Total SVs called, from the table the manuscript's own landscape figure reads."""
    p = os.path.join(root, CALLED_REL)
    if not os.path.exists(p):
        die("the call-set table is missing: %s" % CALLED_REL)
    total, per_type = 0, {}
    with open(p, encoding="utf-8") as fh:
        next(fh)
        for line in fh:
            _, t, n = line.rstrip("\n").split("\t")
            total += int(n)
            per_type[t] = per_type.get(t, 0) + int(n)
    if total != CALLED_PUBLISHED:
        die("the call set holds %s SVs; res_01_landscape.tex reports %s"
            % ("{:,}".format(total), "{:,}".format(CALLED_PUBLISHED)))
    return total, per_type


def build_catalog(root, chrom_index):
    """Every imputed centromeric SV, from the per-chromosome imputation summaries.

    pos/end and svpos/svend are identical in every row of these tables (verified on chr1,
    1823/1823), so only one pair is carried forward.
    """
    rows, missing = [], []
    for ens in ENSEMBLES:
        base = os.path.join(root, "results", "imputation", "decompose", "cosine_nj",
                            "%s_%s" % (ens, SUF))
        if not os.path.isdir(base):
            die("imputation tree not found: %s" % base)
        for c in CHROMS:
            f = os.path.join(base, c, "%s_imputation_summary.tsv" % c)
            if not os.path.exists(f):
                missing.append("%s/%s" % (ens, c))
                continue
            d = pd.read_csv(f, sep="\t")
            d["chrom"] = c
            d["ens"] = ens
            # The eight candidates, split by WHICH SNPS each is allowed rather than by
            # which pool it was chosen from. Strategies 1 and 2 anchor on the centromere
            # boundary and search outward, so they place 0 of 197,629 predictor SNPs inside
            # the centromere; Strategy 3 anchors on the midpoint and places 111,850 of
            # 130,839 (85.5%) inside. Measured against resources/grch38_centromeres.bed.
            s = os.path.join(base, c, "%s_best_strategy_selection.tsv" % c)
            if os.path.exists(s):
                sel = pd.read_csv(s, sep="\t")
                d = d.merge(_families(sel), on="sv_index", how="left")
            rows.append(d)
    if missing:
        die("no imputation summary for: %s" % ", ".join(missing))

    allrows = pd.concat(rows, ignore_index=True)

    shared = allrows.groupby(["chrom", "sv_index"]).agg(
        n_ens=("ens", "nunique"), n_pos=("pos", "nunique"),
        n_type=("svtype", "nunique"), n_len=("svlen", "nunique"))
    both = shared[shared.n_ens > 1]
    clash = both[(both.n_pos > 1) | (both.n_type > 1) | (both.n_len > 1)]
    if len(clash):
        die("%d of the %d SVs present in both ensembles disagree on pos/svtype/svlen, so "
            "sv_index is NOT a shared namespace and this dedup would merge different "
            "variants. First: %s" % (len(clash), len(both), clash.index[:5].tolist()))
    print("[catalog] %d SVs carried by both ensembles, 0 coordinate disagreements" % len(both))

    # One row per (chrom, sv_index), and BOTH accuracies carried, because they are not two
    # estimates of one thing - they are what the same elastic net achieves with and without
    # the centromere's own SNPs.
    #
    # best6 chooses among Strategies 1 and 2, which anchor on the centromere BOUNDARY and
    # search outward; best8 adds Strategy 3, which anchors on the MIDPOINT. Measured over all
    # 11,129 predictors against resources/grch38_centromeres.bed: Strategies 1 and 2 place
    # 0 of 197,629 predictor SNPs inside the centromere, Strategy 3 places 111,850 of 130,839
    # (85.5%) inside. So best6's number is the accuracy with the centromere excluded and
    # best8's is the accuracy without that restriction, and they differ exactly when a
    # midpoint model wins.
    #
    # The kept row is best8's - the ensemble met_03_snp_extraction.tex names as primary
    # ("the best-of-eight ensemble was used for the primary analysis") - and best6's value
    # rides along as cv_r2_excen. `ens` records which ensembles contained it, so nothing
    # about provenance is lost to the dedup.
    #
    # This dedup is only sound if sv_index is a SHARED per-chromosome namespace rather than
    # a per-ensemble running index - otherwise it would silently merge two different SVs and
    # every layer join on that key would land on the wrong variant. Checked, not assumed:
    # 9,457 (chrom, sv_index) pairs appear in BOTH ensembles and zero of them disagree on
    # pos, svtype or svlen. The assertion below keeps it that way.
    ens_of = (allrows.groupby(["chrom", "sv_index"]).ens
              .apply(lambda s: "+".join(sorted(set(s)))).rename("ens_set"))

    allrows["_rank"] = allrows.ens.map({e: i for i, e in enumerate(ENSEMBLES)})
    cat = (allrows.sort_values("_rank")
           .drop_duplicates(subset=["chrom", "sv_index"], keep="first")
           .drop(columns=["_rank", "ens"])
           .merge(ens_of, on=["chrom", "sv_index"], how="left")
           .reset_index(drop=True))
    # The headline cv_r2 must be the better of the two families - it is the max over all
    # eight and the families partition the eight. If it is not, one family is missing a
    # candidate and both printed numbers are wrong.
    _b = cat.dropna(subset=["cv_r2_cen", "cv_r2_flank"])
    _mx = _b[["cv_r2_cen", "cv_r2_flank"]].max(axis=1)
    _bad = int((_mx - _b.cv_r2).abs().gt(1e-9).sum())
    if _bad:
        die("%d SVs where cv_r2 is not the larger of the centromeric and flank families, so "
            "the two families do not partition the eight candidates" % _bad)
    _miss = int(cat.cv_r2_cen.isna().sum() + cat.cv_r2_flank.isna().sum())
    _w = int((_b.cv_r2_cen > _b.cv_r2_flank + 1e-9).sum())
    _d = (_b.cv_r2_cen - _b.cv_r2_flank)
    print("[catalog] centromeric SNPs beat the flank on %d of %d SVs (%.1f%%); among those, "
          "median +%.3f, p90 +%.3f, max +%.3f; %d SVs missing a family"
          % (_w, len(_b), 100.0 * _w / len(_b), float(_d[_d > 1e-9].median()),
             float(_d[_d > 1e-9].quantile(0.9)), float(_d.max()), _miss))
    print("[catalog] %d rows over %d ensembles -> %d unique SVs"
          % (len(allrows), len(ENSEMBLES), len(cat)))

    # position within the active array, 0-1, which is what the browser draws on
    hs = {c["chrom"]: c["hor_start"] for c in chrom_index}
    he = {c["chrom"]: c["hor_end"] for c in chrom_index}
    cat["hor_start"] = cat.chrom.map(hs)
    cat["hor_end"] = cat.chrom.map(he)
    span = (cat.hor_end - cat.hor_start).replace(0, pd.NA)
    cat["hor_frac"] = ((cat.pos - cat.hor_start) / span).astype(float)

    outside = int(((cat.pos < cat.hor_start) | (cat.pos > cat.hor_end)).sum())
    print("[catalog] %d SVs over %d chromosomes; %d outside the active array"
          % (len(cat), cat.chrom.nunique(), outside))
    if outside:
        # not fatal - flanking SVs are real - but it must be visible, since the browser
        # clamps them to the axis edge and a large count would mean the wrong bed file
        frac = 100.0 * outside / len(cat)
        print("[catalog] WARNING: %.1f%% of SVs fall outside the CenSat active array" % frac)
        if frac > 25:
            die("more than a quarter of SVs outside the array - wrong reference or bed")

    keep = ["chrom", "sv_index", "svtype", "svlen", "pos", "end", "sv_category",
            "cv_r2", "cv_r2_cen", "cv_r2_flank", "svfreq", "hor_frac",
            "mapped_haplogroup", "ens_set", "strategy_cen", "strategy_flank"]
    keep = [k for k in keep if k in cat.columns]
    cat = cat[keep].copy()
    cat["sv_id"] = cat.chrom + "_sv" + cat.sv_index.astype(int).astype(str) + "_" + cat.svtype
    return cat


# ---------------------------------------------------------------------------------------
# what a row of the catalog IS
# ---------------------------------------------------------------------------------------
VARKEY = ["chrom", "pos", "svtype", "svlen"]


def audit_catalog(root, catalog):
    """Say what the catalog counts, and check it against the manuscript's own substrate.

    This is the one table with no published count of its own, and that gap produced a real
    confusion: the site said "10,705 SVs" while the manuscript says 11,129, and the two are
    not the same unit in either direction.

      11,129   met_08b / met_11.  ROWS of the CDR scan substrate: one per
               (variant x resolution mode x ensemble x weight strategy).  Its own distinct
               coordinate count is 6,041 and the manuscript states its distinct
               188-sample genotype-vector count, 7,276.
      10,705   here.  Distinct (chrom, sv_index) across both ensembles.  sv_index encodes
               the RESOLUTION MODE as well as the variant: chr1:121,797,438 DEL 340 bp is
               sv0 monophyletic (CV R2 0.66, freq 0.082) and sv1 original_decomposed
               (0.77, 0.098) - one DNA event, two genotype reconstructions with different
               accuracy and different frequency.
       8,792   here.  Distinct (chrom, pos, svtype, svlen) - distinct variants.

    That every one of the 1,732 multi-index coordinates differs in sv_category, and none
    shares one, is what establishes the mode reading rather than assuming it. It is checked
    below, not asserted from this comment.

    The containment check is the point: every variant the manuscript's CDR section scans must
    be present here. If it were not, the browser would be silently narrower than the paper.
    """
    n_pred = len(catalog)
    coords = catalog[VARKEY].drop_duplicates()
    n_var = len(coords)

    per = catalog.groupby(VARKEY).sv_index.nunique()
    multi = per[per > 1]
    modes = catalog.set_index(VARKEY).loc[multi.index].reset_index().groupby(
        VARKEY).sv_category.nunique() if len(multi) else pd.Series(dtype=int)
    shared = int((modes == 1).sum())
    if shared:
        die("%d coordinates carry several sv_index values that share one resolution class, "
            "so sv_index is NOT (variant x mode) and the catalog is double-counting real "
            "duplicates" % shared)

    out = dict(n_predictors=n_pred, n_variants=n_var,
               n_multi_mode=int(len(multi)),
               n_from_multi_mode=int(multi.sum()),
               modes=catalog.sv_category.value_counts().to_dict()
               if "sv_category" in catalog.columns else {})

    # containment against the CDR scan substrate
    vp = os.path.join(root, layers_cdr.VARS)
    if os.path.exists(vp):
        fv = pd.read_csv(vp, sep="\t", usecols=VARKEY)
        sub = set(map(tuple, fv.drop_duplicates().values))
        have = set(map(tuple, coords.values))
        lost = sub - have
        out.update(substrate_rows=int(len(fv)), substrate_variants=len(sub),
                   substrate_absent=len(lost))
        if lost:
            die("%d of the %d variants the CDR section scans are absent from this catalog; "
                "the browser would be narrower than the paper. First: %s"
                % (len(lost), len(sub), sorted(lost)[:4]))
        print("[catalog] unit is (variant x resolution mode): %s predictors over %s distinct "
              "variants; %s coordinates carry more than one mode"
              % ("{:,}".format(n_pred), "{:,}".format(n_var), "{:,}".format(len(multi))))
        print("[catalog] contains all %s variants of the %s-row CDR substrate, 0 absent"
              % ("{:,}".format(len(sub)), "{:,}".format(len(fv))))
    return out


# ---------------------------------------------------------------------------------------
# layers
# ---------------------------------------------------------------------------------------
LOADERS = {
    "eqtl": layers_qtl.load,
    "sqtl": layers_qtl.load,
    "mqtl": layers_meth.load,
    "cdr": layers_cdr.load,
    "aou": layers_aou.load,
}


def build_layers(root, catalog, allow_missing):
    """Return (long-form hit table, per-layer status)."""
    valid = set(zip(catalog.chrom, catalog.sv_index.astype(int)))
    hits, status = [], []

    for spec in LAYERS:
        path = os.path.join(root, spec["path"])
        if not os.path.exists(path):
            status.append(dict(spec, present=False, n=0,
                               why="source not found: %s" % spec["path"]))
            continue

        loader = LOADERS.get(spec["key"])
        if loader is None:
            status.append(dict(spec, present=False, n=0, why="loader not implemented yet"))
            continue

        df, why = loader(root, catalog=catalog)
        if df is None:
            status.append(dict(spec, present=False, n=0, why=why))
            continue
        df = df[df.layer == spec["key"]] if "layer" in df.columns else df.assign(layer=spec["key"])

        # Every hit must declare its significance tier. Without it the browser's tier
        # control would silently show or hide records depending on how a loader happened to
        # be written, which is exactly the kind of quiet disagreement with the paper this
        # build exists to prevent.
        if "tier" not in df.columns or df.tier.isna().any():
            die("layer %s emits hits with no tier" % spec["key"])
        bad_tier = sorted(set(df.tier) - set(TIERS))
        if bad_tier:
            die("layer %s emits unknown tiers %s (allowed: %s)"
                % (spec["key"], bad_tier, TIERS))

        # An unjoinable hit is a defect, not a filter. Report it rather than dropping it
        # quietly - a hit that references an SV the catalog lacks means the catalog is
        # built from the wrong ensemble or strategy.
        ok = df.apply(lambda r: (r["chrom"], int(r["sv_index"])) in valid, axis=1)
        if (~ok).any():
            lost = df[~ok]
            print("[layer %s] %d of %d hits reference SVs absent from the catalog: %s"
                  % (spec["key"], int((~ok).sum()), len(df),
                     ", ".join("%s/sv%d" % (r.chrom, int(r.sv_index))
                               for r in lost.head(6).itertuples())))
            if (~ok).mean() > 0.02:
                die("layer %s loses %.0f%% of its hits to the catalog join"
                    % (spec["key"], 100 * (~ok).mean()))
        df = df[ok]
        hits.append(df)
        by_tier = {t: int((df.tier == t).sum()) for t in TIERS}
        status.append(dict(spec, present=True, n=len(df), tiers=by_tier,
                           n_svs=int(df.groupby(["chrom", "sv_index"]).ngroups),
                           why=why or ""))

    table = pd.concat(hits, ignore_index=True) if hits else pd.DataFrame(
        columns=["chrom", "sv_index", "layer", "tier", "target", "scope"])

    print("\n%-8s %-6s %-30s %8s %8s %7s  %s"
          % ("LAYER", "SEC", "LABEL", "PRIMARY", "SUGGEST", "SVs", "STATUS"))
    print("-" * 96)
    bad = []
    for s in status:
        mark = "ok" if s["present"] else ("MISSING" if s["required"] else "missing (optional)")
        t = s.get("tiers", {})
        print("%-8s %-6s %-30s %8s %8s %7s  %s"
              % (s["key"], s["section"], s["label"], t.get("primary", "-"),
                 t.get("suggestive", "-"), s.get("n_svs", "-"), mark))
        if s["why"]:
            print("%-46s %s" % ("", s["why"]))
        if s["required"] and not s["present"]:
            bad.append(s["key"])
    print("-" * 96)

    if bad and not allow_missing:
        die("required layers could not be built: %s\n"
            "       Re-run with --allow-missing to produce a deliberately partial build."
            % ", ".join(bad))
    if bad:
        print("\nWARNING: building WITHOUT required layers %s (--allow-missing given).\n"
              "         The site will state which analyses are absent." % ", ".join(bad))
    return table, status


# ---------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("out")
    ap.add_argument("--allow-missing", action="store_true")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)

    chroms = build_chromosomes(a.root)
    catalog = build_catalog(a.root, chroms)

    # R9: population differentiation, attached to the SV rather than drawn as evidence.
    # The key check inside is that its table and this catalog are the SAME SV set - if they
    # were not, every F_ST here would sit on the wrong variant.
    keys = set(zip(catalog.chrom, catalog.sv_index.astype(int)))
    feats, fnote = features_fst.load(a.root, keys)
    if feats is None:
        die("population-differentiation features could not be built: %s" % fnote)
    catalog = catalog.merge(feats.reset_index(), on=["chrom", "sv_index"], how="left")
    print("[fst] %s" % fnote)

    # R8 coverage: which SVs the methylation scan tested, and which reached nothing. A
    # property of the variant, like F_ST above, so it stays out of the hit table.
    mcov, mnote = layers_meth.coverage(a.root, catalog)
    if mcov is None:
        die("methylation coverage could not be built: %s" % mnote)
    catalog = catalog.merge(mcov, on=["chrom", "sv_index"], how="left")
    for c in ("meth_tested", "meth_hits"):
        catalog[c] = catalog[c].fillna(0).astype(int)
    print("[meth] %s" % mnote)

    audit = audit_catalog(a.root, catalog)

    layers, status = build_layers(a.root, catalog, a.allow_missing)

    # R11 per ancestry. Attached to the All of Us hits rather than shipped as a layer: a
    # stratum-restricted association is the SAME association re-tested, not a second piece
    # of evidence, so counting it would inflate the converging-analyses colour.
    anc, anc_meta, anc_note = None, None, ""
    aou_hits = layers[layers.layer == "aou"] if len(layers) else layers
    if len(aou_hits):
        anc, anc_meta, anc_note = features_aou_ancestry.load(a.root, aou_hits)
        if anc is None:
            die("R11 per-ancestry could not be built: %s" % anc_note)
        print("[ancestry] %s" % anc_note)

    # R8b substrate tracks: 5mC along the array and dip density, both on the array's
    # covered-base frame rather than on this chart's CHM13 axis.
    trk, trk_note = tracks.load(a.root, chroms)
    if trk is None:
        die("substrate tracks could not be built: %s" % trk_note)
    print("[tracks] %s" % trk_note)

    # Pericentromeric LD, shipped as genotypes so the browser computes r for what a reader
    # chooses to draw. Fatal like the tracks rather than optional: its own loader asserts
    # that r recomputed from these genotypes reproduces the published panels on the variants
    # they share, and a build that quietly drops that assertion would ship a panel nobody
    # had checked against the manuscript.
    ldd, ld_note = ld.load(a.root, chroms, catalog)
    if ldd is None:
        die("pericentromeric LD could not be built: %s" % ld_note)
    print("[ld] %s" % ld_note)

    # Evidence count per SV at the PRIMARY tier - what the site paints on first load and
    # sorts its tables by. The browser recomputes this whenever the tier control changes,
    # so the colour always answers the question the control is asking.
    prim = layers[layers.tier == "primary"] if len(layers) else layers
    n_layers = (prim.groupby(["chrom", "sv_index"]).layer.nunique()
                if len(prim) else pd.Series(dtype=int))
    catalog["n_layers"] = [
        int(n_layers.get((c, int(i)), 0)) for c, i in zip(catalog.chrom, catalog.sv_index)]

    commit = sh("git rev-parse --short HEAD", cwd=a.root) or "unknown"
    meta = dict(
        source_commit=commit,
        source_root=os.path.abspath(a.root),
        meqtl_root=layers_meth.ROOT,
        ensembles=ENSEMBLES,
        n_svs=int(len(catalog)),
        n_chromosomes=len(chroms),
        catalog_unit=audit,
        catalog_unit_note=(
            "A row here is one imputed SV genotype: a variant under one resolution mode. "
            "%s of the %s coordinates were resolved under more than one mode, and each mode "
            "carries its own imputation accuracy and its own carrier frequency, so each is its "
            "own predictor. The manuscript's 11,129 counts "
            "something else again - rows of the CDR scan substrate, one per variant x mode x "
            "ensemble x weight strategy, over %s distinct coordinates, all of which are "
            "present here."
            % ("{:,}".format(audit["n_multi_mode"]), "{:,}".format(audit["n_variants"]),
               "{:,}".format(audit.get("substrate_variants", 0)))),
        layers=[{k: v for k, v in s.items() if k != "path"} for s in status],
        tiers=TIERS,
        tier_labels={"primary": "Primary", "suggestive": "Suggestive"},
        tier_note=("Primary is each section's headline significance. Suggestive is its "
                   "second band where the section states one (All of Us 0.05 <= q < 0.10; "
                   "methylation QTL robust in one SNP panel of two) and, for the e/sQTL "
                   "layers only, a 0.05 < q <= 0.10 band derived with the same filter the "
                   "manuscript uses at 0.05 - that band is derived here."),
        n_hits=int(len(layers)),
        n_hits_by_tier={t: int((layers.tier == t).sum()) for t in TIERS} if len(layers) else {},
        fst_note=fnote,
        coordinate_system="T2T-CHM13 v2.0",
        array_annotation="CenSat v2.1 (active)",
        ancestry=anc_meta,
        ancestry_note=anc_note,
        aou_tiers=layers_aou.PREDICTOR_TIERS,
        aou_tier_tests=layers_aou.TIER_TESTS,
        aou_n_tests=layers_aou.N_TESTS,
        # R8 headline counts, so the overview card and the table header state the
        # section's figures without recomputing them from the drawn rows - the drawn rows
        # are catalogue entries, which is a larger number than the section's SV count.
        # What the tile counts out of, and what a reader arriving from the paper
        # has just read. n_called is the whole call set; the catalog_unit above is the
        # modellable subset drawn here.
        n_called=n_called(a.root)[0],
        meth=dict(
            n_svs=layers_meth.PUBLISHED["n_svs"],
            n_cpgs=layers_meth.PUBLISHED["n_cpgs"],
            n_pairs=layers_meth.PUBLISHED["n_pairs"],
            n_near=layers_meth.PUBLISHED["n_near"],
            n_tested=layers_meth.PUBLISHED["n_tested"],
            n_chroms=int(layers[layers.layer == "mqtl"].chrom.nunique()),
        ),
        tracks_note=trk_note,
        ld_note=ld_note,
        # The floors the CATALOG already sits above, measured rather than assumed, so the
        # front end's filters can default to them and say plainly that they only ever
        # subtract. Nothing below these is in the file to be shown.
        floors=dict(
            svfreq=float(catalog.svfreq.min()) if "svfreq" in catalog else None,
            cv_r2=float(catalog.cv_r2.min()) if "cv_r2" in catalog else None,
            svfreq_default=0.025,
            cv_r2_default=0.1,
            cv_r2_strict=0.3,
            n_at_strict=int((catalog.cv_r2 >= 0.3).sum()) if "cv_r2" in catalog else None,
            note=("The upstream imputation summaries are already filtered, so these controls "
                  "can only raise a floor, never lower it. Raising cross-validated R-squared "
                  "to 0.30 reproduces the manuscript's strict imputability tier, which is "
                  "the set the population-differentiation section reasons on."),
        ),
    )

    def dump(name, obj):
        p = os.path.join(a.out, name)
        with open(p, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"), allow_nan=False, default=str)
        print("[out] %-18s %8.1f KB" % (name, os.path.getsize(p) / 1024))

    def records(frame):
        """Rows as plain dicts, floats round-tripping exactly, NaN keys omitted.

        NOT pandas.to_json. Its encoder rounds to a fixed number of DECIMAL places, and at
        the default 10 that silently turns q = 3.7e-13 into 0.0 - while leaving 2.1e-57
        alone, because the damage depends on the significand rather than the magnitude. An
        inconsistency like that is invisible to a glance at the output: the very smallest
        p-values look fine, and the ones in the middle read as exactly zero. Raising it to
        15 only moves the problem, truncating 3.713609e-13 to 3.71e-13.

        json.dump writes floats with repr, which round-trips a double exactly.
        """
        out = []
        for rec in frame.to_dict(orient="records"):
            r = {}
            for k, v in rec.items():
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    continue          # a missing key reads the same as null to the site
                r[k] = v.item() if hasattr(v, "item") else v
            out.append(r)
        return out

    def columnar(name, keys):
        """A row list on its side, with the round trip asserted rather than assumed.

        The row form was self-describing: a truncated file showed up as a row missing keys.
        This one is not - a column one element short shifts every value below it into the
        wrong row and leaves every row looking complete. So the transpose is inverted here and
        compared field by field against the rows it came from, and nothing is written if they
        differ.

        `keys` comes from the FRAME rather than from rows[0], because the rows do not all
        carry every key. records() drops a NaN instead of writing null - unambiguous in the
        row form, impossible in this one - so ancestry.json arrives with a standard error on
        686 of its 1,530 rows and no `se` key at all on the other 844. A missing value is
        normalised to None on both sides of the comparison below; that difference and nothing
        else. A shifted column still fails.
        """
        def go(rows):
            for i, r in enumerate(rows):
                extra = [k for k in r if k not in keys]
                if extra:
                    die("%s row %d carries %r, which is not a column of the frame it came "
                        "from (%r)" % (name, i, extra, keys))
            out = {"columns": keys, "rows": len(rows),
                   "data": [[r.get(k) for r in rows] for k in keys]}
            want = [{k: r.get(k) for k in keys} for r in rows]
            back = [dict(zip(out["columns"], vals)) for vals in zip(*out["data"])]
            if back != want:
                n = sum(1 for a, b in zip(back, want) if a != b)
                die("the columnar %s does not rebuild the rows it came from: %d of %d rows "
                    "differ" % (name, n, len(rows)))
            return out
        return go

    def dump_frame(name, frame, precision=None, transform=None):
        """Serialise a frame and verify nothing was lost to the encoder.

        The guard is the point: a value that was nonzero in the frame and is zero in the
        file is a p-value that has been rounded away, which renders as "q = 0.00e+0" and
        looks like a result rather than a bug.
        """
        obj = (json.loads(frame.to_json(orient="records", double_precision=precision))
               if precision is not None else records(frame))
        num = frame.select_dtypes("number")
        lost = 0
        for col in num.columns:
            for i, v in enumerate(num[col].tolist()):
                if v and not pd.isna(v) and not obj[i].get(col):
                    lost += 1
        if lost:
            die("%s: %d nonzero numeric values were written as zero or dropped - the JSON "
                "encoder is rounding them away" % (name, lost))
        dump(name, transform(obj) if transform else obj)

    dump("chromosomes.json", chroms)
    # 5 decimals on the catalog: nothing there is finer (frequencies are over a few hundred
    # to a few thousand haplotypes, CV R2 is reported to 2), and full float repr on
    # 10,705 rows x 8 numeric columns costs about a third of the file. dump_frame verifies
    # that choice rather than trusting it.
    # COLUMNAR, since 2026-08-31: one array per field rather than one object per row.
    # 21 key names written once instead of 10,705 times, worth 8.1% of the shipped file.
    # dump_frame's own encoder guard runs on the ROW form first, because that is what it
    # knows how to inspect; columnar() then asserts the transpose rebuilds those exact rows.
    dump_frame("catalog.json", catalog, precision=5,
               transform=columnar("catalog", list(catalog.columns)))
    # Full precision here: these are p- and q-values, several below 1e-40.
    dump_frame("layers.json", layers)
    # Same reason: the per-stratum Firth p-values reach 1e-16. Columnar since 2026-09-01,
    # when this went from 204 rows to 1,530 - see the header of etl/features_aou_ancestry.py.
    if anc is not None:
        dump_frame("ancestry.json", anc,
                   transform=columnar("ancestry", list(anc.columns)))
    dump("tracks.json", trk)
    # Genotypes, 2-bit packed and base64. Written whole rather than through dump_frame:
    # there is no numeric column here for a rounding check to protect.
    dump("ld.json", ldd)
    dump("meta.json", meta)

    print("\nsource commit %s | %d SVs | %d layers built | %d hits (%s)"
          % (commit, len(catalog), sum(1 for s in status if s["present"]), len(layers),
             ", ".join("%d %s" % (v, k) for k, v in meta["n_hits_by_tier"].items())))


if __name__ == "__main__":
    main()
