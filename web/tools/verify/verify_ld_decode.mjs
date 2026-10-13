/**
 * The browser's own decoder, held against the published LD matrices.
 *
 *     pixi run node web/tools/verify/verify_ld_decode.mjs
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ETL CHECK
 * ---------------------------------------------
 * etl/ld.py already asserts that r recomputed from the extracted genotypes reproduces the
 * manuscript's panels. It does that in numpy, through the same array code that wrote the
 * packed bytes, so it proves the extraction is the right measurement and says nothing about
 * whether the browser reads those bytes back correctly. The packing is two bits per dosage
 * written least-significant-bit-first into a stream that is read most-significant-bit-first,
 * so 1 and 2 change places if the reader takes the pair in the obvious order - and a panel
 * built on swapped heterozygotes and homozygotes would still be a smooth, plausible,
 * completely wrong triangle.
 *
 * So this loads web/src/ld.js itself - the module the browser ships - decodes
 * web/public/data/ld.json with it, and requires the r it produces to match the published
 * matrices on every variant the two share. It runs without a browser, so the deploy can run
 * it beside the ETL rather than only on a machine with Chrome.
 *
 * Exits non-zero on any mismatch.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as LD from "../../src/ld.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "public", "data");
// one reference panel per flank, on the same windows the frames use
const PUB = path.join(HERE, "..", "..", "..", "..", "discovery", "2026-05-19_ld_plot_all_chr",
  "output", "_ld_reference_g38");
const TOL = 1e-6;

const ld = JSON.parse(fs.readFileSync(path.join(WEB, "ld.json"), "utf-8"));

/** A tab-separated table as an array of objects, keyed by its header row. */
function tsv(text) {
  const lines = text.split("\n").filter((l) => l.length);
  const head = lines[0].split("\t");
  return lines.slice(1).map((l) => {
    const f = l.split("\t");
    const o = {};
    head.forEach((h, i) => { o[h] = f[i]; });
    return o;
  });
}

let checked = 0, pairs = 0, worst = 0, worstAt = "", bad = [], skipped = [];

const targets = [];
for (const chrom of Object.keys(ld.chrom).sort()) for (const side of ["L", "R"]) {
  targets.push([chrom, side]);
}
for (const [chrom, side] of targets) {
  const dir = path.join(PUB, chrom, side);
  if (!fs.existsSync(dir)) { skipped.push(chrom + side); continue; }
  const files = fs.readdirSync(dir);
  const vf = files.filter((f) => f.endsWith("_variants.tsv")).sort()[0];
  const rf = files.filter((f) => f.endsWith("_r.tsv.gz")).sort()[0];
  if (!vf || !rf) { skipped.push(chrom + side); continue; }

  const pv = tsv(fs.readFileSync(path.join(dir, vf), "utf-8"));
  const rt = tsv(zlib.gunzipSync(fs.readFileSync(path.join(dir, rf))).toString("utf-8"));
  const cols = Object.keys(rt[0]).slice(1);
  const R = rt.map((row) => cols.map((c) => parseFloat(row[c])));

  const frame = LD.frameOf(ld, chrom);
  if (!frame) { bad.push(`${chrom}: the payload carries no frame`); continue; }
  void side;

  // Published column -> frame variant. SNPs key on position, which is unique inside a 100 kb
  // window; SVs key on the coordinate, type and frequency together, because this catalog
  // carries one locus at up to four decomposition modes and a coordinate alone would hand a
  // column the genotypes of a different variant at the same base pair.
  const bySnp = new Map();
  const bySv = new Map();
  frame.variants.forEach((v, i) => {
    if (v.kind === "snp") bySnp.set(v.pos, i);
    else bySv.set(`${v.pos}|${v.end}|${v.svtype}|${v.maf.toFixed(4)}`, i);
  });

  const map = [];
  pv.forEach((row, i) => {
    if (row.source === "peri_snp") {
      const j = bySnp.get(+row.pos);
      if (j != null) map.push([i, j]);
      return;
    }
    const af = parseFloat(row.af);
    const maf = Math.min(af, 1 - af);
    const j = bySv.get(`${row.pos}|${row.end}|${row.svtype}|${maf.toFixed(4)}`);
    if (j != null) map.push([i, j]);
  });
  if (map.length < 3) { skipped.push(`${chrom}${side} (${map.length} shared)`); continue; }

  let mx = 0, mxAt = "";
  for (let a = 0; a < map.length; a++) {
    for (let b = a; b < map.length; b++) {
      const got = a === b ? 1 : LD.rOf(frame, map[a][1], map[b][1]);
      const want = R[map[a][0]][map[b][0]];
      const d = Math.abs(got - want);
      pairs++;
      if (d > mx) { mx = d; mxAt = `${map[a][0]},${map[b][0]}`; }
    }
  }
  checked++;
  if (mx > worst) { worst = mx; worstAt = `${chrom} ${side} cells ${mxAt}`; }
  const ok = mx <= TOL;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${(chrom + " " + side).padEnd(8)}`
    + ` ${String(map.length).padStart(4)}`
    + ` shared variants   max |delta r| = ${mx.toExponential(2)}`);
  if (!ok) bad.push(`${chrom} ${side}: max |delta r| = ${mx.toExponential(3)} at ${mxAt}`);
}

console.log();
if (skipped.length) console.log("  no reference panel: " + skipped.join(", "));
console.log(`  ${checked} flank panels, ${pairs.toLocaleString("en-US")} cells compared, `
  + `worst |delta r| = ${worst.toExponential(2)} (${worstAt})`);
// A run that compared nothing must not report a pass. The reference panels live OUTSIDE
// this repository - three levels up, in the analysis tree - so on a fresh clone, in CI, or
// after that tree moves, every target hits the `continue`s above, `bad` stays empty, and
// this printed "ALL PASS" and exited 0. verify_shipped_data.py gets the identical comparison
// right (`checked > 0 and not bad`); this is that guard, here.
if (!checked) {
  console.log("\nFAILED\n  0 flank panels compared, so nothing was checked."
    + `\n  No reference panels under ${PUB}`
    + "\n  This is the state the check exists to catch, not a clean run.");
  process.exit(1);
}
if (bad.length) {
  console.log("\nFAILED\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`\nALL PASS - the browser's decoder reproduces the published panels`
  + ` (${checked} flank panels)`);
