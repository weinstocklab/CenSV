#!/usr/bin/env python3
"""R11, per ancestry: the same phenome-wide scan re-run inside each of the six strata.

The browser shipped only the cross-ancestry model, which is the primary analysis but not the
whole of what R11 reports. met_11_aou.tex says:

    "Every cell was re-tested independently within each of the six ancestry strata, with
     exact per-ancestry Firth regression and within-stratum Benjamini--Hochberg correction."

and res_11_aou.tex turns that into the section's most consequential single sentence:

    "The chromosome-16 signal was concentrated in the AMR ancestry stratum. Of the 170
     significant associations, 138 reached nominal significance in AMR, compared with 12 in
     EUR, two in AFR, and none in EAS, SAS, or MID ... This concentration was not explained
     by greater statistical power in AMR, because the EUR sample was approximately three
     times larger for these phenotypes."

Both of those are asserted below, together with the supplementary caption's own per-stratum
counts and cohort sizes, so three independent published anchors have to agree with these
files before the layer is built.

WHAT ABSENCE MEANS, which decides the whole display
---------------------------------------------------
This changed on 2026-09-01 and the change is the point of this module's current shape.

Until then the only per-stratum tables available were threshold-exported, so a stratum with
no row for a cell had not returned a null - it had returned something the workbench never
released, anywhere from p = 0.9 to p = 1.1e-4. The browser could say nothing more than "not
reported", and three of six strata were a dash on every association.

The workbench has now released the UNTHRESHOLDED grid for exactly the cells this browser
shows: grid_255cells_6strata.tsv, 255 cells x 6 strata = 1,530 rows, of which 204 were in the
prior release and 920 now carry an estimate. Every remaining blank is LABELLED, per cell, and
the two labels mean different things:

    suppressed_lt20_cases       the stratum has fewer than 20 cases for that phecode, so the
                                count itself is withheld under the disclosure rule. The
                                cases field reads "<20". This is a sample-size limit.
    not_tested_no_information   the cell WAS reachable but the predictor carries no usable
                                variance in that stratum. cases is a real number here, so
                                this is NOT a sample-size limit - it is the dosage being
                                near-constant. Different fact, different sentence.

So the display no longer says "not reported". It says which of those two, per chip.

One premise correction the workbench made in the same reply, and it was ours to get wrong:
the export rule was never a bare p threshold. It is the UNION (q_bh_tier < 0.10) OR
(p_final < 1e-4). EXPORT_RULE below says so, and the reader-facing note says so.

THE STANDARD ERROR, and why it is shipped for only some rows
------------------------------------------------------------
The engine is a Rao score test, so Var(beta) = 1/V and SE = 1/sqrt(V) exactly. It is on disk
as se_score. It pairs ONLY with beta_score_logOR.

The beta this browser displays is beta_final_logOR, a MIXTURE: exact Firth where it converged,
approximate Firth next, score otherwise. No standard error was ever stored for any Firth fit
and none can be back-derived, because a Firth p is a penalised-likelihood p and not a Wald p.
The workbench measured what a naive beta_final +/- 1.96*se_score would do on the 234 rows
where a Firth refit sits beside a score SE: the implied p is wrong by up to 2,564x, 143 of 234
by more than 2x, and one cell crosses 0.05.

Therefore se is shipped ONLY on rows where final_estimator == "score", i.e. exactly where the
displayed beta IS the score beta. That is asserted below rather than assumed: all such rows
must have beta_final equal to beta_score exactly.

WHAT THE WORKBENCH COULD NOT PROVIDE, so that nothing here implies it
---------------------------------------------------------------------
Carrier count, allele frequency and call rate are not definable for this predictor. It is a
weighted sum of standardised tag SNPs, affine-rescaled to [0,2] over the whole cohort, so
mean/2 is not an allele frequency; and missing tag SNPs are mean-imputed before the sum, so
call rate is 100% by construction and sees nothing. Per-stratum imputation r-squared does not
exist either - cv_r2 is one global number per SV from this project's own elastic-net CV.
This module ships none of those and the front end must not offer them.
"""
import os

import pandas as pd

# Outside the project tree, like the meQTL root: the All of Us results were exported from the
# Researcher Workbench into a handoff tree and were never copied under the manuscript.
HANDOFF = ("/home/ydon268/AUO_handoff/beegfs/labs/weinstocklab/projects/ydon268/"
           "Project1_Centromere/discovery/2026-06-24_candidate_triage/aou_replication/"
           "results_vds")
ROOT = os.path.join(HANDOFF, "step30_phewide_ext2")
FIRTH = os.path.join(ROOT, "disease_matrices_firth")
PERANC = os.path.join(FIRTH, "per_ancestry")

# The unthresholded grid, delivered 2026-09-01 in answer to a data request. See the module
# docstring: this is what replaced "not reported" with a reason.
GRID = os.path.join(HANDOFF, "step97_discovery_requests", "grid_255cells_6strata.tsv")

# Ordered by cohort size, which is the order the power argument is read in.
STRATA = ["EUR", "AFR", "AMR", "EAS", "SAS", "MID"]

STRATUM_LABEL = {
    "EUR": "European",
    "AFR": "African",
    "AMR": "Admixed American",
    "EAS": "East Asian",
    "SAS": "South Asian",
    "MID": "Middle Eastern",
}

# figures_supp.tex, caption of fig:aou_robust: "The six strata sum to the scan cohort ---
# EUR 177,230, AFR 64,726, AMR 60,984, EAS 7,144, SAS 3,944, MID 1,176".
COHORT = dict(EUR=177230, AFR=64726, AMR=60984, EAS=7144, SAS=3944, MID=1176)
COHORT_TOTAL = 315204

# res_11_aou.tex: of the 170 significant cross-ancestry associations, how many appear in each
# stratum's exported hit table. Still asserted against the PRIOR release, because that is the
# table the published sentence was written from.
PUBLISHED_OF_170 = dict(AMR=138, EUR=12, AFR=2, EAS=0, SAS=0, MID=0)

# figures_supp.tex, same caption: "The admixed-American stratum carries 56 significant
# phecodes, the European 1 and the African 2". That is the WHOLE stratum scan at within-
# stratum q < 0.05, not the 170 - a second, independent anchor on the same six files.
PUBLISHED_DISEASES = dict(AMR=56, EUR=1, AFR=2, EAS=0, SAS=0, MID=0)

# The prior release's inclusion rule, corrected by the workbench on 2026-09-01: it is a UNION,
# not the bare p threshold this module used to state.
EXPORT_RULE = "(q_bh_tier < 0.10) OR (p_final < 1e-4)"
EXPORT_P = 1e-4

# Shape of the grid, and how many of its cells each stratum can estimate. Every one of these
# is a number the workbench stated in its reply, so each is an anchor that can fail.
GRID_CELLS = 255
GRID_ROWS = GRID_CELLS * len(STRATA)
GRID_PRIOR = 204
GRID_INFORMATIVE = dict(EUR=255, AFR=247, AMR=246, EAS=107, SAS=38, MID=27)

# The only two reasons a cell can be blank, and what each means. Codes are what ships.
NA_CODES = {"": 0, "suppressed_lt20_cases": 1, "not_tested_no_information": 2}

# met_11_aou.tex: "principal components were recomputed afresh within the AMR stratum and
# added to the null; the association was then re-fit with them included."
RESCUE = os.path.join(PERANC, "chr16_within_amr_pc_rescue_ext2.tsv")
RESCUE_N = 197
RESCUE_VERDICT = "SURVIVES"

KEY = ["sv_locus", "phecode"]


def _num(d, col):
    return pd.to_numeric(d[col], errors="coerce")


def _read(path):
    """The grid carries a # header block explaining the SE caveat. Skip it."""
    return pd.read_csv(path, sep="\t", dtype=str, comment="#")


def _sig(x, nd):
    return float("%.*g" % (nd, x))


def _ndigits(s):
    """Significant digits the prior release wrote, so a comparison uses ITS precision."""
    body = str(s).lstrip("-").split("e")[0].replace(".", "").lstrip("0").rstrip("0")
    return max(len(body), 1)


def load(root, hits):
    """Per-stratum records for the cells in `hits`.

    `hits` is the all-ancestry AoU table already built by layers_aou, carrying sv_locus,
    phecode, chrom and sv_index. Returns (frame, meta, note) or (None, None, why).
    """
    if not os.path.isdir(PERANC):
        return None, None, "per-ancestry tree not found: %s" % PERANC
    if not os.path.exists(GRID):
        return None, None, "the unthresholded grid is not on disk: %s" % GRID

    allanc = pd.read_csv(os.path.join(FIRTH, "disease_hits_final.tsv"), sep="\t", dtype=str)
    allanc["q"] = _num(allanc, "q_bh_tier")
    sig = allanc[allanc.q < 0.05]
    if len(sig) != 170:
        return None, None, ("the all-ancestry table behind the per-ancestry tree holds %d "
                            "cells at q<0.05, not the 170 res_11 states" % len(sig))
    sigkeys = set(map(tuple, sig[KEY].values))

    # ---------------------------------------------------------------- the PRIOR release
    # Still read in full, for two reasons: the three published anchors were written from it,
    # and it is an independently produced file the new grid can be checked against.
    prior, of170, diseases, maxp, in_strata = {}, {}, {}, {}, {}
    for s in STRATA:
        f = os.path.join(PERANC, "disease_hits_final_%s.tsv" % s)
        if not os.path.exists(f):
            return None, None, "stratum table missing: %s" % os.path.basename(f)
        d = pd.read_csv(f, sep="\t", dtype=str)
        d["p"] = _num(d, "p_final")
        d["q"] = _num(d, "q_bh_tier")

        maxp[s] = float(d.p.max())
        diseases[s] = int(d[d.q < 0.05].phecode.nunique())

        k = list(map(tuple, d[KEY].values))
        of170[s] = int(sum(1 for x in k if x in sigkeys))
        for x in k:
            if x in sigkeys:
                in_strata.setdefault(x, []).append(s)
        for _, row in d.iterrows():
            prior[(row.sv_locus, row.phecode, s)] = row

    # --- three published anchors, each able to fail
    if of170 != PUBLISHED_OF_170:
        return None, None, ("per-stratum counts of the 170 do not reproduce res_11_aou.tex; "
                            "got %s, published %s" % (of170, PUBLISHED_OF_170))
    if diseases != PUBLISHED_DISEASES:
        return None, None, ("whole-stratum significant phecode counts do not reproduce the "
                            "fig:aou_robust caption; got %s, published %s"
                            % (diseases, PUBLISHED_DISEASES))
    if max(maxp.values()) > 2e-4:
        return None, None, ("a per-ancestry table reaches p = %.3g, so it is NOT the "
                            "threshold export the prior release was; the cross-check below "
                            "would be comparing the grid against something else"
                            % max(maxp.values()))

    # ------------------------------------------------------------------- the NEW grid
    g = _read(GRID)
    need = ["sv_locus", "phecode", "stratum", "cases", "n", "beta_score_logOR", "se_score",
            "beta_final_logOR", "p_final", "final_estimator", "na_reason",
            "exported_in_prior_release"]
    missing = [c for c in need if c not in g.columns]
    if missing:
        return None, None, "the grid is missing columns %s" % missing
    if len(g) != GRID_ROWS:
        return None, None, ("the grid holds %d rows, not the %d cells x %d strata it is "
                            "documented as" % (len(g), GRID_CELLS, len(STRATA)))

    gcells = set(map(tuple, g[KEY].values))
    hcells = set(map(tuple, hits[KEY].values))
    if gcells != hcells:
        return None, None, ("the grid covers %d cells and this browser shows %d; %d shown "
                            "cells have no grid row and %d grid cells are not shown"
                            % (len(gcells), len(hcells), len(hcells - gcells),
                               len(gcells - hcells)))
    if sorted(set(g.stratum)) != sorted(STRATA):
        return None, None, "the grid's strata are %s" % sorted(set(g.stratum))

    g["na_reason"] = g.na_reason.fillna("")
    bad = sorted(set(g.na_reason) - set(NA_CODES))
    if bad:
        return None, None, "the grid uses unknown na_reason values %s" % bad

    g["beta"] = _num(g, "beta_final_logOR")
    g["p"] = _num(g, "p_final")
    g["bscore"] = _num(g, "beta_score_logOR")
    g["se"] = _num(g, "se_score")

    # A blank estimate and a reason must be exactly complementary. If a row ever carries both,
    # or neither, the display would either state a reason for a number it is showing or show a
    # dash it cannot explain.
    inc = g[(g.beta.isna()) != (g.na_reason != "")]
    if len(inc):
        return None, None, ("%d grid rows have a blank estimate without a reason, or a "
                            "reason beside an estimate" % len(inc))

    got_inf = {s: int(((g.stratum == s) & (g.beta.notna())).sum()) for s in STRATA}
    if got_inf != GRID_INFORMATIVE:
        return None, None, ("the grid's informative counts do not match the ones the "
                            "workbench stated; got %s, stated %s"
                            % (got_inf, GRID_INFORMATIVE))

    # SE exists for every score fit, and the displayed beta IS the score beta on exactly those
    # rows - which is the whole licence for shipping an interval anywhere.
    sc = g[g.final_estimator == "score"]
    if not len(sc):
        return None, None, "no score-test rows at all, which contradicts the mixture on record"
    if sc.se.isna().any():
        return None, None, ("%d score-test rows carry no standard error"
                            % int(sc.se.isna().sum()))
    drift = float((sc.beta - sc.bscore).abs().max())
    if drift != 0.0:
        return None, None, ("on %d rows the estimator is the score test yet the final beta "
                            "differs from the score beta by up to %.3g, so pairing se_score "
                            "with the displayed beta would be wrong" % (len(sc), drift))
    if not len(g[(g.final_estimator != "score") & (g.beta.notna())]):
        return None, None, "no Firth rows at all, which contradicts the mixture on record"

    # --- the cross-check: two independently produced files, 204 overlapping rows
    marked = g[g.exported_in_prior_release == "1"]
    if len(marked) != GRID_PRIOR:
        return None, None, ("the grid marks %d rows as previously exported, not the %d this "
                            "browser last shipped" % (len(marked), GRID_PRIOR))
    absent, moved = [], []
    for _, row in marked.iterrows():
        o = prior.get((row.sv_locus, row.phecode, row.stratum))
        if o is None:
            absent.append((row.sv_locus, row.phecode, row.stratum))
            continue
        # Compare at the PRIOR file's own precision: it wrote four significant digits and the
        # grid carries full precision, so a bit-for-bit test would fail on every row.
        #
        # The tolerance is ONE unit in the prior file's last printed digit, not half of one.
        # Both sides rounded independently and several values sit exactly on a tie
        # (p_final 1.475e-09 against a printed 1.48e-09), so half a unit rejects rounding
        # rather than disagreement. A full unit still demands agreement to four significant
        # digits, so a value that actually moved fails this.
        for c in ("beta_final_logOR", "p_final"):
            a, b = row[c], o[c]
            if a in ("", "NA") or b in ("", "NA"):
                continue
            b = float(b)
            if abs(float(a) - b) > 10.0 ** -(_ndigits(o[c]) - 1) * abs(b):
                moved.append((row.sv_locus, row.phecode, row.stratum, c, a, o[c]))
    if absent:
        return None, None, ("%d rows the grid says were previously exported are not in the "
                            "prior release: %s" % (len(absent), absent[:3]))
    if moved:
        return None, None, ("%d values disagree between the prior release and the grid beyond "
                            "the prior file's own precision: %s" % (len(moved), moved[:3]))

    # Cohort size per stratum: the largest n any cell was tested at. Every cell is a subset of
    # the stratum after cohort intersection and sex restriction, so the maximum is the stratum
    # itself - and it must equal the caption's number.
    g["n_num"] = _num(g, "n")
    got_cohort = {s: int(g[g.stratum == s].n_num.max()) for s in STRATA}
    off = {s: (got_cohort[s], COHORT[s]) for s in STRATA if got_cohort[s] != COHORT[s]}
    if off:
        return None, None, ("stratum cohort sizes disagree with the fig:aou_robust caption; "
                            "(got, published) = %s" % off)
    if sum(COHORT.values()) != COHORT_TOTAL:
        return None, None, "the six published cohort sizes do not sum to %d" % COHORT_TOTAL

    # How many strata carry each of the 170 IN THE PRIOR RELEASE. Kept because it is the
    # published spread, not a property of the new grid.
    spread = {}
    for k in sigkeys:
        spread[len(in_strata.get(k, []))] = spread.get(len(in_strata.get(k, [])), 0) + 1
    if spread.get(0, 0) + spread.get(1, 0) != len(sigkeys):
        return None, None, ("some of the 170 reach the export threshold in more than one "
                            "stratum, which the note below says none do: %s" % spread)

    # --- the within-AMR principal-component re-fit
    resc = None
    if os.path.exists(RESCUE):
        r = pd.read_csv(RESCUE, sep="\t", dtype=str)
        if len(r) != RESCUE_N:
            return None, None, ("the within-AMR PC re-fit holds %d cells, not the %d on "
                                "record" % (len(r), RESCUE_N))
        v = sorted(set(r.verdict.astype(str)))
        if v != [RESCUE_VERDICT]:
            return None, None, ("the within-AMR PC re-fit no longer returns %s for every "
                                "cell; verdicts present: %s" % (RESCUE_VERDICT, v))
        r["beta0"] = _num(r, "beta_model0")
        r["beta1"] = _num(r, "beta_model1_withinPC")
        resc = float((1 - (r.beta1.abs() / r.beta0.abs())).median())

    # ------------------------------------------------------------------ what ships
    # One row per cell x stratum, blanks included: a blank now CARRIES information and the
    # front end draws a reason for it. Only the fields the display reads:
    #   se     only where the estimator is the score test, per the docstring
    #   cases  numeric; "<20" becomes null and na says so
    #   n      NOT shipped - the chip prints the stratum cohort from meta, not the cell's n
    out = pd.DataFrame(dict(
        sv_locus=g.sv_locus.values,
        phecode=g.phecode.values,
        stratum=g.stratum.values,
        beta=g.beta.values,
        p=g.p.values,
        cases=_num(g, "cases").values,
        se=g.se.where(g.final_estimator == "score").values,
        na=[NA_CODES[x] for x in g.na_reason],
    ))

    meta = dict(
        strata=STRATA,
        labels=STRATUM_LABEL,
        cohort=COHORT,
        cohort_total=COHORT_TOTAL,
        of_170=of170,
        diseases_q05=diseases,
        export_rule=EXPORT_RULE,
        export_p=EXPORT_P,
        prior_release_cells=GRID_PRIOR,
        informative=got_inf,
        cells=GRID_CELLS,
        spread={str(k): v for k, v in sorted(spread.items())},
        amr_pc_refit_shrinkage=resc,
        na_codes={str(v): k for k, v in NA_CODES.items()},
        source=os.path.dirname(GRID),
        note=(
            "Each cell was re-tested inside every ancestry stratum. The Researcher Workbench "
            "released the full grid for these %d cells in all six strata, so a stratum "
            "without an estimate is either a cell with fewer than 20 cases or one where the "
            "imputed predictor carries no usable variance there; the chip says which."
            % GRID_CELLS),
    )

    note = ("%d per-stratum records over %d cells; %d carry an estimate against %d in the "
            "prior release, including %d in EAS/SAS/MID which had none; %d blanks are fewer "
            "than 20 cases and %d are a predictor with no information there"
            % (len(out), GRID_CELLS, int(out.beta.notna().sum()), GRID_PRIOR,
               got_inf["EAS"] + got_inf["SAS"] + got_inf["MID"],
               int((out.na == 1).sum()), int((out.na == 2).sum())))
    return out, meta, note
