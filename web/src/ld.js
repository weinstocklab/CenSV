/**
 * Pericentromeric linkage disequilibrium, computed here in the browser.
 *
 * WHY THE CORRELATIONS ARE COMPUTED RATHER THAN SHIPPED
 * -----------------------------------------------------
 * etl/ld.py ships genotypes: every SV in this catalog and every 1000 Genomes SNP at MAF >= 1%
 * in the 100 kb window outside each GRCh38 centromere edge, left and right, on the individuals
 * the assembly and 1000G cohorts share, two bits each. (It read "the 100 kb window upstream of
 * the active-HOR start" - the pre-2026-08-29 behaviour, which took a CHM13 coordinate and
 * queried a GRCh38 panel at it.) A shipped correlation matrix would have had to be
 * capped - 9,177 KB uncapped, and 0.44 px per column on chr1 - and every cap is a selection
 * made on the reader's behalf. Computing r here turns "how many variants" into a display
 * choice the reader makes with a control, and leaves the substrate whole.
 *
 * THE GEOMETRY IS THE PUBLISHED ONE
 * ---------------------------------
 * Same as discovery/2026-05-19_ld_plot_all_chr/code/plot_sv_ld_pubfig.py: the diagonal runs
 * along one edge and the apex is the most distant pair, cell (i, j) has its CENTRE at
 * x = (i + j + 1) / 2 and y = (j - i) / 2 in column units, and the colour is matplotlib
 * coolwarm over signed r clipped to (-1, 1). The colour table below was generated from that
 * same colormap, so a colour here means the same r as a colour in the manuscript figure.
 *
 * Its top CORNER is at x = (i + j) / 2, which is the form the region outlines use, because
 * an outline has to meet the block edge rather than the first cell's middle. Both appear
 * below; they are the same geometry read at two points.
 *
 * The one departure: the triangle HANGS. The diagonal runs along the top and the apex points
 * down, so the panel reads downward from the genomic axis the way the tracks above it do.
 * Mirroring y leaves every cell's (i, j) and every colour untouched.
 *
 * WHY A CANVAS RASTER RATHER THAN ONE POLYGON PER CELL
 * ----------------------------------------------------
 * chr1 draws 3,906 columns, which is 7.6 million cells. The raster walks output pixels and
 * inverts the geometry to find the cell under each one, so its cost follows the size of the
 * figure and not the size of the matrix: about 350,000 pixels either way. Where a cell is
 * wider than a pixel, a cache keeps each r to one computation; where the columns run finer
 * than the screen, each pixel reports the one pair nearest its centre, and the caption in
 * main.js says so at the density where it starts to matter.
 */
import { css, esc } from "./dom.js";

// matplotlib coolwarm at 65 stops, r = -1 at the first and r = +1 at the last. Generated with
// `matplotlib.colormaps["coolwarm"]` from the project environment that renders the published
// panels, so the two figures share a scale exactly.
const COOLWARM = new Uint8Array([
  59, 76, 192, 63, 83, 198, 68, 90, 204, 73, 97, 210, 78, 104, 216,
  83, 110, 221, 88, 117, 225, 93, 124, 230, 98, 130, 234, 103, 136, 238,
  108, 143, 241, 114, 149, 244, 119, 154, 247, 125, 160, 249, 130, 166, 251,
  136, 171, 253, 141, 176, 254, 147, 181, 254, 152, 185, 255, 158, 190, 255,
  163, 194, 254, 169, 198, 253, 174, 201, 252, 179, 205, 251, 185, 208, 249,
  190, 210, 246, 195, 213, 244, 199, 215, 240, 204, 217, 237, 209, 218, 233,
  213, 219, 229, 217, 220, 225, 221, 220, 220, 225, 218, 214, 229, 216, 209,
  233, 213, 203, 236, 211, 197, 239, 207, 191, 241, 204, 184, 243, 200, 178,
  245, 196, 172, 246, 191, 166, 247, 186, 159, 247, 181, 153, 247, 176, 147,
  247, 170, 140, 246, 165, 134, 245, 159, 128, 244, 152, 122, 242, 146, 116,
  240, 139, 110, 238, 132, 104, 235, 125, 98, 232, 118, 92, 228, 110, 86,
  225, 103, 81, 221, 95, 75, 216, 86, 70, 212, 78, 65, 207, 69, 60,
  202, 59, 55, 196, 48, 50, 190, 36, 46, 184, 18, 42, 180, 4, 38,
]);
const STOPS = COOLWARM.length / 3;

/** The colour the published panels give this r, as a CSS string. */
export function colourOf(r) {
  const k = lutIndex(r) * 3;
  return `rgb(${COOLWARM[k]},${COOLWARM[k + 1]},${COOLWARM[k + 2]})`;
}

function lutIndex(r) {
  const t = Math.round(((r < -1 ? -1 : r > 1 ? 1 : r) + 1) / 2 * (STOPS - 1));
  return t < 0 ? 0 : t > STOPS - 1 ? STOPS - 1 : t;
}

/** #rgb, #rrggbb or rgb(...) to a triple, so canvas fills can use the theme's own tokens. */
function rgbOf(v) {
  const s = String(v || "").trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const w = h.length === 3
      ? [h[0] + h[0], h[1] + h[1], h[2] + h[2]] : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
    return w.map((x) => parseInt(x, 16) || 0);
  }
  const m = s.match(/-?\d+(\.\d+)?/g) || [];
  return [+m[0] || 0, +m[1] || 0, +m[2] || 0];
}

// ------------------------------------------------------------------ the substrate
function bytesOf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Two bits per genotype, and the pair reads back reversed.
 *
 * The packer wrote each dosage least-significant bit first (`bitorder="little"`) into a bit
 * stream that `np.packbits` then filled most-significant bit first. So the two bits of one
 * dosage arrive as (low, high) inside a byte that is read (high, low): 1 and 2 swap places.
 *
 * State 3 is a SNP call the 1000 Genomes panel left open. 540,007 of the 7,656,648 SNP calls
 * in these windows are open - 7.05%, and 14.2% on chr1, which is the worst - and the source's
 * own loader replaces each with its variant's mean dosage before correlating, so this decoder
 * puts the same value back. Rounding those cells to whole dosages instead is what an earlier
 * extractor did, and it moved 98% of chr8's SNP correlations by up to 0.37.
 *
 * These figures were 'roughly half, and chr8 alone has 28,950 of 55,272'. That described the
 * extraction whose SNP window was anchored on the CHM13 active-HOR start and queried against
 * GRCh38 - a coordinate mismatch fixed on 2026-08-29. chr8 now has 98 open calls of 90,240,
 * 0.11%. The mechanism is unchanged and still load-bearing; only the numbers were stale.
 */
const PAIR = [0, 2, 1, 3];
const MISSING = 3;

/**
 * Row-standardised genotypes, scaled so a dot product IS Pearson r.
 *
 * With w = (x - mean) / (sd * sqrt(m)) and sd the population standard deviation, w_i . w_j is
 * exactly the r that etl/ld.py computes and asserts against the published panels. Doing the
 * scaling once per row turns every later correlation into m multiply-adds.
 */
function standardise(bytes, nrow, m) {
  const z = new Float32Array(nrow * m);
  for (let row = 0; row < nrow; row++) {
    const base = row * m;
    // The dosage that stands in for a call the panel left open is the mean of that row's
    // OBSERVED calls, so it does not have to ship - one pass to find it, one to apply it.
    // etl/ld.py asserts the identity against the source's own value before dropping
    // the column - they agree to 8.9e-16, and the build fails above 1e-12 - so this
    // is a recomputation of a checked quantity, not a guess at one.
    let obs = 0;
    let seen = 0;
    for (let k = 0; k < m; k++) {
      const cell = base + k;
      const raw = PAIR[(bytes[cell >> 2] >> (6 - ((cell & 3) << 1))) & 3];
      if (raw !== MISSING) { obs += raw; seen += 1; }
    }
    // SV rows have no open calls, so this is their own mean and is never read.
    const fill = seen ? obs / seen : 0;
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const cell = base + k;
      const raw = PAIR[(bytes[cell >> 2] >> (6 - ((cell & 3) << 1))) & 3];
      const v = raw === MISSING ? fill : raw;
      z[cell] = v;
      sum += v;
    }
    const mean = sum / m;
    let ss = 0;
    for (let k = 0; k < m; k++) {
      const d = z[base + k] - mean;
      z[base + k] = d;
      ss += d * d;
    }
    const sd = Math.sqrt(ss / m);
    const f = sd > 0 ? 1 / (sd * Math.sqrt(m)) : 0;
    for (let k = 0; k < m; k++) z[base + k] *= f;
  }
  return z;
}

/**
 * Raw dosages, one row per variant and one column per individual, 3 for an open SNP call.
 *
 * standardise() is the wrong substrate for a per-individual view and would be quietly wrong
 * rather than visibly so: it removes each row's mean, so a cell there reads how far one
 * person sits from the cohort at that variant, not how many copies they carry. Painting an
 * array needs the copies. Decoded once per frame with the same bit arithmetic, and cached
 * beside the standardised copy so a page that wants both pays for each once.
 */
export function dosages(frame) {
  if (!frame.raw.__dose) {
    const bytes = bytesOf(frame.raw.gt);
    const n = (frame.nsv + frame.nsnp) * frame.m;
    const out = new Uint8Array(n);
    for (let cell = 0; cell < n; cell++) {
      out[cell] = PAIR[(bytes[cell >> 2] >> (6 - ((cell & 3) << 1))) & 3];
    }
    Object.defineProperty(frame.raw, "__dose", { value: out, enumerable: false });
  }
  return frame.raw.__dose;
}

/** The individuals behind one frame's columns, in column order. */
export function samplesOf(ld, chrom) {
  const f = ld && ld.chrom ? ld.chrom[chrom] : null;
  if (!f || !ld.samples || !f.cols) return null;
  return f.cols.map((i) => ld.samples[i]);
}

/**
 * One chromosome's variants, merged into CHM13 position order.
 *
 * The payload holds the SV rows first and the SNP rows second; sorting them together puts the
 * columns in genomic order, which is what makes the base-pair fan above the triangle a
 * stretch of one axis into another rather than a scramble. The pericentromeric SNPs sit
 * upstream of the array, so they take the left of the figure, exactly as in the published
 * panels.
 */
export function frameOf(ld, chrom) {
  const f = ld && ld.chrom ? ld.chrom[chrom] : null;
  if (!f) return null;
  if (f.__frame) return f.__frame;
  const v = [];
  for (let i = 0; i < f.n_sv; i++) {
    v.push({
      row: i, kind: "sv", pos: f.sv.pos[i], end: f.sv.end[i], id: f.sv.sv_id[i],
      maf: f.sv.maf[i], thin: !!f.sv.thin[i],
      svtype: f.sv.svtype[i],
    });
  }
  // Positions ship as deltas over this order - the first absolute, the rest differences -
  // because consecutive pericentromeric SNPs are a few hundred bases apart and a difference
  // is two or three digits where an absolute is eight. Rebuilt once, here; everything
  // downstream sees absolute coordinates.
  const spos = new Array(f.n_snp);
  for (let i = 0, acc = 0; i < f.n_snp; i++) {
    acc += f.snp.pos[i];
    spos[i] = acc;
  }
  for (let i = 0; i < f.n_snp; i++) {
    v.push({
      row: f.n_sv + i, kind: "snp", side: f.snp.side ? f.snp.side[i] : "L",
      pos: spos[i], end: spos[i],
      id: chrom + ":" + spos[i], maf: f.snp.maf[i], thin: !!f.snp.thin[i],
      missing: f.snp.missing ? f.snp.missing[i] : 0,
    });
  }
  // Block first, position second. A SNP position is GRCh38 and an SV position CHM13 v2.0, so
  // ordering the whole list by position would be a comparison between two assemblies - and
  // where a flank is re-anchored megabases out, it would interleave that flank with the array.
  v.forEach((x) => { x.block = x.kind === "sv" ? 1 : (x.side === "R" ? 2 : 0); });
  v.sort((a, b) => a.block - b.block || a.pos - b.pos || a.end - b.end);
  const frame = {
    chrom, raw: f, variants: v, m: f.n_samples, nsv: f.n_sv, nsnp: f.n_snp, z: null,
    byId: new Map(v.map((x, k) => [x.id, k])),
  };
  Object.defineProperty(f, "__frame", { value: frame, enumerable: false });
  return frame;
}

function zOf(frame) {
  if (!frame.z) {
    frame.z = standardise(bytesOf(frame.raw.gt), frame.nsv + frame.nsnp, frame.m);
  }
  return frame.z;
}

/** Pearson r between two variants, by their index into frame.variants. */
export function rOf(frame, a, b) {
  const z = zOf(frame), m = frame.m;
  const p = frame.variants[a].row * m, q = frame.variants[b].row * m;
  let s = 0;
  for (let k = 0; k < m; k++) s += z[p + k] * z[q + k];
  return s < -1 ? -1 : s > 1 ? 1 : s;
}

/** One variant's r against a whole list of others, in that list's order. */
export function rowOf(frame, a, idx) {
  const z = zOf(frame), m = frame.m, p = frame.variants[a].row * m;
  const out = new Float32Array(idx.length);
  for (let t = 0; t < idx.length; t++) {
    const q = frame.variants[idx[t]].row * m;
    let s = 0;
    for (let k = 0; k < m; k++) s += z[p + k] * z[q + k];
    out[t] = s < -1 ? -1 : s > 1 ? 1 : s;
  }
  return out;
}

// ------------------------------------------------------------------ what to draw
/**
 * Three display selections, each one rule stated in full, widening left to right.
 *
 * The shipped substrate holds every variant, so these narrow the DRAWING and leave the data
 * whole - which is the reason for shipping genotypes in the first place.
 */
export const MODES = [
  ["common", "Common SVs + common SNPs",
    "everything at MAF 5% and above, of both kinds: the columns r is best estimated on"],
  ["sv", "SVs only",
    "every catalog SV including the rare ones, so the array's structure fills the width"],
  ["all", "All variants",
    "every catalog SV and every pericentromeric SNP on this chromosome"],
];

/**
 * The three kinds of pair the triangle holds, in the order the key lists them.
 *
 * Which two blocks a cell joins decides what it can mean: an SV x SV correlation is two
 * array variants travelling together, an SV x SNP one is an array variant travelling with a
 * flanking haplotype, and a SNP x SNP one is the flank's own background. The colour scale
 * carries r and cannot carry this, so the regions are outlined instead.
 */
export const REGIONS = [
  ["sv-sv", "SV \u00d7 SV", "#c0392b"],
  ["sv-snp", "SV \u00d7 SNP", "#6c3baa"],
  ["snp-snp", "SNP \u00d7 SNP", "#a8763c"],
];
const REGION_COLOUR = Object.fromEntries(REGIONS.map(([k, , c]) => [k, c]));

/** The view a reader lands on. */
export const DEFAULT_MODE = "common";

/** The column list for a mode, as indices into frame.variants, in position order. */
export function select(frame, mode) {
  const all = frame.variants.map((_, i) => i);
  let keep = all;
  if (mode === "common") {
    // `thin` marks the variants BELOW the MAF threshold, so the common ones are the ones it
    // leaves unmarked. r on a rare column rests on a handful of carriers.
    keep = all.filter((i) => !frame.variants[i].thin);
  } else if (mode === "sv") {
    keep = all.filter((i) => frame.variants[i].kind === "sv");
  }
  keep = keep.slice().sort((a, b) => frame.variants[a].block - frame.variants[b].block
    || frame.variants[a].pos - frame.variants[b].pos
    || frame.variants[a].end - frame.variants[b].end);
  return Int32Array.from(keep);
}

// ------------------------------------------------------------------ the triangle
const W = 1180, PAD = 6;
const BW = W - 2 * PAD, X0 = PAD;
// The strip sits on top and the triangle hangs from it: BASE is the diagonal, i = j, and the
// apex is BASE + H below it. The panel then reads downward from the axis, like the tracks.
const STRIP_Y = 3, STRIP_H = 9;
const BASE = STRIP_Y + STRIP_H + 4, H = BW / 2;
const CH = BASE + H + 3;
// Above this many columns the r cache would want more memory than the figure is worth, and
// the cells have run finer than a pixel anyway, so each pixel is computed once and directly.
const CACHE_MAX = 1400;
const SVG = "http://www.w3.org/2000/svg";

const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  kids.flat().filter((c) => c != null && c !== false).forEach((c) => n.append(c));
  return n;
};
const svgText = (attrs, text) => {
  const n = svg("text", attrs);
  n.textContent = text;
  return n;
};

const fmtBp = (bp) => (bp / 1e6).toFixed(3) + " Mb";
// The SNP block is called against GRCh38 and the SV block against CHM13 v2.0, so a position
// only means something beside the assembly it is in - and a base-pair distance between one of
// each is a subtraction across two genomes, which is why the tooltip below reports a distance
// only when both variants sit in the same one.
const asmOf = (v) => (v.kind === "sv" ? "CHM13" : "GRCh38");
const labelOfVariant = (v) => (v.kind === "sv" ? v.id : v.id + " SNP");

/**
 * The panel: a rasterised triangle, the column strip under it, and an overlay carrying the
 * landmarks that have to sit on top of the ink.
 *
 * Returns the node and the geometry the caption needs, so the reader-visible copy can state
 * the column count and the drawn density from the same numbers the drawing used.
 */
export function triangle(frame, idx, hooks = {}) {
  const n = idx.length;
  const cell = BW / n;
  const V = frame.variants;
  const bounds = blockBounds(frame, idx);

  const cv = document.createElement("canvas");
  cv.className = "ldcanvas";
  const scale = n <= CACHE_MAX ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  cv.width = Math.round(W * scale);
  cv.height = Math.round(CH * scale);
  // The key names everything the triangle's ink depends on and nothing it does not: which
  // chromosome, which display selection, how many columns, and the raster resolution. The
  // theme is deliberately absent.
  paint(cv, frame, idx, cell, scale,
    `${frame.chrom}|${hooks.mode || ""}|${n}|${scale}`);

  const over = svg("svg", {
    class: "ldover", viewBox: `0 0 ${W} ${CH}`, preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  const xOf = (col) => X0 + col * cell;
  const base = BASE;

  // Every region of the triangle, outlined in the colour its pair type carries in the key.
  //
  // A cell (i, j) has its top CORNER at x = (i + j) / 2 and y = (j - i) / 2 - the corner and
  // not the centre, which is the form at the top of this file - so a block against itself is
  // a triangle standing on the diagonal and a block against a later one is a rhombus. The
  // corners are block edges rather than cell centres, which is what makes the outlines meet
  // exactly where the blocks do.
  const pt = (i, j) => `${xOf((i + j) / 2)},${base + ((j - i) / 2) * cell}`;
  const self = (lo, hi) => [pt(lo, lo), pt(lo, hi), pt(hi, hi)].join(" ");
  const cross = (a, b, c, d) => [pt(b, c), pt(a, c), pt(a, d), pt(b, d)].join(" ");

  const blks = [];
  if (bounds[0] > 0) blks.push([0, bounds[0], "snp"]);
  if (bounds[1] > bounds[0]) blks.push([bounds[0], bounds[1], "sv"]);
  if (n > bounds[1]) blks.push([bounds[1], n, "snp"]);

  const REGION_LABEL = Object.fromEntries(REGIONS.map(([k, l]) => [k, l]));
  const regions = [];
  blks.forEach(([lo, hi, kind], a) => {
    regions.push({ kind: kind === "sv" ? "sv-sv" : "snp-snp", points: self(lo, hi),
      ci: (lo + hi) / 2, cj: (lo + hi) / 2 + (hi - lo) / 3, w: (hi - lo) * cell,
      cols: hi - lo, own: true });
    blks.slice(a + 1).forEach(([lo2, hi2, kind2]) => {
      regions.push({
        kind: kind === "sv" || kind2 === "sv" ? "sv-snp" : "snp-snp",
        points: cross(lo, hi, lo2, hi2),
        ci: (lo + hi) / 2, cj: (lo2 + hi2) / 2,
        w: Math.min(hi - lo, hi2 - lo2) * cell,
        cols: Math.min(hi - lo, hi2 - lo2), own: false,
      });
    });
  });
  // One plate per pair type, on the widest region of that type. chr21 drew SNP x SNP three
  // times and SV x SNP twice - six plates naming three distinct facts, over a figure whose
  // subject is a sliver of it. The outlines still mark every region; only the naming is once.
  const widest = new Map();
  regions.forEach((r) => {
    const cur = widest.get(r.kind);
    if (!cur || r.w > cur.w) widest.set(r.kind, r);
  });

  regions.forEach((r) => {
    const colour = REGION_COLOUR[r.kind];
    // Solid, not dashed. A dashed line at this weight over a busy raster reads as texture,
    // and its colour - which is the whole point of it - reads as a suggestion.
    over.append(svg("polygon", {
      points: r.points, fill: "none", stroke: colour, "stroke-width": 1.8, opacity: 0.95,
    }));
    // A region needs to be wide enough to hold its label; below that the key carries it.
    if (r.w < 54 || hooks.labels === false || widest.get(r.kind) !== r) return;
    // The plate names the pair type and nothing else. How many columns the block holds is on
    // the axis above it and in the caption already; three places for one number is two too
    // many, and the plate has the least room of the three.
    const label = REGION_LABEL[r.kind];
    const cx = xOf((r.ci + r.cj) / 2), cy = base + ((r.cj - r.ci) / 2) * cell;
    const w = label.length * 5.9 + 14;
    // The label sits on a plate in the surface colour, bordered and lettered in the region's
    // own. It reads at this size against any correlation underneath it, and it names the
    // colour twice, so the key is a reminder rather than the only way in.
    over.append(svg("rect", {
      x: cx - w / 2, y: cy - 9, width: w, height: 17, rx: 4,
      fill: css("--surface-1"), stroke: colour, "stroke-width": 1.6, opacity: 0.97,
    }));
    // The colour goes in an inline STYLE, not the `fill` attribute. style.css carries both
    // `svg text` and `svg text.ldnote` fill rules, and an author rule beats an SVG
    // presentation attribute unconditionally - so the attribute rendered all six labels in
    // --text-muted and the plate's border was the only thing saying which region it named,
    // which is the one job the label has.
    over.append(svgText({
      x: cx, y: cy + 3.5, class: "ldnote", style: `fill:${colour}`,
      "text-anchor": "middle", "font-weight": "600",
    }, label));
  });

  // Where the marks with evidence sit on the strip. Few enough to be real elements, so each
  // one carries its name, takes focus, and opens its record.
  const evOf = hooks.evidenceOf || (() => 0);
  const marks = [];
  for (let t = 0; t < n; t++) {
    const v = V[idx[t]];
    if (v.kind !== "sv") continue;
    const e = evOf(v.id);
    if (e > 0) marks.push([t, v, e]);
  }
  marks.forEach(([t, v, e]) => {
    const x = xOf(t + 0.5);
    const g = svg("g", {
      class: "ldmark", tabindex: "0", role: "button",
      "aria-label": `${v.id}, ${e} converging analyses, column ${t + 1} of ${n}`,
    });
    g.append(svg("polygon", {
      points: `${x - 3.5},${STRIP_Y - 2} ${x + 3.5},${STRIP_Y - 2} ${x},${STRIP_Y + 4}`,
      fill: (hooks.colourOf || (() => "#b8501e"))(e),
    }));
    const ttl = svg("title");
    ttl.textContent = `${v.id} - ${fmtBp(v.pos)} - ${e} converging analyses`;
    g.append(ttl);
    const open = () => hooks.onPick && hooks.onPick(v.id);
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" || e2.key === " ") { e2.preventDefault(); open(); }
    });
    over.append(g);
  });
  over.setAttribute("aria-hidden", marks.length ? "false" : "true");

  const stack = document.createElement("div");
  stack.className = "ldstack";
  stack.append(cv, over);

  // The pair under the pointer, read back through the same inversion the raster uses, so the
  // tooltip and the ink agree by construction.
  if (hooks.onHover) {
    cv.addEventListener("mousemove", (e) => {
      const b = cv.getBoundingClientRect();
      const f = W / b.width;
      const pair = cellAt((e.clientX - b.left) * f, (e.clientY - b.top) * f, cell, n);
      if (!pair) { hooks.onLeave && hooks.onLeave(); return; }
      const [i, j] = pair;
      const a = V[idx[i]], c = V[idx[j]];
      const r = i === j ? 1 : rOf(frame, idx[i], idx[j]);
      const same = a.kind === c.kind;
      const d = Math.abs(c.pos - a.pos);
      hooks.onHover(
        `<div class="t">r = ${r.toFixed(3)}</div>`
        + `<div class="r">${esc(labelOfVariant(a))} &middot; ${fmtBp(a.pos)} ${asmOf(a)}</div>`
        + `<div class="r">${esc(labelOfVariant(c))} &middot; ${fmtBp(c.pos)} ${asmOf(c)}</div>`
        + `<div class="r muted">columns ${i + 1} and ${j + 1} of ${n}`
        + (same
          ? ` &middot; ${d < 1000 ? d + " bp" : (d / 1000).toFixed(1) + " kb"} apart`
          : " &middot; one in each assembly") + "</div>", e);
    });
    cv.addEventListener("mouseleave", () => hooks.onLeave && hooks.onLeave());
  }

  // Only what a caller reads. Three more fields were advertised here and never taken, which
  // reads as an interface someone depends on.
  return { node: stack, n, cell, bounds, marks: marks.length };
}

/** Where the left flank ends and where the array ends, as column counts. */
function blockBounds(frame, idx) {
  let nL = 0, nSv = 0;
  for (let t = 0; t < idx.length; t++) {
    const b = frame.variants[idx[t]].block;
    if (b === 0) nL++;
    else if (b === 1) nSv++;
  }
  return [nL, nL + nSv];
}

/** The (i, j) under a point in viewBox units, or null outside the triangle. */
function cellAt(x, y, cell, n) {
  if (y < BASE || y > BASE + H) return null;
  const u = (x - X0) / cell, v = (y - BASE) / cell;
  const i = Math.round(u - v - 0.5), j = Math.round(u + v - 0.5);
  if (i < 0 || j > n - 1 || i > j) return null;
  return [i, j];
}

/**
 * The finished triangle, kept so that a control which cannot change it does not pay to
 * redraw it.
 *
 * renderDetail rebuilds the whole page on every route(), and the LD panel is open by
 * default, so the significance tier and both frequency floors each cost a full
 * re-standardise and re-raster - measured at +133 and +134 ms on chr1 against the same click
 * with the panel folded. Neither can move a single cell: r comes from the genotypes and the
 * column selection comes from MAF. The theme CAN move the column strip, but not the
 * triangle, whose colours are the fixed coolwarm table.
 *
 * One entry, not a map. A per-chromosome cache would hold 2.85 MB of ImageData for every
 * chromosome visited, 11.4 MB at devicePixelRatio 2; this holds one.
 */
let RASTER = null;

function paintTriangle(frame, idx, cell, scale, w, h, key) {
  if (RASTER && RASTER.key === key) return RASTER.img;
  const n = idx.length, V = frame.variants;
  const img = new ImageData(w, h);
  const D = img.data;
  const z = zOf(frame), m = frame.m;
  const off = new Int32Array(n);
  for (let t = 0; t < n; t++) off[t] = V[idx[t]].row * m;

  const useCache = n <= CACHE_MAX;
  const cacheV = useCache ? new Float32Array(n * n) : null;
  const cacheS = useCache ? new Uint8Array(n * n) : null;
  const rAt = (i, j) => {
    if (i === j) return 1;
    const k = i * n + j;
    if (useCache && cacheS[k]) return cacheV[k];
    const p = off[i], q = off[j];
    let s = 0;
    for (let t = 0; t < m; t++) s += z[p + t] * z[q + t];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    if (useCache) { cacheV[k] = s; cacheS[k] = 1; }
    return s;
  };

  const base = BASE;
  for (let py = 0; py < h; py++) {
    const yU = (py + 0.5) / scale;
    if (yU < base || yU > base + H) continue;
    const rowOff = py * w * 4;
    const v = (yU - base) / cell;
    for (let px = 0; px < w; px++) {
      const u = ((px + 0.5) / scale - X0) / cell;
      const i = Math.round(u - v - 0.5), j = Math.round(u + v - 0.5);
      if (i < 0 || j > n - 1 || i > j) continue;
      const k = lutIndex(rAt(i, j)) * 3;
      const o = rowOff + px * 4;
      D[o] = COOLWARM[k]; D[o + 1] = COOLWARM[k + 1]; D[o + 2] = COOLWARM[k + 2];
      D[o + 3] = 255;
    }
  }
  RASTER = { key, img };
  return img;
}

/**
 * The column strip, drawn over the blitted triangle rather than into it.
 *
 * It takes its two fills from the theme, so it is the one part that a theme toggle really
 * does have to redraw - nine of the canvas's 603 rows. Drawn with fillRect rather than into
 * the cached ImageData, which would poison the cache.
 */
function paintStrip(ctx, frame, idx, cell, scale) {
  const n = idx.length, V = frame.variants;
  const sv = css("--text-secondary"), snp = css("--axis");
  const y = STRIP_Y * scale, h = STRIP_H * scale;
  for (let t = 0; t < n; t++) {
    const vv = V[idx[t]];
    const c = rgbOf(vv.kind === "sv" ? sv : snp);
    // Columns below MAF 0.05 are drawn lighter: r is estimable there and thinner, and a
    // reader tracing a strong pair back to the strip can see which of the two it was.
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${vv.thin ? 90 / 255 : 235 / 255})`;
    const x0 = (X0 + t * cell) * scale, x1 = (X0 + (t + 1) * cell) * scale;
    ctx.fillRect(x0, y, Math.max(scale * 0.5, x1 - x0), h);
  }
}

function paint(cv, frame, idx, cell, scale, key) {
  const ctx = cv.getContext("2d");
  ctx.putImageData(paintTriangle(frame, idx, cell, scale, cv.width, cv.height, key), 0, 0);
  paintStrip(ctx, frame, idx, cell, scale);
}

// ------------------------------------------------------------------ the base-pair fan
// Mirrored with the triangle: the assembly labels and ticks at the top, the axis line
// below them, and the leader lines running DOWN to the columns, which are now the bottom
// edge of this block and the top edge of the strip beneath it.
const FH = 96, FAN_LAB = 86, FAN_TOP = 79, FAN_BOT = 45;

/**
 * What the rank abscissa costs, drawn instead of asserted - and in two assemblies.
 *
 * A triangle's columns are one per variant, so the width a region gets follows how many
 * variants it holds. The leader lines run from each column to where that variant actually
 * sits, so the reader can see the stretch.
 *
 * The axis breaks at each block boundary because the blocks are in different genomes. The two
 * SNP flanks carry GRCh38 positions, which is what the 1000 Genomes panel is called against;
 * the array between them carries CHM13 v2.0. Drawing them on one linear scale would be a
 * single axis over two assemblies, and the reference LD figure breaks its axis for this
 * reason.
 */
export function fan(frame, idx, geom) {
  const n = idx.length, V = frame.variants;
  const node = svg("svg", { class: "ldfan", viewBox: `0 0 ${W} ${FH}`, role: "img" });
  const cell = BW / n;
  const bd = (geom && geom.bounds) || [0, n];

  const segs = [];
  if (bd[0] > 0) segs.push({ lo: 0, hi: bd[0], asm: "GRCh38", what: "SNPs, left flank" });
  if (bd[1] > bd[0]) segs.push({ lo: bd[0], hi: bd[1], asm: "CHM13 v2.0",
    what: "active-HOR SVs" });
  if (n > bd[1]) segs.push({ lo: bd[1], hi: n, asm: "GRCh38", what: "SNPs, right flank" });

  segs.forEach((s, si) => {
    const xa = X0 + s.lo * cell, xb = X0 + s.hi * cell;
    const p0 = V[idx[s.lo]].pos, p1 = V[idx[s.hi - 1]].pos;
    const span = Math.max(1, p1 - p0);
    const xBp = (p) => xa + (p - p0) / span * (xb - xa);
    const wide = xb - xa > 150;

    node.append(svg("line", {
      x1: xa, x2: xb, y1: FAN_BOT, y2: FAN_BOT, stroke: css("--axis"), "stroke-width": 1,
    }));
    node.append(svgText({
      x: (xa + xb) / 2, y: FAN_LAB, class: "ldnote", "text-anchor": "middle",
    }, wide ? `columns ${s.lo + 1}\u2013${s.hi} \u00b7 ${s.what}` : `${s.hi - s.lo} ${s.what}`));

    const picks = new Set([s.lo, s.hi - 1]);
    const steps = Math.max(2, Math.round((s.hi - s.lo) / n * 9));
    for (let k = 1; k < steps; k++) {
      picks.add(s.lo + Math.round(k / steps * (s.hi - 1 - s.lo)));
    }
    [...picks].sort((a, c) => a - c).forEach((t) => {
      const x1 = X0 + (t + 0.5) * cell, x2 = xBp(V[idx[t]].pos);
      node.append(svg("path", {
        d: `M${x1},${FAN_TOP} C${x1},${(FAN_TOP + FAN_BOT) / 2} ${x2},`
          + `${(FAN_TOP + FAN_BOT) / 2} ${x2},${FAN_BOT}`,
        fill: "none", stroke: css("--text-muted"), "stroke-width": 0.9, opacity: 0.9,
      }));
      node.append(svg("circle", { cx: x2, cy: FAN_BOT, r: 1.8, fill: css("--text-muted") }));
    });

    // Each join prints two coordinates, one per assembly, which is the pair a reader needs
    // and what the source figure prints. A segment's inner label drops a line so the two do
    // not land on each other.
    const ticks = wide ? [p0, p1] : [p0];
    ticks.forEach((p, k) => {
      const x = xBp(p);
      const inner = (k === 0 && si > 0);
      node.append(svg("line", {
        x1: x, x2: x, y1: FAN_BOT, y2: FAN_BOT - (inner ? 13 : 4),
        stroke: css("--axis"), "stroke-width": 1,
      }));
      node.append(svgText({
        x, y: FAN_BOT - (inner ? 18 : 9), class: "ldtick",
        "text-anchor": k === 0 ? "start" : "end",
      }, (p / 1e6).toFixed(2)));
    });
    node.append(svgText({
      x: (xa + xb) / 2, y: 11, class: "ldtick", "text-anchor": "middle",
    }, wide ? `${s.asm} position (Mb)` : s.asm));
  });

  // the breaks themselves, so the scales read as separate
  segs.slice(1).forEach((s) => {
    const bx = X0 + s.lo * cell;
    node.append(svg("line", {
      x1: bx, x2: bx, y1: FAN_LAB - 10, y2: FAN_BOT - 6, stroke: css("--axis"),
      "stroke-width": 1, "stroke-dasharray": "3 3",
    }));
  });
  return node;
}

// ------------------------------------------------------------------ one variant's row
const PW = 372, PH = 92, PTOP = 6, PBOT = 74;

/**
 * One SV against every other variant on its chromosome: the record panel's version.
 *
 * A needle per column, on the same rank abscissa as the triangle, so the two read together.
 * Where several columns share a pixel the strongest of them is drawn, which keeps a single
 * high correlation visible at any width - the question this panel exists to answer is whether
 * an association travels with something else nearby.
 */
export function profileCanvas(frame, self, idx, r) {
  const n = idx.length;
  const cv = document.createElement("canvas");
  cv.className = "ldprof";
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(PW * scale);
  cv.height = Math.round(PH * scale);
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  const y0 = (PTOP + PBOT) / 2, half = (PBOT - PTOP) / 2;
  const yOf = (v) => y0 - v * half;

  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 0.5); ctx.lineTo(PW, y0 + 0.5);
  ctx.stroke();

  const cols = Math.round(PW);
  const best = new Float32Array(cols);
  const seen = new Uint8Array(cols);
  for (let t = 0; t < n; t++) {
    if (idx[t] === self) continue;
    const c = Math.min(cols - 1, Math.floor(t / n * cols));
    if (!seen[c] || Math.abs(r[t]) > Math.abs(best[c])) { best[c] = r[t]; seen[c] = 1; }
  }
  for (let c = 0; c < cols; c++) {
    if (!seen[c]) continue;
    ctx.strokeStyle = colourOf(best[c]);
    ctx.beginPath();
    ctx.moveTo(c + 0.5, y0);
    ctx.lineTo(c + 0.5, yOf(best[c]));
    ctx.stroke();
  }

  // where this SV itself sits along the rank axis
  let at = -1;
  for (let t = 0; t < n; t++) if (idx[t] === self) { at = t; break; }
  if (at >= 0) {
    const x = at / n * PW + 0.5;
    ctx.fillStyle = css("--text-primary");
    ctx.beginPath();
    ctx.moveTo(x - 4, PH - 1); ctx.lineTo(x + 4, PH - 1); ctx.lineTo(x, PH - 8);
    ctx.closePath();
    ctx.fill();
  }
  return cv;
}
