#!/usr/bin/env python3
"""R8 layer: methylation QTL, from the read-genotyped MAC8/PC10 scan.

WHAT REPLACED WHAT. res_08_mqtl.tex was rewritten on 2026-09-02 (commit 531f0232, "Clean
slate: the section now describes one scan and never references the layer it replaces"). The
layer this file replaces drew the SUPERSEDED imputed-dosage scan: seven rows over five SVs,
a chr12 lead that appears nowhere in the current scan, and a chr3 -> chr17 trans pair
annotated with VMP1/MIR21/TUBD1. The manuscript's own figure script records that that pair
"has zero rows in every MAC8 trans output", and the rewritten section carries no gene symbols
at all - its checker fails on them. The browser was the only place still publishing it.

That went unnoticed because the old assertions compared this ETL against the OLD upstream
tree, which is still on disk, so they passed throughout. An assertion that can only confirm
agreement with what you are replacing is not a check. The ones below are written against the
scan the section now describes, and the trans guard FAILS on the version being replaced.

WHAT IS DRAWN. Every same-chromosome association at global pair-level BH q < 0.01 - the
section's one significance band, so every row is tier "primary". There is no second band to
tier against, and distance is carried as scope and as a printed number instead: a pair 107 Mb
from its CpG passed the same test as one 766 bp away, and the honest way to separate them is
to print the distance, not to demote one into a band the section never states.

The scan's own stricter calibration travels with each row. met_08_mqtl.tex states it - 10,000
Mammen score-multiplier replicates giving a maximum-statistic reference - and Figure 4a marks
the CpG that clears it, so this discloses a published quantity rather than adding a new one.
"""
import csv
import gzip
import os

import pandas as pd

ROOT = "/beegfs/labs/weinstocklab/projects/centromere_analysis/exploration/meQTL/results"
SCAN = ROOT + "/meqtl_cis/chm13_observed_sv_robust_mac8_pc10/summary"
REL = SCAN + "/association_results.tsv.gz"      # what build_data.py tests for existence

QCUT = 0.01
NEAR = 5_000_000        # the window every direction claim in the section is computed in
MAXT = 0.05

# Every number here is printed in res_08_mqtl.tex or met_08_mqtl.tex and was reproduced from
# this file before it was written down. If the upstream scan is refreshed and any of them
# moves, the build stops rather than shipping a browser that disagrees with the section.
PUBLISHED = dict(
    n_tested=68,            # "68 SVs on 19 autosomes were retained"
    n_tested_chroms=19,
    n_tested_del=37,        # "including 37 deletions and 31 insertions"
    n_tested_ins=31,
    n_pairs=418,            # "we identified 418 same-chromosome SV--CpG associations"
    n_svs=42,               # "involving 42 SVs and 376 CpGs"
    n_cpgs=376,
    n_near=360,             # "Of the 418 associated pairs, 360 lay within 5 Mb"
    del_near=296,           # "increasing deletion dosage was associated with lower
    del_near_neg=288,       #  methylation in 97.3% of cases" -> 288/296
    del_loci=20,            # "including 18 of 20 deletion loci"
    del_loci_neg=18,
    n_maxt=2,               # rows clearing the global maxT at 0.05: one deletion, two
)                           # coordinates 9 bp apart that share a catalogue identity


def _read(path):
    with gzip.open(path, "rt") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def load(root, strict=True, catalog=None):
    """Return (long-form hits, note). One row per (catalogue SV, CpG)."""
    if not os.path.exists(REL):
        return None, "MAC8/PC10 scan not found: %s" % REL
    if catalog is None:
        return None, "the methylation layer needs the catalog to resolve SV coordinates"

    rows = _read(REL)

    # The file holds same-chromosome tests only. Asserted rather than assumed, because the
    # coverage line below states a count of zero for SVs with no hit, and that statement is
    # false if off-chromosome rows live here and were never counted.
    cross = [r for r in rows if r["sv_chrom"] != r["methyl_chrom"]]
    if cross:
        return None, ("%d off-chromosome rows in a scan this layer treats as "
                      "same-chromosome" % len(cross))

    tested = {r["sv_id"]: r for r in rows}
    got = dict(
        n_tested=len(tested),
        n_tested_chroms=len({r["sv_chrom"] for r in rows}),
        n_tested_del=len({s for s, r in tested.items() if "DEL" in r["svtype"]}),
        n_tested_ins=len({s for s, r in tested.items() if "DEL" not in r["svtype"]}),
    )

    hits = [r for r in rows if float(r["rint_hc3_bh_q_primary_t"]) < QCUT]
    got["n_pairs"] = len(hits)
    got["n_svs"] = len({r["sv_id"] for r in hits})
    got["n_cpgs"] = len({r["feature_id"] for r in hits})

    def dist(r):
        return abs(int(r["methyl_start"]) - int(r["sv_pos"]))

    near = [r for r in hits if dist(r) <= NEAR]
    got["n_near"] = len(near)

    dn = [r for r in near if "DEL" in r["svtype"]]
    got["del_near"] = len(dn)
    got["del_near_neg"] = sum(1 for r in dn if float(r["raw_beta"]) < 0)

    # Deletion loci whose within-5 Mb associations are predominantly negative. Recomputed,
    # never copied: the section states 18 of 20 and this is where that comes from.
    byloc = {}
    for r in dn:
        a, b = byloc.setdefault(r["sv_id"], [0, 0])
        byloc[r["sv_id"]] = [a + 1, b + (1 if float(r["raw_beta"]) < 0 else 0)]
    got["del_loci"] = len(byloc)
    got["del_loci_neg"] = sum(1 for n, k in byloc.values() if k > n / 2.0)

    got["n_maxt"] = sum(1 for r in hits
                        if float(r["global_primary_mammen_maxT_p"]) <= MAXT)

    if got != PUBLISHED:
        diff = {k: (got[k], PUBLISHED[k]) for k in PUBLISHED if got[k] != PUBLISHED[k]}
        msg = ("R8 counts do not reproduce res_08_mqtl.tex; (got, published) = %s" % diff)
        if strict:
            raise SystemExit("ERROR: " + msg)
        return None, msg

    # --- resolve each scan coordinate to catalogue entries ------------------------------
    # The scan's own sv_index is a per-job index that repeats across chromosomes, so the
    # join goes through CHM13 position and SV type. A coordinate resolved under more than
    # one mode matches two or three catalogue rows, and each is its own predictor here, so
    # the association attaches to each.
    cat = catalog[["chrom", "sv_index", "pos", "svtype"]].copy()
    cat["sv_index"] = cat.sv_index.astype(int)
    cat["pos"] = cat.pos.astype(int)
    by_chrom = {c: g for c, g in cat.groupby("chrom")}

    def entries(chrom, pos, svt):
        g = by_chrom.get(chrom)
        if g is None:
            return []
        m = g[((g.pos - pos).abs() <= 10)
              & g.svtype.astype(str).str.startswith(svt)]
        return sorted(int(x) for x in m.sv_index)

    resolved, unmatched = {}, []
    for sid, r in tested.items():
        svt = "DEL" if "DEL" in r["svtype"] else "INS"
        idx = entries(r["sv_chrom"], int(r["sv_pos"]), svt)
        if not idx:
            unmatched.append(sid)
        resolved[sid] = idx
    if unmatched:
        return None, ("%d scan SVs match no catalogue row: %s"
                      % (len(unmatched), unmatched[:4]))

    recs = []
    for r in hits:
        d = dist(r)
        cpg = "%s:%s" % (r["methyl_chrom"], "{:,}".format(int(r["methyl_start"])))
        span = ("%d bp" % d if d < 1000 else "%.1f kb" % (d / 1e3) if d < 1e6
                else "%.0f Mb" % (d / 1e6))
        mx = float(r["global_primary_mammen_maxT_p"])
        for ix in resolved[r["sv_id"]]:
            recs.append(dict(
                layer="mqtl",
                tier="primary",          # the section states one band
                scope="within 5 Mb" if d <= NEAR else "same chromosome",
                chrom=r["sv_chrom"],
                _cpg_chrom=r["methyl_chrom"],
                sv_index=ix,
                target="%s · %s away" % (cpg, span),
                qval=float(r["rint_hc3_bh_q_primary_t"]),
                pval=float(r["rint_hc3_p_t"]),
                beta=float(r["raw_beta"]),
                n=int(r["n_samples_analyzed"]),
                carriers=int(r["n_carriers_analyzed"]),
                distance=d,
                maxt=mx,
                detail=("%s of the scan's %s individuals carry this SV. Whole-scan "
                        "maximum-statistic p = %.3g, from 10,000 Mammen score-multiplier "
                        "replicates."
                        % (r["n_carriers_analyzed"], r["n_samples_analyzed"], mx)),
            ))

    out = pd.DataFrame(recs)

    # Guards that FAIL on the layer being replaced, which is the point of writing them.
    off = out[out.chrom != out._cpg_chrom]
    if len(off):
        return None, ("%d emitted rows put the CpG on a different chromosome from its SV"
                      % len(off))
    out = out.drop(columns=["_cpg_chrom"])
    if len(out) < PUBLISHED["n_pairs"]:
        return None, ("%d emitted rows for %d associations; a coordinate resolved to "
                      "nothing" % (len(out), PUBLISHED["n_pairs"]))
    if out.qval.max() >= QCUT or out.qval.max() < 0.009:
        return None, ("emitted q values top out at %.4g, so the admission filter is "
                      "absent or misapplied" % out.qval.max())

    n_entries = len(set(zip(out.chrom, out.sv_index)))
    pct = 100.0 * PUBLISHED["del_near_neg"] / PUBLISHED["del_near"]
    note = ("%d same-chromosome CpG associations at q < %.2f over %d SVs and %d CpGs, drawn "
            "on %d catalogue entries; %d lie within 5 Mb, where deletion dosage marks lower "
            "methylation at %d of %d CpGs (%.1f%%) across %d of %d deletion loci. %d SVs "
            "entered the scan. One deletion clears the whole-scan maximum-statistic "
            "calibration at %.2f."
            % (PUBLISHED["n_pairs"], QCUT, PUBLISHED["n_svs"], PUBLISHED["n_cpgs"],
               n_entries, PUBLISHED["n_near"], PUBLISHED["del_near_neg"],
               PUBLISHED["del_near"], pct, PUBLISHED["del_loci_neg"],
               PUBLISHED["del_loci"], PUBLISHED["n_tested"], MAXT))
    return out, note


def coverage(root, catalog):
    """Return (frame, note): every SV the scan tested, and how many CpGs it reached.

    A record panel with no methylation block cannot tell a reader whether the SV came back
    clean or never entered the scan. This is the difference, attached to the SV the way F_ST
    is - a property of the variant rather than evidence about it, so it stays out of the hit
    table and out of the converging-analyses count.
    """
    if not os.path.exists(REL):
        return None, "MAC8/PC10 scan not found"
    rows = _read(REL)
    hit_svs = {r["sv_id"] for r in rows if float(r["rint_hc3_bh_q_primary_t"]) < QCUT}

    cat = catalog[["chrom", "sv_index", "pos", "svtype"]].copy()
    cat["sv_index"] = cat.sv_index.astype(int)
    cat["pos"] = cat.pos.astype(int)
    by_chrom = {c: g for c, g in cat.groupby("chrom")}

    seen, recs = set(), []
    for r in rows:
        if r["sv_id"] in seen:
            continue
        seen.add(r["sv_id"])
        svt = "DEL" if "DEL" in r["svtype"] else "INS"
        g = by_chrom.get(r["sv_chrom"])
        if g is None:
            continue
        m = g[((g.pos - int(r["sv_pos"])).abs() <= 10)
              & g.svtype.astype(str).str.startswith(svt)]
        for ix in m.sv_index:
            recs.append(dict(chrom=r["sv_chrom"], sv_index=int(ix),
                             meth_tested=1,
                             meth_hits=1 if r["sv_id"] in hit_svs else 0,
                             meth_carriers=int(r["n_carriers_analyzed"]),
                             meth_n=int(r["n_samples_analyzed"])))
    out = pd.DataFrame(recs).drop_duplicates(["chrom", "sv_index"])
    n_hit = len(hit_svs)
    n_clean = len(seen) - n_hit
    if len(seen) != PUBLISHED["n_tested"]:
        return None, ("%d SVs in the scan; the section states %d"
                      % (len(seen), PUBLISHED["n_tested"]))
    if n_hit != PUBLISHED["n_svs"]:
        return None, "%d SVs carry hits; the section states %d" % (n_hit, PUBLISHED["n_svs"])
    note = ("%d SVs entered the read-based scan: %d carry a CpG at q < %.2f and %d carry "
            "none, over %d catalogue entries"
            % (len(seen), n_hit, QCUT, n_clean, len(out)))
    return out, note
