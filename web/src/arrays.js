/**
 * One individual's structural variants, painted onto the centromeric arrays themselves.
 *
 * The rest of the site reads a variant across the cohort. This reads a person across the
 * genome, which is the view a reader asks for after meeting a locus: whose arrays carry
 * this, and what does one genome look like end to end.
 *
 * Two readings share the geometry, because the same picture answers two different questions
 * and drawing them apart would ask a reader to hold one in memory while looking at the
 * other. BALANCE colours each window by the classes it holds, deletions against the
 * sequence-adding classes, with depth for how much sits there. DEPARTURE colours the same
 * window by this individual against the mean of everyone assembled on that array.
 *
 * Two measured properties of the arrays are load-bearing here.
 *
 * 356 of the 10,691 variants sit outside the active array they belong to, reaching 3.82 Mb
 * past the chr3 array end and 2.40 Mb before the chr4 array start; half of chr4's 268 and a
 * third of chr3's 142 are among them. Each row therefore spans the array WITH its flanks,
 * drawn as a narrower band, and the active array is outlined inside it. Drawing on the
 * active bounds alone loses those variants without saying so.
 *
 * Carriage density runs from 18.7 variants per Mb on chrX to 2,355 on chr21, a factor of
 * 126, so depth runs through log1p: a linear ramp fills chr21 solid and leaves chrX blank.
 */
import { el, fmtInt } from "./dom.js";
import { dosages, frameOf, samplesOf } from "./ld.js";

/** Window width for every row, in bases. 25 kb keeps chr21's 331 kb array at 14 windows. */
export const BIN = 25000;
export const MODES = [
  ["balance", "deletions against insertions"],
  ["departure", "departure from the cohort"],
];
export const DEFAULT_MODE = "balance";
/** The two tracks laid over the cohort figure. Both start on; either may be turned off. */
export const TRACKS = [["meth", "methylation"], ["dips", "dip density"]];
export const DEFAULT_TRK = "md";

const DEL_HUE = [184, 80, 30];      // --del
const INS_HUE = [47, 125, 158];     // --INS
const PAGE = [244, 243, 238];
const COOL = [28, 85, 120];
const WARM = [140, 58, 18];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const logT = (v, max) => (max > 0 ? Math.log1p(v) / Math.log1p(max) : 0);
/** A span in the unit that suits its size, for the hover text on each array. */
const bp = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + " Mb"
  : n >= 1e3 ? (n / 1e3).toFixed(0) + " kb" : n + " bp");

/**
 * Every array's drawn geometry and its SV rows, built once from the shipped frames.
 *
 * Returns null when ld.json predates the sample list, because a per-individual view with no
 * names would be a view of column indices.
 */
export function geometry(ld, chroms) {
  if (!ld || !ld.chrom || !ld.samples) return null;
  if (ld.__geom) return ld.__geom;
  const recOf = new Map((chroms || []).map((c) => [c.chrom, c.arrays || []]));
  const arrays = [];
  for (const chrom of Object.keys(ld.chrom)) {
    const frame = frameOf(ld, chrom);
    const raw = ld.chrom[chrom];
    if (!frame || !raw.cols) return null;
    const svs = frame.variants.filter((v) => v.kind === "sv");
    let lo = raw.active_start, hi = raw.active_end;
    for (const v of svs) { if (v.pos < lo) lo = v.pos; if (v.pos > hi) hi = v.pos; }
    // Every CenSat HOR record this row covers, the active one marked. The active bounds
    // the frame chose match exactly one record on all 23 chromosomes, and ten chromosomes
    // carry more than one, so the rest are the sequence a reader sees outside the outline.
    // A row used to stop at its last variant, so a record whose tail carries nothing in
    // these 188 had its box cut short of the array it outlines - thirteen were, hor_4_1 by
    // 8,047 bp - and the box then measured less than the length its hover text gave. The
    // span grows to cover every record it draws. Repeated because widening can bring a
    // further record into range; it settles in one pass on this annotation.
    const every = recOf.get(chrom) || [];
    for (let pass = 0; pass < 4; pass++) {
      let lo2 = lo, hi2 = hi;
      for (const a of every) {
        if (a.end > lo && a.start < hi) {
          lo2 = Math.min(lo2, a.start); hi2 = Math.max(hi2, a.end);
        }
      }
      if (lo2 === lo && hi2 === hi) break;
      lo = lo2; hi = hi2;
    }
    const recs = every
      .filter((a) => a.end > lo && a.start < hi)
      .map((a) => ({
        s: Math.max(a.start, lo), e: Math.min(a.end, hi),
        name: String(a.name).replace(/\(.*$/, ""), full: String(a.name),
        active: a.start === raw.active_start && a.end === raw.active_end,
      }))
      .sort((p, q) => p.s - q.s);
    // A record sharing an exact boundary with the active array is the same tract of
    // satellite continuing, and is drawn as part of one object; one with sequence between
    // gets its own box. Measured: seven of the fourteen touch, four of those render under
    // 1.5 px, and a separate dashed box that small reads as an edge on its neighbour.
    recs.forEach((q) => {
      q.joins = q.e === raw.active_start || q.s === raw.active_end;
    });
    // The methylation tracks are computed on covered-base fraction over the active
    // blocks, and main.js walks these same blocks in coveredPos to put them on the detail
    // chart's axis. The cohort figure needs the walk in the other direction, so the merged
    // blocks travel with the row. Merging matters on the ten chromosomes carrying more
    // than one: chr3's blocks cover 0.309 of their span and chr4's 0.674.
    const blocks = [];
    for (const a of [...every].sort((p, q) => p.start - q.start)) {
      const last = blocks[blocks.length - 1];
      if (last && a.start <= last.end) last.end = Math.max(last.end, a.end);
      else blocks.push({ start: a.start, end: a.end });
    }
    arrays.push({
      chrom, frame, cols: raw.cols, alo: raw.active_start, ahi: raw.active_end, blocks,
      lo, hi, span: hi - lo, active: raw.active_end - raw.active_start,
      nsv: svs.length, svs, recs,
      outside: svs.filter((v) => v.pos < raw.active_start || v.pos > raw.active_end).length,
      nb: Math.max(1, Math.ceil((hi - lo) / BIN)),
    });
  }
  arrays.sort((a, b) => a.chrom.localeCompare(b.chrom, undefined, { numeric: true }));
  // One origin for the whole stack: the active array start. Rows reach back from it by
  // however much sequence outside the active array carries variants.
  const back = Math.max(...arrays.map((a) => a.alo - a.lo));
  const fwd = Math.max(...arrays.map((a) => a.hi - a.alo));
  const geom = {
    arrays, samples: ld.samples,
    back, fwd, axis: back + fwd,
    maxSpan: Math.max(...arrays.map((a) => a.span)),
    totSpan: arrays.reduce((s, a) => s + a.span, 0),
    totActive: arrays.reduce((s, a) => s + a.active, 0),
    outside: arrays.reduce((s, a) => s + a.outside, 0),
    nsv: arrays.reduce((s, a) => s + a.nsv, 0),
    nMulti: arrays.filter((a) => a.recs.length > 1).length,
  };
  Object.defineProperty(ld, "__geom", { value: geom, enumerable: false });
  return geom;
}

/**
 * Which column of one array belongs to an individual, or -1 where they have no assembly.
 *
 * Resolved through the cohort index the ETL ships rather than by position, and memoised per
 * array: a frame narrower than the cohort holds its people in the same order but not at the
 * same offsets, so column k of chr13 and column k of chr12 are different individuals from
 * the sixth absent person onward.
 */
function columnOf(a, geom, who) {
  if (!a.__at) {
    const at = new Map();
    a.cols.forEach((sample, col) => at.set(geom.samples[sample], col));
    Object.defineProperty(a, "__at", { value: at, enumerable: false });
  }
  const col = a.__at.get(who);
  return col == null ? -1 : col;
}

/**
 * One individual's carriage along one array, split by class, in windows of BIN bases.
 *
 * Deletions remove sequence and the other three classes add or rearrange it, so the split
 * drawn here is deletions against everything else. That keeps the 244 tandem duplications
 * and 64 breakends inside the picture: a deletions-against-insertions split would leave 308
 * of the 10,691 variants painted nowhere.
 */
export function binOne(a, geom, who) {
  const col = columnOf(a, geom, who);
  const del = new Float32Array(a.nb), ins = new Float32Array(a.nb);
  if (col < 0) return { del, ins, absent: true, total: 0 };
  const d = dosages(a.frame), m = a.frame.m, w = a.span / a.nb;
  let total = 0;
  for (const v of a.svs) {
    if (!d[v.row * m + col]) continue;
    const k = Math.min(a.nb - 1, Math.floor((v.pos - a.lo) / w));
    if (v.svtype === "DEL") del[k] += 1; else ins[k] += 1;
    total += 1;
  }
  return { del, ins, absent: false, total };
}

/** The same windows averaged over every individual assembled on that array. Cached. */
export function binCohort(a, geom) {
  if (a.__coh) return a.__coh;
  const acc = new Float32Array(a.nb);
  const d = dosages(a.frame), m = a.frame.m, w = a.span / a.nb;
  for (const v of a.svs) {
    const k = Math.min(a.nb - 1, Math.floor((v.pos - a.lo) / w));
    let n = 0;
    for (let c = 0; c < m; c++) if (d[v.row * m + c]) n += 1;
    acc[k] += n / m;
  }
  Object.defineProperty(a, "__coh", { value: acc, enumerable: false });
  return acc;
}

/** Every array's windows for one individual, with the totals a note needs. */
function profile(geom, who) {
  const rows = geom.arrays.map((a) => {
    const b = binOne(a, geom, who);
    const coh = binCohort(a, geom);
    let peak = 0, del = 0, ins = 0;
    for (let k = 0; k < a.nb; k++) {
      const t = b.del[k] + b.ins[k];
      if (t > peak) peak = t;
      del += b.del[k]; ins += b.ins[k];
    }
    return { a, ...b, coh, peak, delTot: del, insTot: ins };
  });
  return {
    rows,
    peak: Math.max(1, ...rows.map((r) => r.peak)),
    total: rows.reduce((s, r) => s + r.total, 0),
    delTot: rows.reduce((s, r) => s + r.delTot, 0),
    insTot: rows.reduce((s, r) => s + r.insTot, 0),
    absent: rows.filter((r) => r.absent).map((r) => r.a.chrom),
  };
}

/** A window's colour under each reading. */
function fillOf(mode, r, k, peak) {
  const mine = r.del[k] + r.ins[k];
  if (mode === "departure") {
    const theirs = r.coh[k];
    if (mine + theirs < 0.05) return rgb(PAGE);
    const t = (mine - theirs) / (mine + theirs + 1);
    return rgb(mix(PAGE, t > 0 ? COOL : WARM, Math.min(1, Math.abs(t) * 1.6)));
  }
  if (!mine) return rgb(PAGE);
  const hue = mix(DEL_HUE, INS_HUE, r.ins[k] / mine);
  return rgb(mix(PAGE, hue, clamp(0.22 + 0.78 * logT(mine, peak), 0, 1)));
}

const W = 980, LABEL = 128, PAD = 14, ROW = 15, GAP = 4;

function figure(geom, prof, mode) {
  const plot = W - LABEL - PAD;
  const H = geom.arrays.length * (ROW + GAP) + 46;
  const perPx = geom.axis / plot;
  // x = 0 is the active array start on every row; sequence before it runs negative
  const X = (bp) => LABEL + (bp + geom.back) / perPx;
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", `0 0 ${W} ${H}`);
  s.setAttribute("width", W); s.setAttribute("height", H);
  s.setAttribute("role", "img");
  s.setAttribute("aria-label",
    `Twenty-three centromeric arrays at one scale, painted by ${mode}.`);
  const add = (tag, attrs) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    s.append(e); return e;
  };
  const text = (x, y, str, attrs = {}) => {
    const e = add("text", { x, y, "font-size": 10, fill: "var(--text-secondary)", ...attrs });
    e.textContent = str; return e;
  };

  // the origin, drawn once behind every row
  add("line", { x1: X(0), x2: X(0), y1: 3, y2: geom.arrays.length * (ROW + GAP) + 4,
    stroke: "var(--accent)", "stroke-width": 1, opacity: 0.45 });

  prof.rows.forEach((r, i) => {
    const y = i * (ROW + GAP) + 6;
    const a = r.a;
    text(LABEL - 44, y + 11, a.chrom, { "text-anchor": "end", "font-size": 10.5 });
    text(LABEL - 6, y + 11, r.absent ? "—" : fmtInt(r.total),
      { "text-anchor": "end", class: "num", "font-size": 10 });
    if (r.absent) {
      add("rect", { x: X(a.lo - a.alo), y: y + 3, width: a.span / perPx, height: ROW - 6,
        fill: "none", stroke: "var(--grid)", "stroke-dasharray": "3 3" });
      text(X(a.lo - a.alo) + 6, y + 11, "no assembly",
        { "font-size": 9.5, fill: "var(--text-muted)" });
      return;
    }
    // the sequence between records carries no variant in any of the 188, so it reads as a
    // rule rather than a band: empty width should look empty
    add("line", { x1: X(a.lo - a.alo), x2: X(a.hi - a.alo), y1: y + ROW / 2,
      y2: y + ROW / 2, stroke: "var(--grid)" });
    a.recs.forEach((rec) => {
      const h = rec.active ? ROW : ROW - 6;
      add("rect", { x: X(rec.s - a.alo), y: y + (rec.active ? 0 : 3),
        width: Math.max((rec.e - rec.s) / perPx, 1), height: h, fill: "var(--surface-1)" });
    });
    const bw = a.span / a.nb / perPx;
    for (let k = 0; k < a.nb; k++) {
      const mid = a.lo + (k + 0.5) * (a.span / a.nb);
      const rec = a.recs.find((q) => mid >= q.s && mid <= q.e);
      if (!rec) continue;                    // between records: nothing is carried there
      add("rect", { x: X(a.lo + k * (a.span / a.nb) - a.alo),
        y: y + (rec.active ? 0 : 3), width: Math.max(bw, 0.7),
        height: rec.active ? ROW : ROW - 6, fill: fillOf(mode, r, k, prof.peak) });
    }
    a.recs.forEach((rec) => {
      const w = Math.max((rec.e - rec.s) / perPx, 1);
      // one tract keeps one stroke and steps in height; a box set apart keeps its own
      // dash, dropped below 3 px where the pattern has no room to resolve
      const joined = rec.active || rec.joins;
      const box = add("rect", { x: X(rec.s - a.alo), y: y + (rec.active ? 0 : 3),
        width: w, height: rec.active ? ROW : ROW - 6,
        fill: "none", stroke: joined ? "var(--axis)" : "var(--text-muted)",
        "stroke-width": rec.active ? 0.9 : 0.7,
        "stroke-dasharray": (joined || w < 3) ? null : "3 2" });
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = `${rec.full} · ${bp(rec.e - rec.s)}`
        + (rec.active ? " · the active array"
           : rec.joins ? " · a further HOR array continuing from the active one"
           : " · a further HOR array, with sequence between");
      box.append(t);
    });
    // the CenSat boundary inside a continuous tract, which the step alone leaves implicit
    a.recs.forEach((rec, j) => {
      const nxt = a.recs[j + 1];
      if (!nxt || rec.e !== nxt.s) return;
      add("line", { x1: X(rec.e - a.alo), x2: X(rec.e - a.alo), y1: y, y2: y + ROW,
        stroke: "var(--text-muted)", "stroke-width": 0.7 });
    });
  });

  const y = geom.arrays.length * (ROW + GAP) + 12;
  add("line", { x1: X(-geom.back), x2: X(geom.fwd), y1: y, y2: y, stroke: "var(--grid)" });
  const first = Math.ceil(-geom.back / 1e6), last = Math.floor(geom.fwd / 1e6);
  for (let mb = first; mb <= last; mb++) {
    const x = X(mb * 1e6);
    add("line", { x1: x, x2: x, y1: y, y2: y + 4, stroke: "var(--grid)" });
    text(x, y + 14, String(mb), { "text-anchor": "middle", "font-size": 9 });
  }
  text(X(geom.fwd), y + 26, "Mb from the active array start, one shared scale",
    { "text-anchor": "end", "font-size": 9.5, fill: "var(--text-muted)" });
  text(LABEL - 44, y + 14, "chr", { "text-anchor": "end", "font-size": 9 });
  return s;
}

function legend(mode, peak) {
  const swatch = (c, label) =>
    el("span", {}, el("i", { style: `background:${c}` }), label);
  if (mode === "departure") {
    // The neutral tone covers two cases a reader would otherwise read as one: this
    // individual matching the cohort, and a window the panel holds no variant in at all.
    return el("div", { class: "arrkey" },
      swatch(rgb(mix(PAGE, WARM, 0.85)), "below the cohort"),
      swatch(rgb(PAGE), "at the cohort, or holding no variant"),
      swatch(rgb(mix(PAGE, COOL, 0.85)), "above the cohort"),
      swatch("transparent", "outlined: the active array"));
  }
  return el("div", { class: "arrkey" },
    swatch(rgb(DEL_HUE), "deletions"),
    swatch(rgb(mix(DEL_HUE, INS_HUE, 0.5)), "both classes"),
    swatch(rgb(INS_HUE), "insertions, duplications and breakends"),
    swatch(rgb(mix(PAGE, INS_HUE, 0.3)), `paler: fewer, to ${peak} in a 25 kb window`),
    el("span", {}, el("i", { style: "background:transparent;border:1px solid #c3c2b7" }),
      "the active array, aligned at zero"),
    el("span", {}, el("i", { style: "background:transparent;border:1px solid #c3c2b7;" +
      "border-top-width:4px" }), "a further HOR array continuing from it"),
    el("span", {}, el("i", { style: "background:transparent;border:1px dashed #75726b" }),
      "a further HOR array, with sequence between"));
}

/** The measured sentence under each reading. Numbers a reader would otherwise have to guess. */
function caption(geom, prof, mode, who, pop) {
  const drawn = prof.rows.filter((r) => !r.absent);
  if (mode === "departure") {
    // Windows the panel holds no variant in are excluded from the denominator: counting them
    // as agreement would read as this individual matching the cohort across empty sequence.
    let above = 0, below = 0, level = 0, empty = 0;
    let up = { t: -2 }, dn = { t: 2 };
    for (const r of drawn) {
      for (let k = 0; k < r.a.nb; k++) {
        const mine = r.del[k] + r.ins[k], theirs = r.coh[k];
        if (mine + theirs < 0.05) { empty += 1; continue; }
        const t = (mine - theirs) / (mine + theirs + 1);
        if (t > 0.005) above += 1; else if (t < -0.005) below += 1; else level += 1;
        const at = r.a.lo + (k + 0.5) * (r.a.span / r.a.nb);
        if (t > up.t) up = { t, chrom: r.a.chrom, at, mine, theirs };
        if (t < dn.t) dn = { t, chrom: r.a.chrom, at, mine, theirs };
      }
    }
    return `<b>${who}</b> (${pop}) carries <b>${fmtInt(prof.total)}</b> variants across ` +
      `${drawn.length} arrays. Of the ${fmtInt(above + below + level)} windows where this ` +
      `cohort carries anything, <b>${fmtInt(above)}</b> hold more than the cohort mean, ` +
      `<b>${fmtInt(below)}</b> hold less and ${fmtInt(level)} match it; a further ` +
      `${fmtInt(empty)} windows of the array hold no variant in any of the 188. ` +
      `The widest excess falls on <b>${up.chrom}</b> at ` +
      `${(up.at / 1e6).toFixed(2)} Mb, ${up.mine} against a cohort mean of ` +
      `${up.theirs.toFixed(2)}; the widest shortfall on <b>${dn.chrom}</b> at ` +
      `${(dn.at / 1e6).toFixed(2)} Mb, ${dn.mine} against ${dn.theirs.toFixed(2)}.`;
  }
  const skew = drawn.filter((r) => r.total >= 20)
    .map((r) => ({ c: r.a.chrom, f: r.delTot / r.total, n: r.total }));
  skew.sort((a, b) => b.f - a.f);
  const most = skew[0], least = skew[skew.length - 1];
  return `<b>${who}</b> (${pop}) carries <b>${fmtInt(prof.total)}</b> variants across ` +
    `${drawn.length} arrays: <b>${fmtInt(prof.delTot)}</b> deletions and ` +
    `<b>${fmtInt(prof.insTot)}</b> insertions, tandem duplications and breakends. ` +
    (most ? `Deletions run highest on <b>${most.c}</b> at ` +
      `${(100 * most.f).toFixed(0)}% of ${fmtInt(most.n)} carried, and lowest on ` +
      `<b>${least.c}</b> at ${(100 * least.f).toFixed(0)}% of ${fmtInt(least.n)}. ` : "") +
    `The deepest window holds <b>${prof.peak}</b>.`;
}

/** #/arrays/<individual> */
export function page(ctx) {
  const { geom, ld, hapIndex, opt, onOpt } = ctx;
  const who = opt.who, mode = opt.mode;
  const prof = profile(geom, who);
  const rec = (hapIndex && hapIndex.samples || []).find((x) => x.s === who);
  const pop = rec ? `${rec.pop} · ${rec.sup}` : "ancestry unrecorded";

  const picker = el("label", { class: "arrpick" }, "individual ",
    el("select", { onchange: (e) => onOpt("who", e.target.value) },
      ...geom.samples.map((s) => el("option", { value: s, selected: s === who || null }, s))));
  const modes = el("div", { class: "arrmodes paintswitch", role: "group", "aria-label": "what colour reads" },
    ...MODES.map(([v, label]) => el("button", {
      type: "button", class: "arrmode" + (v === mode ? " on" : ""),
      "aria-pressed": v === mode ? "true" : "false",
      onclick: () => onOpt("mode", v),
    }, label)));

  return [
    el("div", { class: "arrbar" }, picker, modes),
    el("div", { class: "arrfig" }, figure(geom, prof, mode)),
    legend(mode, prof.peak),
    el("p", { class: "note", html: caption(geom, prof, mode, who, pop) }),
    el("details", { class: "pnote" },
      el("summary", { class: "muted" }, "What the bands are"),
      el("div", { class: "muted" },
        el("p", {}, `Every row is aligned on the start of its active array, the solid ` +
          `outline, so the same x means the same landmark on all ${geom.arrays.length}. ` +
          `${fmtInt(geom.outside)} of the ${fmtInt(geom.nsv)} variants sit outside an ` +
          `active array, and every one of them falls inside a further CenSat HOR array on ` +
          `the same chromosome; ${geom.nMulti} chromosomes carry more than one. A further ` +
          `array that continues straight out of the active one shares its outline and ` +
          `steps down in height, with a tick at the boundary; one with sequence between ` +
          `keeps its own dashed box. Every record is named on hover with its length, and ` +
          `sequence belonging to no array is left as a rule, because every variant the ` +
          `${fmtInt(geom.samples.length)} carry falls inside one of the arrays.`),
        el("p", {}, `Depth runs through log1p, because carriage density across these arrays ` +
          `spans a factor of 126 and a linear ramp would fill the densest and empty the ` +
          `sparsest.`),
        el("p", {}, `Columns are joined to individuals by name. ` +
          Object.entries(ld.partial || {}).map(([c, n]) =>
            `${c} is assembled for ${fmtInt(n)} of the ${fmtInt(geom.samples.length)}`)
            .join("; ") +
          `${Object.keys(ld.partial || {}).length ? ", and an" : "An"} individual without ` +
          `an assembly reads as a dashed row.`))),
  ];
}

/**
 * A CHM13 position as a fraction of its array's COVERED bases, or null outside them.
 *
 * The mirror of main.js coveredPos, which converts the other way. Every catalogued variant
 * sits inside a block - checked there, and checked again by the count this figure prints -
 * so a null here would mean the annotation and the frame had come apart.
 */
export function coveredFrac(blocks, pos) {
  let total = 0;
  for (const b of blocks) total += b.end - b.start;
  if (!total) return null;
  let seen = 0;
  for (const b of blocks) {
    if (pos < b.start) return null;
    if (pos <= b.end) return (seen + (pos - b.start)) / total;
    seen += b.end - b.start;
  }
  return null;
}

/** Pearson r over the bins where both series carry a number. */
function corr(a, b) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (b[i] == null || !Number.isFinite(b[i])) continue;
    n += 1; sa += a[i]; sb += b[i];
  }
  if (n < 3) return null;
  const ma = sa / n, mb = sb / n;
  let saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    if (b[i] == null || !Number.isFinite(b[i])) continue;
    const da = a[i] - ma, db = b[i] - mb;
    saa += da * da; sbb += db * db; sab += da * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * Every array's variants binned onto the tracks' own frame, with both correlations.
 *
 * The bin count comes from the shipped track rather than a constant, so a rebuild at a
 * different resolution moves all three quantities together.
 */
export function cohortProfile(geom, tracks) {
  if (geom.__cop) return geom.__cop;
  const rows = geom.arrays.map((a) => {
    const meth = tracks?.meth?.[a.chrom] || null;
    const dips = tracks?.density?.[a.chrom] || null;
    const nb = (meth && meth.length) || 60;
    const n = new Float64Array(nb);
    let placed = 0;
    for (const v of a.svs) {
      const f = coveredFrac(a.blocks, v.pos);
      if (f == null) continue;
      n[Math.min(nb - 1, Math.floor(f * nb))] += 1;
      placed += 1;
    }
    return { a, nb, n, placed, meth, dips,
      rMeth: meth ? corr(n, meth) : null, rDips: dips ? corr(n, dips) : null };
  });
  rows.sort((p, q) => (q.rMeth ?? -2) - (p.rMeth ?? -2));
  const rs = rows.map((r) => r.rMeth).filter((x) => x != null).sort((x, y) => x - y);
  const cop = {
    rows,
    placed: rows.reduce((s, r) => s + r.placed, 0),
    nsv: rows.reduce((s, r) => s + r.a.nsv, 0),
    med: rs.length ? rs[rs.length >> 1] : null,
    lo: rows[rows.length - 1], hi: rows[0],
  };
  Object.defineProperty(geom, "__cop", { value: cop, enumerable: false });
  return cop;
}

const CW = 980, CLAB = 196, CROW = 23, CGAP = 4;

/**
 * All 23 on the tracks' frame: variants as bars, methylation and dips as lines.
 *
 * Each row's methylation runs over its OWN range. The 23 together span 43.7 to 71.8 and
 * one chromosome moves over a tenth of that, so a shared scale draws every line flat under
 * a printed correlation that is entirely about shape.
 */
function cohortFigure(cop, show) {
  // The bars carry the new reading and the lines carry the context, so the bars take the
  // heavier tone. --array-band is the flank band's fill, meant to sit under a painted
  // window, and it left this track fainter than either line.
  const BAR = rgb(mix(PAGE, [34, 44, 54], 0.42));
  const plot = CW - CLAB - 16;
  const H = cop.rows.length * (CROW + CGAP) + 84;
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", `0 0 ${CW} ${H}`);
  s.setAttribute("width", CW); s.setAttribute("height", H);
  s.setAttribute("role", "img");
  s.setAttribute("aria-label",
    "Variant density along all 23 centromeric arrays, beside methylation and dip density.");
  const add = (tag, attrs) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    s.append(e); return e;
  };
  const text = (x, y, str, attrs = {}) => {
    const e = add("text", { x, y, "font-size": 10, fill: "var(--text-secondary)", ...attrs });
    e.textContent = str; return e;
  };
  const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
    .join(" ");

  text(CLAB - 150, 20, "chr", { "text-anchor": "end", "font-size": 9 });
  text(CLAB - 116, 20, "SVs", { "text-anchor": "end", "font-size": 9, fill: "var(--text-muted)" });
  if (show.meth) text(CLAB - 62, 20, "r meth",
    { "text-anchor": "end", "font-size": 9, fill: `${rgb(DEL_HUE)}` });
  if (show.dips) text(CLAB - 6, 20, "r dips",
    { "text-anchor": "end", "font-size": 9, fill: `${rgb(INS_HUE)}` });
  text(CLAB, 20, "bars: that centromere's variants", { "font-size": 9.5, fill: "var(--text-muted)" });

  cop.rows.forEach((r, i) => {
    const y = 30 + i * (CROW + CGAP);
    const tot = r.placed || 1;
    add("rect", { x: CLAB, y, width: plot, height: CROW, fill: "var(--surface-1)" });
    let top = 0;
    for (let k = 0; k < r.nb; k++) top = Math.max(top, r.n[k] / tot);
    for (let k = 0; k < r.nb; k++) {
      const h = top > 0 ? CROW * (r.n[k] / tot) / top : 0;
      if (h > 0) add("rect", { x: CLAB + k * plot / r.nb, y: y + CROW - h,
        width: plot / r.nb - 0.5, height: h, fill: BAR });
    }
    if (show.dips && r.dips) {
      let dm = 0;
      for (const v of r.dips) if (Number.isFinite(v)) dm = Math.max(dm, v);
      if (dm > 0) add("path", { d: line(r.dips.map((v, k) =>
        [CLAB + (k + 0.5) * plot / r.nb, y + CROW - CROW * (v || 0) / dm])),
        fill: "none", stroke: `${rgb(INS_HUE)}`, "stroke-width": 0.8, opacity: 0.55 });
    }
    if (show.meth && r.meth) {
      const fin = r.meth.filter((v) => Number.isFinite(v));
      const lo = Math.min(...fin), hi = Math.max(...fin), rng = hi - lo || 1;
      add("path", { d: line(r.meth.map((v, k) =>
        [CLAB + (k + 0.5) * plot / r.nb,
          y + CROW - (CROW - 2) * ((v - lo) / rng) - 1])),
        fill: "none", stroke: `${rgb(DEL_HUE)}`, "stroke-width": 1.5 });
    }
    text(CLAB - 150, y + 15, r.a.chrom, { "text-anchor": "end", "font-size": 10.5,
      fill: "var(--text-primary)" });
    text(CLAB - 116, y + 15, fmtInt(r.placed), { "text-anchor": "end", "font-size": 9.5,
      class: "num" });
    if (show.meth) text(CLAB - 62, y + 15, r.rMeth == null ? "—" : fmtSig(r.rMeth),
      { "text-anchor": "end", "font-size": 10, class: "num",
        fill: Math.abs(r.rMeth ?? 0) > 0.4 ? rgb(DEL_HUE) : "var(--text-muted)" });
    if (show.dips) text(CLAB - 6, y + 15, r.rDips == null ? "—" : fmtSig(r.rDips),
      { "text-anchor": "end", "font-size": 9.5, class: "num",
        fill: Math.abs(r.rDips ?? 0) > 0.4 ? rgb(INS_HUE) : "var(--text-muted)" });
  });

  const y = 30 + cop.rows.length * (CROW + CGAP) + 6;
  add("line", { x1: CLAB, x2: CLAB + plot, y1: y, y2: y, stroke: "var(--axis)" });
  ["array start", "quarter", "midpoint", "three quarters", "array end"].forEach((t, k) => {
    const x = CLAB + k * plot / 4;
    add("line", { x1: x, x2: x, y1: y, y2: y + 4, stroke: "var(--axis)" });
    text(x, y + 15, t, { "font-size": 9,
      "text-anchor": k === 0 ? "start" : k === 4 ? "end" : "middle" });
  });
  text(CLAB, y + 30, "covered bases of the active array", { "font-size": 9.5,
    fill: "var(--text-muted)" });
  if (show.meth) text(CLAB + plot, y + 30, "each row's methylation over its own range",
    { "font-size": 9.5, "text-anchor": "end", fill: "var(--text-muted)" });
  return s;
}

/** A signed correlation, always with its sign, so a column of them reads as one. */
function fmtSig(v) {
  return (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(2);
}

/** Which optional tracks are on, from the compact form the address carries. */
export function readTrk(q) {
  const v = q == null ? DEFAULT_TRK : q;
  return { meth: v.includes("m"), dips: v.includes("d") };
}

export function writeTrk(show) {
  return (show.meth ? "m" : "") + (show.dips ? "d" : "") || "none";
}

/** #/individuals with the cohort reading on screen. */
export function cohortBlock(ctx) {
  const { geom, tracks, trk, onTrk } = ctx;
  const cop = cohortProfile(geom, tracks);
  const show = readTrk(trk);
  const bar = el("div", { class: "arrbar" },
    el("span", { class: "eyebrow" }, "tracks"),
    el("div", { class: "arrmodes trackswitch", role: "group",
      "aria-label": "which tracks are drawn" },
      ...TRACKS.map(([v, label]) => el("button", {
        type: "button", class: "arrmode" + (show[v] ? " on" : ""),
        "aria-pressed": show[v] ? "true" : "false",
        onclick: () => onTrk(writeTrk({ ...show, [v]: !show[v] })),
      }, label))),
    el("span", { class: "eyebrow num", html:
      `<b>${fmtInt(cop.placed)}</b> variants · <b>${geom.arrays.length}</b> centromeres` }));
  return [
    bar,
    el("div", { class: "arrfig" }, cohortFigure(cop, show)),
    el("p", { class: "note", html:
      `Variant density along every array, on the covered-base frame the methylation ` +
      `track uses. Across the ${geom.arrays.length} the two agree at a median of ` +
      `<b>${fmtSig(cop.med)}</b>, from <b>${fmtSig(cop.lo.rMeth)}</b> on ` +
      `<b>${cop.lo.a.chrom}</b> to <b>${fmtSig(cop.hi.rMeth)}</b> on ` +
      `<b>${cop.hi.a.chrom}</b>.` }),
    el("details", { class: "pnote" },
      el("summary", { class: "muted" }, "How the three are placed"),
      el("div", { class: "muted" },
        el("p", {}, `All three read the same abscissa: covered bases of the active ` +
          `blocks, which is the frame the methylation and dip tracks are computed on. ` +
          `Ten chromosomes carry more than one block, and merging them is what lets a ` +
          `gap stay a gap; all ${fmtInt(cop.placed)} of the ${fmtInt(cop.nsv)} variants ` +
          `land inside one.`),
        el("p", {}, `Bars carry each centromere's own variants as a share of its own ` +
          `total, so a short array and a long one are read alike. Methylation runs over ` +
          `each row's own range for the same reason: the 23 together span 43.7 to 71.8 ` +
          `percent and one chromosome moves over a tenth of that.`),
        el("p", {}, `Methylation and dip density are close partners by construction, so ` +
          `their own correlation carries little. The variant row is the new reading, and ` +
          `the array interior it asks about is also where calling is hardest.`))),
  ];
}

/** What the heading says while this reading is on screen. */
export function cohortLine(geom) {
  return `<b>${fmtInt(geom.samples.length)}</b> individuals with diploid genotypes · ` +
    `<b>${fmtInt(geom.nsv)}</b> variants · <b>${geom.arrays.length}</b> centromeres · ` +
    `<b>${(geom.totActive / 1e6).toFixed(1)} Mb</b> of active array`;
}
