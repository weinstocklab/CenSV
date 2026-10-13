/**
 * The haplotype layer: the same centromeres, counted in assembled haplotypes.
 *
 * Everywhere else the browser's unit is the variant. Here it is the haplotype, and the two
 * questions that unit answers live in two places, because they are asked in two places:
 *
 *   #/individuals          how long is the array, per person? The whole cohort at once, on one
 *                          CHM13 base-pair axis, every array anchored at its START. Reached
 *                          from the overview, where "which individuals" is the standing
 *                          question.
 *   #/chrN/haplotypes      which SVs mark a single lineage? The Jaccard-NJ tree with the clade
 *                          outlined, and the SVs whose carriers form one. Reached from the
 *                          chromosome page and from the record of a monophyletic SV, which is
 *                          the only kind of SV that has a clade to show.
 *
 * WHAT THIS SHIPS AND WHAT IT JOINS. hap_<chrom>.json carries only what no other file holds:
 * the tree, the dip geometry, the array lengths, the ascAIRN pairs, and per SV the
 * decomposition r2, the clade size and the carrier row. svtype, svlen, pos, frequency, evidence
 * count and sv_category are read from the catalog rows main.js already built.
 */
import "./haplo.css";
import { el, css, esc, fmtInt } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
const POPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];
const PAIR = [0, 2, 1, 3];   // ld.js: stored 2-bit code -> dosage. Self-inverse.
const UNIT = 100;            // dip coordinates ship in 100 bp steps
const HAPS = ["hap1", "hap2"];

/**
 * A token, or magenta.
 *
 * css() returns "" for a custom property that does not exist, and an SVG fill of "" paints
 * BLACK - which looks like a deliberate colour and reads as the strongest mark on the ribbon.
 * That is how a carrier ribbon shipped with its non-carriers drawn darker than its
 * homozygotes: --surface is not a token here, --surface-1 is. Magenta belongs to no palette
 * on this site, so the next missing token is visible in one glance and is asserted against in
 * verify_haplotypes.mjs.
 */
const tok = (n) => css(n) || "#ff00ff";

function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().filter((c) => c != null && c !== false).forEach((c) => n.append(c));
  return n;
}

const bp = (v) => (v == null ? "—" : v >= 1e6 ? (v / 1e6).toFixed(2) + " Mb"
  : v >= 1e3 ? (v / 1e3).toFixed(0) + " kb" : fmtInt(v) + " bp");
const ancFill = (pop) => tok("--anc-" + ((POPS.indexOf(pop) % 6) + 1));

/**
 * Carrier dosage, on the site's own ordinal ramp.
 *
 * Dosage is ordinal - 0, 1, 2 copies - so it takes the one-hue ramp the evidence colour uses,
 * light to dark, rather than three slots of a categorical palette. The earlier version drew
 * dosage 1 and 2 from --anc-4 and --anc-3, which are two unrelated hues from the ancestry
 * legend sitting three pixels away, and read as a third category.
 */
const carrierFill = (d) => (d === 3 ? tok("--grid") : d === 0 ? tok("--ev-0")
  : d === 1 ? tok("--ev-1") : tok("--ev-3"));

/**
 * Outline colours for the origins of one SV, and the dash each one is drawn with.
 *
 * The label beside each outline carries the carrier count and the decomposition r2, and sits
 * on the side of its outline facing away from the nearest other clade. Which origin it is
 * comes from the colour and from the table beside the tree, which also says whether that
 * origin reached imputation - 107 of the 158 later origins drawn here reached imputation
 * nowhere, and 110 of them appear in no catalog row, so the record a reader opens describes
 * the first origin alone. Past two origins the palette repeats, so the number returns to the
 * label there and identity stops resting on hue.
 *
 * Two hues, not four. Every colour already on this figure was measured against the candidates:
 * --origin-2 clears the ancestry ribbon, the ascAIRN swatches and the carrier ramp, and sits dE
 * 32 from --accent with 16 under simulated protanopia, in both themes. The best three-colour
 * set clears only in dark mode and the best four-colour set falls to dE 4.6 under colour-vision
 * deficiency against a floor of 8, so a third hue would be a colour a reader cannot use.
 *
 * Beyond two origins the dash pattern separates the outlines and the label names them, which is
 * what carries identity in every case anyway. Ordered, never cycled.
 */
const ORIGIN_STROKE = ["--accent", "--origin-2", "--origin-3"];
const ORIGIN_DASH = ["3 2", "3 2", "6 3", "1 3"];
const originStroke = (i) => tok(ORIGIN_STROKE[Math.min(i, ORIGIN_STROKE.length - 1)]);
const originDash = (i) => ORIGIN_DASH[Math.min(i, ORIGIN_DASH.length - 1)];

/**
 * Which of the three hues each origin is drawn in, given where its clade sits in the tree.
 *
 * Three is the ceiling, measured rather than chosen. Searched over every hue and every chroma,
 * with a value per theme and the relaxed floor of 8 between two origins that a dash pattern and
 * a numbered label already separate, no three colours BEYOND the accent clear the figure's own
 * palette and each other at once: 127 single colours pass, and 0 triples of them do. Two beyond
 * the accent is what fits, so a fourth origin repeats one of the three.
 *
 * Which one it repeats matters, because clades TOUCH. Of the nine rows with three or more
 * origins, six hold a pair of clades one tip row apart or less, and their outlines are drawn a
 * row beyond the clade at each end - so two touching clades in the same hue read as one region
 * whatever the dash does. The clades are disjoint spans along one axis, which makes adjacency a
 * path, and a path needs two colours; with three in hand there is always one free. So rank
 * picks the hue for the first three origins, and from the fourth the hue is the lowest that no
 * touching clade already holds.
 */
function originHues(clades) {
  const span = clades.map((c) => (c.tips.size
    ? { lo: Math.min(...c.tips), hi: Math.max(...c.tips) } : null));
  // A clade's outline runs one tip row past it at each end, so two of them meet at a gap of
  // two rows and overlap below that.
  const touches = (a, b) => (a && b
    && Math.max(a.lo, b.lo) - Math.min(a.hi, b.hi) <= 2);
  const hue = clades.map((c, i) => (i < ORIGIN_STROKE.length ? i : -1));
  clades.forEach((c, i) => {
    if (hue[i] >= 0) return;
    const taken = new Set();
    clades.forEach((o, j) => {
      if (j !== i && hue[j] >= 0 && touches(span[i], span[j])) taken.add(hue[j]);
    });
    for (let k = 0; k < ORIGIN_STROKE.length; k++) {
      if (!taken.has(k)) { hue[i] = k; return; }
    }
    throw new Error(`origin ${i + 1} touches a clade in all three hues, and disjoint spans `
      + "along one axis have at most two neighbours each");
  });
  return hue;
}

/** The origins of one sv_index, or null where the resolution gives it only one. */
function originsOf(block, svIndex) {
  const o = block.origins && block.origins[String(svIndex)];
  return o && o.length > 1 ? o : null;
}

/**
 * The dosage row this SV had before the decomposition split it, where the payload holds one.
 *
 * The origins of a multi-origin SV are components of a single variant, and the record a reader
 * opens describes one of them. This row is the variant. 137 of the 145 multi-origin rows carry
 * one, and every carrier haplotype of every origin drawn belongs to a sample it calls a
 * carrier - etl/build_haplotypes.py asserts exactly that on every build, over all 6,679 of
 * them, so the ribbon painted from it reaches every outline on the figure.
 */
function parentOf(block, svIndex) {
  return (block.parent && block.parent[String(svIndex)]) || null;
}

/**
 * The carrier tips of one origin, from the bitset etl/build_haplotypes.py packs.
 *
 * Carriers are HAPLOTYPES. The packed dosage row beside this one is per SAMPLE and diploid, so
 * it cannot say which of an individual's two tips carries; this can, and every quantity the
 * per-origin table shows is counted over it.
 */
function carrierTips(packed, nTip) {
  const bin = atob(packed);
  const out = new Set();
  for (let k = 0; k < nTip; k++) {
    if (bin.charCodeAt(k >> 3) >> (7 - (k & 7)) & 1) out.add(k);
  }
  return out;
}

// ------------------------------------------------------------------ loading

let INDEX = null;
const BLOCKS = new Map();

/**
 * One chromosome's haplotype block, and the shared index behind it.
 *
 * The files are flat in data/ as hap_<chrom>.json because the single-file build collects the
 * payload with a non-recursive listing; a subdirectory would serve from the dev server and
 * 404 in the published file.
 */
export async function load(base, chrom) {
  if (!INDEX) {
    const r = await fetch(base + "data/hap_index.json");
    if (!r.ok) return null;
    INDEX = await r.json();
    INDEX.ix = new Map(INDEX.samples.map((v, i) => [v.s, i]));
  }
  if (!BLOCKS.has(chrom)) {
    const r = await fetch(base + "data/hap_" + chrom + ".json");
    BLOCKS.set(chrom, r.ok ? await r.json() : null);
  }
  const b = BLOCKS.get(chrom);
  return b ? { index: INDEX, block: b } : null;
}

/** The clade record for one sv_index, or null where that SV marks no clade. */
export function monoOf(chrom, svIndex) {
  const b = BLOCKS.get(chrom);
  if (!b) return null;
  const m = b.mono.find((r) => r[0] === svIndex);
  return m ? { svIndex: m[0], tips: m[1], exact: m[2], r2: m[3] } : null;
}

// ------------------------------------------------------------------ tree geometry

/** y for every node, from the tips outward: a tip's y is its index in tips[]. */
function geometry(tree) {
  const { parent, n_node, tip_node } = tree;
  const kids = Array.from({ length: n_node }, () => []);
  let root = 0;
  parent.forEach((p, i) => { if (p >= 0) kids[p].push(i); else root = i; });
  const y = new Float64Array(n_node).fill(-1);
  tip_node.forEach((nd, k) => { y[nd] = k; });
  const order = [], stack = [root];
  while (stack.length) {
    const i = stack.pop();
    order.push(i);
    for (const c of kids[i]) stack.push(c);
  }
  for (let t = order.length - 1; t >= 0; t--) {
    const i = order[t];
    if (!kids[i].length) continue;
    let sum = 0;
    for (const c of kids[i]) sum += y[c];
    y[i] = sum / kids[i].length;
  }
  return { kids, root, y };
}

function tipsUnder(tree, geo, node) {
  const out = new Set(), stack = [node];
  const nodeToTip = new Map(tree.tip_node.map((nd, k) => [nd, k]));
  while (stack.length) {
    const i = stack.pop();
    if (geo.kids[i].length) stack.push(...geo.kids[i]);
    else if (nodeToTip.has(i)) out.add(nodeToTip.get(i));
  }
  return out;
}

function under(tree, root, i) {
  if (root < 0) return false;
  let cur = i;
  while (cur >= 0) {
    if (cur === root) return true;
    cur = tree.parent[cur];
  }
  return false;
}

function dosages(packed, n) {
  const bin = atob(packed);
  const out = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    out[c] = PAIR[(bin.charCodeAt(c >> 2) >> (6 - ((c & 3) << 1))) & 3];
  }
  return out;
}

// ------------------------------------------------------------------ #/individuals

const COUNTS = [["10", 10], ["50", 50], ["all", Infinity]];

/**
 * The cohort's arrays, small, on one axis.
 *
 * Every array is anchored at the CHM13 array start and drawn at the same scale, so the column
 * of right-hand edges IS the length distribution. Sorted longest first for the same reason.
 */
function gallery(ctx, opt) {
  const { block, index } = ctx;
  const [as, ae] = block.active;
  const alen = ae - as;

  let rows = index.samples
    .filter((v) => block.alen[v.s] || block.dips[v.s])
    .filter((v) => opt.pop === "all" || v.sup === opt.pop)
    .map((v) => ({ s: v.s, pop: v.pop, sup: v.sup,
      len: (block.alen[v.s] || [null, null]), dips: block.dips[v.s] || {} }));
  rows.sort((a, b) => (b.len[0] || 0) - (a.len[0] || 0) || (a.s < b.s ? -1 : 1));
  const shown = rows.slice(0, opt.n === Infinity ? rows.length : opt.n);

  const W = 1180, PAD = 96, X0 = PAD, BW = W - PAD - 24;
  let widest = alen;
  rows.forEach((r) => r.len.forEach((v) => { if (v) widest = Math.max(widest, v); }));
  const LO = as - widest * 0.03, HI = as + widest * 1.05;
  const X = (v) => X0 + (v - LO) / (HI - LO) * BW;

  const BAR = 6, GAP = 1, ROW = BAR * 2 + GAP + 5;
  const TOP = 34, H = TOP + shown.length * ROW + 30;
  const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "hapsvg" });

  const step = Math.pow(10, Math.floor(Math.log10((HI - LO) / 5)));
  const tick = ((HI - LO) / step > 12) ? step * 5 : ((HI - LO) / step > 6 ? step * 2 : step);
  for (let t = Math.ceil(LO / tick) * tick; t <= HI; t += tick) {
    svg.append(s("line", { x1: X(t), x2: X(t), y1: TOP - 6, y2: H - 24, stroke: tok("--grid"),
      "stroke-width": 0.8, "stroke-dasharray": "3 3" }));
    svg.append(s("text", { x: X(t), y: H - 10, "text-anchor": "middle",
      fill: tok("--text-muted"), "font-size": 11, text: (t / 1e6).toFixed(2) }));
  }
  svg.append(s("text", { x: X0 + BW / 2, y: H - 1, "text-anchor": "middle",
    fill: tok("--text-muted"), "font-size": 11, text: `CHM13 v2.0 ${block.chrom}, Mb` }));

  // the reference's own active array, as the line every bar is read against
  svg.append(s("rect", { x: X(as), y: TOP - 26, width: X(ae) - X(as), height: 12,
    fill: tok("--array-band"), stroke: tok("--text-primary"), "stroke-width": 1 }));
  svg.append(s("text", { x: X0 - 8, y: TOP - 17, "text-anchor": "end", "font-size": 10,
    fill: tok("--text-secondary"), text: "CHM13" }));
  svg.append(s("line", { x1: X(ae), x2: X(ae), y1: TOP - 28, y2: H - 26,
    stroke: tok("--axis"), "stroke-width": 1, "stroke-dasharray": "2 4" }));

  const label = shown.length <= 60;
  shown.forEach((r, i) => {
    const y0 = TOP + i * ROW;
    if (label) {
      svg.append(s("text", { x: X0 - 26, y: y0 + BAR + 3, "text-anchor": "end",
        "font-size": 9.5, fill: tok("--text-secondary"), text: r.s }));
    }
    svg.append(s("rect", { x: X0 - 20, y: y0, width: 6, height: BAR * 2 + GAP,
      fill: ancFill(r.sup) }));
    HAPS.forEach((h, hi) => {
      const y = y0 + hi * (BAR + GAP), L = r.len[hi];
      if (!L) {
        // A thin rule, not a full-width dashed box. A box the width of CHM13's array reads
        // as an array of exactly that length, which is a measurement this haplotype has none
        // of - and at 50 rows the boxes outnumber the bars.
        const g0 = s("g", {});
        g0.append(s("line", { x1: X(as), x2: X(as) + 14, y1: y + BAR / 2, y2: y + BAR / 2,
          stroke: tok("--array-edge"), "stroke-width": 1, "stroke-dasharray": "2 2" }));
        g0.append(s("title", { text: `${r.s} ${h} · no assembled array` }));
        svg.append(g0);
        return;
      }
      const g = s("g", {});
      g.append(s("rect", { x: X(as), y, width: X(as + L) - X(as), height: BAR,
        fill: tok("--array-band"), stroke: tok("--array-edge"), "stroke-width": 0.5 }));
      (r.dips[h] || []).forEach(([qa, qw, span]) => {
        const wbp = qw * UNIT, mid = as + (span + 1) * L / 2;
        g.append(s("rect", { x: X(mid - wbp / 2), y: y + 0.5,
          width: Math.max(1, X(mid + wbp / 2) - X(mid - wbp / 2)), height: BAR - 1,
          fill: tok("--text-primary"), opacity: 0.68 }));
      });
      g.append(s("title", { text: `${r.s} ${h} · ${r.pop} (${r.sup}) · ${bp(L)} · ` +
        `${((L / alen - 1) * 100).toFixed(0)}% of CHM13 · ${(r.dips[h] || []).length} dips` }));
      svg.append(g);
    });
  });

  const lens = shown.flatMap((r) => r.len).filter(Boolean);
  const med = lens.length ? lens.slice().sort((a, b) => a - b)[lens.length >> 1] : null;
  const nd = shown.reduce((n, r) => n + HAPS.reduce((m, h) => m + (r.dips[h] || []).length, 0), 0);
  const cap = el("figcaption", {},
    el("span", { class: "eyebrow inline num", html:
      `<b>${shown.length}</b> of ${rows.length} individuals · median array <b>${bp(med)}</b>` +
      ` against CHM13's ${bp(alen)} · <b>${fmtInt(nd)}</b> dips` }),
    " Each array at its own length, anchored at the CHM13 array start, longest first;",
    " dips in dark, ancestry in the left margin.");
  return el("figure", { class: "chart" }, svg, cap);
}

/** The whole #/individuals page. ctx adds { chroms, opt, onOpt }. */
export function individualsPage(ctx) {
  const { block, index, opt, onOpt } = ctx;
  const sel = (label, value, options, key) => el("label", { class: "chk" }, label + " ",
    el("select", { class: "hapsel", onchange: (e) => onOpt(key, e.target.value) },
      ...options.map(([t, v]) => el("option",
        { value: String(v), selected: String(v) === String(value) || null }, t))));

  const nPop = {};
  index.samples.forEach((v) => { nPop[v.sup] = (nPop[v.sup] || 0) + 1; });

  return [
    el("div", { class: "controls" },
      sel("Centromere", block.chrom, ctx.chroms.map((c) => [c, c]), "chrom"),
      sel("Ancestry", opt.pop,
        [["all", "all"], ...POPS.map((p) => [`${p} (${nPop[p] || 0})`, p])], "pop"),
      sel("Show", String(opt.n), COUNTS.map(([t, v]) => [t, v]), "n")),
    gallery(ctx, opt),
  ];
}

// ------------------------------------------------------------------ #/chrN/haplotypes

function treeFigure(ctx, sel) {
  const { block, index } = ctx;
  const tree = block.tree;
  const geo = geometry(tree);
  const nT = tree.n_tip;

  // One entry per origin. An SV with a single origin yields one, which is what this drew
  // before, so a single-origin page is unchanged.
  const clades = [];
  if (sel && sel.origins) {
    // The fourth field of an origin record is its evidence tier, 1 where the component
    // reached imputation. The ETL reads it from the resolution's own `modelled` column and
    // stops the build where an origin has no row there, so it is present on every origin the
    // payload carries.
    sel.origins.forEach(([branch, r2, car, imputed], i) => {
      const node = tree.branch_node[branch];
      if (node === undefined) throw new Error(`the tree carries no branch ${branch}`);
      clades.push({ branch, r2, i, node, imputed, tips: tipsUnder(tree, geo, node),
        carriers: carrierTips(car, tree.n_tip) });
    });
  } else if (sel && sel.branch && tree.branch_node[sel.branch] !== undefined) {
    const node = tree.branch_node[sel.branch];
    clades.push({ branch: sel.branch, r2: sel.r2, i: 0, node,
      tips: tipsUnder(tree, geo, node), carriers: null });
  }
  const clade = clades.length ? clades[0].tips : new Set();
  const hue = originHues(clades);
  const multi = clades.length > 1;
  // What the carrier ribbon paints. On an SV that arose more than once it is the variant's own
  // row, so the carriers of every outline on this figure appear in it; the record's component
  // alone would colour one outline and leave the others blank. The rows with no such row in
  // the payload, and every single-origin SV, paint the record's component exactly as before.
  const whole = multi && sel && sel.parent ? sel.parent : null;
  const src = whole || (sel && sel.packed) || null;
  const dos = src ? dosages(src, index.samples.length) : null;
  // Which origin each haplotype belongs to, or -1. This was drawn as a column of its own for
  // one round and taken out again on the author reading the page: the outline around each clade
  // already says which origin a haplotype is in, and a second mark saying it again was the
  // largest block of new colour on a figure that carries six ancestry hues and a dosage ramp.
  // What went with it is the per-HAPLOTYPE reading - the ribbon beside the tree is a per-SAMPLE
  // diploid dosage and cannot say which of an individual's two haplotypes an origin holds. The
  // assignment stays because the residual count in the caption is derived from it.
  const originOf = new Int8Array(nT).fill(-1);
  if (multi) clades.forEach((c) => (c.carriers || []).forEach((k) => { originOf[k] = c.i; }));

  const W = 470, TOP = 66, H = Math.max(340, nT * 1.5), LEFT = 8, BAND = 34;
  const maxx = Math.max(...tree.x);
  const X = (v) => LEFT + (v / maxx) * (W - LEFT - BAND - 96);
  const Y = (v) => TOP + (v / (nT - 1)) * (H - TOP - 14);
  const svg = s("svg", { width: W, height: H + 6, viewBox: `0 0 ${W} ${H + 6}`,
    class: "hapsvg haptree" });

  // Which origin an edge belongs to, or -1. The clades are disjoint - the ETL fails the build
  // if two of them share a tip - so an edge can be under at most one, and a second match would
  // mean the shipped tree and the shipped origins disagree.
  const owner = (i) => {
    let found = -1;
    for (const c of clades) {
      if (!under(tree, c.node, i)) continue;
      if (found >= 0) throw new Error(`node ${i} sits under origins ${clades[found].branch} `
        + `and ${c.branch}, and the build requires every pair of origins to be disjoint`);
      found = c.i;
    }
    return found;
  };
  tree.parent.forEach((p, i) => {
    if (p < 0) return;
    const o = owner(i);
    svg.append(s("line", { x1: X(tree.x[p]), x2: X(tree.x[i]), y1: Y(geo.y[i]), y2: Y(geo.y[i]),
      stroke: o < 0 ? tok("--grid") : originStroke(hue[o]),
      "stroke-width": o < 0 ? 0.6 : 1.1 }));
  });
  geo.kids.forEach((cs, i) => {
    if (cs.length < 2) return;
    const ys = cs.map((c) => geo.y[c]), o = owner(i);
    svg.append(s("line", { x1: X(tree.x[i]), x2: X(tree.x[i]),
      y1: Y(Math.min(...ys)), y2: Y(Math.max(...ys)),
      stroke: o < 0 ? tok("--grid") : originStroke(hue[o]),
      "stroke-width": o < 0 ? 0.6 : 1.1 }));
  });

  const tipX = X(maxx) + 8;
  const clusters = block.asc_clusters || [];
  const rowH = Math.max(1, (H - TOP - 14) / (nT - 1));
  tree.tips.forEach((tip, k) => {
    const name = tip.replace(/_hap[12]$/, "");
    const si = index.ix.get(name);
    const y = Y(k) - rowH / 2, h = Math.max(1, rowH);
    const meta = si === undefined ? null : index.samples[si];
    svg.append(s("rect", { x: tipX, y, width: 10, height: h,
      fill: meta ? ancFill(meta.sup) : tok("--grid") }));
    const pr = block.asc[name];
    if (pr) {
      svg.append(s("rect", { x: tipX + 13, y, width: 5, height: h,
        fill: hgFill(clusters, pr[0]) }));
      svg.append(s("rect", { x: tipX + 18, y, width: 5, height: h,
        fill: hgFill(clusters, pr[1]) }));
    }
    if (dos && si !== undefined) {
      svg.append(s("rect", { x: tipX + 26, y, width: 10, height: h, class: "hapcar",
        fill: carrierFill(dos[si]) }));
    }
  });
  [["ancestry", tipX + 5], ["ascAIRN", tipX + 18], ["carrier", tipX + 31]].forEach(([t, x]) => {
    svg.append(s("text", { x, y: TOP - 8, "font-size": 10, fill: tok("--text-muted"),
      transform: `rotate(-90 ${x} ${TOP - 8})`, "text-anchor": "start", text: t }));
  });

  // One outline per origin, each labelled. The label is what carries identity past the second
  // origin, where no further hue clears the palette already on this figure.
  const band = clades.map((c) => {
    if (!c.tips.size) return null;
    const ys = [...c.tips].map((k) => Y(k));
    return { top: Math.min(...ys) - rowH, bot: Math.max(...ys) + rowH,
      x0: X(tree.x[c.node]) - 3 };
  });
  clades.forEach((c) => {
    const b = band[c.i];
    if (!b) return;
    svg.append(s("rect", { x: b.x0, y: b.top, width: W - b.x0 - 4, height: b.bot - b.top,
      fill: "none", stroke: originStroke(hue[c.i]), "stroke-width": 1,
      "stroke-dasharray": originDash(c.i) }));
    if (clades.length < 2) return;
    const n = c.carriers ? c.carriers.size : null;
    const parts = [];
    // Two hues carry two origins. From three up the colour repeats, so the number is what
    // separates them and it goes back on the label.
    if (clades.length > 2) parts.push(`origin ${c.i + 1}`);
    if (n != null) parts.push(`${n} carriers`);
    if (c.r2 != null) parts.push(`r² ${c.r2.toFixed(3)}`);
    const txt = parts.join(" · ");
    if (!txt) return;
    // The side of this outline facing away from the nearest other clade.
    let up = Infinity, down = Infinity;
    band.forEach((o, j) => {
      if (!o || j === c.i) return;
      if (o.bot <= b.top) up = Math.min(up, b.top - o.bot);
      if (o.top >= b.bot) down = Math.min(down, o.top - b.bot);
    });
    const y = up >= down ? Math.max(10, b.top - 3) : b.bot + 10;
    // A backing, because either side of the outline is over drawn tree.
    svg.append(s("rect", { x: b.x0 - 1, y: y - 9, width: txt.length * 5.15 + 5, height: 11,
      fill: tok("--surface-1"), opacity: 0.9 }));
    svg.append(s("text", { x: b.x0 + 2, y, "font-size": 10, fill: originStroke(hue[c.i]),
      text: txt }));
  });
  // The frequency of the row the ribbon paints, and the carriers it holds that no origin
  // accounts for - the residual the decomposition leaves. Both are counted over the samples
  // this tree carries, because those are the ones the ribbon draws.
  const onTree = new Set(), owned = new Set();
  tree.tips.forEach((tip, k) => {
    const si = index.ix.get(tip.replace(/_hap[12]$/, ""));
    if (si === undefined) return;
    onTree.add(si);
    if (originOf[k] >= 0) owned.add(si);
  });
  let sum = 0, called = 0, unassigned = 0;
  if (dos) {
    onTree.forEach((i) => {
      if (dos[i] === 3) return;
      sum += dos[i];
      called++;
      if (dos[i] > 0 && !owned.has(i)) unassigned++;
    });
  }
  return { svg, clades, hue, whole: !!whole, unassigned,
    af: called ? sum / (2 * called) : null };
}

const hgFill = (clusters, k) =>
  (k == null || clusters.indexOf(k) < 0 ? tok("--grid")
    : tok("--anc-" + ((clusters.indexOf(k) % 6) + 1)));

/** A cluster's colour as a box, so the pair in the table reads as the pair on the ribbon. */
function swatch(clusters, k) {
  return el("span", { class: "hapsw",
    style: `background:${hgFill(clusters, k)}`, title: k == null ? "no second cluster" : `cluster ${k}` });
}

/**
 * ascAIRN pairs, per clade.
 *
 * With one clade the column counts the TIPS inside it, which is what this always counted. With
 * several it becomes one column per origin counting that origin's CARRIERS, because carriers
 * are the unit the origins are defined on and the only one that compares between them: B4
 * spans 107 tips and 56 carriers, so a tips column would be half non-carrier background. The
 * header says which unit is in force.
 */
function composition(ctx, clades) {
  const { block } = ctx;
  const tree = block.tree, clusters = block.asc_clusters || [];
  const multi = clades.length > 1;
  const sets = clades.map((c) => (multi ? c.carriers : c.tips) || new Set());
  const all = new Map(), pairOf = new Map();
  const inc = sets.map(() => new Map());
  tree.tips.forEach((tip, k) => {
    const name = tip.replace(/_hap[12]$/, "");
    const pr = block.asc[name];
    const key = pr ? pr.map((v) => (v == null ? "—" : v)).join("|") : "untyped";
    if (!pairOf.has(key)) pairOf.set(key, pr || null);
    all.set(key, (all.get(key) || 0) + 1);
    sets.forEach((st, i) => {
      if (st.has(k)) inc[i].set(key, (inc[i].get(key) || 0) + 1);
    });
  });
  const total = (g) => inc.reduce((n, m) => n + (m.get(g) || 0), 0);
  const labels = [...all.keys()];
  const present = labels.filter((g) => total(g))
    .sort((a, b) => total(b) - total(a) || all.get(b) - all.get(a));
  const absent = labels.filter((g) => !total(g));

  const t = el("table", { class: "haptab" },
    el("thead", {}, el("tr", {},
      el("th", {}, "ascAIRN pair"),
      // The tier lives here rather than on the outline label, which carries the two
      // quantities and nothing else.
      ...clades.map((c) => el("th", { class: "num" },
        multi ? `origin ${c.i + 1}`
          + (c.imputed == null ? ""
             : ` · ${c.imputed ? "imputed" : "assembly only"}`)
          : "in the clade")),
      el("th", { class: "num" }, "cohort"))));
  const body = el("tbody");
  present.forEach((g) => {
    const pr = pairOf.get(g);
    body.append(el("tr", {},
      el("td", {}, pr ? el("span", { class: "hapsws" }, swatch(clusters, pr[0]),
        swatch(clusters, pr[1])) : null, " ", g),
      ...inc.map((m) => el("td", { class: "num" }, String(m.get(g) || 0))),
      el("td", { class: "num" }, String(all.get(g)))));
  });
  if (absent.length) {
    body.append(el("tr", { class: "muted" },
      el("td", {}, `${absent.length} other pair${absent.length === 1 ? "" : "s"}, ` +
        (multi ? "none in any origin" : "none in the clade")),
      ...inc.map(() => el("td", { class: "num" }, "0")),
      el("td", { class: "num" },
        String(absent.reduce((n, g) => n + all.get(g), 0)))));
  }
  t.append(body);
  return t;
}

/**
 * The columns, each with the value it sorts on.
 *
 * Four of the nine come from the catalog rows main.js built and five from the haplotype file,
 * so the accessor takes both and the table never needs to know which side a column came from.
 */
export const MONO_COLS = [
  { label: "SV", key: "sv", num: false, get: (m, d) => (d ? d.sv_id : String(m[0])) },
  { label: "clade tips", key: "tips", num: true, get: (m) => m[1] },
  { label: "type", key: "type", num: false, get: (m, d) => (d ? d.svtype : null) },
  { label: "length", key: "len", num: true, get: (m, d) => (d ? d.svlen : null) },
  { label: "CHM13 pos", key: "pos", num: true, get: (m, d) => (d ? d.pos : null) },
  { label: "AF", key: "af", num: true, get: (m, d) => (d ? d.svfreq : null) },
  { label: "decomp r²", key: "r2", num: true, get: (m) => m[3] },
  { label: "dosage exact", key: "exact", num: true, get: (m) => m[2] },
  // How many times this SV arose. Blank rather than 1 where it arose once, so the column reads
  // as a flag on the few rows that carry one instead of a column of ones.
  { label: "origins", key: "origins", num: true,
    get: (m, d, block) => {
      const o = block && block.origins && block.origins[String(m[0])];
      return o && o.length > 1 ? o.length : null;
    } },
  { label: "evidence", key: "ev", num: true, get: (m, d) => (d ? d.n_layers : null) },
];
export const MONO_SORT = { key: "r2", dir: -1 };

/**
 * Sorted rows.
 *
 * A missing value sorts LAST whichever way the arrow points: a null decomposition r2 has no
 * claim to make, and floating it to the top on one click would put the least informative rows
 * where the most informative ones were. Ties fall back to the default order, so the table is
 * deterministic rather than dependent on the engine's sort.
 */
function sortMono(mono, rowOf, sort, block) {
  const col = MONO_COLS.find((c) => c.key === sort.key) || MONO_COLS[6];
  const dflt = (a, b) => (b[3] == null ? -1 : b[3]) - (a[3] == null ? -1 : a[3]) || b[1] - a[1];
  return mono.slice().sort((a, b) => {
    const va = col.get(a, rowOf.get(a[0]), block), vb = col.get(b, rowOf.get(b[0]), block);
    const na = va == null || va === "", nb = vb == null || vb === "";
    if (na !== nb) return na ? 1 : -1;
    if (na) return dflt(a, b);
    const c = col.num ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return (c * sort.dir) || dflt(a, b);
  });
}

function monoTable(ctx, selIndex, onPick) {
  const { block } = ctx;
  const sort = ctx.sort || MONO_SORT;
  const rows = new Map((ctx.rows || []).map((d) => [d.sv_index, d]));
  const head = el("tr", {}, ...MONO_COLS.map((c, i) => {
    const on = sort.key === c.key;
    return el("th", { class: i >= 1 && i !== 2 ? "num" : null,
      "aria-sort": on ? (sort.dir < 0 ? "descending" : "ascending") : "none" },
      el("button", { class: "hapsort" + (on ? " on" : ""), type: "button",
        onclick: () => ctx.onSort(c.key) },
        c.label, el("span", { class: "arr", "aria-hidden": "true" },
          on ? (sort.dir < 0 ? "↓" : "↑") : "")));
  }));
  const t = el("table", { class: "haptab wide" }, el("thead", {}, head));
  const body = el("tbody");
  sortMono(block.mono, rows, sort, block).forEach(([svIndex, tips, exact, r2]) => {
    const d = rows.get(svIndex);
    const o = originsOf(block, svIndex);
    body.append(el("tr", { class: svIndex === selIndex ? "sel" : null,
      id: "hapsv-" + svIndex, onclick: () => onPick(svIndex) },
      el("td", {}, d ? d.sv_id : String(svIndex)),
      el("td", { class: "num" }, fmtInt(tips)),
      el("td", {}, d ? d.svtype : "—"),
      el("td", { class: "num" }, d ? fmtInt(d.svlen) : "—"),
      el("td", { class: "num" }, d ? fmtInt(d.pos) : "—"),
      el("td", { class: "num" }, d && d.svfreq != null ? d.svfreq.toFixed(3) : "—"),
      el("td", { class: "num" }, r2 == null ? "—" : r2.toFixed(3)),
      el("td", { class: "num" }, (100 * exact).toFixed(0) + "%"),
      el("td", { class: "num" }, o ? String(o.length) : ""),
      // The count of converging layers, and the way to read them: it opens that variant's
      // record, where each association is named with its source. Fifty of the 1,783
      // monophyletic rows carry one, so the link is also what tells a reader which rows
      // have something to open. The click stops here rather than reaching the row beneath
      // it, which would repaint the table around the link mid-click.
      el("td", { class: "num" }, d && d.n_layers > 0
        ? el("a", { class: "hapev", href: `#/${block.chrom}/${svIndex}`,
            title: `${d.n_layers} converging layer${d.n_layers === 1 ? "" : "s"}` +
              ` · open the record for ${d.sv_id}`,
            onclick: (e) => { e.stopPropagation(); ctx.onMark(svIndex); } },
          String(d.n_layers))
        : "")));
  });
  t.append(body);
  return t;
}

/** The tree page for one chromosome. ctx adds { chroms, onChrom, onMark }. */
export function treePage(ctx) {
  const { block, index } = ctx;
  const sum = index.summary[block.chrom];
  const rowOf = new Map((ctx.rows || []).map((d) => [d.sv_index, d]));
  const mono = block.mono.find((m) => m[0] === ctx.svIndex) || block.mono[0] || null;
  const sel = mono ? {
    svIndex: mono[0], tips: mono[1], exact: mono[2], r2: mono[3], packed: mono[4],
    branch: (rowOf.get(mono[0]) || {}).mapped_haplogroup,
    id: (rowOf.get(mono[0]) || {}).sv_id,
    origins: originsOf(block, mono[0]),
    parent: parentOf(block, mono[0]),
  } : null;
  const fig = treeFigure(ctx, sel);
  const { svg, clades } = fig;
  // Which outline is the record the reader opened. The catalog row sits on either origin - two
  // chr1 records are the same pair of clades with the row on opposite branches - so it is read
  // off the branch rather than assumed to be the first.
  const own = sel ? clades.findIndex((c) => c.branch === sel.branch) : -1;
  const ownAf = sel ? (rowOf.get(sel.svIndex) || {}).svfreq : null;

  return [
    el("header", { class: "detailhd" },
      el("h1", {}, `${block.chrom} clade trees`),
      el("span", { class: "muted num" },
        `${fmtInt(sum.tips)} haplotypes · ${sum.mono} of ${sum.nsv} SVs mark one clade` +
        ` · ${sum.exact} predict the exact dosage`)),
    el("div", { class: "controls" },
      el("label", { class: "chk" }, "Centromere ",
        el("select", { class: "hapsel", onchange: (e) => ctx.onChrom(e.target.value) },
          ...ctx.chroms.map((c) => el("option",
            { value: c, selected: c === block.chrom || null }, c))))),
    el("div", { class: "haprow" },
      el("figure", { class: "chart" }, svg, ribbonKey(!!sel, clades, fig.hue),
        el("figcaption", {},
          el("span", { class: "eyebrow inline num", html:
            sel && sel.id ? `<b>${esc(sel.id)}</b> · <b>${sel.tips}</b> tips · ` +
              `r² <b>${sel.r2 == null ? "—" : sel.r2.toFixed(3)}</b> · ` +
              `<b>${(100 * sel.exact).toFixed(0)}%</b> exact`
              : `<b>${sum.mono}</b> monophyletic of <b>${sum.nsv}</b> typed SVs` }),
          ` Jaccard-NJ tree of ${sum.tips} haplotypes, midpoint-rooted, drawn to branch length.`,
          sel && sel.origins
            ? ` This SV arose ${sel.origins.length} times: each origin is outlined and` +
              " labelled with its carriers and its decomposition r², and the table beside the" +
              " tree counts each origin's carriers and says whether it reached imputation." +
              (fig.whole && fig.af != null
                ? " The carrier ribbon reads the variant as it stood before the" +
                  ` decomposition, at frequency ${fig.af.toFixed(3)}, so the carriers of` +
                  " every origin appear in it" +
                  (own >= 0 && ownAf != null
                    ? `, while this record's own frequency of ${ownAf.toFixed(3)} covers` +
                      ` origin ${own + 1} alone.`
                    : ".")
                : " The carrier ribbon reads the genotype of the origin this record" +
                  " describes.") +
              (fig.unassigned
                ? ` ${fig.unassigned} carrier ` +
                  `${fig.unassigned === 1 ? "individual falls" : "individuals fall"} outside` +
                  " every origin, which is the residual the decomposition leaves."
                : "")
            : "")),
      el("div", { class: "hapside" }, composition(ctx, clades))),
    el("section", { class: "hapsec", id: "hap-mono" },
      el("h2", {}, "The monophyletic SVs"),
      el("div", { class: "scroll" }, monoTable(ctx, sel ? sel.svIndex : null, ctx.onPick)),
      el("p", { class: "muted" },
        `Ordered by ${(MONO_COLS.find((c) => c.key === (ctx.sort || MONO_SORT).key)
          || MONO_COLS[6]).label}, ` +
        `${(ctx.sort || MONO_SORT).dir < 0 ? "highest" : "lowest"} first. ` +
        "Select a column to reorder, a row to outline its clade, or an evidence count " +
        "for that variant's record.")),
  ];
}

// ------------------------------------------------------------------ the ways in

/**
 * A key for the two ribbons the rest of the site does not already explain.
 *
 * Ancestry appears in the dip track's own legend, and the ascAIRN colours are keyed by the
 * composition table beside the tree, so neither is repeated. Carrier dosage is drawn here and
 * nowhere else, and an ordinal ramp with no key is three shades of one colour.
 */
function ribbonKey(hasSel, clades, hue) {
  const box = (fill, label) => el("span", { class: "hapkey" },
    el("span", { class: "hapsw", style: `background:${fill}` }), label);
  return el("div", { class: "hapkeys" },
    el("span", { class: "hapkeyg" }, el("span", { class: "hapkeyl" }, "ancestry"),
      ...POPS.map((p) => box(ancFill(p), p))),
    hasSel ? el("span", { class: "hapkeyg" }, el("span", { class: "hapkeyl" }, "carrier"),
      box(carrierFill(0), "0"), box(carrierFill(1), "1"), box(carrierFill(2), "2"),
      box(carrierFill(3), "open")) : null,
    clades && clades.length > 1
      ? el("span", { class: "hapkeyg" }, el("span", { class: "hapkeyl" }, "origin"),
        ...clades.map((c, i) => box(originStroke(hue[i]), String(i + 1))))
      : null);
}

/** Two links on the overview, one per question the individual-level views answer. */
export function overviewEntry(index, firstChrom, genotyped) {
  // The count the manuscript reports, shipped by the ETL as mono_reported, NOT the number
  // this site draws. 179 of those components are carried by fewer than ten haplotypes or
  // have no row in ld.json, so the per-chromosome strips add up to 1,783 while this reads
  // 1,962. Chosen deliberately so the card and the paper agree.
  const mono = index.mono_reported;
  return el("section", { class: "hapentry" },
    el("h2", {}, "By individual"),
    el("div", { class: "hapentrys" },
      el("a", { class: "hapcta", href: "#/individuals" },
        el("b", {}, "Individual arrays"),
        el("span", { class: "eyebrow inline num", html:
          // Both cohorts, because the page behind this card reads two of them: the whole
          // cohort as assembled haplotypes, and the whole genome from the individuals who
          // also carry 1000 Genomes genotypes. With no clause here to attach them to, each
          // figure stands on its own and the page says which reading uses which.
          `<b>${index.samples.length}</b> assembled as <b>${index.n_tip}</b> haplotypes` +
          (genotyped ? `, <b>${genotyped.length}</b> with diploid genotypes` : "") })),
      el("a", { class: "hapcta", href: `#/${firstChrom}/haplotypes` },
        el("b", {}, "Clade trees"),
        el("span", { class: "eyebrow inline num", html:
          `<b>${fmtInt(mono)}</b> SVs across 23 centromeres mark a single lineage` }))));
}

/** The strip on a chromosome page. It points at the tree, which is what lives per chromosome. */
export function chromEntry(chrom, sum) {
  return el("a", { class: "hapcta wide", href: `#/${chrom}/haplotypes` },
    el("b", {}, "Clade trees"),
    el("span", { class: "eyebrow inline num", html:
      `<b>${sum.mono}</b> of <b>${sum.nsv}</b> SVs mark one clade of the ` +
      `<b>${sum.tips}</b>-haplotype tree · <b>${sum.exact}</b> predict the exact dosage` }));
}
