#!/usr/bin/env python3
"""Pericentromeric linkage disequilibrium, shipped as genotypes rather than as correlations.

WHAT THIS SHIPS
---------------
For every chromosome: the genotypes of every SV in this browser's catalog and of every
biallelic 1000 Genomes SNP at MAF >= 1% in a 100 kb window outside each GRCh38 centromere
edge, on the individuals the assembly and 1000G cohorts share, 2-bit packed. The browser
computes r for whatever is on screen.

TWO ASSEMBLIES, AND WHY THE WINDOW IS ANCHORED IN THE SECOND
------------------------------------------------------------
SV coordinates are CHM13 v2.0. SNP coordinates are GRCh38, because that is what the 1000
Genomes panel is called against. A window is only meaningful in the assembly it is queried in,
and until 2026-08-29 this substrate's was not: the extractor took the 100 kb before the CHM13
CenSat active-HOR start and queried the GRCh38 VCF at those coordinates without converting
them. The CHM13 start sits a median 1.04 Mb inside the GRCh38 centromere - up to 6.01 Mb on
chr14, and inside on 19 of 23 chromosomes - so the window landed in sequence the panel largely
cannot call. Six chromosomes returned no SNP at all and 34% of the calls elsewhere were open.

Anchored on the GRCh38 edges instead, as the manuscript's own LD figure is, every chromosome
carries both flanks and the open-call fraction falls to 7%. The re-anchoring the source
pipeline performs where a flank is uncallable is reproduced too, and lands chr1's right window
15.08 Mb distal - the same 15.1 Mb the Methods states.

WHY NOT SHIP THE CORRELATIONS, WHICH ALREADY EXIST
--------------------------------------------------
Because they are selected three times over. The reference panels plot
`sv_category == "original_decomposed"` only, then the top 160 SNPs and 80 SVs by MAF. This
catalog is all four decomposition modes, and four fifths of the SVs the browser marks are
absent from that selection. Shipping correlations would mean choosing a cap, and every cap is
a selection made on the reader's behalf; the unselected substrate costs about what the
selected matrices cost. How much to DRAW becomes a display choice, and the published view
stays reproducible from this same data by applying the published selection as a preset -
which is asserted below, not assumed.

WHAT THE PANEL IS NOT
---------------------
It is not on a single linear abscissa. A triangle's columns are one per variant in position
order within its own block, so the width a region gets follows how many variants it holds.
The browser draws a rank axis and fans each landmark column down to its own assembly's
coordinate.
"""
import base64
import json
import os

import numpy as np
import pandas as pd

SRC = ("/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere/discovery/"
       "2026-05-19_ld_plot_all_chr/output/_censv_frames")
# the reference panels, used only to assert that this substrate reproduces them. One per
# flank, rendered by plot_sv_ld_pubfig.py on the same windows the frames use.
PUB = ("/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere/discovery/"
       "2026-05-19_ld_plot_all_chr/output/_ld_reference_g38")
# the source's own bcftools filter; below it r between two columns turns on whether a handful
# of carriers happen to coincide
MIN_MAF_SNP = 0.01
# r is estimable but thin below this; the browser marks these columns rather than dropping them
THIN_MAF = 0.05
# the published selection, reproduced as a preset and asserted below
PUB_SNP_CAP, PUB_SV_CAP = 160, 80
MAX_REPRO_ERR = 1e-6
# `impute` is not shipped: every consumer recomputes it as the mean of the row's observed
# calls. This asserts the SOURCE column against that mean, both at full precision, and the
# current data agrees to 8.9e-16 - they are the same computation, not merely close. (The
# 5.0e-10 in FINDINGS is a different comparison: the value as it used to SHIP, rounded to
# nine decimals, against the same mean.) Three orders over what is observed, to leave room
# for a numpy or BLAS difference in summation order, and four orders tighter than a
# substitution taken over a different cohort or by a different estimator would be.
MAX_IMPUTE_ERR = 1e-12
SIDES = ("L", "R")


def _fail(msg):
    return None, msg


def _deltas(pos):
    """[p0, p1 - p0, p2 - p1, ...] - the first absolute, the rest differences."""
    return [pos[0]] + [pos[i] - pos[i - 1] for i in range(1, len(pos))] if pos else []


def _pack(a):
    """Genotype STATES - 0, 1, 2, or 3 for an open call - two bits each, row-major."""
    if a.dtype.kind == "f":
        raise ValueError("_pack takes genotype states; a float array here is the dosage "
                         "matrix, whose imputed cells would be truncated to whole numbers")
    bits = np.unpackbits(a.astype(np.uint8).reshape(-1, 1), axis=1, count=2,
                         bitorder="little").reshape(-1)
    return base64.b64encode(np.packbits(bits).tobytes()).decode("ascii")


def _unpack(b64, nrow, m):
    """The inverse, written the way web/src/ld.js writes it rather than as numpy's inverse.

    The packer wrote each state least-significant-bit first into a stream that packbits then
    filled most-significant-bit first, so the low bit arrives first and the value is
    b0 + 2 * b1. Anything that disagrees with this is a browser reading different numbers
    from the ones this build checked.
    """
    raw = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
    bits = np.unpackbits(raw)[:nrow * m * 2].reshape(-1, 2)
    return (bits[:, 0] + 2 * bits[:, 1]).reshape(nrow, m)


def _r(x):
    x = np.asarray(x, dtype=np.float64)
    sd = x.std(axis=1, keepdims=True)
    sd[sd == 0] = 1.0
    z = (x - x.mean(axis=1, keepdims=True)) / sd
    return np.clip((z @ z.T) / x.shape[1], -1.0, 1.0)


def load(root, chrom_index, catalog):
    """Return (ld dict, note) or (None, why)."""
    if not os.path.isdir(SRC):
        return _fail("CenSV LD frames not found: %s. Run "
                     "discovery/2026-05-19_ld_plot_all_chr/code/submit_extract_censv.sh"
                     % SRC)
    known = {c["chrom"] for c in chrom_index}

    out = {}
    cohort, per_chrom_names = set(), {}
    n_repro = n_repro_cells = n_sv_tot = n_snp_tot = n_thin_tot = n_imputed_tot = 0
    worst_impute = 0.0
    n_reanchored = 0
    for chrom in sorted(known, key=lambda c: (len(c), c)):
        d = os.path.join(SRC, chrom)
        if not os.path.isdir(d):
            return _fail("%s has no extracted frame under %s" % (chrom, SRC))
        s = json.load(open(os.path.join(d, "summary.json")))
        if s.get("snp_assembly") != "GRCh38" or s.get("sv_assembly") != "CHM13v2.0":
            return _fail("%s: the frame records assemblies %s/%s, so it predates the "
                         "GRCh38-anchored windows and its SNP block is measured somewhere "
                         "this build cannot describe. Re-run "
                         "code/launchers/submit_extract_censv.sh."
                         % (chrom, s.get("sv_assembly"), s.get("snp_assembly")))
        g = np.load(os.path.join(d, "genotypes.npz"))
        sv = pd.read_csv(os.path.join(d, "sv_variants.tsv"), sep="\t")
        snp = (pd.read_csv(os.path.join(d, "snp_variants.tsv"), sep="\t")
               if os.path.exists(os.path.join(d, "snp_variants.tsv"))
               else pd.DataFrame(columns=["pos", "end", "af", "maf", "side", "impute",
                                          "n_missing"]))
        gsv, gsnp = g["sv"], g["snp"]

        # ---- who the columns are
        #
        # The block ships one column per individual and, until now, no way to say which. Any
        # per-individual view has to join on a name, and a position will not do: chr13 carries
        # 182 of these 188 people, so reading column k of chr13 as the same person as column k
        # of chr12 moves six individuals' genotypes onto their neighbours from chr13 onward.
        names = s.get("samples")
        if not names:
            return _fail("%s: the frame's summary.json carries no sample list, so its "
                         "genotype columns cannot be named" % chrom)
        if len(names) != gsv.shape[1]:
            return _fail("%s: %d sample names against %d genotype columns, so a per-individual "
                         "view would read one person's dosage under another's name"
                         % (chrom, len(names), gsv.shape[1]))
        if len(set(names)) != len(names):
            return _fail("%s: the frame names one individual twice" % chrom)
        cohort.update(names)
        per_chrom_names[chrom] = list(names)

        if gsv.shape[0] != len(sv) or gsnp.shape[0] != len(snp):
            return _fail("%s: %d/%d genotype rows against %d/%d variant rows"
                         % (chrom, gsv.shape[0], gsnp.shape[0], len(sv), len(snp)))
        if gsnp.shape[0] and gsnp.shape[1] != gsv.shape[1]:
            return _fail("%s: the SNP block has %d individuals and the SV block %d, so r "
                         "between them would be computed across different people"
                         % (chrom, gsnp.shape[1], gsv.shape[1]))

        # ---- the fourth state
        #
        # The source's SNP loader replaces a missing call with its variant's mean dosage, and
        # the reference panels correlate the matrix that substitution produces. The frames
        # mark those cells with dosage 3 and carry the substituted value beside them, so the
        # reference matrix is recoverable exactly; an earlier extractor rounded the imputed
        # cells to integers instead, which moved 25,080 of chr8's 25,600 SNP-SNP correlations
        # by up to 0.37 while every assertion here still passed.
        if len(snp) and "impute" not in snp.columns:
            return _fail("%s: the SNP frame carries no imputed values, so it predates the "
                         "fourth genotype state and its correlations would be the rounded "
                         "ones. Re-run code/launchers/submit_extract_censv.sh." % chrom)
        bad = set(np.unique(gsv).tolist()) - {0, 1, 2}
        if bad:
            return _fail("%s: SV genotypes carry %s, and an imputed SV dosage has no meaning "
                         "here - the SV panel is complete by construction"
                         % (chrom, sorted(bad)))
        if gsnp.shape[0]:
            bad = set(np.unique(gsnp).tolist()) - {0, 1, 2, 3}
            if bad:
                return _fail("%s: SNP genotypes carry %s, beyond the four states two bits hold"
                             % (chrom, sorted(bad)))
            n_miss_row = (gsnp == 3).sum(axis=1)
            if not np.array_equal(n_miss_row, snp.n_missing.to_numpy(int)):
                off = int((n_miss_row != snp.n_missing.to_numpy(int)).sum())
                return _fail("%s: the genotype matrix marks a different set of calls missing "
                             "from the one the variants table counts, on %d of %d rows"
                             % (chrom, off, len(snp)))
            imp = snp.impute.to_numpy(float)
            # The column does not ship. Every consumer - standardise() in the browser, and
            # dosages() in verify_shipped_data.py - recomputes it as the mean of the row's
            # observed calls, so the identity is asserted here, against the values the source
            # supplies, immediately before it stops being written. An upstream loader that
            # changes its substitution rule turns this red rather than leaving the browser to
            # correlate a different matrix in silence.
            seen = (gsnp != 3).sum(axis=1)
            if (seen == 0).any():
                return _fail("%s: %d SNP rows carry no observed call, so the substituted "
                             "dosage cannot be recomputed from the genotypes that ship"
                             % (chrom, int((seen == 0).sum())))
            derived = np.where(gsnp == 3, 0.0, gsnp.astype(float)).sum(axis=1) / seen
            dev = float(np.abs(derived - imp).max())
            if dev > MAX_IMPUTE_ERR:
                return _fail("%s: the substituted dosage is not the mean of the row's "
                             "observed calls - worst deviation %.3e over %d rows, above the "
                             "%.0e this build allows" % (chrom, dev, len(imp),
                                                         MAX_IMPUTE_ERR))
            snpd = np.where(gsnp == 3, imp[:, None], gsnp.astype(float))
            n_imputed = int(n_miss_row.sum())
        else:
            imp = np.zeros(0)
            snpd = gsnp.astype(float)
            n_imputed = 0
        # Two matrices, deliberately. `packed` is what ships - states, with 3 for an open
        # call. `both` is what every check and every correlation below runs on - dosages,
        # with the substituted value in place, which is what the reference panels correlate.
        # The round-trip assertion further down is what keeps the two from drifting apart.
        packed = np.concatenate([gsv, gsnp]) if gsnp.shape[0] else gsv
        both = np.concatenate([gsv.astype(float), snpd]) if gsnp.shape[0] else gsv.astype(float)

        dosages = both
        if (dosages.std(axis=1) == 0).any():
            return _fail("%s: %d rows are monomorphic, so their r is undefined and the panel "
                         "would draw an empty column"
                         % (chrom, int((dosages.std(axis=1) == 0).sum())))

        # ---- the blocks, and their order
        #
        # A SNP position is GRCh38 and an SV position is CHM13 v2.0, so the three blocks are
        # ordered by BLOCK and then by position inside it. Sorting the whole table by position
        # would be a comparison between two assemblies, and on a chromosome whose right flank
        # is re-anchored megabases out it would interleave the SNPs with the array.
        flanks = s.get("flanks") or {}
        side_col = (snp.side.to_numpy() if "side" in snp.columns
                    else np.array([], dtype=object))
        for side in SIDES:
            want = int((flanks.get(side) or {}).get("n_snp") or 0)
            got = int((side_col == side).sum())
            if want != got:
                return _fail("%s: the %s flank holds %d SNPs and its summary records %d"
                             % (chrom, side, got, want))
            blk = snp[snp.side == side] if got else snp.iloc[:0]
            if len(blk) > 1 and not blk.pos.is_monotonic_increasing:
                return _fail("%s: the %s SNP block is out of position order, so every column "
                             "of the drawn triangle would sit at the wrong place"
                             % (chrom, side))
            if (flanks.get(side) or {}).get("gap_bp", 0) > 10_000:
                n_reanchored += 1
        if len(sv) > 1 and not sv.pos.is_monotonic_increasing:
            return _fail("%s: the SV block is out of position order, so every column of the "
                         "drawn triangle would sit at the wrong place" % chrom)
        if len(snp) and float(snp.maf.min()) < MIN_MAF_SNP:
            return _fail("%s: a SNP at MAF %.4f is below the %.2f the source filters at"
                         % (chrom, snp.maf.min(), MIN_MAF_SNP))
        if not len(snp):
            return _fail("%s carries no SNP block at all. Anchored on the GRCh38 centromere "
                         "edges every chromosome has one, so an empty block here means the "
                         "extraction found no callable sequence within %d Mb and the caption "
                         "has no way to say why." % (chrom, 30))

        # Every catalog SV must be here - that is the whole reason for this substrate - and
        # the only permitted absences are the ones the extractor recorded as unresolvable.
        missing = sorted(set(catalog.loc[catalog.chrom == chrom].sv_id) - set(sv.sv_id))
        if len(missing) != int(s.get("n_unresolved", 0)):
            return _fail("%s: %d catalog SVs are absent from the frame but the extractor "
                         "recorded %d as unresolvable: %s"
                         % (chrom, len(missing), int(s.get("n_unresolved", 0)),
                            missing[:5]))

        # ---- and it must reproduce the reference panel where the two overlap, on EVERY
        # column they share. Comparing the SV block alone left the larger half of each figure
        # unchecked, and that is exactly where the extraction had drifted.
        ours = {}
        for r in sv.reset_index().itertuples():
            ours.setdefault(("sv", int(r.pos), int(r.end), r.svtype,
                             round(float(r.af), 6)), int(r.index))
        for i, p in enumerate(snp.pos.to_numpy(int)):
            ours.setdefault(("snp", int(p)), len(sv) + i)

        def key_of(r):
            if r.source == "peri_snp":
                return ("snp", int(r.pos))
            return ("sv", int(r.pos), int(r.end), r.svtype, round(float(r.af), 6))

        for side in SIDES:
            pd_dir = os.path.join(PUB, chrom, side)
            if not os.path.isdir(pd_dir):
                continue
            pv = [f for f in os.listdir(pd_dir) if f.endswith("_variants.tsv")]
            pr = [f for f in os.listdir(pd_dir) if f.endswith("_r.tsv.gz")]
            if not (pv and pr):
                continue
            P = pd.read_csv(os.path.join(pd_dir, sorted(pr)[0]), sep="\t",
                            index_col=0).to_numpy(float)
            pvar = pd.read_csv(os.path.join(pd_dir, sorted(pv)[0]), sep="\t")
            pairs = [(int(r.Index), ours[k]) for r in pvar.itertuples()
                     for k in [key_of(r)] if k in ours]
            if len(pairs) < 3:
                continue
            pi = [a for a, _ in pairs]
            oi = [b for _, b in pairs]
            err = float(np.nanmax(np.abs(_r(both[oi]) - P[np.ix_(pi, pi)])))
            if err > MAX_REPRO_ERR:
                return _fail("%s %s: r recomputed from the extracted genotypes differs from "
                             "the reference panel by %.2e on the %d variants they share. The "
                             "extraction is no longer the same measurement."
                             % (chrom, side, err, len(pairs)))
            n_repro += len(pairs)
            n_repro_cells += len(pairs) * (len(pairs) + 1) // 2

        # ---- the bytes that ship, decoded back
        #
        # Everything above checks the matrix this loader built. This checks the payload, and
        # the two are not the same object: `_pack` was once handed the dosage matrix and
        # truncated every imputed cell to zero, which no assertion above could see because
        # each of them was reading the floats.
        gt = _pack(packed)
        imp_ship = np.round(imp, 9)
        back = _unpack(gt, packed.shape[0], packed.shape[1])
        rt = np.concatenate([
            back[:len(sv)].astype(float),
            np.where(back[len(sv):] == 3, imp_ship[:, None], back[len(sv):].astype(float))
            if len(snp) else np.zeros((0, packed.shape[1]))])
        off = float(np.abs(rt - both).max())
        if off > 1e-8:
            return _fail("%s: the packed payload decodes to dosages up to %.2e away from the "
                         "matrix these checks ran on, so the browser would read numbers this "
                         "build never verified" % (chrom, off))

        n_imputed_tot += n_imputed
        worst_impute = max(worst_impute, dev if len(snp) else 0.0)
        thin = (sv.maf < THIN_MAF).astype(int).tolist()
        n_thin_tot += sum(thin) + int((snp.maf < THIN_MAF).sum() if len(snp) else 0)
        n_sv_tot += len(sv)
        n_snp_tot += len(snp)
        out[chrom] = dict(
            n_samples=int(gsv.shape[1]),
            n_sv=int(len(sv)), n_snp=int(len(snp)),
            # No `marked` and no `category`. Both were read out of this frame by nothing:
            # the record panel and the search facets take sv_category from the CATALOG, and
            # the evidence ticks on the column strip come from evidenceOf(), which joins
            # sv_id against the catalog as well.
            sv=dict(pos=[int(x) for x in sv.pos], end=[int(x) for x in sv.end],
                    svtype=list(sv.svtype), maf=[round(float(x), 4) for x in sv.maf],
                    sv_id=list(sv.sv_id),
                    thin=thin),
            # No `impute`. The dosage substituted for an open call is the mean of that
            # row's observed calls, which the shipped matrix already carries, so the browser
            # recomputes it in standardise(). Asserted above to 1e-8 before it is dropped.
            # `missing` stays: it is the census the caption reports, and it is what the
            # round-trip check compares the matrix against.
            # Positions as DELTAS over this order, the first absolute and the rest
            # differences. Consecutive pericentromeric SNPs are a few hundred bases apart, so
            # a difference is two or three digits where an absolute is eight. ld.js rebuilds
            # them once per frame. verify_ld_decode.mjs keys every published column on its
            # position, so a reconstruction off by one base matches nothing.
            snp=dict(pos=_deltas([int(x) for x in snp.pos]),
                     maf=[round(float(x), 4) for x in snp.maf],
                     thin=[int(x) for x in (snp.maf < THIN_MAF)],
                     side=list(snp.side),
                     missing=[int(x) for x in snp.n_missing]) if len(snp) else None,
            # SV rows then SNP rows (L then R), each n_samples wide, two bits per state
            gt=gt,
            active_start=s.get("active_start"), active_end=s.get("active_end"),
            grch38_centromere=s.get("grch38_centromere"),
            flanks=flanks,
            n_unresolved=int(s.get("n_unresolved", 0)),
            n_snp_missing=n_imputed,
        )

    if not out:
        return _fail("no chromosome produced an LD frame")

    # One cohort order, and every frame's columns as indices into it. The indirection is what
    # makes the chr13 gap explicit: a frame narrower than the cohort resolves to a shorter
    # `cols`, and the browser reads the difference as an individual with no assembly there.
    cohort = sorted(cohort)
    at = {n: i for i, n in enumerate(cohort)}
    for chrom, names in per_chrom_names.items():
        out[chrom]["cols"] = [at[n] for n in names]
    if max(len(v) for v in per_chrom_names.values()) != len(cohort):
        return _fail("the widest frame holds %d individuals against a cohort of %d, so some "
                     "individual appears on no chromosome at full width"
                     % (max(len(v) for v in per_chrom_names.values()), len(cohort)))
    partial = {c: len(v) for c, v in sorted(per_chrom_names.items())
               if len(v) != len(cohort)}
    absent = sorted(set(cohort) - set(per_chrom_names[min(partial, key=partial.get)])) \
        if partial else []
    note = ("%d individuals over %d chromosomes; %s catalog SVs and %s pericentromeric SNPs on both GRCh38 "
            "centromere flanks, the complete substrate; %s columns below MAF %.2f "
            "are marked thin; %s of %s SNP calls were open and carry their variant's mean "
            "dosage, recomputed here and agreeing with the source to %.1e; "
            "%d flanks re-anchored outward past a callability gap; r recomputed from "
            "these genotypes reproduces the reference panels on %s shared variants and %s "
            "cells, SNP and cross blocks included, to better than %.0e"
            % (len(cohort), len(out), format(n_sv_tot, ","), format(n_snp_tot, ","),
               format(n_thin_tot, ","), THIN_MAF, format(n_imputed_tot, ","),
               format(sum(v["n_snp"] * v["n_samples"] for v in out.values()), ","),
               worst_impute, n_reanchored, format(n_repro, ","), format(n_repro_cells, ","),
               MAX_REPRO_ERR))
    return dict(chrom=out, samples=cohort, partial=partial, absent=absent,
                statistic="pearson_r", bits=2, source=SRC,
                min_maf_snp=MIN_MAF_SNP, thin_maf=THIN_MAF,
                sv_assembly="CHM13 v2.0", snp_assembly="GRCh38",
                published_preset=dict(snp=PUB_SNP_CAP, sv=PUB_SV_CAP,
                                      category="original_decomposed"),
                note=("Genotypes, not correlations: every catalog SV and every 1000 Genomes "
                      "SNP at MAF >= 1% in the 100 kb window outside each GRCh38 centromere "
                      "edge, on the individuals the two cohorts share. The browser computes "
                      "Pearson r for what is on screen, so nothing is selected on its "
                      "behalf. A SNP call the source could not make carries that variant's "
                      "mean dosage, which is the substitution the reference panels "
                      "correlate. SV positions are CHM13 v2.0 and SNP positions GRCh38; the "
                      "columns are one per variant in position order WITHIN a block, and "
                      "the browser draws each block on its own axis. `samples` names the "
                      "cohort once and each frame's `cols` indexes into it, so a per-individual "
                      "view joins on a name and a frame narrower than the cohort reads as an "
                      "individual with no assembly on that centromere.")), note
