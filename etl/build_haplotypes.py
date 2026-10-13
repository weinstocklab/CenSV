#!/usr/bin/env python3
"""Write the haplotype layer: one index plus one file per chromosome.

    python etl/build_haplotypes.py [--src DIR] [--out DIR]

WHAT THIS IS. The browser's unit of analysis is the variant. These files add a second unit,
the assembled haplotype: each individual's array on a CHM13 base-pair axis, the Jaccard-NJ
tree of 392 haplotypes, and the SVs whose carriers form one clade of it.

WHAT IS NOT WRITTEN, DELIBERATELY. Everything already in catalog.json and ld.json is joined at
read time instead of copied. sv_category, cv_r2, mapped_haplogroup, svtype, svlen, pos, svfreq,
sv_id and n_layers come from catalog.json on (chrom, sv_index); carrier state comes from
ld.json's SV rows through ld.js's own decoder. Copying them would double 2.4 MB of payload and
create two answers to every question. The four fields below are the ones no shipped file holds:

    r2         decomposition r2 - how well the branch explains the genotype. catalog.json's
               cv_r2 is the CROSS-VALIDATED r2 and is a different number; the table column
               reads "decomp r2" and means this one.
    tips       how many tree tips the clade spans
    exact      fraction of individuals whose dosage the clade predicts exactly
    parent/x   tree topology and root distance

SIZE. Three trims, each measured, none of which changes anything drawn:
    tree      ship parent + x, lay the tree out in the browser      -220 KB gz
    dips      100 bp coordinates and widths, depth at 2 dp          -90 KB gz
    arrays    the array length only, not the twelve-field record    -113 KB gz

EVERY ASSERTION BELOW FAILS THE BUILD. The upstream analysis lives in another repository, so a
mismatch means the two describe different runs, and a browser that draws the wrong clade
silently is worse than one that does not build.
"""
import argparse
import base64
import csv
import gzip
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(ROOT), "discovery",
                   "2026-08-30_censv_individual_views", "output", "demo")
# FLAT, in data/ itself, named hap_<chrom>.json. web/tools/build_singlefile.py collects the
# payload with a NON-RECURSIVE os.listdir over data/, and its fetch shim matches on a flat
# file name, so anything written to data/hap/ would serve correctly from the dev server and
# 404 in the published single file - which is the only build a reader ever opens.
OUT = os.path.join(ROOT, "web", "public", "data")
DATA = os.path.join(ROOT, "web", "public", "data")

# The resolution's own table of SVs that arose more than once: one row per component, with its
# branch, decomposition r2, carrier haplotypes and their ancestry. It belongs to the resolution
# run rather than to the individual-views demo, so it is named apart from SRC and stamped into
# the manifest beside the other three inputs.
#
# The two runs are NOT the same vintage, and that is on the record here because it decides what
# a reader is looking at: compared on the 1,779 components both describe, the cross-validated
# r2 of this table and of the imputation summaries behind catalog.json agree on 86, with a
# median gap of 0.077 and a worst of 0.873. So catalog.json's cv_r2 and this file's are two
# different measurements, and nothing below mixes them.
MULTI = os.path.join(os.path.dirname(ROOT), "discovery",
                     "2026-08-03_cdr_qtl_full_substrate", "output",
                     "multiorigin_components_carriers.tsv")

# Whether a component reached imputation, from the same resolution run as MULTI. It is read
# rather than derived: the lowest carrier count among modelled components is exactly ten, but
# the floor does not decide the flag on its own - four later origins hold ten or more
# haplotypes and are still unmodelled, so a derived tier would disagree with the run on them.
RESOLUTION = os.path.join(os.path.dirname(ROOT), "discovery",
                          "2026-08-03_cdr_qtl_full_substrate", "output",
                          "monophyletic_components.tsv")

# Both tables are --multi and --resolution rather than fixed, because catalog.json and this
# layer have to come from the SAME resolution run and the live tables moved on 2026-09-12,
# when the chromosome 15 and 18 rebuild was adopted into them. catalog.json stayed where it
# was, since the rebuild left the two imputation ensembles on different sv_index numberings
# and the catalog build stops on that. Pointing both layers at one vintage is what keeps the
# branch a record names and the branch the figure outlines the same branch, and the shipped
# manifest records the sha1 of whichever files were read, so the vintage is never a guess.
#
# The pre-rebuild pair is archived at output/_archive/2026-09-11_resolution_prerebuild/ and is
# the vintage published today. Passing the live tables while catalog.json is older fails the
# build on the first SV whose branch moved, which is the behaviour wanted.

# 100 bp, not 1 kb. Measured over all 21,515 dips: at 100 bp the worst reconstruction overlaps
# its original by 0.980 of their union, at 500 bp by 0.906 and at 1 kb by 0.818, against a 0.95
# floor asserted below - so the threshold discriminates between the options rather than blessing
# whichever was picked. 100 bp is 0.05 px on a 2 Mb array drawn a thousand pixels wide.
UNIT = 100

# The monophyletic component count the manuscript reports, from
# paper/v2/sec/res_02_resolution.tex.
#
# It is NOT derivable from anything shipped here. 171 of those components are carried by fewer
# than ten haplotypes and sit below this table's own frequency floor, and a further 8 have no
# row in ld.json, so their genotypes exist in no file the browser reads. The browser therefore
# DRAWS 1,783 and REPORTS this. Declared in one place, with its source, and asserted below so
# it can never fall under the count actually drawn. Re-run the resolution and this needs
# updating by hand.
MONO_REPORTED = 1962

# How many of the multi-origin rows must carry the SV's own pre-decomposition row for the
# carrier ribbon to mean what the figure says it means. 137 of the 145 carry one today.
#
# The floor is here because the failure it guards against is silent: the block names that row
# `original_decomposed`, and an upstream rename would empty the dict below, send every ribbon
# back to painting one component, and leave every check green. That is the defect this field
# was added to remove, so it stops the build instead.
PARENT_FLOOR = 130


def fail(msg):
    sys.exit("build_haplotypes: " + msg)


def load(path):
    if not os.path.exists(path):
        fail("missing input %s" % path)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def stamp(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return {"path": os.path.relpath(path, os.path.dirname(ROOT)).replace("\\", "/"),
            "sha1": h.hexdigest()[:16], "bytes": os.path.getsize(path)}


def catalog_index(path):
    """(chrom, sv_index) -> row dict, from the columnar catalog."""
    d = load(path)
    if not isinstance(d, dict) or "columns" not in d:
        fail("catalog.json is not columnar; this build reads {columns, data, rows}")
    cols, data = d["columns"], d["data"]
    if len(cols) != len(data):
        fail("catalog.json has %d columns and %d data arrays" % (len(cols), len(data)))
    n = len(data[0])
    ix = {}
    for i in range(n):
        row = {c: data[k][i] for k, c in enumerate(cols)}
        ix[(row["chrom"], row["sv_index"])] = row
    return ix


def ld_sv_ids(path):
    """chrom -> the sv_id list of ld.json's SV rows, in row order."""
    d = load(path)
    return {c: list(b["sv"]["sv_id"]) for c, b in d["chrom"].items()}


PAIR = [0, 2, 1, 3]   # ld.js: stored code -> dosage. Self-inverse, so it also packs.


def unpack_demo(b64, nrow, ncol):
    """The upstream packing: bits MSB-first, each pair read as low-bit-first."""
    raw = bytearray(__import__("base64").b64decode(b64))
    out = []
    for r in range(nrow):
        row = []
        for c in range(ncol):
            cell = r * ncol + c
            byte = raw[cell >> 2]
            hi = (byte >> (7 - ((cell & 3) << 1))) & 1
            lo = (byte >> (6 - ((cell & 3) << 1))) & 1
            row.append(hi + 2 * lo)
        out.append(row)
    return out


def pack_ldjs(dos):
    """Pack dosages the way web/src/ld.js reads them: 2 bits per cell, MSB-first, via PAIR."""
    b = bytearray((len(dos) + 3) // 4)
    for cell, d in enumerate(dos):
        b[cell >> 2] |= PAIR[d] << (6 - ((cell & 3) << 1))
    return __import__("base64").b64encode(bytes(b)).decode("ascii")


def unpack_ldjs(b64, n):
    """web/src/ld.js standardise(), transcribed: PAIR[(byte >> (6 - 2k)) & 3]."""
    raw = __import__("base64").b64decode(b64)
    return [PAIR[(raw[c >> 2] >> (6 - ((c & 3) << 1))) & 3] for c in range(n)]


def multiorigin_index(path):
    """(chrom, pos, svtype, svlen) -> its components, in the resolution's own rank order.

    `carriers` in this file is the semicolon-joined HAPLOTYPE list and `n_carriers` its count;
    both are read, because the list is what ships and the count is one of the things that
    checks it.
    """
    if not os.path.exists(path):
        fail("missing input %s" % path)
    out = {}
    with open(path, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            key = (r["chrom"], int(r["pos"]), r["svtype"], int(r["svlen"]))
            out.setdefault(key, []).append({
                "branch": r["branch"],
                "rank": int(r["rank"]),
                "iteration": int(r["iteration"]),
                # Blank on 5 of 285 components, all of them zero-carrier placeholders; see
                # the filter in main(), which asserts that shape rather than tolerating it.
                "r2": None if r["branch_r2"].strip() == "" else float(r["branch_r2"]),
                "n_carriers": int(r["n_carriers"]),
                "tips": int(r["clade_tips"]),
                "ancestry": r["ancestry"],
                "names": {x for x in r["carriers"].split(";") if x},
            })
    for key in out:
        out[key].sort(key=lambda c: c["rank"])
    return out


def modelled_index(path):
    """(chrom, pos, branch) -> did this component reach imputation?

    `modelled` is the resolution's own flag. Anything the file spells other than True or
    False stops the build, because a tier silently defaulting to one side would label
    origins wrongly and look like a finding.
    """
    if not os.path.exists(path):
        fail("missing input %s" % path)
    out = {}
    with open(path, encoding="utf-8", newline="") as fh:
        for i, r in enumerate(csv.DictReader(fh, delimiter="\t")):
            flag = r["modelled"].strip()
            if flag not in ("True", "False"):
                fail("%s row %d states modelled=%r, which is neither True nor False"
                     % (os.path.basename(path), i, r["modelled"]))
            out[(r["chrom"], int(float(r["pos"])), r["mapped_haplogroup"])] = flag == "True"
    return out


def tips_under(tree, node):
    """The tip INDICES under a node, by the same walk web/src/haplo.js tipsUnder() does."""
    kids = [[] for _ in range(tree["n_node"])]
    for i, p in enumerate(tree["parent"]):
        if p >= 0:
            kids[p].append(i)
    tip_of = {nd: k for k, nd in enumerate(tree["tip_node"])}
    out, stack = set(), [node]
    while stack:
        i = stack.pop()
        if kids[i]:
            stack.extend(kids[i])
        elif i in tip_of:
            out.add(tip_of[i])
    return out


def pack_bits(idx, n):
    """A set of tip indices as a bitset over n tips, bit k at byte k>>3, MSB first.

    Same orientation as pack_ldjs above, so one convention covers every packed row in this
    file and web/src/haplo.js reads both the same way.
    """
    b = bytearray((n + 7) // 8)
    for k in idx:
        b[k >> 3] |= 1 << (7 - (k & 7))
    return base64.b64encode(bytes(b)).decode("ascii")


def unpack_bits(b64, n):
    """pack_bits inverted, so the round trip is checked rather than assumed."""
    raw = base64.b64decode(b64)
    return {k for k in range(n) if raw[k >> 3] >> (7 - (k & 7)) & 1}


def trim_tree(tr, chrom):
    """Topology and root distance. Everything else is a layout the browser can redo."""
    lay = tr["layout"]
    par, x = lay["parent"], lay["x"]
    n = lay["n_node"]
    if not (len(par) == len(x) == n):
        fail("%s: layout has %d parents, %d x, n_node %d" % (chrom, len(par), len(x), n))
    roots = [i for i, p in enumerate(par) if p < 0]
    if len(roots) != 1:
        fail("%s: %d roots in the tree topology" % (chrom, len(roots)))
    # A child must sit further from the root than its parent, or "drawn to branch length"
    # is not what the x values describe.
    bad = [i for i, p in enumerate(par) if p >= 0 and x[i] < x[p] - 1e-9]
    if bad:
        fail("%s: %d nodes sit closer to the root than their parent" % (chrom, len(bad)))

    # tips[k] -> node index. Shipped rather than inferred from a traversal: which node is
    # which tip decides which haplotype every ribbon cell describes, and an in-order walk
    # that happened to disagree would mislabel the whole figure without changing its shape.
    by_name = {nm: i for i, nm in enumerate(lay["name"]) if nm}
    tip_node = [by_name.get(t) for t in tr["tips"]]
    if any(v is None for v in tip_node):
        missing = [t for t, v in zip(tr["tips"], tip_node) if v is None]
        fail("%s: %d tips have no node in the layout (%s)"
             % (chrom, len(missing), missing[:3]))
    if len(set(tip_node)) != len(tip_node):
        fail("%s: two tips resolve to the same node" % chrom)
    not_leaf = [i for i in tip_node if lay["tip"][i] != 1 and lay["tip"][i] is not True]
    if not_leaf:
        fail("%s: %d tip names resolve to internal nodes" % (chrom, len(not_leaf)))

    return {"n_node": n, "parent": par, "x": [round(v, 5) for v in x],
            "tips": tr["tips"], "n_tip": tr["n_tip"], "tip_node": tip_node,
            "branch_node": tr["branch_node"]}


def trim_dips(dips_c):
    """[start_bp, end_bp, pos_span] -> [start, width, span] in UNIT-bp steps, rounded."""
    out = {}
    for s, haps in dips_c.items():
        row = {}
        for h, arr in haps.items():
            if not arr:
                continue
            row[h] = [[int(round(a / UNIT)), max(1, int(round((b - a) / UNIT))),
                       round(v, 2)] for a, b, v in arr]
        if row:
            out[s] = row
    return out


def check_dip_roundtrip(orig, trimmed, chrom):
    """Reconstruct every dip from the kb form and require it to land on the original.

    An absolute-error bound is worthless here: flooring to kb cannot produce an error of a
    unit or more, so `error < one unit` is true whatever the code does, including if the unit
    or the width field is wrong. The test is INTERSECTION OVER UNION against the original
    interval, which a unit error drives to 0 and a width error drives well below 1.
    """
    worst_iou, worst_bp = 1.0, 0
    for s, haps in orig.items():
        for h, arr in haps.items():
            if not arr or s not in trimmed or h not in trimmed[s]:
                continue
            for (a, b, _), (ka, kw, _) in zip(arr, trimmed[s][h]):
                ra, rb = ka * UNIT, ka * UNIT + kw * UNIT
                inter = max(0, min(b, rb) - max(a, ra))
                union = max(b, rb) - min(a, ra)
                worst_iou = min(worst_iou, inter / union if union else 1.0)
                worst_bp = max(worst_bp, abs(ra - a), abs((rb - ra) - (b - a)))
    if worst_iou < 0.95:
        fail("%s: a reconstructed dip overlaps its original by only %.3f of their union"
             % (chrom, worst_iou))
    return worst_iou, worst_bp


def clade_exact(tree, node, dos, names):
    """Recompute clade_pred.exact: does the clade predict each individual's dosage?

    WHY THIS EXISTS. An allele frequency cannot see a cohort-order error - permuting the
    samples leaves it identical - and the carrier ribbon is exactly a statement about which
    individual is which. This quantity touches the tree, the genotypes and the sample order
    at once, so it can. Measured over 996 monophyletic SVs on seven chromosomes: aligned it
    reproduces the shipped value to a median of 0.00009, and with the columns rolled by one
    it moves to a median of 0.143 and never below 0.216 on any chromosome.

    Scored over individuals with BOTH haplotypes assembled. Where only one is, the clade can
    predict at most 1 while the call can be 2, and that ploidy gap - not any misalignment -
    is what drove the residual to 0.066 on chr13 and 0.090 on chrX while every other
    chromosome sat at 0.000.
    """
    par, n_node = tree["parent"], tree["n_node"]
    kids = [[] for _ in range(n_node)]
    for i, p in enumerate(par):
        if p >= 0:
            kids[p].append(i)
    seen, stack = set(), [node]
    while stack:
        i = stack.pop()
        if kids[i]:
            stack.extend(kids[i])
        else:
            seen.add(i)
    in_clade, total_tips = {}, {}
    for k, nd in enumerate(tree["tip_node"]):
        s = tree["tips"][k].rsplit("_hap", 1)[0]
        total_tips[s] = total_tips.get(s, 0) + 1
        if nd in seen:
            in_clade[s] = in_clade.get(s, 0) + 1
    ok = tot = 0
    for i, s in enumerate(names):
        if dos[i] == 3 or total_tips.get(s, 0) != 2:
            continue
        tot += 1
        if in_clade.get(s, 0) == dos[i]:
            ok += 1
    return (ok / tot) if tot else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--multi", default=MULTI)
    ap.add_argument("--resolution", default=RESOLUTION)
    args = ap.parse_args()

    p_ind = os.path.join(args.src, "individual_demo.json")
    p_tree = os.path.join(args.src, "trees.json")
    p_asc = os.path.join(args.src, "ascairn_labels.json")
    ind, trees, asc = load(p_ind), load(p_tree), load(p_asc)
    multi = multiorigin_index(args.multi)
    modelled = modelled_index(args.resolution)
    n_imputed = {True: 0, False: 0}
    cat = catalog_index(os.path.join(DATA, "catalog.json"))
    ldsv = ld_sv_ids(os.path.join(DATA, "ld.json"))
    # ld.json carries the same per-chromosome SV universe these views count against, and the
    # browser reads carrier state out of its packed rows. The ids are NOT copied here; they
    # are checked, so a build against a different LD payload stops.
    chroms = [c["chrom"] for c in load(os.path.join(DATA, "chromosomes.json"))]

    os.makedirs(args.out, exist_ok=True)
    samples = ind["samples"]
    sample_names = [r["s"] for r in samples]
    sample_ix = {s: i for i, s in enumerate(sample_names)}
    asc_ix = {s: i for i, s in enumerate(asc["order"])}

    total_raw = total_gz = 0
    n_mono_all = 0
    n_origin_sv = n_origin_comp = 0
    multi_seen = set()
    multi_index = {}
    written = []
    worst_iou, worst_bp = 1.0, 0
    af_checks, ex_checks = [], []
    n_parent_row = n_noparent_row = n_parent_car = n_noparent_car = 0
    summary = {}

    for chrom in chroms:
        blk = ind["chroms"].get(chrom)
        tr = trees.get(chrom)
        if blk is None or tr is None:
            fail("%s has no haplotype block or no tree" % chrom)

        # ---- the SV universe these views count against must be ld.json's own
        # "28 monophyletic of 204" is a claim about a specific set of variants. If the shipped
        # LD payload were rebuilt over a different set, that denominator would be silently
        # wrong, so the two are compared as SETS here rather than by count.
        sv, pred = blk["sv"], blk["clade_pred"]
        gt = unpack_demo(blk["gt"], blk["n_sv"], len(sample_names))
        tree = trim_tree(tr, chrom)
        mine, theirs = set(sv["id"]), set(ldsv.get(chrom, []))
        if mine != theirs:
            fail("%s: the haplotype block holds %d SVs and ld.json %d, differing on %d "
                 "(%s)" % (chrom, len(mine), len(theirs), len(mine ^ theirs),
                           sorted(mine ^ theirs)[:3]))
        # the tree is built before the SV loop because the clade check reads it per SV
        mono = []
        for k in range(blk["n_sv"]):
            if sv["cat"][k] != "monophyletic" or pred[k] is None:
                continue
            idx = sv["i"][k]
            row = cat.get((chrom, idx))
            if row is None:
                fail("%s sv_index %d is monophyletic here and absent from catalog.json"
                     % (chrom, idx))
            if row["sv_id"] != sv["id"][k]:
                fail("%s sv_index %d is %s in catalog.json and %s here"
                     % (chrom, idx, row["sv_id"], sv["id"][k]))
            if row["sv_category"] != "monophyletic":
                fail("%s %s is %s in catalog.json and monophyletic here"
                     % (chrom, row["sv_id"], row["sv_category"]))
            if row["mapped_haplogroup"] != sv["branch"][k]:
                fail("%s %s sits on branch %s in catalog.json and %s here"
                     % (chrom, row["sv_id"], row["mapped_haplogroup"], sv["branch"][k]))
            br = sv["branch"][k]
            if br is not None and br not in tr["branch_node"]:
                fail("%s %s names branch %s, which the tree does not carry"
                     % (chrom, row["sv_id"], br))
            r2 = sv["r2"][k]
            dos = gt[k]
            packed = pack_ldjs(dos)
            if unpack_ldjs(packed, len(dos)) != dos:
                fail("%s %s: the packed dosage row does not read back through ld.js's decoder"
                     % (chrom, row["sv_id"]))
            called = [v for v in dos if v != 3]
            af = sum(called) / (2 * len(called)) if called else None
            af_checks.append((chrom, row["sv_id"], af, row["svfreq"]))
            if br is not None:
                got = clade_exact(tree, tree["branch_node"][br], dos, sample_names)
                if got is not None:
                    ex_checks.append((chrom, row["sv_id"], got, pred[k]["exact"]))
            mono.append([idx, pred[k]["tips"], round(pred[k]["exact"], 4),
                         None if r2 is None else round(r2, 4), packed])
        mono.sort(key=lambda m: (m[3] is None, -(m[3] or 0), -m[1]))
        n_mono_all += len(mono)

        # ---- the sibling origins of the SVs that arose more than once
        #
        # Keyed by sv_index, so the browser reaches them from the row it already draws. Every
        # assertion below fails the build, and none restates a check made elsewhere: each
        # compares the SHIPPED tree against the resolution's own table, which are two
        # repositories and two runs.
        sup_of = {r["s"]: r.get("sup") for r in samples}
        # This block's SVs by coordinate and category, so the row an SV had before the
        # decomposition split it can be found beside the component the catalog names. The
        # parent block further down says why it is wanted.
        at = {}
        for k in range(blk["n_sv"]):
            at.setdefault((sv["pos"][k], sv["t"][k], sv["len"][k]), {}) \
              .setdefault(sv["cat"][k], []).append(k)
        origins, parent = {}, {}
        for m in mono:
            idx = m[0]
            row = cat[(chrom, idx)]
            key = (chrom, row["pos"], row["svtype"], row["svlen"])
            comps = multi.get(key)
            if comps is None:
                continue
            multi_seen.add(key)
            brs = [c["branch"] for c in comps]
            if row["mapped_haplogroup"] not in brs:
                fail("%s %s sits on branch %s, and the resolution gives this SV the %d "
                     "components %s, so the two decompose it differently"
                     % (chrom, row["sv_id"], row["mapped_haplogroup"], len(brs),
                        ",".join(brs)))
            # Five components of 285, on two chr10 SVs, carry no carriers at all: iteration
            # -1, purity 0, and an empty carrier list, r2 and ancestry. They are unresolved
            # placeholders with nothing to outline. Dropping them is safe ONLY if that is
            # exactly what they are, so the shape is asserted here - a component that has
            # carriers but no r2 stops the build instead of being quietly skipped.
            live = []
            for c in comps:
                if c["n_carriers"]:
                    live.append(c)
                    continue
                if c["iteration"] != -1 or c["names"] or c["r2"] is not None or c["ancestry"]:
                    fail("%s %s origin %s carries no carriers yet is not the unresolved "
                         "placeholder that state is documented as: iteration %s, r2 %s, %d "
                         "carrier names, ancestry %r"
                         % (chrom, row["sv_id"], c["branch"], c["iteration"], c["r2"],
                            len(c["names"]), c["ancestry"]))
            if not live:
                continue

            rec, tipsets = [], {}
            for c in live:
                b = c["branch"]
                if c["r2"] is None:
                    fail("%s %s origin %s carries %d haplotypes and states no decomposition "
                         "r2, so it is neither a drawable origin nor the unresolved "
                         "placeholder" % (chrom, row["sv_id"], b, c["n_carriers"]))
                if b not in tree["branch_node"]:
                    fail("%s %s names origin branch %s, which the shipped tree does not carry"
                         % (chrom, row["sv_id"], b))
                t = tips_under(tree, tree["branch_node"][b])
                if len(t) != c["tips"]:
                    fail("%s %s origin %s spans %d tips in the shipped tree and %d in the "
                         "resolution table" % (chrom, row["sv_id"], b, len(t), c["tips"]))
                tip_ix = {nm: k for k, nm in enumerate(tree["tips"])}
                unknown = c["names"] - set(tip_ix)
                if unknown:
                    fail("%s %s origin %s names %d carrier haplotypes that are not tips of "
                         "this tree (%s)" % (chrom, row["sv_id"], b, len(unknown),
                                             sorted(unknown)[:3]))
                car = {tip_ix[nm] for nm in c["names"]}
                if car - t:
                    fail("%s %s origin %s has %d carriers outside its own clade, so the "
                         "branch and the carrier list describe different trees"
                         % (chrom, row["sv_id"], b, len(car - t)))
                if len(car) != c["n_carriers"]:
                    fail("%s %s origin %s names %d carrier haplotypes and counts %d"
                         % (chrom, row["sv_id"], b, len(car), c["n_carriers"]))
                packed = pack_bits(car, tree["n_tip"])
                if unpack_bits(packed, tree["n_tip"]) != car:
                    fail("%s %s origin %s: the packed carrier bitset does not read back"
                         % (chrom, row["sv_id"], b))
                # The resolution states ancestry over CARRIERS. Deriving it here from the
                # carrier tips and comparing is what proves the browser may derive it too.
                want = dict(p.split(":") for p in c["ancestry"].split(",")) if c["ancestry"] else {}
                want = {k: int(v) for k, v in want.items()}
                got = {}
                for k in car:
                    sp = sup_of.get(tree["tips"][k].rsplit("_hap", 1)[0])
                    if sp:
                        got[sp] = got.get(sp, 0) + 1
                if got != want:
                    fail("%s %s origin %s: ancestry derived from its carrier tips is %s and "
                         "the resolution states %s"
                         % (chrom, row["sv_id"], b, sorted(got.items()), sorted(want.items())))
                # The fourth field is the evidence tier, 1 where the component reached
                # imputation. Every drawn origin must appear in the resolution table, and it
                # does for all 285 components; a missing one stops the build rather than
                # taking a default, since either answer would be a claim about the origin.
                key = (chrom, row["pos"], b)
                if key not in modelled:
                    fail("%s %s origin %s has no row in %s, so whether it reached imputation "
                         "is unknown" % (chrom, row["sv_id"], b,
                                         os.path.basename(args.resolution)))
                n_imputed[modelled[key]] += 1
                tipsets[b] = t
                rec.append([b, round(c["r2"], 4), packed, 1 if modelled[key] else 0])
            # Disjoint clades are what make these separate ORIGINS rather than one clade
            # described twice, and the display draws them as separate outlines on that basis.
            for i in range(len(rec)):
                for j in range(i + 1, len(rec)):
                    shared = tipsets[rec[i][0]] & tipsets[rec[j][0]]
                    if shared:
                        fail("%s %s origins %s and %s share %d tips, so they are not two "
                             "origins" % (chrom, row["sv_id"], rec[i][0], rec[j][0],
                                          len(shared)))
            origins[str(idx)] = rec
            multi_index.setdefault(chrom, {})[str(idx)] = len(rec)

            # ---- the row this SV had before the decomposition split it
            #
            # The ribbon beside the tree paints one packed dosage row per record, and on an SV
            # that arose more than once the catalog row's component is one origin of several.
            # Painting from it marks 561 of the 1,622 later-origin carrier haplotypes and
            # leaves 77 of the 158 later origins with every carrier blank, so a reader sees an
            # outline drawn around a clade whose carriers the colour beside it never names.
            # The block already holds the pre-decomposition `original_decomposed` row at the
            # same coordinate for 137 of the 145 multi-origin rows, and that row is the
            # variant itself.
            #
            # The two assertions below fail the build and neither restates the other. The
            # first says this row decodes to the frequency the source states for it, which is
            # what reading the wrong row out of the packed matrix would break. The second says
            # every carrier haplotype of every origin drawn belongs to a sample this row calls
            # a carrier, which is what makes it the superset the figure claims it is. Measured
            # over all 137 rows before the field was added, by
            # discovery/2026-08-03_cdr_qtl_full_substrate/code/origins/parent_superset.py:
            # 1,532 of 1,532 later-origin carriers covered, 0 contradicted, 0 uncalled.
            pks = at.get((row["pos"], row["svtype"], row["svlen"]), {}).get(
                "original_decomposed", [])
            if len(pks) > 1:
                fail("%s %s has %d pre-decomposition rows at its own coordinate, so there is "
                     "no one row that is the variant" % (chrom, row["sv_id"], len(pks)))
            n_car = sum(len(unpack_bits(c[2], tree["n_tip"])) for c in rec)
            if pks:
                pdos = gt[pks[0]]
                ppacked = pack_ldjs(pdos)
                if unpack_ldjs(ppacked, len(pdos)) != pdos:
                    fail("%s %s: the packed pre-decomposition row does not read back through "
                         "ld.js's decoder" % (chrom, row["sv_id"]))
                pcalled = [v for v in pdos if v != 3]
                paf = sum(pcalled) / (2.0 * len(pcalled)) if pcalled else None
                if paf is None or abs(paf - sv["af"][pks[0]]) > 1e-3:
                    fail("%s %s: the pre-decomposition row decodes to frequency %s where the "
                         "source states %.6f, so the two name different rows"
                         % (chrom, row["sv_id"], "nothing" if paf is None else "%.6f" % paf,
                            sv["af"][pks[0]]))
                for c in rec:
                    for t_ix in sorted(unpack_bits(c[2], tree["n_tip"])):
                        nm = tree["tips"][t_ix].rsplit("_hap", 1)[0]
                        if nm not in sample_ix:
                            fail("%s %s origin %s: carrier haplotype %s names a sample the "
                                 "index does not carry"
                                 % (chrom, row["sv_id"], c[0], tree["tips"][t_ix]))
                        d = pdos[sample_ix[nm]]
                        if d not in (1, 2):
                            fail("%s %s origin %s: carrier haplotype %s belongs to a sample "
                                 "the pre-decomposition row reads as dosage %d, so that row "
                                 "and these components describe different variants"
                                 % (chrom, row["sv_id"], c[0], tree["tips"][t_ix], d))
                parent[str(idx)] = ppacked
                n_parent_row += 1
                n_parent_car += n_car
            else:
                n_noparent_row += 1
                n_noparent_car += n_car
            n_origin_sv += 1
            n_origin_comp += len(rec)

        tip_samples = {t.rsplit("_hap", 1)[0] for t in tree["tips"]}
        unknown = tip_samples - set(sample_names)
        if unknown:
            fail("%s: %d tree tips name samples the index does not carry (%s)"
                 % (chrom, len(unknown), sorted(unknown)[:3]))

        # ---- ascAIRN pairs, per sample, for the tips this chromosome has
        a_c = asc["chroms"].get(chrom)
        pairs = {}
        if a_c is not None:
            for s in sorted(tip_samples):
                j = asc_ix.get(s)
                if j is None:
                    continue
                p = a_c["c"][j]
                if p:
                    pairs[s] = p

        # ---- arrays and dips
        dips_raw = ind["dips"].get(chrom, {})
        dips = trim_dips(dips_raw)
        iou, bp = check_dip_roundtrip(dips_raw, dips, chrom)
        worst_iou, worst_bp = min(worst_iou, iou), max(worst_bp, bp)
        alen, contig = {}, {}
        for s in sorted(tip_samples):
            ph = (ind["pheno"].get(s) or {}).get(chrom)
            cg = (ind["contig"].get(s) or {}).get(chrom)
            if ph:
                alen[s] = [ph.get("hap1", [None])[0], ph.get("hap2", [None])[0]]
            if cg:
                contig[s] = [cg.get("hap1"), cg.get("hap2")]

        out = {
            "chrom": chrom,
            "active": blk["active"],
            "censat": [[g["s"], g["e"], g["rgb"], g["name"]] for g in blk["censat"]],
            "n_sv": blk["n_sv"],
            "tree": tree,
            "mono": mono,
            "origins": origins,
            "parent": parent,
            "n_gt": len(sample_names),
            "asc": pairs,
            "asc_clusters": (a_c or {}).get("clusters", []),
            "alen": alen,
            "contig": contig,
            "dips": dips,
        }
        raw = json.dumps(out, separators=(",", ":")).encode("utf-8")
        with open(os.path.join(args.out, "hap_" + chrom + ".json"), "wb") as fh:
            fh.write(raw)
        gz = len(gzip.compress(raw, 9, mtime=0))
        total_raw += len(raw)
        total_gz += gz
        written.append((chrom, len(mono), len(raw), gz))
        # The entry strip on #/chrN and the line in the record panel read ONLY this, so a
        # reader who never opens the haplotype page pays 1.5 KB and no per-chromosome fetch.
        summary[chrom] = {"tips": tree["n_tip"], "mono": len(mono), "nsv": blk["n_sv"],
                          "exact": sum(1 for m in mono if m[2] >= 0.95)}

    index = {
        "build": "haplotype layer v1",
        "n_chrom": len(written),
        "n_tip": max(trees[c]["n_tip"] for c in chroms),
        "samples": samples,
        "asc": {k: asc["meta"][k] for k in ("n_cohort", "n_typed", "n_panel", "untyped")
                if k in asc["meta"]},
        "summary": summary,
        "mono_reported": MONO_REPORTED,
        # sv_index -> how many origins, for the SVs that arose more than once. Read by the
        # record panel, which holds this index and not the per-chromosome block.
        "multi": multi_index,
        "src_manifest": [stamp(p)
                         for p in (p_ind, p_tree, p_asc, args.multi, args.resolution)],
    }
    raw = json.dumps(index, separators=(",", ":")).encode("utf-8")
    with open(os.path.join(args.out, "hap_index.json"), "wb") as fh:
        fh.write(raw)
    total_raw += len(raw)
    total_gz += len(gzip.compress(raw, 9, mtime=0))

    print("%-8s %5s %10s %9s" % ("chrom", "mono", "raw", "gzip"))
    for chrom, nm, r, g in written:
        print("%-8s %5d %10d %9d" % (chrom, nm, r, g))
    print("%-8s %5d %10d %9d" % ("index", 0, len(raw), len(gzip.compress(raw, 9, mtime=0))))
    # The declared figure counts every component; this build counts those that clear the
    # ten-carrier floor and have a genotype row, so it must be the larger of the two.
    if MONO_REPORTED < n_mono_all:
        fail("the manuscript figure %d is below the %d components this build draws, so one of "
             "the two describes a different run" % (MONO_REPORTED, n_mono_all))
    print("")
    print("%d monophyletic SVs drawn over %d chromosomes; manuscript reports %d, "
          "%d of them below the ten-carrier floor or without a genotype row"
          % (n_mono_all, len(written), MONO_REPORTED, MONO_REPORTED - n_mono_all))
    # The dosage rows are packed from the upstream matrix and drawn as the carrier ribbon. If
    # they were misaligned by a row or a column the ribbon would still render, so the allele
    # frequency they imply is compared against the one the shipped catalog states.
    # svfreq ONLY. af_hprc is a different quantity (it sits 0.64 away) and the upstream file's
    # own af would be comparing this build against its own input, so neither belongs in a
    # cross-repository check. Measured worst gap against svfreq over 451 SVs: 0.01048.
    worst_af, worst_id = 0.0, None
    for c, sid, af, svfreq in af_checks:
        if af is None or svfreq is None:
            continue
        d = abs(af - svfreq)
        if d > worst_af:
            worst_af, worst_id = d, "%s %s (mine %.5f, catalog svfreq %.5f)" % (c, sid, af, svfreq)
    if worst_af > 0.03:
        fail("a packed dosage row implies an allele frequency %.4f from the catalog's own "
             "figure for the same SV: %s" % (worst_af, worst_id))

    # And the order-sensitive one. 0.05 sits between the aligned residual (0.005 worst on any
    # chromosome once single-haplotype individuals are excluded) and the smallest movement a
    # one-column roll produces on any chromosome (0.216).
    worst_ex, worst_exid = 0.0, None
    for c, sid, got, want in ex_checks:
        d = abs(got - want)
        if d > worst_ex:
            worst_ex, worst_exid = d, "%s %s (recomputed %.4f, shipped %.4f)" % (c, sid, got, want)
    if worst_ex > 0.05:
        fail("a clade predicts dosages %.4f differently from the shipped clade_pred, which "
             "means the tree, the genotypes and the cohort order do not describe one run: %s"
             % (worst_ex, worst_exid))
    # Reported rather than asserted: a multi-origin SV carried by fewer than ten haplotypes,
    # or without an ld.json row, has no mono row to hang its origins on and is legitimately
    # absent. The count says how many, so the gap is on the record instead of inferred.
    # n_origin_sv counts MONO ROWS, not SVs: 18 of these SVs already have each origin as its
    # own sv_index, so both of their rows carry the same origins list and the whole SV is
    # reachable from either. The distinct-SV figure is multi_seen.
    print("multi-origin: %d of the %d SVs the resolution names are drawable here, their "
          "origins attached to %d mono rows; %d have no mono row to hang them on"
          % (len(multi_seen), len(multi), n_origin_sv, len(multi) - len(multi_seen)))
    if n_parent_row < PARENT_FLOOR:
        fail("only %d of the %d multi-origin rows carry the SV's own pre-decomposition row, "
             "against a floor of %d. The carrier ribbon would fall back to painting one "
             "component on the rest, which is the reading this field replaced"
             % (n_parent_row, n_parent_row + n_noparent_row, PARENT_FLOOR))
    print("carrier ribbon: %d of %d multi-origin rows paint the variant's own row, covering "
          "all %d of their origins' carrier haplotypes; %d rows paint the record's component "
          "(%d carriers)"
          % (n_parent_row, n_parent_row + n_noparent_row, n_parent_car, n_noparent_row,
             n_noparent_car))
    print("evidence tier: %d of the %d origins drawn reached imputation, %d carry "
          "assembled haplotypes and no model"
          % (n_imputed[True], n_imputed[True] + n_imputed[False], n_imputed[False]))
    print("carrier rows: %d packed; worst allele-frequency gap vs catalog svfreq %.5f"
          % (len(af_checks), worst_af))
    print("clade prediction: %d checked, worst gap vs shipped clade_pred %.5f"
          % (len(ex_checks), worst_ex))
    print("dip trim: worst overlap %.4f of union, worst edge move %d bp" % (worst_iou, worst_bp))
    print("TOTAL raw %d, gzip %d (+%.1f%% on the 1440183-byte data container)"
          % (total_raw, total_gz, 100 * total_gz / 1440183))


if __name__ == "__main__":
    main()
