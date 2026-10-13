#!/usr/bin/env python3
"""Open the published build the way a reader does, and check what it actually says.

    python web/tools/verify/verify_shipped_data.py CenSV_offline.html
    CENSV_PW=... python web/tools/verify/verify_shipped_data.py CenSV_locked.html

The form is read off the payload rather than passed in: a container beginning with the magic
CSV1 is decrypted with CENSV_PW, and anything else is gunzipped directly. The open form is
what ships since the preprint posted on 2026-10-13; the locked path is kept because the
builder can still produce one.

The crypto checks that used to run beside this proved the published bytes decrypt to the
container the build produced. That is a statement about the crypto, and it is true of a build
whose data is a month stale - every one of those checks passed without reading a single
number. This reads the numbers.

It exists because that failure happened. On 2026-08-28 the ancestry join was fixed in the ETL
and the site was rebuilt and republished; `npm run build` only COPIES web/public/data, the
deploy did not re-run the ETL, and all seventeen crypto and browser checks passed on a page
still shipping the old labels. The check that caught it is the one below.

Every assertion here is on the container as it comes out of the published file, so it speaks
for the artefact a reader opens rather than for an intermediate nobody sees.
"""
import base64
import gzip
import io
import json
import os
import re
import struct
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

TARGET = sys.argv[1] if len(sys.argv) > 1 else "CenSV_offline.html"

fails, ran = [], []


def check(name, ok, detail):
    ran.append(name)
    print("  %-4s %-46s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


html = io.open(TARGET, encoding="utf-8").read()
m = re.search(r'<script id="payload" type="text/plain">([A-Za-z0-9+/=\s]*)</script>', html)
if not m:
    raise SystemExit("%s has no payload script" % TARGET)
blob = base64.b64decode(m.group(1))
if blob[:4] == b"CSV1":
    PW = os.environ.get("CENSV_PW")
    if not PW:
        raise SystemExit("%s is a locked build; set CENSV_PW to its password" % TARGET)
    iters = struct.unpack("<I", blob[4:8])[0]
    salt, iv, ct = blob[8:24], blob[24:36], blob[36:]
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=iters).derive(PW.strip("\r\n").encode("utf-8"))
    raw = AESGCM(key).decrypt(iv, ct, None)
else:
    raw = blob
container = json.loads(gzip.decompress(raw))
data = {k: json.loads(v) if isinstance(v, str) else v
        for k, v in container["data"].items()}

print("reading %s as a reader would" % os.path.abspath(TARGET))

trk = data.get("tracks.json")
check("1. the container carries the tracks", trk is not None,
      "keys: %s" % ", ".join(sorted(data)))
if trk is None:
    sys.exit(1)

# ---- the ancestry join is TOTAL
#
# Read with .get throughout. A build predating the four-table join has no `n_samples` at all,
# and a check that raises KeyError on the very artefact it exists to reject is a bad
# instrument: it stops the deploy for the wrong stated reason.
a = trk.get("ancestry") or {}
want = ("n_samples", "n_from_panel", "n_unlabelled", "outside_1kgp")
absent = [k for k in want if k not in a]
check("2. the ancestry block has the shipped shape", not absent,
      "%s" % ", ".join(sorted(a)) if not absent
      else "missing %s - this build predates the four-table join" % ", ".join(absent))
check("3. no sample is unlabelled",
      not absent and not a.get("n_unlabelled") and not a.get("unlabelled"),
      "%s of %s samples, %s from the 1kGP panel, %d assigned by hand"
      % (a.get("n_samples", "?"), a.get("n_samples", "?"), a.get("n_from_panel", "?"),
         len(a.get("outside_1kgp") or []))
      if not absent else "%d unlabelled: %s"
      % (a.get("n_unlabelled", 0), (a.get("unlabelled") or [])[:8]))

drawn = sorted({p for n in trk["nhap_anc"].values() for p, v in n.items() if v})
shipped = trk.get("strata") or []
check("4. no chromosome draws an unlabelled stratum",
      "unlabelled" not in drawn and "unlabelled" not in shipped,
      "strata drawn: %s; declared: %s" % (", ".join(drawn), ", ".join(shipped)))

# ---- and the strata still decompose the pooled track, in the shipped numbers
bad = []
for c, counts in trk["density_anc"].items():
    stacked = [0] * trk["nbin"]
    for v in counts.values():
        for i, x in enumerate(v):
            stacked[i] += x
    nhap = sum(trk["nhap_anc"].get(c, {}).values())
    if not nhap:
        continue
    off = max(abs(s / nhap - d) for s, d in zip(stacked, trk["density"][c]))
    if off > 1e-5:
        bad.append("%s %.2e" % (c, off))
check("5. the strata rebuild the pooled track", not bad,
      "%d chromosomes, max bin error below 1e-5" % len(trk["density_anc"])
      if not bad else "off on %s" % ", ".join(bad))

# ---- the hand assignments are named, because the caption has to be able to name them
named = [h for h in (a.get("outside_1kgp") or []) if h.get("sample") and h.get("basis")
         and h.get("superpop")]
check("6. every hand assignment carries its basis",
      len(named) == len(a.get("outside_1kgp") or []),
      "; ".join("%s -> %s (%s)" % (h["sample"], h["superpop"], h["basis"])
                for h in (a.get("outside_1kgp") or [])) or "none")

# ---- a coarse freshness signal: the catalog the manuscript reports
# The catalog ships columnar, so it is rebuilt here the way the browser rebuilds it - a third
# rehydrator beside the ETL's round-trip assertion and build.yml's jq one.
raw_cat = data.get("catalog.json")
if isinstance(raw_cat, dict) and "columns" in raw_cat:
    cols, cdata, nrow = raw_cat["columns"], raw_cat["data"], raw_cat["rows"]
    ragged = [len(c) for c in cdata if len(c) != nrow]
    check("6b. the columnar catalog is not ragged", not ragged and len(cdata) == len(cols),
          "%d columns x %d rows" % (len(cols), nrow) if not ragged
          else "column lengths %r against %d rows" % (sorted(set(ragged))[:4], nrow))
    cat = [dict(zip(cols, vals)) for vals in zip(*cdata)]
elif isinstance(raw_cat, list):
    check("6b. the columnar catalog is not ragged", False,
          "catalog.json is still a row list - this payload predates the columnar writer")
    cat = raw_cat
else:
    cat = []
check("7. the catalog is the size the manuscript reports", len(cat) == 10705,
      "%d rows" % len(cat))

# ---- the LD payload, read the way the browser reads it
import numpy as np                                                          # noqa: E402
import pandas as pd                                                         # noqa: E402

# one reference panel per flank, on the same windows the frames use
PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..",
                   "discovery", "2026-05-19_ld_plot_all_chr", "output",
                   "_ld_reference_g38")
ldp = data.get("ld.json")
check("8. the container carries the LD panel", ldp is not None and len(ldp.get("chrom", {})),
      "%d chromosomes" % len(ldp.get("chrom", {})) if ldp else "absent")


def dosages_raw(f):
    """The state matrix as shipped, 3 still meaning an open call."""
    nrow, m = f["n_sv"] + f["n_snp"], f["n_samples"]
    raw = np.frombuffer(base64.b64decode(f["gt"]), dtype=np.uint8)
    bits = np.unpackbits(raw)[:nrow * m * 2].reshape(-1, 2)
    return (bits[:, 0] + 2 * bits[:, 1]).reshape(nrow, m).astype(float)


def dosages(f):
    """The shipped base64 back to a dosage matrix, exactly as web/src/ld.js reads it.

    Two bits a cell, written least-significant-bit first into a stream packed most-significant
    bit first, so the low bit arrives first. State 3 marks a SNP call the 1000 Genomes panel
    left open, and the dosage substituted for it is the mean of that row's observed calls -
    which is the substitution the published panels correlate.

    That mean is RECOMPUTED here rather than read from the payload, because the payload no
    longer carries it: etl/ld.py asserts it against the source's own value to 1e-8 and then
    drops the column. This function is therefore the same arithmetic web/src/ld.js does, and
    check 11 below compares the result against the published panels.
    """
    nrow, m = f["n_sv"] + f["n_snp"], f["n_samples"]
    raw = np.frombuffer(base64.b64decode(f["gt"]), dtype=np.uint8)
    bits = np.unpackbits(raw)[:nrow * m * 2].reshape(-1, 2)
    g = (bits[:, 0] + 2 * bits[:, 1]).reshape(nrow, m).astype(float)
    if f["n_snp"]:
        blk = g[f["n_sv"]:]
        open_call = blk == 3
        seen = (~open_call).sum(axis=1)
        imp = np.where(open_call, 0.0, blk).sum(axis=1) / np.maximum(seen, 1)
        g[f["n_sv"]:] = np.where(open_call, imp[:, None], blk)
    return g


def rmat(x):
    sd = x.std(axis=1, keepdims=True)
    sd[sd == 0] = 1.0
    z = (x - x.mean(axis=1, keepdims=True)) / sd
    return np.clip((z @ z.T) / x.shape[1], -1.0, 1.0)


if ldp:
    shapes = []
    for c, f in ldp["chrom"].items():
        need = -(-(f["n_sv"] + f["n_snp"]) * f["n_samples"] * 2 // 8)
        got = len(base64.b64decode(f["gt"]))
        if got != need:
            shapes.append("%s %d bytes for %d" % (c, got, need))
    check("9. every genotype block is the size its shape needs", not shapes,
          "%d chromosomes" % len(ldp["chrom"]) if not shapes else ", ".join(shapes[:4]))

    # This used to assert `imputed > 0` under a name promising the open calls carry their
    # variant's MEAN dosage, and the bug its comment cited - imputed cells rounded to whole
    # numbers - leaves the missing counts untouched and passed it. The substituted dosage is
    # no longer shipped, so what the payload can still be held to is the PRECONDITION for
    # recomputing it: every SNP row needs at least one observed call, or the mean it is
    # replaced with is undefined and the row silently becomes zeros.
    imputed = sum(sum(f["snp"]["missing"]) for f in ldp["chrom"].values() if f["n_snp"])
    cells = sum(f["n_snp"] * f["n_samples"] for f in ldp["chrom"].values())
    blind = []
    for c, f in ldp["chrom"].items():
        if not f["n_snp"]:
            continue
        blk = dosages_raw(f)[f["n_sv"]:]
        n = int(((blk == 3).sum(axis=1) == f["n_samples"]).sum())
        if n:
            blind.append("%s %d rows" % (c, n))
    check("10. every SNP row has an observed call to take the mean of", not blind,
          "%s of %s SNP calls open (%.0f%%), 0 rows open in every sample"
          % ("{:,}".format(imputed), "{:,}".format(cells),
             100.0 * imputed / max(cells, 1)) if not blind else ", ".join(blind[:4]))

    worst, worst_c, checked, bad = 0.0, "", 0, []
    for c, side in [(c, s) for c in sorted(ldp["chrom"]) for s in ("L", "R")]:
        d = os.path.join(PUB, c, side)
        if not os.path.isdir(d):
            continue
        vf = sorted(x for x in os.listdir(d) if x.endswith("_variants.tsv"))
        rf = sorted(x for x in os.listdir(d) if x.endswith("_r.tsv.gz"))
        if not vf or not rf:
            continue
        f = ldp["chrom"][c]
        g = dosages(f)
        pv = pd.read_csv(os.path.join(d, vf[0]), sep="\t")
        R = pd.read_csv(os.path.join(d, rf[0]), sep="\t", index_col=0).to_numpy(float)
        # An SV key needs its frequency as well as its coordinate: this catalog carries one
        # locus at up to four decomposition modes, and a coordinate alone hands a column the
        # genotypes of a different variant at the same base pair.
        ours = {}
        for i in range(f["n_sv"]):
            ours.setdefault(("sv", f["sv"]["pos"][i], f["sv"]["end"][i],
                             f["sv"]["svtype"][i], round(f["sv"]["maf"][i], 4)), i)
        # The payload's SNP positions are deltas over the shipped order, so they are
        # rebuilt here the way ld.js rebuilds them. This is the only check that reads them
        # from the payload rather than through ld.js.
        spos, acc = [], 0
        for dx in (f["snp"]["pos"] if f["n_snp"] else []):
            acc += dx
            spos.append(acc)
        for i in range(f["n_snp"]):
            ours[("snp", spos[i])] = f["n_sv"] + i
        pairs = []
        for row in pv.itertuples():
            af = float(row.af)
            k = (("snp", int(row.pos)) if row.source == "peri_snp"
                 else ("sv", int(row.pos), int(row.end), row.svtype,
                       round(min(af, 1.0 - af), 4)))
            if k in ours:
                pairs.append((int(row.Index), ours[k]))
        if len(pairs) < 3:
            continue
        pi = [a for a, _ in pairs]
        oi = [b for _, b in pairs]
        err = float(np.nanmax(np.abs(rmat(g[oi]) - R[np.ix_(pi, pi)])))
        checked += 1
        if err > worst:
            worst, worst_c = err, "%s %s" % (c, side)
        if err > 1e-6:
            bad.append("%s %s %.1e" % (c, side, err))
    check("11. the shipped genotypes reproduce the published panels",
          checked > 0 and not bad,
          "%d flank panels, worst |delta r| = %.1e on %s" % (checked, worst, worst_c)
          if not bad else "off on " + ", ".join(bad[:6]))

print("\n%s  -  %d checks, %d failed"
      % ("ALL PASS" if not fails else "FAILED", len(ran), len(fails)))
sys.exit(1 if fails else 0)
