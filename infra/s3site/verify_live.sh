#!/usr/bin/env bash
# Assert the LIVE site is correct, not merely reachable.
#
#   verify_live.sh <base-url>          # run from inside the Emory network
#
# These are the same content assertions build.yml runs against the container, pointed at the
# deployed bucket instead. A 200 on index.html proves nothing about whether the catalog
# arrived intact, and a truncated upload returns 200 for every file in it.
#
# --compressed is not optional: data/*.json are stored pre-gzipped with Content-Encoding,
# because S3 has no on-the-fly compression the way the container's nginx did.
set -uo pipefail
U="${1:?usage: verify_live.sh <base-url>}"
fail=0
ok()  { printf "  PASS  %s\n" "$1"; }
bad() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
g()   { curl -s --compressed --max-time 60 "$U$1"; }

echo "== reachability and shape"
curl -s --max-time 30 "$U/index.html" | grep -q "CenSV" && ok "index mentions CenSV" || bad "index missing"

META=$(g /data/meta.json)
echo "$META" | jq -e '.n_svs > 0' >/dev/null 2>&1 && ok "meta.n_svs > 0" || bad "meta.n_svs"
echo "$META" | jq -e '.coordinate_system == "T2T-CHM13 v2.0"' >/dev/null 2>&1 \
  && ok "coordinate system" || bad "coordinate system"

# The catalog ships columnar - one array per field. This rebuilds the rows every
# expression below was written against.
CATROWS='def catrows: .columns as $k | (.data | transpose) | map(with_entries(.key = $k[.key]));'

echo "== the catalog arrived whole"
NM=$(echo "$META" | jq -r '.n_svs')
NR=$(g /data/catalog.json | jq "$CATROWS"' | length' 2>/dev/null)
[ "$NM" = "$NR" ] && ok "catalog holds $NR rows, matching meta" || bad "meta $NM vs catalog $NR"

echo "== gzip is actually applied (3.8 MB uncompressed)"
CE=$(curl -s -o /dev/null -D - --max-time 40 "$U/data/catalog.json" | tr -d '\r' | grep -i '^content-encoding:')
echo "$CE" | grep -qi gzip && ok "catalog served $CE" || bad "catalog NOT gzipped"

echo "== the published counts still reproduce"
echo "$META" | jq -e '
  ([.layers[] | select(.key == "eqtl")] | .[0].tiers.primary == 86)
  and ([.layers[] | select(.key == "sqtl")] | .[0].tiers.primary == 74)
  and ([.layers[] | select(.key == "aou")]  | .[0].tiers.primary == 170)
  and ([.layers[] | select(.present | not)] | length == 0)' >/dev/null 2>&1 \
  && ok "86 eGenes / 74 sGenes / 170 PheWAS, 5 of 5 layers present" || bad "published counts"

echo "== per-ancestry, the thing added today"
echo "$META" | jq -e '.ancestry.of_170 | .AMR == 138 and .EUR == 12 and .AFR == 2' >/dev/null 2>&1 \
  && ok "AMR 138 / EUR 12 / AFR 2" || bad "per-ancestry counts"
TR=$(g /data/tracks.json)
echo "$TR" | jq -e '.strata == ["AFR","AMR","EAS","EUR","SAS","unlabelled"]' >/dev/null 2>&1 \
  && ok "six ancestry strata" || bad "strata"
echo "$TR" | jq -e '(.density_anc | length) == 23 and (.nhap_anc | length) == 23' >/dev/null 2>&1 \
  && ok "ancestry split covers 23 centromeres" || bad "ancestry coverage"
# the decomposition property, re-checked against what is actually SERVED
BADC=$(echo "$TR" | jq -r '. as $t | [ $t.nhap_anc | to_entries[]
  | select((.value | add) != $t.chrom[.key].n_hap) | .key ] | length')
[ "$BADC" = "0" ] && ok "strata partition the cohort on all 23" || bad "$BADC chromosomes do not partition"

echo "== every hit joins to a catalog row"
ORPH=$(jq -n --slurpfile c <(g /data/catalog.json) --slurpfile l <(g /data/layers.json) \
  "$CATROWS"'
  ($c[0] | catrows | map("\(.chrom):\(.sv_index)") | INDEX(.)) as $k
  | [$l[0][] | select($k["\(.chrom):\(.sv_index)"] == null)] | length' 2>/dev/null)
[ "$ORPH" = "0" ] && ok "0 orphaned hits" || bad "$ORPH hits reference absent SVs"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED against the live site" || echo "$fail CHECK(S) FAILED"
exit $fail
