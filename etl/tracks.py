#!/usr/bin/env python3
"""Two tracks drawn under the per-chromosome chart: 5mC along the array, and dip density.

Both come from R8b's substrate - the same haplotype-resolved methylation the CDR phenotypes
are computed from - so the browser shows the signal the section reasons about rather than
only the section's verdict about it.

THE FRAME, which is the whole difficulty
----------------------------------------
The chart's abscissa is a CHM13 v2.0 coordinate inside the active HOR array. Neither track
is on that axis. Both are on the array's own COVERED-BASE frame, because array bounds differ
between haplotypes and no single reference coordinate is shared by 245 of them.

  methyl_profile.tsv, frame `rel`   off / S, where off is covered bases before the window
                                    midpoint and S the summed length of the merged active
                                    blocks. 0 = array start, 1 = array end. 60 bins.
  per_dip_positions.tsv, pos_splice (dip covered offset - m) / (L/2), which met_08b_cdr.tex
                                    defines as "running from -1 at the array start through 0
                                    at its center to +1 at its end".

The two are the same frame up to `pos = 2*rel - 1`, which is why they can share an axis with
each other. They are only an APPROXIMATION to the chart's axis, and how good an approximation
is measured per chromosome below rather than asserted: `covered_frac` is the fraction of the
CHM13 union span that the active-array intervals actually cover, and where that is 1.0 a
covered-base fraction and a linear fraction are the same number.

`methyl_profile.tsv` also carries an `abs` frame - megabases of covered bases from the array
start, capped at 6 Mb. It is NOT a CHM13 coordinate either, so it buys nothing here and is
not shipped; the note records that it exists.

WHAT IS ASSERTED
----------------
met_08b_cdr.tex states two counts these files must reproduce - about 22,000 dips restricted
to the active array, a median of 4 per centromere - and the frame definition above bounds
every position to [-1, +1].

The third check is a cross-check between two tables written by two different scripts: a
chromosome's dip density must peak where its methylation troughs.

Be precise about what it does and does not test. Dips are CALLED FROM this profile by a
thresholding caller, so the anticorrelation is guaranteed by construction and this is NOT
evidence that hypomethylated domains exist or that the caller is right. It is an ENGINEERING
check, and a strong one: if either track were binned on the wrong frame, reversed, joined to
the wrong chromosome, or scaled wrongly, the correlation would collapse while every
structural check above still passed. That is the failure mode a browser actually has.

WHAT IS DELIBERATELY *NOT* ASSERTED, AND WHY
--------------------------------------------
res_08b_cdr.tex and supp_notes.tex state a dispersion result:

    "the median within-haplotype standard deviation of dip position is 0.061 against a
     between-individual standard deviation of 0.373, a ~6.1-fold ratio (6.0-fold on
     chromosome 8)"

Every recipe tried lands within 0.003 of every one of those numbers and none reproduces all
four at once. Averaging both statistics over an individual's two haplotypes first, which is
what Methods M8b prescribes, gives 0.0609 / 0.3696 / 6.07 with chromosome 8 at 5.97 - three
of the four. Not averaging, and requiring at least three dips per haplotype, gives
0.0615 / 0.3735 / 6.07 - the other three, with chromosome 8 at 5.89. The published pair is
therefore not exactly derivable from the shipped table, most likely because it was computed
from a different vintage of it.

Asserting whichever variant happened to match would be a test tuned to pass, so it is
recorded instead. What IS asserted is the claim the section actually rests on: the ratio is
about six. Every recipe tried returns between 5.6 and 6.3, so that claim is robust to the
ambiguity even though the digits are not.
"""
import os

import numpy as np
import pandas as pd

ROOT = ("/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere/discovery/"
        "2026-08-20_cdr_length_frame_rederivation/output/phenotypes")
REL_PROFILE = os.path.join(ROOT, "methyl_profile.tsv")
DIPS = os.path.join(ROOT, "per_dip_positions.tsv")
FRAMES = os.path.join(ROOT, "frame_comparison.tsv")
HAPPHENO = os.path.join(ROOT, "per_hap_chrom_phenotypes_v2.tsv")

# Ancestry labels for the assembly cohort.
#
# These are NOT in this project. Neither phenotype table carries an ancestry column and the
# methylation manifest has none, so every ancestry word this browser puts on the dip track is
# joined here, by sample ID, from tables belonging to other studies.
#
# It takes more than one table, and an earlier build of this browser got that wrong. The
# cohort is the Gao / Oshima / ... / Logsdon (2025) global centromere deposit - HPRC plus
# HGSVC3 plus the Platinum pedigree - which is not a subset of any single 1kGP release.
# Joining against the 3,202-sample NYGC panel alone leaves 7 of the 188 samples with no row,
# and those 7 were drawn as an "unlabelled" stratum. They are not unlabelled: five carry a
# published 1000 Genomes population, one a HapMap population, and the seventh is a documented
# GIAB / Personal Genome Project participant. The panel was simply the wrong table to ask.
# Its own release note says what it is - "2504 phase three panel plus additional 698 related
# samples", the 698 "mainly completing trios" - so it is a CALL SET, and a collection sample
# that neither sits in the phase-3 panel nor completes one of those trios was never in it:
# ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000G_2504_high_coverage/
# README_2504_plus_additional_698_related_samples.txt
#
# So four tables are read. Coverage of this cohort's 188 samples, measured not assumed:
#
#   PANEL    3,202 samples  NYGC 30x call set; the ONLY one with a superpopulation column  181
#   PED      3,501 samples  the 1kGP collection, incl. samples in no call set              185
#   HPRC_R2    234 samples  HPRC release 2; the only one that names NA21309's population   187
#   HPRC_Y1     46 samples  HPRC year-1 freeze; the only one that explains the two
#                           samples with no population code at all                          39
#
# Where two tables name the same sample they must AGREE - the build fails if they do not, and
# on this cohort all 188 agree across every overlap. Superpopulation is then taken from the
# panel's own Population -> Superpopulation pairs rather than from a map written here, so the
# five-way grouping stays the 1kGP's and not mine.
PANEL = ("/beegfs/labs/weinstocklab/projects/ydon268/_shared/datasets/1KGP/"
         "v_sample_panel_20260822/3202_samples_ped_population.txt")
PED = ("/beegfs/labs/weinstocklab/projects/ydon268/_shared/datasets/1KGP/"
       "v_g1k_ped_20260828/20130606_g1k.ped")
HPRC_R2 = ("/beegfs/labs/weinstocklab/projects/ydon268/_shared/datasets/HPRC/"
           "v_sample_metadata_20260828/hprc_release2_sample_metadata.csv")
HPRC_Y1 = ("/beegfs/labs/weinstocklab/projects/ydon268/_shared/datasets/HPRC/"
           "v_sample_metadata_20260828/hprc_year1_sample_metadata.txt")
SUPERPOPS = ("AFR", "AMR", "EAS", "EUR", "SAS")

# Two of the 188 were never 1kGP participants, so no released table gives them a 1kGP
# superpopulation and no join can produce one. They are assigned here, by hand, from their own
# collection's documentation, and both are NAMED in the browser's caption rather than being
# folded silently into a stratum. The assignment is continental geography - which is what the
# 1kGP superpopulations are - not an inference from genotype, and the browser says so.
#
# Both entries are asserted to be USED below. If a wider panel or a different cohort ever
# makes one unnecessary it must be deleted, not left sitting here as a hand assignment that
# nobody checks any more.
OUTSIDE_1KGP_POP = {
    # HapMap Maasai in Kinyawa, Kenya (HPRC release 2 population_abbreviation `MKK`). MKK is
    # a HapMap population and has no 1kGP superpopulation by construction, so AFR here is a
    # BORROWED continental grouping rather than a 1kGP assignment. The precedent is this
    # cohort's own: HGSVC3 labels its population groups "according to the 1000 Genomes
    # Project ... along with the added Maasai in Kinyawa, Kenya (MKK) and Ashkenazim (ASK)
    # labels" (Nature 2025, PMC12350169, Fig. 1a legend). The geography is not in question;
    # the framework is borrowed, and the caption says so rather than letting the fill imply
    # a 1kGP label.
    "MKK": ("AFR", "HapMap Maasai in Kinyawa, Kenya"),
}
OUTSIDE_1KGP_SAMPLE = {
    # GIAB / Personal Genome Project Chinese trio son (Coriell NA24631). HPRC's year-1 table
    # records the collection as `PGP - Chinese` and leaves Subpopulation and Superpopulation
    # blank; release 2 gives population_descriptor `N/A`, collection `GIAB`. No released table
    # assigns it a population code, so EAS is the same borrowed continental grouping as MKK.
    #
    # The alternative - a seventh stratum holding one sample - was considered and rejected on
    # this browser's own terms: two haplotypes is below ANC_MIN_HAP, so the row would be
    # drawn with no rate and the stacked band would be a hairline. It would re-create the
    # unreadable outlier stratum this change exists to remove, while telling the reader less
    # than one sentence of caption does.
    "HG005": ("EAS", "GIAB / PGP Chinese trio son (NA24631)"),
}

# Alphabetical. Deliberately NOT by cohort size: the facets are read top to bottom and a size
# ordering would put a reading of "most" on what is only "first". UNLABELLED stays as the
# sentinel the join falls back to so the strata remain a partition whatever happens - but
# nothing may land in it, and load() fails the build if anything does.
UNLABELLED = "unlabelled"
STRATA = list(SUPERPOPS) + [UNLABELLED]

# CHM13's covered array length divided by the cohort median. Below/above these, the
# reference is an unrepresentative haplotype and placing a cohort mean on its coordinate
# implies a precision the data does not have. Both tails matter, so it is a band.
REF_RATIO_BAND = (0.75, 1.35)

NBIN = 60

# met_08b_cdr.tex, asserted
PUBLISHED = dict(
    dips_approx=22000,          # "restricted, they return ~22,000"
    dips_per_centromere=4,      # "a median of 4 per centromere on the chromosomes that yield calls"
)
# res_08b_cdr.tex / supp_notes.tex, recorded rather than asserted - see the header
DISPERSION_PUBLISHED = dict(sd_within=0.061, sd_among=0.373, fold=6.1, fold_chr8=6.0)
# the per-haplotype CDR phenotypes the dispersion result is computed from; a different table
# from the two the tracks are drawn from
PHENO = ("/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere/discovery/"
         "2026-06-23_cdr_qtl_corrected/output/per_hap_chrom_phenotypes_corrected.tsv")
# The section's claim is "about six-fold". Every recipe tried returns 5.86 to 6.27 on the
# pooled statistic, so this band admits all of them while still being tight enough to mean
# something: if dip positions were scrambled, within-haplotype spread would rise to meet
# between-individual spread and the ratio would collapse towards 1.
FOLD_BAND = (5.5, 7.0)

# Below this, the source's own frame_comparison.tsv says the three positional frames
# disagree with each other on that chromosome, so a position along the array is not a
# well-defined quantity there and the track is drawn with a caution rather than silently.
FRAME_R_FLOOR = 0.90


def _fail(msg):
    return None, msg


def resolve_ancestry(samples):
    """Ancestry for every sample in `samples`, from the four staged cohort tables.

    Returns `(sup, basis, hand, panel_pop, None)` or `(None, None, None, None, why)`.

      sup        sample -> superpopulation, one of SUPERPOPS. Total over `samples`.
      basis      sample -> what the label was read off: a 1kGP population code for the ones
                 a table covers, a prose collection description for the hand entries.
      hand       the samples assigned by hand, in cohort order.
      panel_pop  sample -> population, restricted to what the 3,202-sample panel covers.

    Lives here rather than inside load() because two callers need exactly this map, and a
    second hand-rolled join is how two views of the same cohort drift apart.
    """
    # Three checks on the panel before anything is joined against it. None is ceremony: the
    # per-stratum tracks are the only place this browser says a word about ancestry, and the
    # superpopulation grouping comes entirely from this file.
    if not os.path.exists(PANEL):
        return None, None, None, None, "1kGP sample panel not found: %s" % PANEL
    pan = pd.read_csv(PANEL, sep=r"\s+")
    for col in ("SampleID", "Population", "Superpopulation"):
        if col not in pan.columns:
            return None, None, None, None, ("1kGP panel has no `%s` column; columns are %s"
                                            % (col, list(pan.columns)))
    # A fine-grained population belongs to exactly one superpopulation. If a panel ever
    # arrived with rows shuffled between columns this is what would catch it, and none of the
    # completeness checks below would.
    multi = pan.groupby("Population").Superpopulation.nunique()
    if (multi > 1).any():
        return None, None, None, None, ("1kGP panel is internally inconsistent: %s map to "
                                        "more than one superpopulation"
                                        % sorted(multi[multi > 1].index))
    got_pops = set(pan.Superpopulation.dropna().unique())
    if got_pops != set(SUPERPOPS):
        return None, None, None, None, ("1kGP panel carries superpopulations %s, not the "
                                        "expected %s" % (sorted(got_pops), list(SUPERPOPS)))
    pop2sup = dict(zip(pan.Population, pan.Superpopulation))
    panel_pop = dict(zip(pan.SampleID, pan.Population))

    for p in (PED, HPRC_R2, HPRC_Y1):
        if not os.path.exists(p):
            return None, None, None, None, "cohort metadata table not found: %s" % p

    def _clean(v):
        v = str(v).strip()
        return "" if v in ("", "nan", "NA", "N/A", "None", "-") else v

    ped = pd.read_csv(PED, sep="\t")
    for col in ("Individual ID", "Population"):
        if col not in ped.columns:
            return None, None, None, None, ("1kGP pedigree has no `%s` column; columns are "
                                            "%s" % (col, list(ped.columns)))
    ped_pop = {s: _clean(p) for s, p in zip(ped["Individual ID"], ped["Population"])
               if _clean(p)}

    r2 = pd.read_csv(HPRC_R2)
    for col in ("sample_id", "population_abbreviation"):
        if col not in r2.columns:
            return None, None, None, None, ("HPRC release-2 metadata has no `%s` column; "
                                            "columns are %s" % (col, list(r2.columns)))
    r2_pop = {s: _clean(p) for s, p in zip(r2["sample_id"], r2["population_abbreviation"])
              if _clean(p)}

    y1 = pd.read_csv(HPRC_Y1, sep="\t")
    for col in ("Sample", "Subpopulation", "Superpopulation"):
        if col not in y1.columns:
            return None, None, None, None, ("HPRC year-1 metadata has no `%s` column; "
                                            "columns are %s" % (col, list(y1.columns)))
    y1_pop = {s: _clean(p) for s, p in zip(y1["Sample"], y1["Subpopulation"]) if _clean(p)}
    y1_sup = {s: _clean(p) for s, p in zip(y1["Sample"], y1["Superpopulation"]) if _clean(p)}

    # (a) the four tables must not contradict each other about who is who. This is the check
    #     that lets the resolution below take the FIRST table that has a sample and stop.
    sources = (("1kGP panel", panel_pop), ("1kGP pedigree", ped_pop),
               ("HPRC release 2", r2_pop), ("HPRC year 1", y1_pop))
    clash = []
    for s in samples:
        got = {name: d[s] for name, d in sources if s in d}
        if len(set(got.values())) > 1:
            clash.append("%s (%s)" % (s, ", ".join("%s=%s" % kv
                                                   for kv in sorted(got.items()))))
    if clash:
        return None, None, None, None, ("the cohort metadata tables disagree about which "
                                        "population a sample belongs to: %s"
                                        % "; ".join(clash[:5]))

    # (b) and where HPRC states a superpopulation of its own it must match the grouping the
    #     panel's Population -> Superpopulation pairs imply. Nothing else tests that map.
    regroup = sorted(s for s in samples
                     if s in y1_sup and s in panel_pop and y1_sup[s] != pop2sup[panel_pop[s]])
    if regroup:
        return None, None, None, None, ("HPRC's own superpopulation disagrees with the 1kGP "
                                        "panel's grouping for %s" % regroup[:5])

    # (c) resolve every sample. Tables first, hand entries last, so a table that starts
    #     covering one of them silently takes precedence and (d) then reports the hand entry
    #     as dead rather than letting it shadow real metadata.
    sup, basis, used_pop, used_sample, hand = {}, {}, set(), set(), []
    for s in samples:
        pop = next((d[s] for _, d in sources if s in d), None)
        if pop in pop2sup:
            sup[s], basis[s] = pop2sup[pop], pop
        elif pop in OUTSIDE_1KGP_POP:
            used_pop.add(pop)
            sup[s], basis[s] = OUTSIDE_1KGP_POP[pop]
            hand.append(s)
        elif s in OUTSIDE_1KGP_SAMPLE:
            used_sample.add(s)
            sup[s], basis[s] = OUTSIDE_1KGP_SAMPLE[s]
            hand.append(s)

    missing = sorted(s for s in samples if s not in sup)
    if missing:
        return None, None, None, None, (
            "%d of %d cohort samples resolve to no ancestry from any of the four staged "
            "tables and have no hand entry: %s. Every sample in this cohort has a published "
            "ancestry, so a sample arriving here means a table is stale or the cohort grew "
            "- not that the sample is unlabelled."
            % (len(missing), len(samples), ", ".join(missing[:8])))

    # (d) the hand entries must still be earning their place
    stale = (sorted(set(OUTSIDE_1KGP_POP) - used_pop)
             + sorted(set(OUTSIDE_1KGP_SAMPLE) - used_sample))
    if stale:
        return None, None, None, None, ("hand ancestry entries %s are not used by this "
                                        "cohort. Delete them rather than leaving an "
                                        "unchecked hand assignment in the file." % stale)

    return sup, basis, hand, panel_pop, None


def load(root, chrom_index):
    """Return (tracks dict keyed by chromosome, note) or (None, why)."""
    for p in (REL_PROFILE, DIPS, FRAMES):
        if not os.path.exists(p):
            return _fail("track source not found: %s" % p)

    chroms = [c["chrom"] for c in chrom_index]

    # ---- reconciling the track frame with the chart's CHM13 axis
    #
    # Two differences, and only one of them is removable.
    #
    #   GAPS. CHM13's active intervals need not tile their union span. This is exactly
    #   invertible - walk the merged blocks accumulating covered bases and a covered
    #   fraction maps to one CHM13 coordinate - and every one of the 10,705 catalogued SVs
    #   sits INSIDE a block, so nothing is lost by doing it. `covered_frac` records how much
    #   remapping a chromosome needs: 1.000 on 21 of 23, 0.674 on chr4, 0.309 on chr3.
    #
    #   HAPLOTYPE AVERAGING. The tracks are a mean over ~215 haplotypes each normalised to
    #   its OWN array; CHM13 is one particular haplotype. No remapping touches this. What it
    #   costs is measured as `ref_ratio` below: on chr21 the reference's whole active array
    #   is a QUARTER of the cohort median, so "40% along" on the reference and "40% along"
    #   for a typical haplotype are the same fraction of very different things.
    covered, ref_ratio = {}, {}
    hap_len = None
    if os.path.exists(HAPPHENO):
        hp = pd.read_csv(HAPPHENO, sep="\t")
        if "active_len_sum" in hp.columns:
            hap_len = hp.groupby("chm13_chrom").active_len_sum.median()
    for c in chrom_index:
        span = c["hor_end"] - c["hor_start"]
        cov = sum(a["end"] - a["start"] for a in c["arrays"])
        covered[c["chrom"]] = round(cov / span, 4) if span else None
        med = (float(hap_len.get(c["chrom"])) if hap_len is not None
               and c["chrom"] in hap_len.index else None)
        ref_ratio[c["chrom"]] = round(cov / med, 3) if med else None

    # ---- methylation profile, relative frame
    mp = pd.read_csv(REL_PROFILE, sep="\t")
    rel = mp[mp.frame == "rel"].copy()
    if not len(rel):
        return _fail("methyl_profile.tsv carries no `rel` frame")
    if rel.meth_cw.min() < 0 or rel.meth_cw.max() > 100:
        return _fail("methylation outside 0-100%%: %.2f .. %.2f"
                     % (rel.meth_cw.min(), rel.meth_cw.max()))
    nb = rel.groupby("chrom").bin.nunique()
    if set(nb.unique()) != {NBIN}:
        return _fail("methylation profile is not %d bins on every chromosome: %s"
                     % (NBIN, sorted(set(nb.unique()))))

    fc = pd.read_csv(FRAMES, sep="\t").set_index("chrom")
    # nhap in the profile is the number of haplotypes averaged into it, and must be the
    # number the frame audit counted for that chromosome - two scripts, one cohort.
    gap = {}
    for c in chroms:
        if c not in fc.index:
            continue
        got = int(rel[rel.chrom == c].nhap.max())
        want = int(fc.loc[c, "n_hap"])
        if got != want:
            gap[c] = (got, want)
    if gap:
        return _fail("the profile averages a different haplotype count from the frame audit; "
                     "(profile, audit) = %s" % gap)

    # ---- dips
    dp = pd.read_csv(DIPS, sep="\t")
    v = pd.to_numeric(dp.pos_splice, errors="coerce")
    if v.isna().any() or v.min() < -1 or v.max() > 1:
        return _fail("dip relative positions are not all inside [-1, +1], which is the "
                     "definition met_08b_cdr.tex gives")

    per_cen = dp.groupby(["sample", "hap_local", "chm13_chrom"]).size()
    got_med = float(per_cen.median())
    if abs(len(dp) - PUBLISHED["dips_approx"]) > 1500:
        return _fail("%d dips, where met_08b_cdr.tex states about %d restricted to the "
                     "active array" % (len(dp), PUBLISHED["dips_approx"]))
    if abs(got_med - PUBLISHED["dips_per_centromere"]) > 0.5:
        return _fail("median dips per centromere is %.1f, not the %d on record"
                     % (got_med, PUBLISHED["dips_per_centromere"]))

    # ---- the dispersion result, which is the section's evidence that dip position is a
    # stable property of a haplotype rather than noise. Computed by the recipe Methods M8b
    # prescribes - per (sample, haplotype, chromosome), then averaged over an individual's
    # two haplotypes - and compared with the published numbers WITHOUT being required to
    # equal them; see the header for why.
    disp = None
    if os.path.exists(PHENO):
        ph = pd.read_csv(PHENO, sep="\t")
        ph["sd"] = np.sqrt(pd.to_numeric(ph.cdr_pos_var, errors="coerce"))
        ph["off"] = pd.to_numeric(ph.cdr_pos_offset, errors="coerce")
        ind = ph.groupby(["chm13_chrom", "sample"]).agg(sd=("sd", "mean"),
                                                        off=("off", "mean"))
        sd_w = float(ind.sd.dropna().median())
        sd_a = float(ind.groupby("chm13_chrom").off.std(ddof=1).median())
        fold = sd_a / sd_w if sd_w else float("nan")
        i8 = ind.loc["chr8"] if "chr8" in ind.index.get_level_values(0) else None
        f8 = (float(i8.off.std(ddof=1) / i8.sd.median())
              if i8 is not None and i8.sd.median() else None)
        if not (FOLD_BAND[0] <= fold <= FOLD_BAND[1]):
            return _fail("dip position is %.1f times more variable between individuals than "
                         "within a haplotype, where res_08b_cdr.tex reports about %.1f. The "
                         "section's stability claim does not hold on these files."
                         % (fold, DISPERSION_PUBLISHED["fold"]))
        disp = dict(sd_within=round(sd_w, 4), sd_among=round(sd_a, 4),
                    fold=round(fold, 2), fold_chr8=round(f8, 2) if f8 else None,
                    published=DISPERSION_PUBLISHED, asserted=False,
                    why=("recorded, not asserted: no single recipe reproduces all four "
                         "published digits, and every recipe tried agrees to within 0.003"))

    # ---- ancestry labels, joined from the four staged cohort tables
    hp2 = pd.read_csv(HAPPHENO, sep="\t", usecols=["sample", "hap_local", "chm13_chrom"])
    # The union, not the dip table alone: a haplotype with no dips anywhere has no row in dp
    # but still counts in the denominators below, so it still needs a label.
    cohort = sorted(set(dp["sample"]) | set(hp2["sample"]))
    sup, basis, hand, panel_pop, why = resolve_ancestry(cohort)
    if sup is None:
        return _fail(why)

    dp = dp.copy()
    dp["pop"] = dp["sample"].map(sup).fillna(UNLABELLED)
    hp2["pop"] = hp2["sample"].map(sup).fillna(UNLABELLED)
    # UNLABELLED survives as a sentinel so the strata stay a partition whatever happens, but
    # after resolve_ancestry() nothing may reach it. Both tables are checked, not only the
    # one the resolver walked.
    orphan = sorted(set(dp.loc[dp["pop"] == UNLABELLED, "sample"])
                    | set(hp2.loc[hp2["pop"] == UNLABELLED, "sample"]))
    if orphan:
        return _fail("%d samples fell through the ancestry join into the unlabelled "
                     "sentinel: %s" % (len(orphan), ", ".join(orphan[:8])))

    # ---- the cross-check: dips are called FROM the profile, so density must track the
    # trough. Computed per chromosome and reported; a global failure is fatal.
    #
    # The per-stratum counts are built in the same pass and from the same histogram edges,
    # so the decomposition is exact by construction rather than by a second computation that
    # happens to agree. What is asserted below is that it stayed exact.
    prof, dens, corr = {}, {}, {}
    dens_anc, nhap_anc = {}, {}
    edges = np.linspace(-1.0, 1.0, NBIN + 1)
    for c in chroms:
        r = rel[rel.chrom == c].sort_values("bin")
        if not len(r):
            continue
        d = dp[dp.chm13_chrom == c]
        nhap = int(r.nhap.max())
        cnt, _ = np.histogram(d.pos_splice.values, bins=edges)
        # dips per haplotype per bin, so chromosomes with different cohort depth compare
        per = (cnt / nhap) if nhap else cnt.astype(float)
        m = r.meth_cw.values
        corr[c] = (round(float(np.corrcoef(m, per)[0, 1]), 3)
                   if m.std() > 0 and per.std() > 0 else None)
        prof[c] = [round(float(x), 3) for x in m]
        dens[c] = [round(float(x), 5) for x in per]

        # Haplotypes per stratum come from the per-haplotype phenotype table, not from the
        # dip table. A haplotype with zero dips on a chromosome has no row in the dip table
        # at all, so using that as the denominator would divide by the haplotypes that
        # happened to yield calls and report a rate that cannot go down.
        hc = hp2[hp2.chm13_chrom == c]
        nhap_anc[c] = {p: int(n) for p, n in
                       hc.groupby("pop")[["sample", "hap_local"]]
                         .apply(lambda g: len(set(map(tuple, g.values)))).items()}
        counts = {}
        for p in STRATA:
            v = d.loc[d["pop"] == p, "pos_splice"].values
            k, _ = np.histogram(v, bins=edges)
            if k.sum():
                counts[p] = [int(x) for x in k]
        dens_anc[c] = counts

        # (1) the strata partition the cohort
        if sum(nhap_anc[c].values()) != nhap:
            return _fail("on %s the per-stratum haplotype counts sum to %d, not the %d the "
                         "methylation profile averages. The ancestry join is not a partition "
                         "of this cohort." % (c, sum(nhap_anc[c].values()), nhap))
        # (2) the strata partition the dips, bin by bin
        stacked = np.zeros(NBIN, dtype=int)
        for v in counts.values():
            stacked += np.array(v, dtype=int)
        if not np.array_equal(stacked, cnt):
            # Bin by bin, not totals: a permuted join keeps the total exactly and moves dips
            # between bins, so reporting sums here would print "1344 vs 1344" on a real
            # failure and send the reader looking for a rounding error.
            off = int(np.abs(stacked - cnt).sum())
            return _fail("on %s the per-stratum dip counts do not rebuild the pooled "
                         "histogram: %d of %d bins differ, %d dips misplaced (totals %d vs "
                         "%d). A dip has been dropped, double counted, or moved by the "
                         "ancestry join."
                         % (c, int((stacked != cnt).sum()), NBIN, off,
                            int(stacked.sum()), int(cnt.sum())))
        # (3) and they rebuild the track that is actually shipped, after rounding
        if nhap:
            rebuilt = stacked / nhap
            off = float(np.abs(rebuilt - np.array(dens[c])).max())
            if off > 1e-5:
                return _fail("on %s the per-stratum tracks do not rebuild the pooled track "
                             "that is shipped (max bin error %.2e)" % (c, off))

    vals = [x for x in corr.values() if x is not None]
    med_corr = float(np.median(vals)) if vals else float("nan")
    if med_corr > -0.3:
        return _fail("dip density does not track the methylation trough (median r = %.2f "
                     "across chromosomes). Dips are called from this profile, so a "
                     "non-negative correlation means one of the two tracks is on the wrong "
                     "frame or reversed." % med_corr)

    # ---- per-chromosome frame stability, from the source's own audit
    flags = {}
    for c in chroms:
        if c not in fc.index:
            continue
        rr = [fc.loc[c, k] for k in
              ("r_span_vs_block", "r_span_vs_splice", "r_block_vs_splice")]
        rat = ref_ratio.get(c)
        flags[c] = dict(
            n_hap=int(fc.loc[c, "n_hap"]),
            pct_multiblock=round(float(fc.loc[c, "pct_multiblock"]), 2),
            min_r=round(float(min(rr)), 3),
            stable=bool(min(rr) >= FRAME_R_FLOOR),
            covered_frac=covered.get(c),
            ref_ratio=rat,
            ref_typical=(None if rat is None
                         else bool(REF_RATIO_BAND[0] <= rat <= REF_RATIO_BAND[1])),
            dips=int((dp.chm13_chrom == c).sum()),
            meth_lo=round(float(rel[rel.chrom == c].meth_cw.min()), 2),
            meth_hi=round(float(rel[rel.chrom == c].meth_cw.max()), 2),
            corr=corr.get(c),
        )

    unstable = sorted(c for c, f in flags.items() if not f["stable"])
    atypical = sorted(c for c, f in flags.items() if f.get("ref_typical") is False)
    out = dict(
        nbin=NBIN,
        frame="rel",
        atypical=atypical,
        ref_ratio_band=list(REF_RATIO_BAND),
        meth=prof,
        density=dens,
        # Raw dip COUNTS per stratum per bin, not a rate, and deliberately so. The browser
        # needs two different quantities from these - a rate (count / that stratum's
        # haplotypes) to compare shapes across strata of very different size, and a
        # contribution (count / all haplotypes) that stacks to the pooled track - and both
        # are exactly derivable from a count plus a denominator. Shipping either rate
        # instead would make the other unrecoverable and put a rounding error between the
        # per-stratum tracks and the pooled one they are supposed to decompose.
        density_anc=dens_anc,
        nhap_anc=nhap_anc,
        # The strata that actually carry something, not STRATA. STRATA is what the build
        # iterates and it still ends in the unlabelled sentinel, which after the join above
        # holds nothing; shipping it would put a stratum in the browser's data contract that
        # is on no chromosome, and the browser would then have to remember to filter it
        # everywhere. It did not remember once - the thin-stratum caption warned that
        # "unlabelled has fewer than 10 haplotypes" about a band that was not drawn.
        strata=[p for p in STRATA
                if any(p in n for n in nhap_anc.values())
                or any(p in d for d in dens_anc.values())],
        ancestry=dict(
            sources=[PANEL, PED, HPRC_R2, HPRC_Y1],
            joined_on="sample ID",
            n_samples=len(cohort),
            n_from_panel=sum(1 for s in cohort if s in panel_pop),
            unlabelled=[],
            n_unlabelled=0,
            # The samples the 1kGP grouping cannot reach. Named, not counted, because the
            # caption has to be able to say which two they are and on whose authority: for
            # these the superpopulation is a borrowed continental grouping rather than a
            # 1000 Genomes assignment, and that is a caveat about two named individuals, not
            # a rate the reader can discount.
            outside_1kgp=[dict(sample=s, superpop=sup[s], basis=basis[s]) for s in hand],
            why=("no table in this project carries an ancestry column for the assembly "
                 "cohort, so ancestry is joined by sample ID from four staged tables: the "
                 "1000 Genomes 3,202-sample panel, the 1000 Genomes 3,501-sample pedigree, "
                 "and the HPRC release-2 and year-1 sample metadata. The panel alone covers "
                 "%d of %d; it is a call set rather than the collection, so the rest are "
                 "resolved from the other three, which agree with it on every sample they "
                 "share. Superpopulation comes from the panel's own population pairs. %d "
                 "samples were never 1000 Genomes participants and are assigned by hand "
                 "from their collection's documentation."
                 % (sum(1 for s in cohort if s in panel_pop), len(cohort), len(hand))),
        ),
        chrom=flags,
        dispersion=disp,
        published=PUBLISHED,
        n_dips=int(len(dp)),
        n_haplotype_chrom=int(dp.groupby(["sample", "hap_local", "chm13_chrom"]).ngroups),
        median_dips_per_centromere=got_med,
        median_corr=round(med_corr, 3),
        unstable=unstable,
        frame_r_floor=FRAME_R_FLOOR,
        meth_range=[round(float(rel.meth_cw.min()), 2), round(float(rel.meth_cw.max()), 2)],
        source=ROOT,
        note=(
            "Both tracks are computed on the array's covered-base frame - the fraction of "
            "covered active-array bases before a point, averaged over the haplotypes with "
            "methylation data - and are placed on the chart's CHM13 axis by walking the "
            "reference's own active blocks to the same covered fraction. That mapping is "
            "exact, and every catalogued SV sits inside a block, so no SV loses a position "
            "to it. What it cannot remove is that the tracks average over haplotypes whose "
            "arrays differ in length while CHM13 is one particular haplotype; `ref_ratio` "
            "gives the reference's covered length over the cohort median for each "
            "chromosome."),
    )

    note = ("%d bins x %d chromosomes of coverage-weighted 5mC over %d-%d haplotypes, and "
            "%d dips; median dips per centromere %.1f; dip position %s more variable between "
            "individuals than within a haplotype; dip density tracks the methylation trough "
            "at median r = %.2f; %d chromosome(s) flagged for an unstable positional frame "
            "and %d where CHM13 is an atypical haplotype (%s)"
            % (NBIN, len(prof), min(f["n_hap"] for f in flags.values()),
               max(f["n_hap"] for f in flags.values()), len(dp), got_med,
               ("%.1fx" % disp["fold"]) if disp else "(not computed)",
               med_corr, len(unstable), len(atypical), ", ".join(atypical) or "none"))
    tot = {p: sum(n.get(p, 0) for n in nhap_anc.values()) for p in STRATA}
    note += ("; decomposed into %d ancestry strata that partition the cohort exactly on "
             "every chromosome (haplotype-chromosomes: %s)"
             % (len([p for p in STRATA if tot.get(p)]),
                ", ".join("%s %d" % (p, tot[p]) for p in STRATA if tot.get(p))))
    return out, note
