"""How much per-ancestry resolution the dip track would actually have.

Reports, per superpopulation: haplotypes contributing calls, total dips, and dips per 60-bin
histogram cell on a single chromosome. The last number is the one that decides the question.

The ancestry map comes from `tracks.resolve_ancestry()`, not from a second join written here.
That is deliberate. This file used to re-derive the labels from the 1kGP panel alone, which is
how it came to report an "unknown" stratum of 7 samples that are not unknown at all - the same
bug the browser shipped. A sizing measurement that does not use the shipped join is measuring
a cohort the browser does not draw.
"""
import collections
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tracks                                                              # noqa: E402

DIPS = ("/beegfs/labs/weinstocklab/projects/ydon268/Project1_Centromere/discovery/"
        "2026-08-20_cdr_length_frame_rederivation/output/phenotypes/per_dip_positions.tsv")

with open(DIPS) as fh:
    rows = list(csv.DictReader(fh, delimiter="\t"))

sup, basis, hand, panel_pop, why = tracks.resolve_ancestry(
    sorted({r["sample"] for r in rows}))
if sup is None:
    raise SystemExit("ancestry could not be resolved, so there is nothing to size: %s" % why)

hap = collections.defaultdict(set)      # superpop -> {(sample, hap)}
dips = collections.Counter()            # superpop -> n dips
per_chrom = collections.defaultdict(lambda: collections.defaultdict(set))
chrom_dips = collections.defaultdict(collections.Counter)

for r in rows:
    p = sup[r["sample"]]
    key = (r["sample"], r["hap_local"])
    hap[p].add(key)
    dips[p] += 1
    per_chrom[r["chm13_chrom"]][p].add(key)
    chrom_dips[r["chm13_chrom"]][p] += 1

order = sorted(hap, key=lambda p: -len(hap[p]))
print("cohort-wide, all chromosomes pooled")
print("%-8s %8s %8s %8s" % ("stratum", "haps", "dips", "dips/hap"))
for p in order:
    print("%-8s %8d %8d %8.1f" % (p, len(hap[p]), dips[p], dips[p] / len(hap[p])))
print("samples: %d, of which %d come from the 1kGP panel and %d are assigned by hand (%s)"
      % (len(sup), sum(1 for s in sup if s in panel_pop), len(hand),
         ", ".join("%s=%s" % (s, sup[s]) for s in hand)))

print()
print("chr8 - the chromosome the CDR section reports on - 60 bins")
c = "chr8"
print("%-8s %8s %8s %14s" % ("stratum", "haps", "dips", "dips per bin"))
for p in order:
    n = chrom_dips[c].get(p, 0)
    print("%-8s %8d %8d %14.2f" % (p, len(per_chrom[c].get(p, ())), n, n / 60.0))

print()
print("worst and best chromosome for the smallest stratum")
small = order[-1]
vals = sorted((chrom_dips[c].get(small, 0), c) for c in per_chrom)
print("smallest stratum: %s" % small)
for n, c in vals[:3] + vals[-3:]:
    print("  %-6s %4d dips  %5.2f per bin" % (c, n, n / 60.0))
