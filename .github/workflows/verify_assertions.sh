#!/usr/bin/env bash
# Run the build.yml content assertions against the real bake, then against corrupted copies
# of it, and require the corrupted runs to fail. A check that has never been shown to fail
# has not been run.
set -uo pipefail
D="${1:-/tmp/censv_data}"
T=$(mktemp -d)
pass=0; fail=0

chk() {   # chk <label> <expect ok|bad> <file-dir>
  local label="$1" expect="$2" dir="$3" rc=0
  run_all "$dir" >/dev/null 2>&1 || rc=1
  if { [ "$expect" = ok ] && [ $rc -eq 0 ]; } || { [ "$expect" = bad ] && [ $rc -ne 0 ]; }; then
    printf "  %-52s %s\n" "$label" "OK"; pass=$((pass+1))
  else
    printf "  %-52s %s\n" "$label" "*** UNEXPECTED (rc=$rc, wanted $expect)"; fail=$((fail+1))
  fi
}

run_all() {
  local d="$1"
  jq -e '.ancestry.of_170 as $o
    | $o.AMR == 138 and $o.EUR == 12 and $o.AFR == 2
      and $o.EAS == 0 and $o.SAS == 0 and $o.MID == 0' "$d/meta.json" >/dev/null || return 1
  jq -e '.ancestry.cohort | (to_entries | map(.value) | add) == 315204' "$d/meta.json" \
    >/dev/null || return 1
  jq -e '.ancestry.spread | keys == ["0","1"]' "$d/meta.json" >/dev/null || return 1
  local adrift
  adrift=$(jq -n --slurpfile a "$d/ancestry.json" --slurpfile l "$d/layers.json" '
    ($l[0] | map(select(.layer == "aou") | "\(.sv_locus)|\(.phecode)") | INDEX(.)) as $k
    | [$a[0][] | select($k["\(.sv_locus)|\(.phecode)"] == null)] | length') || return 1
  [ "$adrift" = "0" ] || return 1
  jq -e '.catalog_unit.n_predictors == .n_svs' "$d/meta.json" >/dev/null || return 1
  jq -e '.catalog_unit.n_variants > 0 and .catalog_unit.n_variants <= .n_svs'     "$d/meta.json" >/dev/null || return 1
  jq -e '.catalog_unit.substrate_absent == 0' "$d/meta.json" >/dev/null || return 1
  local nvar real
  nvar=$(jq -r '.catalog_unit.n_variants' "$d/meta.json") || return 1
  # The catalog ships columnar; catrows rebuilds the rows this expression was written for.
  real=$(jq "$CATROWS"' | [.[] | "\(.chrom):\(.pos):\(.svtype):\(.svlen)"] | unique | length' "$d/catalog.json") || return 1
  [ "$nvar" = "$real" ] || return 1
  jq -e '(.meth | length) == 23 and (.density | length) == 23' "$d/tracks.json" >/dev/null || return 1
  jq -e '[.meth[] | length] | unique == [60]' "$d/tracks.json" >/dev/null || return 1
  jq -e '[.meth[][] | select(. < 0 or . > 100)] | length == 0' "$d/tracks.json" >/dev/null || return 1
  jq -e '.median_corr < -0.3' "$d/tracks.json" >/dev/null || return 1
  return 0
}

CATROWS='def catrows: .columns as $k | (.data | transpose) | map(with_entries(.key = $k[.key]));'

command -v jq >/dev/null || { echo "jq is NOT installed - these checks would all pass by erroring"; exit 2; }
echo "jq $(jq --version)"
echo
echo "baseline (must pass):"
chk "the real bake" ok "$D"

echo
echo "negative controls (each must FAIL):"
for case in unit substrate nvar of170 cohort spread adrift bins range corr; do
  rm -rf "$T/$case"; mkdir -p "$T/$case"; cp "$D"/*.json "$T/$case/"
  case "$case" in
    unit)   jq '.catalog_unit.n_predictors = 9999' "$D/meta.json" > "$T/$case/meta.json" ;;
    substrate) jq '.catalog_unit.substrate_absent = 3' "$D/meta.json" > "$T/$case/meta.json" ;;
    nvar)   jq '.catalog_unit.n_variants = 8791' "$D/meta.json" > "$T/$case/meta.json" ;;
    of170)  jq '.ancestry.of_170.AMR = 137' "$D/meta.json" > "$T/$case/meta.json" ;;
    cohort) jq '.ancestry.cohort.EUR = 177231' "$D/meta.json" > "$T/$case/meta.json" ;;
    spread) jq '.ancestry.spread["2"] = 1' "$D/meta.json" > "$T/$case/meta.json" ;;
    adrift) jq '.[0].phecode = "NOT_A_PHECODE"' "$D/ancestry.json" > "$T/$case/ancestry.json" ;;
    bins)   jq '.meth.chr1 = (.meth.chr1[0:59])' "$D/tracks.json" > "$T/$case/tracks.json" ;;
    range)  jq '.meth.chr1[0] = 140' "$D/tracks.json" > "$T/$case/tracks.json" ;;
    corr)   jq '.median_corr = 0.2' "$D/tracks.json" > "$T/$case/tracks.json" ;;
  esac
  chk "$case corrupted" bad "$T/$case"
done

echo
echo "$pass passed, $fail unexpected"
rm -rf "$T"
[ "$fail" -eq 0 ]
