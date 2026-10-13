#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The size ladder: what each candidate change is worth, measured on the real container.

    python web/tools/dev/measure_size_ladder.py <reference CenSV_offline.html>

WHY THIS EXISTS, AND WHAT IT REPLACED
-------------------------------------
The first version modelled the container as

    {"shell": "x" * 2500, "css": "y" * 26000, "js": "z" * 150000, "data": ...}

with a wrapper constant fitted to one earlier build. Placeholders that are runs of a single
character compress to almost nothing, so the constant was absorbing both the real HTML wrapper
and the ~44 KB the real stylesheet and application cost compressed. It printed

    shipped today (reconstructed)  2363634 B    actual file 2368517 B

- its own output naming a 4,883 B gap - and the size write-up described that row as having
"reproduced the published payload exactly". It had not.

So this version uses the real parts. Row 0 is not a reconstruction to be eyeballed afterwards:
it must reproduce the reference file's length TO THE BYTE or the script exits non-zero and
prints no rungs, because rungs hanging off an unanchored base are not measurements.

It is a deliberate re-implementation rather than an import of `pack()`. Sharing the assembly
would make row 0 agree with itself trivially; two independent paths that must produce the same
byte count is the stronger check, and it fails the day the packer's assembly changes.

EVERY RUNG SHIPS AS TEXT
------------------------
`build_singlefile.py` reads each data file as a STRING and puts the string in the container.
An earlier version of this script put a transformed file back as a parsed OBJECT, so every
rung was quietly carrying part of the separate "embed parsed objects" saving on top of its
own. That showed up when s2 shipped: this predicted -116,248 B for dropping `snp.impute` and
-109,232 B was delivered, 6.4% over. Transformations are now re-serialised to text, exactly as
they would ship, and `embed parsed objects` is measured on its own because it is a different
change.

RUNG 4 is the one model left: it puts the genotype matrices after the JSON as raw bytes, a
container format that does not exist yet. Its length is what that format would cost.

COST. zopfli takes ~48 s per call on this container. Run it under sbatch, not on the head node,
and give `-o` a path on shared storage - a path under /tmp is written on the compute node and
cannot be read afterwards:

    sbatch -c 1 --mem=8G -t 0:40:00 -o _ladder.log \\
      --wrap="cd $PWD && ~/.pixi/bin/pixi run python \\
              web/tools/dev/measure_size_ladder.py CenSV_offline.html"
"""
import base64
import gzip
import io
import json
import os
import re
import sys

import zopfli.gzip

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "..", "dist")

if len(sys.argv) < 2:
    raise SystemExit("usage: measure_size_ladder.py <reference CenSV_offline.html>")
REF = sys.argv[1]

PAYLOAD = re.compile(r'<script[^>]*type="text/plain"[^>]*>([^<]*)</script>', re.S)


def gz9(b):
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as f:
        f.write(b)
    return len(buf.getvalue())


def zop(b):
    return len(zopfli.gzip.compress(b))


def enc(o):
    return json.dumps(o, separators=(",", ":")).encode("utf-8")


def text(o):
    """A data file as the container carries it: a compact JSON string."""
    return o if isinstance(o, str) else json.dumps(o, separators=(",", ":"))


# ------------------------------------------------------------------ the real container
def build():
    """web/dist assembled the way build_singlefile.pack() assembles it."""
    shell = io.open(os.path.join(DIST, "index.html"), encoding="utf-8").read()
    css_m = re.search(r'<link[^>]+href="(\./assets/[^"]+\.css)"[^>]*>', shell)
    js_m = re.search(r'<script[^>]+src="(\./assets/[^"]+\.js)"[^>]*></script>', shell)
    if not css_m or not js_m:
        raise SystemExit("could not find the built css/js references in dist/index.html")

    def asset(rel):
        return io.open(os.path.join(DIST, rel.lstrip("./")), encoding="utf-8").read()

    c = {
        "shell": shell.replace(css_m.group(0), "").replace(js_m.group(0), ""),
        "css": asset(css_m.group(1)),
        "js": asset(js_m.group(1)),
        "data": {},
    }
    for name in sorted(os.listdir(os.path.join(DIST, "data"))):
        if name.endswith(".json"):
            c["data"][name] = io.open(
                os.path.join(DIST, "data", name), encoding="utf-8").read()
    return c


container = build()
base_text = dict(container["data"])
obj = {n: json.loads(t) for n, t in base_text.items()}

# ------------------------------------------------------------------ calibrate on the file
ref_bytes = io.open(REF, "rb").read()
m = PAYLOAD.search(ref_bytes.decode("utf-8"))
if not m:
    raise SystemExit("%s carries no text/plain payload - is it a built single-file page?" % REF)
REF_FILE = len(ref_bytes)
SHELL_B = REF_FILE - len(m.group(1).strip())


def page_len(data_field, extra=b"", comp=zop, as_text=True):
    """The .html length for a container carrying this data, through this compressor."""
    d = {k: text(v) for k, v in data_field.items()} if as_text else data_field
    raw = enc(dict(container, data=d)) + extra
    return SHELL_B + (comp(raw) + 2) // 3 * 4


print("reference   %s" % os.path.abspath(REF))
print("            %d B file, %d B payload, %d B of page around it"
      % (REF_FILE, REF_FILE - SHELL_B, SHELL_B))

row0 = page_len(base_text)
print("\nrow 0, the same container rebuilt from web/dist and re-compressed: %d B" % row0)
if row0 != REF_FILE:
    print("MISMATCH by %+d B - this ladder is not measuring the file it claims to."
          % (row0 - REF_FILE))
    print("Every rung below would be an unanchored number, so nothing is printed.")
    sys.exit(1)
print("reproduces the reference exactly, so the rungs below are anchored to a real file.\n")


# ------------------------------------------------------------------ the transformations
def columnar(rows):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    return {k: [r.get(k) for r in rows] for k in keys}


def rnd(o, nd):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [rnd(x, nd) for x in o]
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    return o


def clone(o):
    return json.loads(json.dumps(o))


def t_columnar(d, _):
    return dict(d, **{"catalog.json": columnar(clone(d["catalog.json"]))}), _


def t_cat4dp(d, _):
    return dict(d, **{"catalog.json": rnd(clone(d["catalog.json"]), 4)}), _


def t_gt_binary(d, _):
    ld = clone(d["ld.json"])
    gt = b"".join(base64.b64decode(ld["chrom"][c].pop("gt")) for c in sorted(ld["chrom"]))
    return dict(d, **{"ld.json": ld}), gt


def t_snp_deltas(d, extra):
    ld = clone(d["ld.json"])
    for f in ld["chrom"].values():
        p = (f.get("snp") or {}).get("pos")
        if p:
            f["snp"]["pos"] = [p[0]] + [p[i] - p[i - 1] for i in range(1, len(p))]
    return dict(d, **{"ld.json": ld}), extra


def t_drop_sv_fields(d, extra):
    ld = clone(d["ld.json"])
    for f in ld["chrom"].values():
        for k in ("category", "marked"):
            (f.get("sv") or {}).pop(k, None)
    return dict(d, **{"ld.json": ld}), extra


def t_drop_impute(d, extra):
    ld = clone(d["ld.json"])
    n = 0
    for f in ld["chrom"].values():
        n += 1 if (f.get("snp") or {}).pop("impute", None) is not None else 0
    if not n:
        print("    (snp.impute is no longer in the data - this rung has already shipped)")
    return dict(d, **{"ld.json": ld}), extra


def t_drop_sv_id(d, extra):
    """sv_id == "{chrom}_sv{sv_index}_{svtype}" on all 10,705 rows, so it need not ship."""
    c = clone(d["catalog.json"])
    cols = c["columns"] if isinstance(c, dict) and "columns" in c else None
    if cols is None:
        raise SystemExit("the catalog is not columnar - this rung expects the shipped shape")
    if "sv_id" not in cols:
        print("    (sv_id is no longer in the catalog - this rung has already shipped)")
        return d, extra
    i = cols.index("sv_id")
    j, k, t = cols.index("chrom"), cols.index("sv_index"), cols.index("svtype")
    bad = sum(1 for r in range(c["rows"])
              if c["data"][i][r] != "%s_sv%s_%s" % (c["data"][j][r], c["data"][k][r],
                                                    c["data"][t][r]))
    if bad:
        raise SystemExit("sv_id is not derivable on %d of %d rows - this rung is invalid"
                         % (bad, c["rows"]))
    c["columns"] = [x for x in cols if x != "sv_id"]
    c["data"] = [col for n, col in enumerate(c["data"]) if n != i]
    return dict(d, **{"catalog.json": c}), extra


# The columns that really are display-only at four decimals. cv_r2, fst and hor_frac are not:
# their smallest values are 3.0e-5, 8.7e-18 and 2.0e-5, all of which 4 dp sends to exactly 0,
# and cv_r2 is the input to the imputation-R2 filter rather than only a number on screen.
SAFE_4DP = ("af_hprc", "af_AFR", "af_AMR", "af_EAS", "af_EUR", "af_SAS", "svfreq")


def t_cat_af_4dp(d, extra):
    c = clone(d["catalog.json"])
    for name in SAFE_4DP:
        if name in c["columns"]:
            i = c["columns"].index(name)
            c["data"][i] = [None if v is None else round(v, 4) for v in c["data"][i]]
    return dict(d, **{"catalog.json": c}), extra


# s2, s5 and s4 have shipped; their rungs would all measure +0 now. What is left:
RUNGS = [
    ("genotypes as raw bytes  [format model]", t_gt_binary, "s3"),
    ("drop sv_id, derive it from chrom/index/type", t_drop_sv_id, "new"),
    ("catalog af_* and svfreq to 4 dp", t_cat_af_4dp, "s5b"),
]

# ------------------------------------------------------------------ cumulative
print("%-46s %5s %10s %9s %9s %8s"
      % ("cumulative change", "plan", "file B", "step", "total", "of file"))
print("%-46s %5s %10d %9s %9s %8s" % ("as published (zopfli)", "-", row0, "-", "-", "-"))
d, extra, prev = dict(obj), b"", row0
for label, fn, plan in RUNGS:
    d, extra = fn(d, extra)
    s = page_len(d, extra)
    print("%-46s %5s %10d %+9d %+9d %7.1f%%"
          % (label, plan, s, s - prev, s - row0, 100.0 * (s - row0) / row0))
    prev = s
full = prev

# ------------------------------------------------------------------ each change alone
# A rung's step depends on everything above it, and the plan plays them in a different order
# again. What ranks the next wave is what each change is worth on its own, against the file
# that ships today - each measured as it would actually ship, which is as text.
print("\n%-46s %5s %10s %9s %8s"
      % ("each change alone, against today's file", "plan", "file B", "saving", "of file"))
alone = []
for label, fn, plan in RUNGS:
    d1, extra1 = fn(dict(obj), b"")
    s = page_len(d1, extra1)
    alone.append((label, s))
    print("%-46s %5s %10d %+9d %7.1f%%"
          % (label, plan, s, s - row0, 100.0 * (s - row0) / row0))

tot_alone = sum(row0 - s for _, s in alone)
print("\nstandalone savings sum to %d B; measured together they are worth %d B."
      % (tot_alone, row0 - full))
print("The %d B difference is redundancy two of them would each have removed."
      % (tot_alone - (row0 - full)))

# ------------------------------------------------------------------ the declined one
# Not a rung: embedding the data as parsed objects removes the browser's second parse, and is
# a different change from any transformation above. Measured on its own, without text.
emb = page_len(dict(obj), b"", zop, as_text=False)
print("\nembed parsed objects instead of JSON text  %10d %+9d %7.1f%%   (declined; the "
      "saving is the second parse, not the bytes)" % (emb, emb - row0, 100.0 * (emb - row0) / row0))

# ------------------------------------------------------------------ the contamination, measured
# The diagnosis for why the old standalone pass over-predicted s2 by 6.4%: putting a file back
# as a parsed object rather than as text is itself a saving, and every rung that touched a file
# was carrying it. This measures that saving directly, per file, changing NOTHING else. If it
# accounts for the gap between what was predicted and what shipped, the diagnosis is measured
# rather than argued.
for name in ("ld.json", "catalog.json"):
    mixed = dict(base_text)
    mixed[name] = obj[name]                      # parsed; every other file still text
    s = page_len(mixed, b"", zop, as_text=False)
    print("parsing %-14s alone, changing nothing: %+d B" % (name, s - row0))

# What the previous compressor would have made of the same two ends, so the zopfli row in
# FINDINGS is a difference between two measurements rather than between two eras.
g_now = page_len(base_text, b"", gz9)
print("\nthe same container under gzip -9: %d B" % g_now)
print("zopfli alone, on today's data:    %+d B (%.2f%%)"
      % (row0 - g_now, 100.0 * (row0 - g_now) / g_now))
