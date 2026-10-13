/**
 * R8: the methylation scan, as one sortable table.
 *
 * The section's claim is DISTRIBUTIONAL - association concentrates near the SV, and deletion
 * dosage runs negative there - so a reader needs to compare variants against each other
 * rather than meet them one record panel at a time. This is that comparison.
 *
 * Two things are carried on every row because leaving either out would flatter the data.
 * DISTANCE, because the scan tested every CpG on the chromosome and a pair 136 Mb from its
 * SV passed the same test as one 766 bp away; the nearest-CpG column is what separates them,
 * and it does so without borrowing the significance slot, which on this site means the
 * section's own headline band. And the WHOLE-SCAN CHECK, the maximum-statistic calibration
 * met_08_mqtl.tex states and Figure 4a marks - one deletion clears it, and a table that
 * showed only q would let 41 other variants read as equally settled.
 *
 * SVs the scan tested and returned nothing for are here too, with an empty q. Their absence
 * is the answer to a question a record panel cannot otherwise settle: whether a variant came
 * back clean or never entered the scan at all.
 */
import { el, fmtInt, fmtQ } from "./dom.js";

const NEAR = 5e6;

/** A distance a reader can compare at a glance, in the unit that suits its size. */
export function span(d) {
  if (d == null) return "—";
  if (d < 1000) return d + " bp";
  if (d < 1e6) return (d / 1e3).toFixed(1) + " kb";
  return (d / 1e6).toFixed(0) + " Mb";
}

/**
 * One row per catalogue SV the scan touched, from the shipped layer rows and catalogue.
 *
 * Built here rather than in the ETL because both inputs are already in the browser, and a
 * second shipped file would be a second thing to keep in step with layers.json.
 */
export function summarise(layers, catalog) {
  const by = new Map();
  for (const d of catalog) {
    if (!d.meth_tested) continue;
    by.set(d.chrom + "|" + d.sv_index, {
      chrom: d.chrom, sv_index: d.sv_index, sv_id: d.sv_id, svtype: d.svtype,
      svlen: d.svlen, pos: d.pos, svfreq: d.svfreq,
      carriers: d.meth_carriers, n: d.meth_n,
      cpgs: 0, near: 0, nearNeg: 0, nearest: null, q: null, beta: null, maxt: null,
    });
  }
  for (const h of layers) {
    if (h.layer !== "mqtl") continue;
    const r = by.get(h.chrom + "|" + h.sv_index);
    if (!r) continue;
    r.cpgs += 1;
    if (h.distance <= NEAR) { r.near += 1; if (h.beta < 0) r.nearNeg += 1; }
    if (r.nearest == null || h.distance < r.nearest) r.nearest = h.distance;
    if (r.q == null || h.qval < r.q) { r.q = h.qval; r.beta = h.beta; }
    if (r.maxt == null || h.maxt < r.maxt) r.maxt = h.maxt;
  }
  for (const r of by.values()) r.negFrac = r.near ? r.nearNeg / r.near : null;
  return [...by.values()];
}

export const METH_COLS = [
  { label: "SV", key: "sv", get: (r) => r.sv_id },
  { label: "type", key: "type", get: (r) => r.svtype },
  { label: "length", key: "len", num: true, get: (r) => r.svlen },
  { label: "CHM13 pos", key: "pos", num: true, get: (r) => r.pos },
  { label: "carriers", key: "carr", num: true, get: (r) => r.carriers },
  { label: "CpGs", key: "cpgs", num: true, get: (r) => (r.cpgs ? r.cpgs : null) },
  { label: "within 5 Mb", key: "near", num: true, get: (r) => (r.cpgs ? r.near : null) },
  { label: "lower methylation", key: "neg", num: true, get: (r) => r.negFrac },
  { label: "nearest CpG", key: "dist", num: true, get: (r) => r.nearest },
  { label: "best q", key: "q", num: true, get: (r) => r.q },
  { label: "β", key: "beta", num: true, get: (r) => r.beta },
  { label: "whole-scan check", key: "maxt", num: true, get: (r) => r.maxt },
];
export const METH_SORT = { key: "q", dir: 1 };

/**
 * Sorted rows, with missing values LAST whichever way the arrow points.
 *
 * The 26 SVs the scan returned nothing for have no q, no distance and no beta. Floating them
 * to the top on one click would fill the first screen with the variants that have least to
 * say. Ties fall back to the default order so the table never depends on the engine's sort.
 */
export function sortMeth(rows, sort) {
  const col = METH_COLS.find((c) => c.key === sort.key) || METH_COLS[9];
  const dflt = (a, b) => (a.q == null ? 1 : b.q == null ? -1 : a.q - b.q)
    || b.cpgs - a.cpgs || a.chrom.localeCompare(b.chrom, undefined, { numeric: true });
  return rows.slice().sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    const na = va == null || va === "", nb = vb == null || vb === "";
    if (na !== nb) return na ? 1 : -1;
    if (na) return dflt(a, b);
    const c = col.num ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return (c * sort.dir) || dflt(a, b);
  });
}

function table(rows, sort, onSort) {
  const head = el("tr", {}, ...METH_COLS.map((c) => {
    const on = sort.key === c.key;
    return el("th", { class: c.num ? "num" : null,
      "aria-sort": on ? (sort.dir < 0 ? "descending" : "ascending") : "none" },
      el("button", { class: "hapsort" + (on ? " on" : ""), type: "button",
        onclick: () => onSort(c.key) },
        c.label, el("span", { class: "arr", "aria-hidden": "true" },
          on ? (sort.dir < 0 ? "↓" : "↑") : "")));
  }));
  const body = el("tbody");
  sortMeth(rows, sort).forEach((r) => {
    body.append(el("tr", { class: r.cpgs ? null : "methclean",
      onclick: () => { location.hash = `#/${r.chrom}/${r.sv_index}`; } },
      el("td", {}, r.sv_id),
      el("td", {}, r.svtype),
      el("td", { class: "num" }, fmtInt(r.svlen)),
      el("td", { class: "num" }, fmtInt(r.pos)),
      el("td", { class: "num" }, `${r.carriers} of ${r.n}`),
      el("td", { class: "num" }, r.cpgs ? fmtInt(r.cpgs) : "0"),
      el("td", { class: "num" }, r.cpgs ? fmtInt(r.near) : "—"),
      el("td", { class: "num" },
        r.negFrac == null ? "—" : (100 * r.negFrac).toFixed(0) + "%"),
      el("td", { class: "num" }, span(r.nearest)),
      el("td", { class: "num" }, r.q == null ? "—" : fmtQ(r.q)),
      el("td", { class: "num" }, r.beta == null ? "—" : r.beta.toFixed(3)),
      el("td", { class: "num" },
        r.maxt == null ? "—" : el("b", { class: r.maxt <= 0.05 ? "methclear" : null },
          r.maxt.toFixed(2)))));
  });
  return el("table", { class: "haptab wide" }, el("thead", {}, head), body);
}

/** #/methylation - every SV the scan tested, ordered by whichever column a reader picks. */
export function page(ctx) {
  const { rows, sort, onSort, note } = ctx;
  const withHits = rows.filter((r) => r.cpgs);
  const cpgs = new Set();
  ctx.layers.forEach((h) => { if (h.layer === "mqtl") cpgs.add(h.target); });
  return [
    el("h1", {}, "Methylation"),
    el("p", { class: "eyebrow num", html:
      `<b>${fmtInt(withHits.length)}</b> of <b>${fmtInt(rows.length)}</b> tested catalogue ` +
      `entries reach a CpG at q &lt; 0.01 · <b>${fmtInt(ctx.nSvs)}</b> SVs across ` +
      `<b>${fmtInt(ctx.nChroms)}</b> centromeres` }),
    el("p", { class: "muted" },
      "Haplotype-resolved CpG methylation against SV genotypes called from long reads, in " +
      "124 people. Every CpG on the same chromosome was tested, so the nearest-CpG column " +
      "carries as much as the q does."),
    el("details", { class: "pnote" },
      el("summary", { class: "muted" }, "How to read this table"),
      el("div", { class: "muted" },
        el("p", {}, el("b", {}, "lower methylation"),
          " is the share of CpGs within 5 Mb where a higher dosage goes with less " +
          "methylation. Across the scan that share is 97.3% for deletions."),
        el("p", {}, el("b", {}, "whole-scan check"),
          " is the maximum-statistic calibration from 10,000 Mammen score-multiplier " +
          "replicates, computed across the whole scan. One deletion clears it at 0.05, " +
          "marked in bold under each of its resolution modes."),
        el("p", {}, el("b", {}, "CpGs 0"),
          " marks an SV the scan tested whose CpGs all sit above q = 0.01."),
        note ? el("p", {}, note) : null)),
    table(rows, sort, onSort),
  ];
}

/** The card on the overview. */
export function overviewEntry(meta) {
  const m = meta && meta.meth;
  if (!m) return null;
  return el("a", { class: "hapcta", href: "#/methylation" },
    el("b", {}, "Methylation"),
    el("span", { class: "eyebrow inline num", html:
      `<b>${fmtInt(m.n_svs)}</b> SVs across <b>${fmtInt(m.n_chroms)}</b> centromeres mark ` +
      `local methylation loss` }));
}
