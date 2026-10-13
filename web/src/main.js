import "./style.css";
import { scaleLinear } from "d3-scale";
import { axisBottom, axisLeft } from "d3-axis";
import { select } from "d3-selection";
import { MB, css, el, esc, fmtInt, fmtMb, fmtQ } from "./dom.js";
import { KIND_LABEL, buildCorpus, mountSearch, resolve } from "./search.js";
import * as LD from "./ld.js";
import * as HAP from "./haplo.js";
import * as METH from "./meth.js";
import * as ARR from "./arrays.js";

const app = document.getElementById("app");
const tip = document.getElementById("tip");
const say = document.getElementById("announce");

const state = {
  catalog: [], layers: [], chroms: [], meta: null,
  byChrom: new Map(), hitsBySv: new Map(), layerMeta: new Map(),
  tier: "primary",        // "primary" = each analysis's headline band only
  evBySv: new Map(),      // sv key -> Set of layer keys, at the CURRENT tier
  fstSorted: [],          // for the percentile a single F_ST is read against
  corpus: null,
  hapIndex: null,        // per-chromosome haplotype counts, read by both entry links
  hapSv: null,           // which SV's clade is outlined
  hapOpt: { chrom: null, pop: "all", n: 50 },   // the gallery's controls
  hapSort: { ...HAP.MONO_SORT },                // which column the SV table is ordered by
  methSort: { ...METH.METH_SORT },              // and which column the methylation table is
  arrOpt: { who: null, mode: ARR.DEFAULT_MODE,   // whose arrays are painted, and in which reading
            trk: ARR.DEFAULT_TRK },              // which optional tracks the cohort figure draws
  tracks: null,           // methylation substrate: 5mC and dip density along the array
  // Which track panels a reader has folded away, by key. Held here rather than left to the
  // DOM, so that re-rendering for a filter change does not reopen them.
  folds: new Set(),
  ancBySv: new Map(),     // "sv_locus|phecode" -> per-stratum All of Us records
  // Filters. The frequency default is the one the author asked for and is a no-op on this
  // catalog, whose rarest SV is 0.0266 - stated on the control rather than left implicit.
  // The imputation floor defaults to NOTHING, because 0.1 is not a no-op here: it hides
  // 3,336 of 10,705 SVs and 12 published associations with them.
  minFreq: 0.025,
  minCvr2: 0,
  // Which analyses to narrow the view to. Empty = all of them.
  layerSel: new Set(),
  // "pooled"   one dip track over every haplotype
  // "ancestry" one track, stacked - each stratum's contribution to that same total
  // "rows"     one track per stratum, as a rate, so strata of different size compare
  dipMode: "pooled",
  // Which marks the chart draws. Held here for the same reason `folds` is: renderDetail
  // rebuilds the page on every filter, tier, fold and theme change, and a checkbox that
  // lives only in its own DOM node comes back unticked - silently restoring the ~1,500
  // marks a reader had just narrowed to 27.
  onlyHits: false,
  // The pericentromeric LD panel. null keeps it closed; a mode name opens it and says which
  // display selection is drawn. It lives in the query string like the dip mode, so a link
  // carries the panel a caption was written about.
  ld: null,
  ldMode: null,
  ldLabels: true,        // the region names on the LD figure
};

/** Fill for the k-th stratum in the fixed stack order. See tokens.css for the validation. */
const ancFill = (k) => css("--anc-" + ((k % 6) + 1));

/**
 * Ancestry strata on the dip track.
 *
 * A stratum needs at least this many haplotypes on a chromosome before its dip rate is
 * drawn. It is not a style choice: with one haplotype, a bin holding one dip reports a rate
 * of 1.0 dips per haplotype, twice the largest value anywhere in the pooled data, and three
 * cells in this cohort are exactly that. Drawn on a shared scale they would flatten every
 * real track underneath a counting artefact. Below the floor the row is kept and labelled
 * with its haplotype count rather than removed, because "too few here" is the answer to the
 * question the reader asked, and a missing row is not.
 */
const ANC_MIN_HAP = 10;
let search = null;

// ------------------------------------------------------------------ filters
/** Does this SV pass the current frequency and imputation floors? */
function passes(d) {
  return (d.svfreq ?? 0) >= state.minFreq && (d.cv_r2 ?? 0) >= state.minCvr2;
}

/**
 * Does this SV carry a result from one of the selected analyses?
 *
 * Deliberately not folded into passes(). The floors describe the CATALOG - what was measured
 * well enough to be worth drawing at all - and so belong in every count on the page. This
 * describes the reader's current question, and narrowing a question must not silently
 * rewrite the totals the page reports beside it.
 */
function inSel(d) {
  if (!state.layerSel.size) return true;
  const set = state.evBySv.get(svKey(d));
  if (!set) return false;
  for (const k of set) if (state.layerSel.has(k)) return true;
  return false;
}

/** Everything a view should draw: passes the floors and answers the current question. */
const shownSv = (d) => passes(d) && inSel(d);

/** A chromosome's SVs after the floors and the analysis selection. */
function svsOf(chrom) {
  return (state.byChrom.get(chrom) || []).filter(shownSv);
}

/**
 * A chromosome's SVs after the floors ONLY.
 *
 * This is the frame the chart's axes are built on, and it is a different list from svsOf on
 * purpose. Ranging the ordinate over whatever happens to be selected made the y-axis jump
 * whenever the reader narrowed the view, so marks moved on a control that was supposed to
 * hide some of them; every mark now keeps its position no matter what is filtered out.
 */
function svsInFrame(chrom) {
  return (state.byChrom.get(chrom) || []).filter(passes);
}

const FREQ_DEFAULT = 0.025, CVR2_DEFAULT = 0;

/**
 * Both floors live in the query string, like the significance tier.
 *
 * Not decoration: a filter that changes which published associations are on the page has to
 * travel with the link, or a colleague opening "the view I was looking at" sees a different
 * one. It is also the only way this control can be screenshotted, since headless Chrome
 * cannot type into a number field.
 */
/**
 * Every write of the address goes through here.
 *
 * Not tidiness: the navigation handler below de-duplicates on `location.href`, and it can
 * only do that safely if nothing changes the address behind its back. Four call sites used
 * to write it directly; a grep for the setter below should find exactly one.
 */
let navUrl = typeof location === "undefined" ? "" : location.href;
function setUrl(u) {
  history.replaceState(null, "", u);
  navUrl = location.href;
}

function syncFilterUrl() {
  const u = new URL(location.href);
  const set = (k, v, dflt) => (v === dflt ? u.searchParams.delete(k)
    : u.searchParams.set(k, String(v)));
  set("freq", state.minFreq, FREQ_DEFAULT);
  set("cvr2", state.minCvr2, CVR2_DEFAULT);
  if (state.layerSel.size) u.searchParams.set("only", [...state.layerSel].sort().join(","));
  else u.searchParams.delete("only");
  set("tier", state.tier, "primary");
  if (state.dipMode !== "pooled") u.searchParams.set("dips", state.dipMode);
  else u.searchParams.delete("dips");
  if (state.onlyHits) u.searchParams.set("hits", "1");
  else u.searchParams.delete("hits");
  if (!state.ldLabels) u.searchParams.set("rlab", "0");
  else u.searchParams.delete("rlab");
  if (state.ldMode) u.searchParams.set("ld", state.ldMode);
  else u.searchParams.delete("ld");
  setUrl(u);
}

function readFilterUrl() {
  const q = new URLSearchParams(location.search);
  const num = (k, dflt) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt;
  };
  // "suggestive" is the older spelling of the same request, and an unrecognised value means
  // the headline band, which is what a reader who set nothing gets.
  const tv = q.get("tier");
  state.tier = tv === "all" || tv === "suggestive" ? "all" : "primary";
  state.minFreq = num("freq", FREQ_DEFAULT);
  state.minCvr2 = num("cvr2", CVR2_DEFAULT);
  // Only keys that name a layer this build actually loaded. An unknown key from an old link
  // would otherwise select nothing and leave the page blank with no explanation.
  state.layerSel = new Set((q.get("only") || "").split(",")
    .filter((k) => k && state.layerMeta.has(k)));
  const dm = q.get("dips");
  state.dipMode = dm === "ancestry" || dm === "rows" ? dm : "pooled";
  // An unknown mode from an old link leaves the panel closed, which is the same state a
  // reader who never opened it sees.
  const lm = q.get("ld");
  state.ldMode = LD.MODES.some(([v]) => v === lm) ? lm : null;
  state.onlyHits = q.get("hits") === "1";
  state.ldLabels = q.get("rlab") !== "0";
}


// ------------------------------------------------------------------ evidence
/** Colour for an evidence count. 0 recedes; 1..4+ walk the validated ordinal ramp. */
function evColor(n) {
  if (!n) return css("--ev-0");
  return css("--ev-" + Math.min(n, 4));
}

/**
 * Ink that reads on a given step of the ramp, in either mode.
 *
 * The tag used to be white on whichever step it sat on, and the ramp inverts between modes -
 * so white was 2.11:1 on the light theme's --ev-1 and 2.22:1 on the dark theme's --ev-3.
 * Following the two ends of the ramp instead of picking a colour: --text-primary is dark on
 * light and white on dark, --surface-1 the reverse, and the low steps are light exactly where
 * the high steps are dark. Measured: 9.31, 4.87, 4.55 and 7.86 to one, all four cases.
 */
const evInk = (n) => css(n >= 3 ? "--surface-1" : "--text-primary");

const svKey = (d) => d.chrom + ":" + d.sv_index;

/** Hits on this SV that the current tier admits. */
function hitsOf(d) {
  const hs = state.hitsBySv.get(svKey(d)) || [];
  return state.tier === "all" ? hs : hs.filter((h) => h.tier === "primary");
}

/** How many independent analyses report a hit here, at the current tier. */
const ev = (d) => state.evBySv.get(svKey(d))?.size || 0;

/**
 * Rebuild the per-SV evidence counts for the active tier.
 *
 * The colour has to answer the question the tier control is asking, so it is recomputed
 * here rather than read off the baked n_layers - otherwise turning suggestive hits on would
 * add rows to the tables while leaving every mark the colour it had before. The search
 * corpus is dropped for the same reason: a suggestive-only gene must not stay findable
 * while the control says primary.
 */
function recomputeEvidence() {
  const shown = new Set();
  for (const d of state.catalog) if (passes(d)) shown.add(svKey(d));
  const m = new Map();
  for (const h of state.layers) {
    if (state.tier !== "all" && h.tier !== "primary") continue;
    const k = h.chrom + ":" + h.sv_index;
    // An SV the floors remove is removed from the counts too. Leaving its hits in would
    // make the legend and the marks disagree about what is on the page.
    if (!shown.has(k)) continue;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(h.layer);
  }
  state.evBySv = m;
  state.corpus = null;
  search?.invalidate();
}

const labelOf = (k) => state.layerMeta.get(k)?.label || k;

/**
 * The short badge on a result row.
 *
 * These used to be the manuscript's own section numbers - R7, R8, R8b - which are the
 * author's internal numbering and say nothing to anyone who has not written the paper.
 * The replacements are the abbreviations the fields themselves use, so a reader who has
 * never seen this study still knows what kind of result they are looking at. Anything
 * without an entry falls back to its layer key rather than rendering blank.
 */
const SHORT = { eqtl: "eQTL", sqtl: "sQTL", mqtl: "mQTL", cdr: "CDR", aou: "PheWAS" };
const shortOf = (k) => SHORT[k] || k.toUpperCase();

// ------------------------------------------------------------------ tooltip
function showTip(html, e) {
  tip.innerHTML = html;
  tip.setAttribute("aria-hidden", "false");
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
const hideTip = () => tip.setAttribute("aria-hidden", "true");

// ------------------------------------------------------------------ controls
/**
 * The significance control. Two tiers, not a slider: each analysis states a headline band
 * and at most one secondary band, so a continuous threshold would invite cuts the study
 * never made and cannot vouch for.
 */
function tierControl() {
  const wrap = el("fieldset", { class: "seg" }, el("legend", {}, "Significance"));
  [["primary", "Primary", "each analysis's headline threshold"],
   ["all", "+ suggestive", "and its secondary threshold where one exists"]].forEach(([val, lab, hint]) => {
    const id = "tier-" + val;
    const input = el("input", { type: "radio", name: "tier", id, value: val });
    input.checked = state.tier === val;
    input.onchange = () => {
      if (!input.checked) return;
      state.tier = val;
      recomputeEvidence();
      syncFilterUrl();
      routeKeepingFocus();
    };
    wrap.append(el("label", { for: id, title: hint }, input, lab));
  });
  return wrap;
}

/**
 * Carrier-frequency and imputation-accuracy floors. One control per quantity.
 *
 * These can only ever REMOVE marks. Nothing below the catalog's own floors was ever built,
 * so there is no "show more" direction to offer and the control says so rather than
 * implying a hidden reserve.
 *
 * There used to be a row of preset buttons beside the accuracy box - none / 0.10 / 0.30 -
 * setting the same number the box already sets. Two controls for one value is one control
 * too many, and bare numbers with no unit beside them read as a setting nobody explained.
 * The presets are gone; the box carries the whole range, and what any setting costs is in
 * its tooltip and in the note under the figure.
 *
 * The two floors are not symmetric and the labels do not pretend they are. Frequency at
 * 0.025 is a no-op: the rarest SV here is 0.0266, five of 188 haplotypes. Imputation
 * accuracy at 0.10 is NOT - a third of the catalog sits below it, carrying 12 published
 * associations - so it starts at nothing.
 */
function filterControl(onChange) {
  const f = state.meta?.floors || {};
  const wrap = el("fieldset", { class: "seg filters" }, el("legend", {}, "Filters"));

  const num = (label, key, step, min, max, title) => {
    const id = "flt-" + key;
    const input = el("input", {
      type: "number", id, step, min, max, value: String(state[key]),
      class: "numin", title,
    });
    input.onchange = () => {
      const v = Number(input.value);
      state[key] = Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
      input.value = String(state[key]);
      syncFilterUrl();
      onChange();
    };
    return el("label", { class: "fl", for: id }, el("span", {}, label), input);
  };

  wrap.append(num("min. allele frequency", "minFreq", 0.005, 0, 1,
    "The share of haplotypes carrying the variant. The rarest SV in this catalog is at " +
    (f.svfreq ?? 0).toFixed(4) + ", so the default of 0.025 keeps the whole catalog."));
  wrap.append(num("min. imputation accuracy", "minCvr2", 0.05, 0, 1,
    "Cross-validated R² between the imputed and the assembly-derived genotype. " +
    fmtInt(f.n_at_strict ?? 0) + " SVs reach the study's strict 0.30 threshold; " +
    "the default of 0 keeps every variant that was imputed at all."));

  return wrap;
}

/**
 * Pooled or per-ancestry dip track.
 *
 * Only offered where the data supports it, which is every chromosome, but the control is
 * still built from the loaded tracks rather than assumed - a build without the ancestry
 * decomposition should show one option, not a broken second one.
 */
function dipControl(onChange) {
  const T = state.tracks;
  if (!T?.density_anc || !T?.strata?.length) return null;
  const wrap = el("fieldset", { class: "seg" }, el("legend", {}, "Dip track"));
  [["pooled", "All haplotypes", "one track over the whole assembly cohort"],
   ["ancestry", "Stacked by ancestry", "the same total, split into each superpopulation's " +
     "share of it — the silhouette is identical to the pooled track"],
   ["rows", "One row each", "one track per superpopulation as a rate per haplotype, which " +
     "is what compares strata of very different size"]].forEach(([val, lab, hint]) => {
    const id = "dip-" + val;
    const input = el("input", { type: "radio", name: "dipmode", id, value: val });
    input.checked = state.dipMode === val;
    input.onchange = () => {
      if (!input.checked) return;
      state.dipMode = val;
      syncFilterUrl();
      onChange();   // routeKeepingFocus, from detailPanels
    };
    wrap.append(el("label", { for: id, title: hint }, input, lab));
  });
  return wrap;
}

// ------------------------------------------------------------------ legend
/**
 * The colour key, and the analysis picker.
 *
 * Two rows that do different jobs, and the difference is the whole design:
 *
 *   the swatch row DESCRIBES the figure beside it. Its counts are of the marks actually on
 *   this page, so on a chromosome page they are that chromosome's, not the catalog's. It is
 *   read, never clicked.
 *
 *   the chip row is a CONTROL. Each chip narrows the view to the SVs one analysis reports,
 *   and its count is of the whole scope regardless of what is currently selected - a
 *   selector whose own numbers move as you use it cannot be used to compare.
 *
 * Only the counts the data actually reaches get a swatch. The ramp holds four steps for
 * headroom, but drawing swatches for 3 and 4+ when nothing converges past 2 would claim a
 * resolution the evidence does not have.
 */
function legend(scope, onChange) {
  // Everything the floors admit in this scope: a chromosome's SVs on a chromosome page, the
  // catalog on the overview. NOT narrowed by the chip selection, which the rows handle
  // separately for the reasons above.
  const frame = scope || state.catalog.filter(passes);
  const drawn = frame.filter(inSel);

  const counts = new Map();
  let none = 0;
  drawn.forEach((d) => {
    const n = ev(d);
    if (n === 0) none += 1;
    else counts.set(n, (counts.get(n) || 0) + 1);
  });

  const wrap = el("div", { class: "legend" });
  wrap.append(el("span", { class: "eyebrow" }, "Converging analyses"));
  const items = el("div", { class: "items" });
  const item = (n, label, count) => el("div", { class: "it" },
    el("span", { class: "sw", style: `background:${evColor(n)}` }),
    el("span", {}, label),
    el("span", { class: "muted num" }, fmtInt(count)));
  if (none) items.append(item(0, "none", none));
  [...counts.keys()].sort((a, b) => a - b).forEach((n) => items.append(item(n, String(n), counts.get(n))));
  wrap.append(items);

  // Every loaded analysis gets a chip whether or not it fires in this scope, so the row does
  // not change shape between chromosomes. One that fires nowhere here is shown greyed rather
  // than dropped: "no result on this chromosome" is information, and a missing chip is not.
  const perLayer = new Map();
  frame.forEach((d) => (state.evBySv.get(svKey(d)) || []).forEach(
    (k) => perLayer.set(k, (perLayer.get(k) || 0) + 1)));
  const chips = el("div", { class: "chips" });
  const order = (state.meta?.layers || []).filter((l) => l.present).map((l) => l.key)
    .sort((a, b) => (perLayer.get(b) || 0) - (perLayer.get(a) || 0));

  order.forEach((k) => {
    const n = perLayer.get(k) || 0;
    const on = state.layerSel.has(k);
    // Nothing to select, and not selected: inert. But a SELECTED chip stays pressable even
    // at zero, because that is exactly the state you most need to leave - narrow to
    // PheWAS, open chr9, and the chip that got you there reads 0. Rendering it inert would
    // make its own toggle the one control that cannot undo itself.
    if (!n && !on) {
      chips.append(el("span", { class: "chip off", title: `${labelOf(k)}: 0 results here` },
        el("span", { class: "k" }, labelOf(k)), el("span", { class: "n num" }, "0")));
      return;
    }
    const b = el("button", {
      type: "button", class: "chip pick" + (on ? " on" : ""),
      "aria-pressed": on ? "true" : "false",
      title: on ? `Stop restricting to ${labelOf(k)}`
        : `Show only the SVs with a ${labelOf(k)} result`,
    }, el("span", { class: "k" }, labelOf(k)), el("span", { class: "n num" }, fmtInt(n)));
    b.onclick = () => {
      if (on) state.layerSel.delete(k); else state.layerSel.add(k);
      syncFilterUrl();
      (onChange || routeKeepingFocus)();
    };
    chips.append(b);
  });

  if (state.layerSel.size) {
    const clear = el("button", { type: "button", class: "chip pick clear",
      title: "Show every analysis again" }, "clear");
    clear.onclick = () => { state.layerSel.clear(); syncFilterUrl(); (onChange || route)(); };
    chips.append(clear);
  }
  wrap.append(chips);

  if (state.layerSel.size) {
    const names = [...state.layerSel].map(labelOf).sort().join(" or ");
    wrap.append(el("p", { class: "fnote", html:
      `Showing the <b>${fmtInt(drawn.length)}</b> SVs with a result from ${esc(names)}. ` +
      "The rest of the catalog stays in place; clear the chips to bring it back." }));
  }
  return wrap;
}

/** States plainly which analyses are absent, rather than implying completeness. */
function missingNotice() {
  const miss = (state.meta.layers || []).filter((l) => !l.present);
  if (!miss.length) return null;
  const names = miss.map((l) => l.label).join(", ");
  return el("div", { class: "notice", html:
    `<b>${miss.length} of ${state.meta.layers.length} analyses are still being added</b> ` +
    `and will bring their own colour when they land: ${esc(names)}. Colour here counts ` +
    "the analyses already loaded, so the ones still to come may add marks anywhere." });
}


/**
 * What one row of this catalog is, and why it is not the manuscript's 11,129.
 *
 * A reader of the paper asked exactly this, and the site had no answer on it. Three numbers
 * are in play and none is a subset of another by simple filtering:
 *
 *   11,129  rows of the CDR scan substrate - variant x resolution mode x ensemble x weight
 *           strategy - over 6,041 distinct coordinates
 *   10,705  rows here - variant x resolution mode, across both ensembles
 *    8,792  distinct coordinates here
 *
 * The containment that matters is asserted in the ETL: all 6,041 of the substrate's variants
 * are present here, and the build stops if one is not.
 */
function unitNote() {
  const u = state.meta?.catalog_unit;
  if (!u || !u.n_variants) return null;
  const d = el("details", { class: "excl" });
  d.append(el("summary", {}, "What counts as one SV here"));
  const modes = Object.entries(u.modes || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${fmtInt(v)}`).join(" · ");
  // The tile counts out of the full call set, so the relationship between that number and
  // this one belongs here, ahead of the mode detail: a reader who opens this is asking
  // exactly why 188,589 became 10,705.
  if (state.meta?.n_called) {
    d.append(el("p", { class: "muted", html:
      `Of the <b>${fmtInt(state.meta.n_called)}</b> SVs called across 196 genomes, the ` +
      `<b>${fmtInt(u.n_variants)}</b> carried by ten or more of the 376 haplotypes can be ` +
      "modelled from flanking SNPs, and those are the variants here." }));
  }
  d.append(el("p", { class: "muted", html:
    "A row is one <b>imputed SV genotype</b>: a variant under one resolution mode. " +
    `<b>${fmtInt(u.n_multi_mode)}</b> of the ${fmtInt(u.n_variants)} distinct variants were ` +
    `resolved under more than one mode, contributing ${fmtInt(u.n_from_multi_mode)} of the ` +
    `${fmtInt(u.n_predictors)} rows. Each mode is counted on its own &mdash; a ` +
    "different genotype reconstruction with its own imputation accuracy and its own carrier " +
    "frequency, and the analyses treat them separately." +
    (modes ? `<br><span class="num">${esc(modes)}</span>` : "") }));
  return d;
}

// ------------------------------------------------------------------ overview
function renderOverview() {
  const frame = state.catalog.filter(passes);
  const drawn = frame.filter(inSel);
  const nHits = drawn.filter((d) => ev(d) > 0).length;
  const nShown = drawn.length;
  const head = el("header", { class: "lede" },
    el("h1", {}, "Centromeric structural variants"),
    el("p", { html:
      "Every imputed centromeric SV across all 23 human centromeres, positioned on " +
      "<b>T2T-CHM13 v2.0</b> inside its chromosome's active &alpha;-satellite HOR array " +
      "and coloured by how many independent analyses report a hit there. " +
      "Choose a centromere below, or search for a gene, a disease or a position." }));

  // "SVs" was ambiguous and a reader of the paper caught it: a row here is a variant under
  // ONE resolution mode, so 10,705 rows are 8,792 distinct variants. The unit is named on
  // the tile and unpacked in the note below the grid.
  const u = state.meta?.catalog_unit || {};
  const stats = el("div", { class: "stats" });
  // Counted out of the full call set res_01_landscape.tex reports, because that is the
  // number a reader arrives holding. The modellable subset this site draws is named on the
  // second line so the two are never the same word: 188,589 were called, 8,792 are carried
  // by ten or more of the 376 haplotypes and can be modelled, and each resolution mode of
  // those is its own predictor.
  [[fmtInt(nShown), "imputed SVs",
    state.meta?.n_called
      ? `of ${fmtInt(state.meta.n_called)} called`
      : `of ${fmtInt(state.catalog.length)} modelled here`],
   [String(state.chroms.length), "centromeres", "chromosomes 1–22 and X"],
   // With an analysis selected every shown SV has evidence by construction, so the share
   // would read a tautological 100%. It says what the selection is instead.
   [fmtInt(nHits), "with evidence", state.layerSel.size
     ? "all of them, by the current selection"
     : (100 * nHits / Math.max(1, nShown)).toFixed(1) + "% of those shown"],
   [String((state.meta.layers || []).filter((l) => l.present).length), "analyses",
    "molecular and disease associations"]]
    .forEach(([v, k, s]) => stats.append(el("div", { class: "stat" },
      el("div", { class: "v num" }, v), el("div", { class: "k" }, k), el("div", { class: "s" }, s))));

  app.replaceChildren(head, stats);
  const notice = missingNotice();
  if (notice) app.append(notice);
  const refresh = () => { recomputeEvidence(); route(); };
  app.append(el("div", { class: "controls" }, tierControl(), filterControl(refresh)),
    legend(frame));

  const grid = el("div", { class: "grid" });
  state.chroms.forEach((c) => grid.append(chromCard(c)));
  if (state.hapIndex) {
    app.append(HAP.overviewEntry(state.hapIndex, state.chroms[0].chrom,
      (ARR.geometry(state.ld, state.chroms) || {}).samples));
    const mcard = METH.overviewEntry(state.meta);
    if (mcard) {
      app.append(el("section", { class: "methentry" },
        el("h2", {}, "By methylation"),
        el("div", { class: "methentrys" }, mcard)));
    }
  }
  app.append(grid, overviewTable(), unitNote());
  crumbs();
  announce(`Overview. ${fmtInt(nHits)} of ${fmtInt(nShown)} SVs carry evidence.`);
}

function chromCard(c) {
  const svs = svsOf(c.chrom);
  const hits = svs.filter((d) => ev(d) > 0);
  const a = el("a", { class: "card", href: "#/" + c.chrom,
    "aria-label": `${c.chrom}, ${fmtInt(svs.length)} SVs, ${hits.length} with evidence` });
  a.append(el("div", { class: "hd" },
    el("span", { class: "name" }, c.chrom),
    el("span", { class: "muted num" },
      fmtInt(svs.length) + (svs.length === 1 ? " SV" : " SVs")),
    // Deliberately NOT on the evidence ramp. This number counts SVs carrying evidence,
    // which is a different quantity from how many analyses converge on one - and painting
    // it with the ramp made chr16's 27 and chr13's 1 the same shade.
    el("span", { class: "badge num" + (hits.length ? "" : " none") },
      hits.length ? `${hits.length} hit${hits.length > 1 ? "s" : ""}` : "0 hits")));
  a.append(miniTrack(c, svs));
  a.append(el("div", { class: "sub num" },
    `${fmtMb(c.hor_start / MB)}–${fmtMb(c.hor_end / MB)} Mb · ` +
    `${fmtMb((c.hor_end - c.hor_start) / MB)} Mb array`));
  return a;
}

/** One chromosome's array as a band, with every SV as a tick. Hits drawn last, on top. */
function miniTrack(c, svs) {
  const W = 244, H = 34, PAD = 1;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-hidden", "true");
  const x = scaleLinear().domain([c.hor_start, c.hor_end]).range([PAD, W - PAD]);
  const s = select(svg);
  s.append("rect").attr("x", PAD).attr("y", 9).attr("width", W - 2 * PAD).attr("height", H - 17)
    .attr("rx", 3).attr("fill", css("--array-band")).attr("stroke", css("--array-edge"));
  const draw = (arr, w, op) => s.selectAll(null).data(arr).join("rect")
    .attr("x", (d) => x(d.pos) - w / 2).attr("y", 10).attr("width", w).attr("height", H - 19)
    .attr("fill", (d) => evColor(ev(d))).attr("opacity", op);
  draw(svs.filter((d) => !ev(d)), 1, css("--ev-0-op"));
  draw(svs.filter((d) => ev(d) > 0), 2.6, 1);
  return svg;
}

function overviewTable() {
  const wrap = el("details", {});
  wrap.append(el("summary", {}, "Table view — per-chromosome counts"));
  const t = el("table", { class: "tbl" });
  t.innerHTML =
    "<thead><tr><th scope='col'>Chromosome</th><th scope='col' class='n'>SVs</th>" +
    "<th scope='col' class='n'>With evidence</th><th scope='col' class='n'>Array start (Mb)</th>" +
    "<th scope='col' class='n'>Array end (Mb)</th><th scope='col' class='n'>Array size (Mb)</th></tr></thead>";
  const tb = el("tbody");
  state.chroms.forEach((c) => {
    const svs = svsOf(c.chrom);
    const h = svs.filter((d) => ev(d) > 0).length;
    const tr = el("tr", h ? { class: "hit" } : {});
    tr.innerHTML =
      `<td><a href="#/${c.chrom}">${c.chrom}</a></td><td class="n">${fmtInt(svs.length)}</td>` +
      `<td class="n">${h || "—"}</td><td class="n">${fmtMb(c.hor_start / MB)}</td>` +
      `<td class="n">${fmtMb(c.hor_end / MB)}</td>` +
      `<td class="n">${fmtMb((c.hor_end - c.hor_start) / MB)}</td>`;
    tb.append(tr);
  });
  t.append(tb);
  wrap.append(t);
  return wrap;
}

// ------------------------------------------------------------------ detail
function renderDetail(chrom) {
  const c = state.chroms.find((d) => d.chrom === chrom);
  if (!c) { location.hash = "#/"; return; }
  // frame = everything the floors admit on this chromosome, and the list the chart's axes
  // are built from. svs = what the current analysis selection leaves of it.
  const frame = svsInFrame(chrom);
  const svs = frame.filter(inSel);
  const hits = svs.filter((d) => ev(d) > 0);

  app.replaceChildren(el("header", { class: "detailhd" },
    el("h1", {}, chrom),
    el("span", { class: "muted num" },
      `${fmtInt(svs.length)} ${svs.length === 1 ? "SV" : "SVs"} · ` +
      `${hits.length} with evidence · array ` +
      `${fmtMb(c.hor_start / MB)}–${fmtMb(c.hor_end / MB)} Mb ` +
      `(${fmtMb((c.hor_end - c.hor_start) / MB)} Mb)`)));
  crumbs(chrom);

  const notice = missingNotice();
  if (notice) app.append(notice);
  // The legend goes in a host rather than straight into the page, because its swatch counts
  // describe "the marks actually on this page" - its own words - and that changes when the
  // checkbox below does. It used to be appended once, before the checkbox even existed.
  const legendHost = el("div");
  app.append(legendHost);

  const onlyHits = el("input", { type: "checkbox", id: "onlyhits" });
  onlyHits.checked = state.onlyHits;
  const refresh = () => { recomputeEvidence(); route(); };
  const controls = el("div", { class: "controls" }, tierControl(), filterControl(refresh),
    el("label", { class: "chk", for: "onlyhits" }, onlyHits, "Show only SVs with evidence"));
  app.append(controls);

  const chart = el("figure", { class: "chart stack" });
  const table = el("div");
  const ld = ldSection(c);
  const hap = state.hapIndex?.summary?.[chrom];
  app.append(chart, ...(ld ? [ld] : []),
    ...(hap ? [HAP.chromEntry(chrom, hap)] : []), table);

  // `frame` goes to the chart alongside the drawn list so the ordinate is a property of the
  // chromosome rather than of the current selection: hiding marks now hides marks, and does
  // not also move the ones that remain.
  const paint = () => {
    const drawn = state.onlyHits ? hits : svs;
    legendHost.replaceChildren(legend(drawn.length === svs.length ? frame : drawn));
    chart.replaceChildren(...detailPanels(c, drawn, frame), ...chartCaption(c));
    applySel();
    table.replaceChildren(svTable(drawn));
  };
  onlyHits.onchange = () => {
    state.onlyHits = onlyHits.checked;
    syncFilterUrl();
    paint();
  };
  paint();
  announce(`${chrom}. ${hits.length} of ${fmtInt(svs.length)} SVs carry evidence.`);
}

/**
 * x = position inside the active array; y = carrier frequency.
 *
 * Carrier frequency is the second axis because it is the property that most changes how a
 * hit should be read: a common SV with an association is a different claim than a rare one.
 * Marks are NOT sized by another variable - with ~98% of the catalog carrying no evidence,
 * the job of this panel is to make the rest findable, and a third channel would compete.
 */
/**
 * CHM13 coordinate at a given fraction of the active array's COVERED bases.
 *
 * This is what lets the substrate tracks share this chart's abscissa. The tracks are
 * computed on covered-base fraction; the chart is a linear CHM13 coordinate; walking the
 * reference's own merged active blocks converts one to the other exactly. Where a
 * chromosome's blocks tile their span - 21 of 23 - the two are the same number anyway, and
 * where they do not (chr3 covers 0.309 of its span, chr4 0.674) this collapses the gaps
 * rather than pretending they carry signal.
 *
 * Nothing is lost to it: all 10,705 catalogued SVs sit inside a block, checked, so no SV
 * has an undefined covered position.
 */
function coveredPos(blocks, f) {
  const total = blocks.reduce((s, b) => s + (b.end - b.start), 0);
  if (!total) return blocks.length ? blocks[0].start : 0;
  let want = Math.max(0, Math.min(1, f)) * total;
  for (const b of blocks) {
    const len = b.end - b.start;
    if (want <= len) return b.start + want;
    want -= len;
  }
  return blocks[blocks.length - 1].end;
}

/**
 * The CHM13 intervals a covered-fraction range occupies - one per block it touches.
 *
 * A bin is a range of covered bases, and on a gapped chromosome that range can straddle a
 * gap. Drawing it as one rectangle from its first coordinate to its last spans the gap and
 * says dips were found there. On chr4, whose blocks cover 0.674 of their span, that produced
 * a single bar 1.6 Mb wide across a region with no covered bases in it at all. Splitting the
 * bin at the block boundaries puts every piece where its bases actually are.
 */
function coveredSegments(blocks, f0, f1) {
  const total = blocks.reduce((s, b) => s + (b.end - b.start), 0);
  if (!total) return [];
  const a = Math.max(0, Math.min(1, f0)) * total;
  const b = Math.max(0, Math.min(1, f1)) * total;
  const out = [];
  let seen = 0;
  for (const blk of blocks) {
    const len = blk.end - blk.start;
    const lo = Math.max(a, seen), hi = Math.min(b, seen + len);
    if (hi > lo) out.push([blk.start + (lo - seen), blk.start + (hi - seen)]);
    seen += len;
  }
  return out;
}

/** Which block index a covered fraction falls in, so a line can break at a gap. */
function coveredBlock(blocks, f) {
  const total = blocks.reduce((s, b) => s + (b.end - b.start), 0);
  let want = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < blocks.length; i += 1) {
    const len = blocks[i].end - blocks[i].start;
    if (want <= len) return i;
    want -= len;
  }
  return blocks.length - 1;
}

function detailChart(c, svs, frame) {
  const T = state.tracks;
  const meth = T?.meth?.[c.chrom], dens = T?.density?.[c.chrom];
  const info = T?.chrom?.[c.chrom] || {};
  const blocks = (c.arrays || []).slice().sort((a, b) => a.start - b.start);
  const withTracks = !!(meth && dens && blocks.length);

  // ---- the ancestry facets, when asked for
  //
  // Small multiples rather than one stacked bar, and the reason is measurable rather than
  // aesthetic. Six categories cannot be told apart by colour alone: the dark surface admits
  // only L 0.48-0.67, and inside that band no six hues clear the colourblind separation
  // floor against each other. Faceting moves identity onto the label and the row, where it
  // does not depend on colour at all - which is also what makes the small strata legible,
  // since each row carries its own haplotype count beside its name.
  const ancData = T?.density_anc?.[c.chrom];
  const ancN = T?.nhap_anc?.[c.chrom] || {};
  const stackMode = state.dipMode === "ancestry" && withTracks && !!ancData;
  const ancMode = state.dipMode === "rows" && withTracks && !!ancData;
  const strata = (stackMode || ancMode)
    ? (T.strata || []).filter((p) => ancData[p] || ancN[p])
    : [];
  // One scale for every facet on every chromosome, like the two pooled track scales, so a
  // row means the same thing wherever it is read. Cells below the haplotype floor are left
  // out of the max as well as out of the drawing - a rate of 1.0 from a single haplotype
  // would set the scale for all 23 chromosomes.
  let ancMax = 0;
  if (ancMode) {
    Object.entries(T.density_anc).forEach(([ch, byPop]) =>
      Object.entries(byPop).forEach(([p, counts]) => {
        const n = T.nhap_anc?.[ch]?.[p] || 0;
        if (n >= ANC_MIN_HAP) ancMax = Math.max(ancMax, Math.max(...counts) / n);
      }));
  }
  if (!(ancMax > 0)) ancMax = 1;

  const hS = 296, hBand = 11, hM = 130;
  // 44 px, not the 30 tried first. The facets share one scale across all 23 chromosomes, and
  // that scale is set by the largest per-stratum rate anywhere - 0.88, on a stratum of 17
  // haplotypes - while the median chromosome peaks around 0.33. At 30 px a typical row drew
  // an 11 px bar and every chromosome looked flat. Clipping to a quantile instead would have
  // been the wrong fix: 21 of 121 cells exceed 0.50, so a 0.50 ceiling would silently cut a
  // sixth of them. Taller rows keep the full range honest and readable.
  const hFacet = 44, gapFacet = 7;
  // ONE height for the pooled track and for the stack, because they are the same track -
  // the stack only decomposes it. Drawing the stack in 118 px against the pooled track's 78
  // stretched the silhouette by 1.51x, so a control whose whole claim is "the same total,
  // split" redrew the shape it was meant to decompose. 118 rather than 78 because the fills
  // need the room to be separable, and the pooled profile reads better for it.
  const hD = ancMode ? strata.length * (hFacet + gapFacet) - gapFacet : 118;
  const gapBand = 12;
  const W = 1180;
  // Constant, in every dip mode: the stack's key rides on the dip track's own label line
  // rather than in a band below the x-axis ticks, so switching modes cannot change the
  // height of the figure or move the caption under it.
  const M = { t: 14, r: 16, b: 66, l: 54 };
  const iw = W - M.l - M.r;
  const ih = hS;

  // Each track is its own <svg>, and they share an abscissa by construction: same width,
  // same left margin, same scale. A reader can fold one away and the ones that remain still
  // line up, which a single figure with the tracks inside it could not do.
  const NS = "http://www.w3.org/2000/svg";
  const panelSvg = (h, top, label) => {
    const node = document.createElementNS(NS, "svg");
    node.setAttribute("viewBox", `0 0 ${W} ${h}`);
    node.setAttribute("role", "img");
    if (label) node.setAttribute("aria-label", label);
    const sel = select(node);
    return { node, sel, g: sel.append("g").attr("transform", `translate(${M.l},${top})`) };
  };
  const PAD_B = 10;
  // Room above a track for the label on its own line, and for the stack's key beside it.
  const PAD_LAB = 24;

  const x = scaleLinear().domain([c.hor_start, c.hor_end]).range([0, iw]);
  const out = {};

  const scat = panelSvg(M.t + ih + gapBand + hBand + PAD_B, M.t,
    `${c.chrom}: ${svs.length} SVs by position and carrier frequency`);
  const g = scat.g;
  out.scatter = scat.node;
  // The plot width, for the one thing drawn later that has to know where the right edge is:
  // the name beside the selected mark, which turns round rather than running off the panel.
  scat.node.dataset.iw = iw;

  // Domain to the data, not to 1. Carrier frequency is bounded at 1, but nearly every
  // centromeric SV is rare - a fixed 0-1 axis left ~80% of the panel empty and squashed
  // the range that actually carries the variation. The axis is labelled, so frequency
  // still reads absolutely.
  //
  // Ranged over `frame`, the chromosome's whole admitted set, NOT over the marks being
  // drawn. Ranging it over the drawn subset meant "show only SVs with evidence" rescaled the
  // ordinate: every surviving mark jumped to a new height on a control whose entire job was
  // to remove the others. A reader watching that cannot tell hiding from moving. The frame
  // is a property of the chromosome, so the same SV is at the same height in every view of
  // it, and toggling is now a pure subtraction.
  const fmax = Math.max(0.05, ...(frame && frame.length ? frame : svs).map((d) => d.svfreq ?? 0));
  const y = scaleLinear().domain([0, fmax * 1.08]).range([ih, 0]).nice();

  y.ticks(5).forEach((t) => g.append("line").attr("class", "gridline")
    .attr("x1", 0).attr("x2", iw).attr("y1", y(t)).attr("y2", y(t)));
  g.append("g").attr("class", "axis").call(axisLeft(y).ticks(5));
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih)
    .attr("stroke", css("--axis"));
  g.append("text").attr("transform", `translate(-40,${ih / 2}) rotate(-90)`)
    .attr("text-anchor", "middle").text("carrier frequency");

  // The CenSat active HOR records. They sit between the scatter and the tracks now, because
  // they are what the tracks' frame is measured along: the covered bases are exactly these
  // blocks, so a gap here is a gap the tracks skip over.
  const tY = ih + gapBand;
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", tY + hBand / 2)
    .attr("y2", tY + hBand / 2).attr("stroke", css("--grid"));
  blocks.forEach((a) => {
    g.append("rect").attr("x", x(a.start)).attr("y", tY)
      .attr("width", Math.max(1.5, x(a.end) - x(a.start))).attr("height", hBand)
      .attr("rx", 2.5).attr("fill", css("--array-band")).attr("stroke", css("--array-edge"))
      .append("title").text(`${a.name} — ${fmtMb(a.start / MB)}–${fmtMb(a.end / MB)} Mb`);
  });
  g.append("text").attr("x", -8).attr("y", tY + 9).attr("text-anchor", "end").text("HOR array");

  g.selectAll(null).data(svs.filter((d) => !ev(d))).join("circle")
    .attr("cx", (d) => x(d.pos)).attr("cy", (d) => y(d.svfreq ?? 0))
    .attr("data-sv", (d) => svKey(d))
    .attr("r", 2).attr("fill", css("--ev-0")).attr("opacity", css("--ev-0-op"));

  // a 2px surface ring so overlapping hit marks stay separable; keyboard-reachable, since
  // these marks are the only route to a record from the chart
  g.selectAll(null).data(svs.filter((d) => ev(d) > 0)).join("circle")
    .attr("cx", (d) => x(d.pos)).attr("cy", (d) => y(d.svfreq ?? 0))
    .attr("r", 5.5).attr("fill", (d) => evColor(ev(d)))
    .attr("data-sv", (d) => svKey(d))
    .attr("stroke", css("--surface-1")).attr("stroke-width", 2)
    .attr("tabindex", 0).attr("role", "button")
    .attr("aria-label", (d) => `${d.sv_id}, ${ev(d)} converging analyses`)
    .style("cursor", "pointer")
    .on("mousemove", (e, d) => showTip(tipHtml(d), e))
    .on("mouseleave", hideTip)
    .on("blur", hideTip)
    .on("keydown", (e, d) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(d); }
    })
    .on("click", (e, d) => { hideTip(); openPanel(d); });

  // ---------------------------------------------------------------- substrate tracks
  // Same abscissa as the scatter above. Each bin's covered-fraction edges are walked
  // through the reference's own blocks, so a bin lands where those bases actually are.
  if (withTracks) {
    const n = meth.length;
    const mid = (i) => x(coveredPos(blocks, (i + 0.5) / n));

    const methP = panelSvg(PAD_LAB + hM + PAD_B, PAD_LAB, `${c.chrom}: mean 5mC`);
    const gm = methP.g;
    out.meth = methP.node;
    const [mlo, mhi] = T.meth_range || [40, 75];
    const ym = scaleLinear().domain([Math.floor(mlo - 1), Math.ceil(mhi + 1)]).range([hM, 0]);
    ym.ticks(4).forEach((t) => gm.append("line").attr("class", "gridline")
      .attr("x1", 0).attr("x2", iw).attr("y1", ym(t)).attr("y2", ym(t)));
    gm.append("g").attr("class", "axis").call(axisLeft(ym).ticks(4));
    gm.append("text").attr("class", "tlab").attr("x", 0).attr("y", -6)
      .text("mean 5mC (%), coverage-weighted");

    const all = Object.values(T.meth).flat();
    const gmed = all.slice().sort((a, b) => a - b)[Math.floor(all.length / 2)];
    gm.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ym(gmed)).attr("y2", ym(gmed))
      .attr("stroke", css("--axis")).attr("stroke-width", 1).attr("stroke-dasharray", "3 3");
    // Below the rule at the left, not above it at the right: a profile that starts high runs
    // straight through a right-anchored label, and the left end below the median is the one
    // region a hypomethylation profile reliably leaves empty.
    gm.append("text").attr("x", 4).attr("y", ym(gmed) + 12).attr("text-anchor", "start")
      .text(`all centromeres, median ${gmed.toFixed(0)}%`);
    // The path breaks where it crosses a gap, rather than drawing a straight segment over a
    // region the profile has no bases in.
    let prevBlk = null;
    const d = meth.map((v, i) => {
      const blk = coveredBlock(blocks, (i + 0.5) / n);
      const cmd = (prevBlk === null || blk !== prevBlk) ? "M" : "L";
      prevBlk = blk;
      return `${cmd}${mid(i)},${ym(v)}`;
    }).join("");
    gm.append("path").attr("d", d)
      .attr("fill", "none").attr("stroke", css("--ev-4")).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");

    const dipP = panelSvg(PAD_LAB + hD + PAD_B, PAD_LAB,
      `${c.chrom}: dips per haplotype`);
    const gd = dipP.g;
    out.dips = dipP.node;
    // The rectangles a bin occupies on the CHM13 axis, one per block it touches.
    const seg = (i) => coveredSegments(blocks, i / n, (i + 1) / n);

    if (stackMode) {
      // ONE track, decomposed. Each segment is that stratum's dips over ALL haplotypes, not
      // over its own - which is what makes the segments additive and the stack total exactly
      // the pooled track. Dividing by each stratum's own haplotypes gives a rate, and rates
      // do not sum to anything; that view is the "one row each" mode.
      const dmax = Math.max(...Object.values(T.density).flat());
      const yd = scaleLinear().domain([0, dmax]).range([hD, 0]);
      yd.ticks(3).forEach((t) => gd.append("line").attr("class", "gridline")
        .attr("x1", 0).attr("x2", iw).attr("y1", yd(t)).attr("y2", yd(t)));
      gd.append("g").attr("class", "axis").call(axisLeft(yd).ticks(3));
      gd.append("text").attr("class", "tlab").attr("x", 0).attr("y", -6)
        .text("dips per haplotype, by ancestry");

      const nhap = info.n_hap || 1;
      const bars = [];
      for (let i = 0; i < n; i += 1) {
        const pieces = seg(i);
        let acc = 0;
        const here = [];
        strata.forEach((p, k) => {
          const v = ((ancData[p] || [])[i] ?? 0) / nhap;
          if (v > 0) pieces.forEach(([a, b]) => here.push({ p, k, v, base: acc, i, a, b }));
          acc += v;
        });
        // Which segment is on top of this bin, so the gap can be taken out of every other.
        const topK = here.reduce((m, b) => Math.max(m, b.k), -1);
        here.forEach((b) => { b.top = b.k === topK; });
        bars.push(...here);
      }
      // A 1 px surface gap between stacked fills, per the marks spec, and the validator's
      // required relief for the sub-3:1 fills. Only where the segment can afford it: at this
      // scale many segments are two or three pixels tall and subtracting a gap from those
      // would delete them, which loses data to make a border. Never off the TOP segment:
      // it has nothing above it to be separated from, and its upper edge IS the outline
      // being compared with the pooled track.
      const GAP = 1;
      gd.selectAll(null).data(bars).join("rect")
        .attr("x", (b) => x(b.a) + 1)
        .attr("width", (b) => Math.max(1, x(b.b) - x(b.a) - 2))
        .attr("y", (b) => yd(b.base + b.v))
        .attr("height", (b) => {
          const h = yd(b.base) - yd(b.base + b.v);
          return h > 3 && !b.top ? h - GAP : Math.max(0.6, h);
        })
        .attr("fill", (b) => ancFill(b.k));

      // The key, in the fixed bottom-to-top order of the stack, with each stratum's
      // haplotype count. Identity does not rest on the fills alone: every stratum is named
      // here and again in the tooltip, beside its own swatch.
      //
      // Right-aligned on the track's own label line, NOT in a band below the x-axis. A key
      // that needs its own band makes the figure taller in one mode than in the other, and
      // then a reader who only changed the fills watches the whole page move.
      const klabs = strata.map((p) => `${p} n=${ancN[p] || 0}`);
      const kw = klabs.reduce((s, l) => s + 13 + l.length * 5.4 + 16, 0) - 16;
      const key = gd.append("g").attr("transform", `translate(${Math.max(0, iw - kw)},-6)`);
      let kx = 0;
      // Left to right in the SAME order the stack goes bottom to top. The first version
      // reversed it to put the top segment first, which read straight past the caption
      // saying "bottom to top" and told the reader the opposite of the drawing.
      strata.forEach((p, k) => {
        key.append("rect").attr("x", kx).attr("y", -8).attr("width", 9).attr("height", 9)
          .attr("rx", 2).attr("fill", ancFill(k));
        key.append("text").attr("x", kx + 13).attr("y", 0).attr("class", "tsub")
          .text(klabs[k]);
        kx += 13 + klabs[k].length * 5.4 + 16;
      });
    } else if (!ancMode) {
      const dmax = Math.max(...Object.values(T.density).flat());
      const yd = scaleLinear().domain([0, dmax]).range([hD, 0]);
      // The gridlines the stack draws, drawn here too, so that the two modes differ in
      // their fills and in nothing else at all.
      yd.ticks(3).forEach((t) => gd.append("line").attr("class", "gridline")
        .attr("x1", 0).attr("x2", iw).attr("y1", yd(t)).attr("y2", yd(t)));
      gd.append("g").attr("class", "axis").call(axisLeft(yd).ticks(3));
      gd.append("text").attr("class", "tlab").attr("x", 0).attr("y", -6)
        .text("dips per haplotype");
      const bars = dens.flatMap((v, i) => seg(i).map(([a, b]) => ({ v, i, a, b })));
      gd.selectAll(null).data(bars).join("rect")
        .attr("x", (b) => x(b.a) + 1).attr("y", (b) => yd(b.v))
        .attr("width", (b) => Math.max(1, x(b.b) - x(b.a) - 2))
        .attr("height", (b) => hD - yd(b.v)).attr("rx", 2).attr("fill", css("--ev-2"));
    } else {
      gd.append("text").attr("class", "tlab").attr("x", 0).attr("y", -6)
        .text("dips per haplotype, by ancestry");
      strata.forEach((p, k) => {
        const top = k * (hFacet + gapFacet);
        const nh = ancN[p] || 0;
        const counts = ancData[p] || [];
        const gf = gd.append("g").attr("transform", `translate(0,${top})`);
        const thin = nh < ANC_MIN_HAP;

        gf.append("line").attr("x1", 0).attr("x2", iw).attr("y1", hFacet)
          .attr("y2", hFacet).attr("stroke", css("--grid"));
        // Name and haplotype count together, always. The count is what tells a reader
        // whether a spiky row is a finding or five dips, and it is the first thing that
        // goes missing when a facet is labelled with its name alone.
        gf.append("text").attr("x", -8).attr("y", hFacet / 2).attr("text-anchor", "end")
          .attr("class", "tlab").text(p);
        gf.append("text").attr("x", -8).attr("y", hFacet / 2 + 12).attr("text-anchor", "end")
          .attr("class", "tsub").text(`n=${nh}`);

        if (thin) {
          gf.append("text").attr("x", 6).attr("y", hFacet / 2 + 4).attr("class", "tsub")
            .text(`${nh} haplotype${nh === 1 ? "" : "s"} here — a rate needs ${ANC_MIN_HAP}`);
          return;
        }
        // A half-scale rule per row. Without it six baselines carry no height reference at
        // all and a tall bar is only tall relative to its neighbours.
        gf.append("line").attr("class", "gridline").attr("x1", 0).attr("x2", iw)
          .attr("y1", hFacet / 2).attr("y2", hFacet / 2);
        const yf = scaleLinear().domain([0, ancMax]).range([hFacet, 0]);
        const bars = counts.flatMap((cnt, i) =>
          seg(i).map(([a, b]) => ({ v: cnt / nh, cnt, i, a, b })));
        gf.selectAll(null).data(bars).join("rect")
          .attr("x", (b) => x(b.a) + 1).attr("y", (b) => yf(b.v))
          .attr("width", (b) => Math.max(1, x(b.b) - x(b.a) - 2))
          .attr("height", (b) => Math.max(0, hFacet - yf(b.v)))
          .attr("rx", 1.5).attr("fill", css("--ev-2"));
      });
      // The top of the scale, once, in the gutter above the first row - every row is drawn
      // to it, and six repeated axes would be worse. A sentence saying so is the reader
      // being told how the figure was built, which is not something they asked to read.
      gd.append("text").attr("x", -8).attr("y", 8).attr("text-anchor", "end")
        .attr("class", "tsub").text(ancMax.toFixed(2));
    }

    // One hover target per bin in each track. Both report the same bin and the same
    // numbers, so pointing at either panel answers the same question it used to.
    const hits = meth.flatMap((v, i) =>
      coveredSegments(blocks, i / n, (i + 1) / n).map(([a, b]) => ({ v, i, a, b })));
    const hitRects = (grp, h) => grp.selectAll(null).data(hits).join("rect")
      .attr("x", (b) => x(b.a)).attr("y", 0)
      .attr("width", (b) => Math.max(1, x(b.b) - x(b.a)))
      .attr("height", h)
      .attr("fill", "transparent").style("cursor", "crosshair")
      .on("mousemove", (e, b) => showTip(
        `<div class="t">${fmtMb(coveredPos(blocks, (b.i + 0.5) / n) / MB)} Mb` +
        ` &middot; ${((b.i + 0.5) / n * 100).toFixed(1)}% along the array</div>` +
        `<div class="r">mean 5mC <b>${b.v.toFixed(1)}%</b></div>` +
        `<div class="r">${(dens[b.i] ?? 0).toFixed(3)} dips per haplotype</div>` +
        `<div class="r muted">averaged over ${fmtInt(info.n_hap ?? 0)} haplotypes</div>` +
        // Raw dip counts beside every rate, because the rate alone hides how thin the
        // stratum is: 0.200 reads the same whether it is 12 dips over 60 haplotypes or 2
        // over 10, and only one of those is worth looking at.
        (ancMode || stackMode
          ? "<div class='tiphits'>" + strata.map((p, k) => {
            const nh = ancN[p] || 0, cnt = (ancData[p] || [])[b.i] ?? 0;
            // The swatch is what ties a tooltip line to a segment in the stack, where the
            // fills are the only thing distinguishing them.
            const sw = stackMode
              ? `<span class="tsw" style="background:${ancFill(k)}"></span>` : "";
            return `<div class="r">${sw}<span class="tier">${esc(p)}</span>` +
              (!stackMode && nh < ANC_MIN_HAP
                ? `<span class="muted">n=${nh}, rate needs ${ANC_MIN_HAP}</span>`
                : `${(cnt / (stackMode ? (info.n_hap || 1) : nh)).toFixed(3)} ` +
                  `<span class="muted">(${cnt} dip${cnt === 1 ? "" : "s"} / ${nh} hap)</span>`)
              + "</div>";
          }).join("") + "</div>"
          : ""), e))
      .on("mouseleave", hideTip);
    hitRects(gm, hM);
    hitRects(gd, hD);
  }

  // The abscissa belongs to the stack rather than to any one track, so it is drawn once,
  // under whichever panels are open.
  const axis = panelSvg(46, 0, null);
  axis.g.append("g").attr("class", "axis")
    .call(axisBottom(x).ticks(8).tickFormat((v) => fmtMb(v / MB)));
  axis.sel.append("text").attr("x", M.l + iw / 2).attr("y", 40)
    .attr("text-anchor", "middle").text(`position on ${c.chrom} (Mb, CHM13 v2.0)`);
  out.axis = axis.node;
  return out;
}

const DIP_HINT = {
  pooled: "all haplotypes",
  ancestry: "stacked by ancestry",
  rows: "one row per superpopulation",
};

/**
 * One track, folded or not, with the controls that act on it.
 *
 * The fold is remembered in `state` rather than in the DOM: a reader who closes a track and
 * then changes a filter should find it still closed.
 */
function trackPanel(key, title, hint, controls, body) {
  const d = el("details", { class: "trackpanel" });
  d.open = !state.folds.has(key);
  d.append(el("summary", {},
    el("span", { class: "tname" }, title),
    hint ? el("span", { class: "thint muted" }, hint) : null));
  if (controls) d.append(el("div", { class: "trackctl" }, controls));
  d.append(body);
  d.addEventListener("toggle", () => {
    // A <details> created with `open` fires a toggle of its own once the event queue
    // drains, after this listener exists. Only a real change is worth a re-render.
    if (d.open === !state.folds.has(key)) return;
    if (d.open) state.folds.delete(key); else state.folds.add(key);
    route();
  });
  return d;
}

/** The chromosome figure as a stack of foldable panels on one abscissa. */
function detailPanels(c, svs, frame) {
  const parts = detailChart(c, svs, frame);
  const out = [trackPanel("scatter", "Structural variants",
    `${fmtInt(svs.length)} on this chromosome`, null, parts.scatter)];
  if (parts.meth) {
    // No hint here: the panel body already labels its own y-axis, and repeating it in the
    // header says the same thing twice a centimetre apart.
    out.push(trackPanel("meth", "Methylation", "", null, parts.meth));
    out.push(trackPanel("dips", "Centromere dips", DIP_HINT[state.dipMode] || "",
      dipControl(() => routeKeepingFocus()), parts.dips));
  }
  // The axis labels the panels above it, so it appears while one of them is open.
  if (out.some((p) => p.open)) out.push(parts.axis);
  return out;
}

// ------------------------------------------------------------------ chart caption
/**
 * One caption for the three panels, and the two caveats the shared abscissa earns.
 *
 * The three panels share an x-axis because they can: the tracks' covered-base frame maps
 * onto this chromosome's CHM13 coordinate exactly by walking the reference's own active
 * blocks, and every catalogued SV sits inside a block. The y-axes do NOT and cannot share a
 * scale - carrier frequency, per-cent methylation and dips per haplotype are three different
 * quantities - so each keeps its own, and the two track scales are held constant ACROSS
 * chromosomes so that centromeres compare with each other.
 *
 * What the shared axis cannot fix is that the tracks average over haplotypes whose arrays
 * differ in length while CHM13 is one particular haplotype. On five chromosomes the
 * reference is far from typical - chr21's active array is a quarter of the cohort median -
 * and there the caption says so.
 */
function chartCaption(c) {
  const T = state.tracks;
  const info = T?.chrom?.[c.chrom] || {};
  const has = !!(T?.meth?.[c.chrom]);
  const out = [];

  // The sentence says what the panels ARE; the counts sit under it as a stat line, because a
  // number reads faster beside the figure than inside a clause about the figure.
  out.push(el("figcaption", { html:
    `Every SV in the ${esc(c.chrom)} active array by position and carrier frequency` +
    (has ? ", and beneath it the methylation profile the dip regions are called from" : "") +
    ". Select a highlighted mark for its record." }));
  if (has) {
    const stat = [
      `${fmtInt(info.n_hap ?? 0)} haplotypes`,
      `${fmtInt(info.dips ?? 0)} dips`,
      info.covered_frac != null && info.covered_frac < 0.99
        ? `${(info.covered_frac * 100).toFixed(1)}% of the span covered` : null,
    ].filter(Boolean);
    out.push(el("div", { class: "eyebrow inline num" }, stat.join(" \u00b7 ")));
  }

  // The ancestry split is a display of the same dips, and the caption has to say so plainly:
  // no association was tested, nothing was fitted, and the study reports no ancestry-
  // stratified dip result. It also has to say where the labels came from, because they came
  // from outside this study entirely.
  const stacked = state.dipMode === "ancestry";
  if ((stacked || state.dipMode === "rows") && T?.density_anc?.[c.chrom]) {
    const nh = T.nhap_anc?.[c.chrom] || {};
    // Over the strata actually DRAWN, not over T.strata. That list still carries the
    // unlabelled sentinel, which holds nothing, and warning that an absent band is thin is
    // worse than not warning at all - it puts a stratum on the page that is not on the page.
    const drawnStrata = (T.strata || [])
      .filter((p) => T.density_anc?.[c.chrom]?.[p] || nh[p]);
    const thin = drawnStrata.filter((p) => (nh[p] || 0) < ANC_MIN_HAP);
    // The two views answer different questions and the caption must not blur them. The stack
    // is additive and therefore weighted by cohort size; the rows are rates and therefore
    // are not. Reading "AFR is largest" off the stack when AFR simply has the most
    // haplotypes is the one misreading this figure invites, so it is named.
    out.push(el("p", { class: "notice small", html:
      "<b>The same dips, split by ancestry.</b> " +
      (stacked
        ? "Each segment is that stratum's share of <i>all</i> haplotypes, so the segments " +
          "add to the pooled track. "
        : "Each row is that stratum's own rate, so strata of very different size compare. ") +
      // The one thing left that a reader cannot see for themselves: below the threshold a row
      // is drawn as a COUNT, not a rate, so two different quantities appear in the same axis.
      (thin.length && !stacked
        ? `Under ${ANC_MIN_HAP} haplotypes, ${esc(thin.join(" and "))} ` +
          `${thin.length === 1 ? "carries a" : "carry a"} haplotype count, not a rate.`
        : "") }));
  }

  if (info.ref_typical === false && info.ref_ratio) {
    const r = info.ref_ratio;
    out.push(el("p", { class: "notice small", html:
      `<b>CHM13 is atypical on ${esc(c.chrom)}</b> — its array is <b>${r.toFixed(2)}×</b> ` +
      "the cohort median. Read the shape along the array; read a position in Mb as approximate." }));
  }
  if (info.stable === false) {
    out.push(el("p", { class: "notice small", html:
      `<b>Positional frame unstable on ${esc(c.chrom)}.</b> The source's own frame audit ` +
      `finds ${info.pct_multiblock}% of haplotypes carry a fragmented array here, and its ` +
      `three position definitions agree only to r = ${info.min_r}. The profile is the mean ` +
      "of what was measured and its shape is the reliable part; read a feature's position " +
      "along the array as approximate." }));
  }
  return out;
}

// ------------------------------------------------------------ linkage disequilibrium
/**
 * The LD panel, open on arrival like every other track panel.
 *
 * It was closed by default, because opening it standardises a chromosome's genotypes and
 * rasterises up to 7.6 million cells - work a reader looking at the scatter above never asked
 * for. That default was changed by request, and the cost it was protecting against is now
 * answered rather than accepted: the standardised genotypes are cached on the frame, and the
 * finished raster is cached in ld.js by (chromosome, selection, columns, resolution), so a
 * re-render for a filter, a tier or a theme blits it instead of recomputing it. Measured on
 * chr1, an unrelated control went from +134 ms to +11.
 *
 * The display selection goes into the query string, so the address carries the view rather
 * than only the chromosome - and a clean address opens the default, which is what makes the
 * open default citable at all.
 */
function ldSection(c) {
  const frame = LD.frameOf(state.ld, c.chrom);
  if (!frame) return null;
  const det = el("details", {
    class: "ldsec trackpanel", id: "ldpanel", open: !state.folds.has("ld"),
  });
  det.append(el("summary", {},
    el("span", { class: "tname" }, "Linkage disequilibrium"),
    el("span", { class: "thint muted" }, "across this pericentromeric region")));
  const body = el("div", { class: "ldbody" });
  det.append(body);
  const fill = () => body.replaceChildren(...ldFigure(c, frame));
  det.addEventListener("toggle", () => {
    if (det.open === !state.folds.has("ld")) return;
    if (det.open) state.folds.delete("ld");
    else state.folds.add("ld");
    if (det.open) fill();
    else body.replaceChildren();
  });
  if (det.open) fill();
  return det;
}

/** The colour key: signed r on the scale the published panels use. */
function ldScale() {
  const stops = [];
  for (let k = 0; k <= 20; k++) stops.push(LD.colourOf(-1 + k / 10));
  return el("div", { class: "ldscale", title: "signed Pearson r, -1 to +1" },
    el("span", { class: "e num" }, "\u22121"),
    el("span", { class: "bar", style: `background:linear-gradient(90deg,${stops.join(",")})` }),
    el("span", { class: "e num" }, "+1"),
    el("span", { class: "k" }, "signed r"));
}

function ldFigure(c, frame) {
  const mode = state.ldMode || LD.DEFAULT_MODE;
  const idx = LD.select(frame, mode);
  const byId = new Map((state.byChrom.get(c.chrom) || []).map((d) => [d.sv_id, d]));

  const seg = el("fieldset", { class: "seg" }, el("legend", {}, "Variants drawn"));
  LD.MODES.forEach(([val, lab, hint]) => {
    const id = "ldmode-" + val;
    const input = el("input", { type: "radio", name: "ldmode", id, value: val });
    input.checked = mode === val;
    input.onchange = () => {
      if (!input.checked) return;
      state.ldMode = val;
      syncFilterUrl();
      const host = document.querySelector(".ldbody");
      if (host) host.replaceChildren(...ldFigure(c, frame));
    };
    seg.append(el("label", { for: id, title: hint }, input, lab));
  });

  // Same shape as the mode buttons above it: both are display choices for this figure.
  const lab = el("fieldset", { class: "seg" }, el("legend", {}, "Region labels"));
  [[true, "On"], [false, "Off"]].forEach(([on, text]) => {
    const id = "ldlab-" + (on ? "on" : "off");
    const input = el("input", { type: "radio", name: "ldlabels", id });
    input.checked = state.ldLabels === on;
    input.onchange = () => {
      if (!input.checked) return;
      state.ldLabels = on;
      syncFilterUrl();
      const host = document.querySelector(".ldbody");
      if (host) host.replaceChildren(...ldFigure(c, frame));
    };
    lab.append(el("label", {
      for: id,
      title: on ? "name each region on the figure"
        : "draw the region outlines without their names",
    }, input, text));
  });

  const g = LD.triangle(frame, idx, {
    mode,
    labels: state.ldLabels,
    evidenceOf: (svId) => { const d = byId.get(svId); return d ? ev(d) : 0; },
    colourOf: evColor,
    onPick: (svId) => { const d = byId.get(svId); if (d) openPanel(d); },
    onHover: (html, e) => showTip(html, e),
    onLeave: hideTip,
  });
  // caption inside the figure, like the scatter above it: a figcaption that is a sibling of
  // its figure is a paragraph that happens to sit nearby
  const fig = el("figure", { class: "chart ldchart" }, LD.fan(frame, idx, g), g.node,
    ...ldCaption(c, frame, g, idx));
  return [el("div", { class: "controls ldctl" }, seg, lab, ldScale()), fig];
}

function ldCaption(c, frame, g, idx) {
  const V = frame.variants;
  const n = g.n, bd = g.bounds;
  const nL = bd[0], nSv = bd[1] - bd[0], nR = n - bd[1];
  // 1,168 is the drawing width of the figure's own coordinate system, so this number is a
  // property of the selection and holds wherever the figure is rendered.
  const cell = 1168 / n;
  const raw = (state.ld && state.ld.chrom) ? state.ld.chrom[c.chrom] || {} : {};
  const flanks = raw.flanks || {};
  const thin = [...idx].reduce((s, i) => s + (V[i].thin ? 1 : 0), 0);
  let openCalls = 0, snpCols = 0;
  for (const i of idx) {
    if (V[i].kind !== "snp") continue;
    openCalls += V[i].missing || 0;
    snpCols += 1;
  }
  const snpCells = snpCols * frame.m;
  const out = [];

  // What the panel is, and how to use it. The colour scale is drawn beside the controls, the
  // block counts are on the axis above, and the density caveat is in "How this figure is
  // built" below - so none of the three is said again here.
  out.push(el("figcaption", { html:
    `<b>Pearson r between imputed genotypes</b>, over the ${fmtInt(frame.m)} individuals ` +
    "both cohorts share. " +
    `<b>${fmtInt(n)}</b> of ${fmtInt(V.length)} variants` +
    (snpCols ? ` \u00b7 ${fmtInt(nL)} SNP \u00b7 ${fmtInt(nSv)} SV \u00b7 ${fmtInt(nR)} SNP`
             : "") +
    `, ${cell.toFixed(2)} px per column. The diagonal runs along the top, the apex is the ` +
    "most distant pair." +
    (g.marks
      ? ` Ticks mark the ${fmtInt(g.marks)} ` +
        (g.marks === 1 ? "SV" : "SVs") + " with evidence; select one for its record."
      : "") }));

  // How the figure is built, rather than what it shows: identical on all 23 chromosomes,
  // 193 words, and two thirds of the visible prose on a chromosome page when it sat open.
  // The same disclosure the page already uses for "What counts as one SV here".
  const how = el("details", { class: "ldmethods" });
  how.append(el("summary", {}, "How this figure is built"));
  how.append(el("p", { class: "notice small", html:
    "<b>The colour scale is the published panels' own</b> \u2014 signed r on coolwarm from " +
    "\u22121 to +1, so a colour here carries the r it carries there. Where a column is " +
    "narrower than a pixel, that pixel reports the pair nearest its centre; the narrower " +
    "selections give every pair a cell of its own." }));
  how.append(el("p", { class: "notice small", html:
    "<b>The abscissa is a column rank.</b> One column per variant in position order inside " +
    "its own block, so the width a region receives follows how many variants it holds. The " +
    "axis above the triangle breaks at each boundary: the flanks carry GRCh38 positions, " +
    "which is the assembly the 1000 Genomes panel is called against, and the array carries " +
    "CHM13 v2.0. The fan runs each landmark column down to its own assembly's coordinate. " +
    "<b>The SNP windows sit outside the GRCh38 centromere.</b> 100 kb beyond each edge, " +
    "which is where that panel has calls to make. " +
    (thin
      ? "<b>Thin columns are drawn faint.</b> In the strip above the triangle, a column below " +
        `minor allele frequency 0.05 is lighter — ${fmtInt(thin)} of the ${fmtInt(n)} drawn ` +
        "here — because r there rests on a handful of carriers. "
      : "<b>Every column here clears minor allele frequency 0.05.</b> r rests on at least " +
        "that many carriers throughout. ") +
    (openCalls
      ? `<b>${(openCalls / snpCells * 100).toFixed(1)}% of the SNP calls here were open.</b> ` +
        `${fmtInt(openCalls)} of the ${fmtInt(snpCells)} SNP genotypes drawn here arrived ` +
        "without a call, and each carries its variant's mean dosage — the substitution the " +
        "published panels correlate. "
      : "") +
    "" }));
  out.push(how);

  // Where a flank had to be anchored past a callability gap, say how far. On chr1 the right
  // window sits 15.08 Mb out, which is the distance the paper's Methods states, and a reader
  // reading "pericentromeric" off the label is entitled to know it.
  const far = ["L", "R"].map((k) => [k, (flanks[k] || {}).gap_bp || 0])
    .filter(([, gap]) => gap > 10000);
  // The outward re-anchoring notice was removed 2026-09-01. The axis above the triangle
  // already carries the flank's real coordinates, which is where a reader checks this.
  return out;
}

/**
 * One SV against everything else in its array and the window upstream of it.
 *
 * The question this answers is the one a reader brings to a single association: whether the
 * SV travels with a neighbour, so that the association could belong to either. A row is
 * cheap - one variant against every other is a few hundred thousand multiply-adds - so this
 * one draws the whole chromosome with no selection at all.
 */
function ldRow(d) {
  const wrap = el("div", { class: "ldrow" },
    el("h3", { class: "eyebrow" }, "Linkage disequilibrium"));
  const frame = LD.frameOf(state.ld, d.chrom);
  if (!frame) return wrap;

  const self = frame.byId.get(d.sv_id);
  if (self == null) {
    const frames = Object.values(state.ld.chrom || {});
    const open = frames.reduce((s, f) => s + (f.n_unresolved || 0), 0);
    const placed = frames.reduce((s, f) => s + (f.n_sv || 0), 0);
    wrap.append(el("p", { class: "muted" },
      `The extraction placed ${fmtInt(placed)} of the catalog's ` +
      `${fmtInt(state.catalog.length)} SVs on their genotypes; this one is among the ` +
      `${open} it left open, so the chromosome panel carries the rest of this array.`));
    return wrap;
  }

  const idx = Int32Array.from(frame.variants.map((_, i) => i));
  const r = LD.rowOf(frame, self, idx);
  const V = frame.variants;
  let bSv = -1, bSnp = -1, strong = 0;
  for (let t = 0; t < idx.length; t++) {
    if (idx[t] === self) continue;
    const a = Math.abs(r[t]);
    if (a >= 0.8) strong++;
    if (V[idx[t]].kind === "sv") { if (bSv < 0 || a > Math.abs(r[bSv])) bSv = t; }
    else if (bSnp < 0 || a > Math.abs(r[bSnp])) bSnp = t;
  }

  wrap.append(LD.profileCanvas(frame, self, idx, r));
  const kb = (bp) => (Math.abs(bp) < 1000
    ? Math.abs(bp) + " bp" : fmtInt(Math.round(Math.abs(bp) / 1000)) + " kb");
  const line = (label, t) => {
    if (t < 0) return null;
    const v = V[idx[t]];
    // A distance is printed only between two SVs. The SNP block is called against GRCh38 and
    // this SV's position is CHM13 v2.0, so subtracting one from the other would be a number
    // in no genome at all.
    return el("div", { class: "ldpart num", html:
      `<span class="sw" style="background:${LD.colourOf(r[t])}"></span>` +
      `<b>${label}</b> <span class="id">${esc(v.id)}</span> ` +
      `<span class="v">r = ${r[t].toFixed(3)}</span> ` +
      (v.kind === "sv"
        ? `<span class="muted">${kb(v.pos - d.pos)} away</span>`
        : `<span class="muted">at ${(v.pos / 1e6).toFixed(3)} Mb GRCh38</span>`) });
  };
  const rows = [line("strongest partner among the SVs", bSv),
    line("strongest partner among the SNPs", bSnp)].filter(Boolean);
  rows.forEach((x) => wrap.append(x));
  const ldn = el("details", { class: "pnote" });
  ldn.append(el("summary", { class: "muted small" }, "What this panel is over"));
  ldn.append(el("div", { class: "muted small" },
    `Over ${fmtInt(frame.m)} individuals, against every one of the ` +
    `${fmtInt(idx.length - 1)} other variants ${esc(d.chrom)} ships` +
    (frame.nsnp ? " — the pericentromeric SNPs first, then the array, in CHM13 order"
      : ", in CHM13 order") +
    `. ${strong === 1 ? "One reaches" : fmtInt(strong) + " reach"} |r| \u2265 0.8. ` +
    "Where several columns share a pixel the strongest of them is drawn."));
  wrap.append(ldn);

  // "show the whole triangle" removed 2026-09-01: it closed the record and landed the reader
  // on the chromosome page, which is where the breadcrumb already goes, so it read as a jump
  // to the main page rather than as a way back to the figure.
  return wrap;
}

function tipHtml(d) {
  const hs = hitsOf(d);
  const lines = hs.slice(0, 4).map((h) =>
    `<div class="r"><span class="tier ${h.tier}">${h.tier === "primary" ? "P" : "S"}</span>` +
    `${esc(labelOf(h.layer))} &middot; ${esc(h.target ?? "")}</div>`).join("");
  const more = hs.length > 4 ? `<div class="r muted">+${hs.length - 4} more</div>` : "";
  return `<div class="t">${esc(d.sv_id)}</div>` +
    `<div class="r">${fmtMb(d.pos / MB)} Mb &middot; ${esc(d.svtype)} &middot; ${fmtInt(d.svlen)} bp</div>` +
    `<div class="r">allele freq ${(d.svfreq ?? 0).toFixed(3)} &middot; CV R&sup2; ${(d.cv_r2_cen ?? d.cv_r2 ?? 0).toFixed(2)} / ${(d.cv_r2_flank ?? 0).toFixed(2)} flank</div>` +
    (lines ? "<div class='tiphits'>" + lines + more + "</div>" : "");
}

function svTable(svs, opts = {}) {
  const wrap = el("details", opts.open ? { open: true } : {});
  const hits = svs.filter((d) => ev(d) > 0);
  wrap.append(el("summary", {},
    opts.title || `Table view — ${fmtInt(svs.length)} ${svs.length === 1 ? "SV" : "SVs"} ` +
      `(${hits.length} with evidence)`));
  const t = el("table", { class: "tbl" });
  t.innerHTML = "<thead><tr><th scope='col'>SV</th><th scope='col'>Type</th>" +
    "<th scope='col' class='n'>Position (Mb)</th><th scope='col' class='n'>Length (bp)</th>" +
    "<th scope='col' class='n'>Allele freq</th><th scope='col' class='n'>CV R²</th>" +
    "<th scope='col' class='n'>F<sub>ST</sub></th><th scope='col'>Class</th>" +
    "<th scope='col'>Evidence</th></tr></thead>";
  const tb = el("tbody");
  // hits first: with ~98% empty, an unsorted table buries the interesting rows
  const ordered = hits.concat(svs.filter((d) => !ev(d))).slice(0, 400);
  ordered.forEach((d) => {
    const hs = hitsOf(d);
    const tr = el("tr", ev(d) ? { class: "hit" } : {});
    tr.innerHTML =
      `<td><a href="#/${d.chrom}/${d.sv_index}">${esc(d.sv_id)}</a></td>` +
      `<td>${esc(d.svtype)}</td><td class="n">${fmtMb(d.pos / MB)}</td>` +
      `<td class="n">${fmtInt(d.svlen)}</td><td class="n">${(d.svfreq ?? 0).toFixed(3)}</td>` +
      `<td class="n">${(d.cv_r2 ?? 0).toFixed(2)}</td>` +
      `<td class="n">${d.fst == null ? "—" : d.fst.toFixed(3)}</td>` +
      `<td>${esc(d.sv_category ?? "—")}</td>` +
      `<td>${hs.length ? esc([...new Set(hs.map((h) => labelOf(h.layer)))].join(", ")) : "—"}</td>`;
    tb.append(tr);
  });
  t.append(tb);
  wrap.append(t);
  if (svs.length > 400) wrap.append(el("p", { class: "muted" },
    `Showing the first 400 of ${fmtInt(svs.length)} rows; every SV with evidence is included.`));
  return wrap;
}

// ------------------------------------------------------------------ search results
/**
 * The results view. A search that could only jump to one variant would be a shortcut, not
 * a search - a gene can be reported on several SVs, and "DEL" names 5,518 of them.
 */
function renderFind(q) {
  if (!state.corpus) state.corpus = buildCorpus(state);
  const { named, svs } = resolve(state.corpus, state, q);
  const withEv = svs.filter((d) => ev(d) > 0);

  app.replaceChildren(el("header", { class: "lede" },
    el("h1", {}, "Search"),
    el("p", { class: "muted" },
      `“${q}” — ${named.length} named match${named.length === 1 ? "" : "es"} and ` +
      `${fmtInt(svs.length)} variant${svs.length === 1 ? "" : "s"}` +
      (svs.length ? `, ${withEv.length} with evidence` : ""))));
  crumbs(null, q);

  if (!named.length && !svs.length) {
    app.append(el("div", { class: "notice", html:
      `<b>Try another term for “${esc(q)}”.</b> Search reads a gene such as ` +
      `<code>SUV39H1</code>, a disease name, a variant such as ` +
      `<code>chr8_sv30_DEL</code>, or a position such as ` +
      `<code>chr8:44,300,221</code> or <code>chr8:44.2-44.5Mb</code>.` }),
      el("p", { class: "muted" },
        "Some terms are missing by design: this study's own controls eliminated several "
        + "candidates."));
    return;
  }

  if (named.length) {
    const list = el("ul", { class: "hitlist" });
    named.slice(0, 60).forEach((r) => {
      const href = r.target.sv_index != null
        ? `#/${r.target.chrom}/${r.target.sv_index}`
        : `#/${r.target.chrom || ""}`;
      list.append(el("li", {}, el("a", { class: "row", href },
        el("span", { class: "kind" }, KIND_LABEL[r.kind] || r.kind),
        el("span", { class: "ttl" }, r.label),
        el("span", { class: "sub muted" }, r.sub || ""))));
    });
    app.append(el("section", {},
      el("h2", { class: "eyebrow" }, `Named matches (${named.length})`), list,
      named.length > 60
        ? el("p", { class: "muted" }, `Showing the first 60 of ${named.length}.`) : null));
  }

  if (svs.length) {
    app.append(el("section", {},
      el("h2", { class: "eyebrow" }, `Variants (${fmtInt(svs.length)})`),
      el("div", { class: "controls" }, tierControl()),
      svTable(svs, { open: true,
        title: `${fmtInt(svs.length)} ${svs.length === 1 ? "variant" : "variants"}, ` +
          `${withEv.length} with evidence` })));
  }
  announce(`${named.length} named matches and ${fmtInt(svs.length)} variants for ${q}.`);
}

// ------------------------------------------------------------------ panel
const POPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];
// assemblies per super-population, met_09_popgen.tex. Shown so a reader can see how few
// haplotypes a frequency here rests on - EUR is 21 assemblies, so its grain is ~0.024.
// Assemblies per super-population in R9. They sum to 188, not to the 196 individuals in the
// SV genotype matrix, and the eight missing are not a sampling choice: they have no row in
// the 1000 Genomes panel R9 joins against - that panel is a call set (2,504 phase-3 unrelated
// + 698 relatives completing trios), not the collection - so they land in no super-population
// index and enter no allele frequency and no F_ST. Seven of the eight have a published
// ancestry (HG01123 CLM; HG02109/HG02486/HG02559 ACB; HG03471 MSL; NA21309 HapMap MKK; HG005
// GIAB Chinese); only HG002 has none. These stay the study's numbers - the browser reports
// what R9 computed - it simply does not call 188 the cohort. See discovery/
// 2026-05-09_sv_imputability_features/FINDING_2026-08-28_fst_cohort_188_of_196.md
// The eight candidate models of met_03_snp_extraction.tex: a short tag for the face and the
// expansion for the hover. Naming the model beats naming the pool it was chosen from, which
// is what "best6 / best8" did and which tells a reader nothing.
const MODEL = {
  midpoint500: ["mid500", "nearest 500 SNPs each side of the centromere midpoint"],
  midpoint1000: ["mid1000", "nearest 1,000 SNPs each side of the centromere midpoint"],
  edge500: ["edge500", "nearest 500 SNPs each side of the centromere boundary"],
  edge1000: ["edge1000", "nearest 1,000 SNPs each side of the centromere boundary"],
  edge2000: ["edge2000", "nearest 2,000 SNPs each side of the centromere boundary"],
  fksize100k: ["fk100kb", "every SNP within 100 kb outward of the centromere boundary"],
  fksize200k: ["fk200kb", "every SNP within 200 kb outward of the centromere boundary"],
  fksize500k: ["fk500kb", "every SNP within 500 kb outward of the centromere boundary"],
};
// Which SNPs a model was allowed, rather than which pool it was chosen from. Strategies 1
// and 2 anchor on the centromere boundary and search outward, so they place 0 of 197,629
// predictor SNPs inside the centromere; Strategy 3 anchors on the midpoint and places 85.5%
// of its 130,839 inside. So the two accuracies are the same net with and without the
// centromere's own SNPs, and naming that is more use to a reader than "best".
const CEN_IN = "pericen SNPs";
const CEN_EX = "flank SNPs";

// One line per permission, not per pool, and each line carries the model that reached it.
// The centromeric line is the better of the two midpoint-anchored models, the flank line the
// better of the six anchored on the boundary; every SV in the catalog has both, so both lines
// always appear. The model is a tag with its expansion on an <abbr>, so hovering says what
// "mid1000" means without spending a row on it.
function cvr2Line(d) {
  const box = el("span", { class: "cvr2" });
  const line = (v, lab, strat) => {
    const s = el("span", { class: "cvline" }, `${v.toFixed(3)} (${lab}`);
    const m = MODEL[strat];
    if (m) {
      s.append(", ", el("abbr", { class: "mtag", title: m[1] }, m[0]));
    } else if (strat) {
      s.append(", " + strat);
    }
    s.append(")");
    return s;
  };
  if (d.cv_r2_cen != null) box.append(line(d.cv_r2_cen, CEN_IN, d.strategy_cen));
  if (d.cv_r2_flank != null) box.append(line(d.cv_r2_flank, CEN_EX, d.strategy_flank));
  if (!box.childNodes.length) box.append(line(d.cv_r2 ?? 0, "—", null));
  return box;
}

const NASM = { AFR: 55, AMR: 39, EAS: 39, EUR: 21, SAS: 34 };
const N_ASM_MATCHED = 188;
const N_ASM_TOTAL = 196;

/** Where this SV's F_ST sits in the catalog, so a bare number can be read as high or low. */
function fstRank(v) {
  const a = state.fstSorted;
  if (v == null || !a.length) return null;
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return 100 * lo / a.length;
}

let panelOpener = null;
let selKey = null;

/**
 * Mark the scatter's circle for the record that is open.
 *
 * Above 1100 px the drawer takes its width out of the page rather than lying over it, so the
 * chart is beside the reader the whole time they are reading a record - and nothing on it
 * said which of chr1's 1,904 marks the record belonged to. An address that names a variant
 * could be read against the figure only by hunting for it.
 *
 * A ring with a gap in the surface colour, and the variant's name beside it. The ring is what
 * FINDS the mark, which is the whole job on the 10,467 catalogued SVs that carry no evidence
 * and are drawn 2 px wide and half transparent; the name is what confirms the address landed
 * where it says. The name turns round within 120 px of the right edge, where chr1_sv1996_DEL
 * sits.
 *
 * Drawn as a sibling of the circle rather than styled onto it, for two reasons. A 2 px mark
 * has no room to carry a highlight of its own. And every repaint - a filter moving, a track
 * folding, the tier changing - rebuilds the marks from scratch, so this is put back by the
 * same call that draws them and cannot drift out of step with the drawer.
 *
 * Decorative, deliberately: the name is already the drawer's title and the mark under it is
 * already a labelled button, so the group is hidden from assistive technology and takes no
 * pointer events. Hover, focus and the tooltip behave exactly as they did.
 */
function applySel() {
  document.querySelectorAll("#app .chart .selmark").forEach((n) => n.remove());
  if (!selKey) return;
  // A record can be open for a variant the floors or the evidence-only checkbox have taken
  // off the chart. Nothing to mark then, which is the honest answer.
  const dot = document.querySelector(
    `#app .chart svg circle[data-sv="${CSS.escape(selKey)}"]`);
  if (!dot) return;
  const cx = +dot.getAttribute("cx"), cy = +dot.getAttribute("cy");
  const r = +dot.getAttribute("r"), iw = +dot.ownerSVGElement.dataset.iw;
  const row = (state.byChrom.get(selKey.split(":")[0]) || [])
    .find((d) => svKey(d) === selKey);
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, at, txt) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(at)) n.setAttribute(k, v);
    if (txt != null) n.textContent = txt;
    return n;
  };
  const g = mk("g", { class: "selmark", "aria-hidden": "true", "pointer-events": "none" });
  // The gap goes down first, so the ring stays separable where marks overlap.
  g.append(mk("circle", { cx, cy, r: r + 2.5, fill: "none",
    stroke: css("--surface-1"), "stroke-width": 3 }));
  g.append(mk("circle", { cx, cy, r: r + 5, fill: "none",
    stroke: css("--accent"), "stroke-width": 2 }));
  if (row) {
    const end = cx > iw - 120;
    const at = { x: cx + (end ? -(r + 9) : r + 9), y: cy + 4,
      "text-anchor": end ? "end" : "start", class: "sellab" };
    // Twice: the first pass is a halo in the surface colour, so the name reads over whatever
    // it lands on. There is no other way to give SVG text a background.
    g.append(mk("text", Object.assign({}, at, { stroke: css("--surface-1"),
      "stroke-width": 3.5, "stroke-linejoin": "round" }), row.sv_id));
    g.append(mk("text", Object.assign({}, at, { fill: css("--accent") }), row.sv_id));
  }
  dot.parentNode.append(g);
}

function openPanel(d, fromUrl = false) {
  document.querySelector(".panel")?.remove();
  if (!fromUrl) {
    panelOpener = document.activeElement;
    setUrl(`#/${d.chrom}/${d.sv_index}`);
  }
  selKey = svKey(d);
  applySel();
  const p = el("aside", {
    class: "panel", role: "dialog", "aria-modal": "true", tabindex: "-1",
    "aria-label": `Record for ${d.sv_id}`,
  });

  const close = () => {
    p.remove();
    selKey = null;
    applySel();
    document.body.classList.remove("panelopen");
    setUrl(`#/${d.chrom}`);
    if (panelOpener && document.contains(panelOpener)) panelOpener.focus();
  };

  const copy = el("button", { class: "ghost", type: "button" }, "copy link");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copy.textContent = "copied";
      setTimeout(() => { copy.textContent = "copy link"; }, 1600);
    } catch { copy.textContent = "press ⌘C"; }
  };
  const closeBtn = el("button", { class: "ghost", type: "button", "aria-label": "Close record" }, "close");
  closeBtn.onclick = close;

  p.append(el("div", { class: "phd" },
    el("div", { class: "pttl" },
      el("h2", {}, d.sv_id),
      el("div", { class: "muted num" }, `${d.chrom}:${fmtInt(d.pos)}–${fmtInt(d.end)}`),
      el("div", { class: "muted" }, "CHM13 v2.0")),
    el("div", { class: "pact" }, copy, closeBtn)));

  const dl = el("dl");
  [["Type", d.svtype],
   ["Length", fmtInt(d.svlen) + " bp"],
   ["Allele frequency", (d.svfreq ?? 0).toFixed(4)],
   ["Imputation CV R²", cvr2Line(d)],
   ["Resolution class", d.sv_category ?? "—"],
   ["Haplogroup", d.mapped_haplogroup ?? "—"],
   ["Position in array", ((d.hor_frac ?? 0) * 100).toFixed(1) + "% along"]]
    .forEach(([k, v]) => dl.append(el("dt", {}, k),
      el("dd", { class: "num" }, v instanceof Node ? v : String(v))));
  p.append(dl);
  // Only a monophyletic SV has a clade, so only a monophyletic record offers one. The
  // first pass offered the link from every record, which sent 176 of chr8's 204 typed
  // SVs to a tree with no outline on it.
  if (state.hapIndex?.summary?.[d.chrom] && d.sv_category === "monophyletic") {
    // How many times this SV arose, where the resolution gives it more than one origin. The
    // count comes from hap_index.json, which is already loaded; reaching for the per-chromosome
    // block here would fetch it on every monophyletic record to answer nothing on most of them.
    const n = state.hapIndex.multi?.[d.chrom]?.[String(d.sv_index)];
    p.append(el("p", { class: "hapline" },
      n ? `This SV arose ${n === 2 ? "twice" : n + " times"}, and each origin marks its own `
        + "clade of the haplotype tree. "
        : "Carriers form one clade of the haplotype tree. ",
      el("a", { href: `#/${d.chrom}/haplotypes/${d.sv_index}` },
        n ? "See the origins" : "See the clade")));
  }
  p.append(popgen(d));
  p.append(ldRow(d));

  const hs = hitsOf(d);
  const hidden = (state.hitsBySv.get(svKey(d)) || []).length - hs.length;
  p.append(el("h3", { class: "eyebrow" },
    hs.length ? `Reported associations (${hs.length})` : "Associations"));
  if (!hs.length) {
    p.append(el("p", { class: "muted" }, "No associations reported for this SV."));

  } else {
    hs.forEach((h) => p.append(hitRow(h)));
  }
  if (hidden > 0) {
    p.append(el("p", { class: "muted" },
      `${hidden} further association${hidden > 1 ? "s" : ""} at the suggestive tier. ` +
      `Switch the significance control to see ${hidden > 1 ? "them" : "it"}.`));
  }

  // Esc closes and focus returns where it came from; Tab stays inside while it is open.
  p.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    // <summary> is natively focusable and matched none of the four selectors that used to be
    // here, so Tab could land on a control the trap did not know about and walk out past it.
    // The visibility filter keeps a control inside a collapsed <details> from becoming
    // `first` or `last`.
    const f = [...p.querySelectorAll(
      'button,a[href],input,summary,[tabindex]:not([tabindex="-1"])')]
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.body.append(p);
  // The page makes room for the drawer rather than being covered by it. Measured: at a
  // 1440 px viewport the fixed 408 px panel hid 24.2% of the 1,182 px chart, 31.0% at 1280 -
  // and the hidden part is the right end of the array, which is often exactly where the mark
  // that opened the record sits.
  document.body.classList.add("panelopen");
  p.focus();
}

function hitRow(h) {
  const r = el("div", { class: "hitrow" });
  const step = h.tier === "primary" ? 3 : 1;
  r.append(el("span", { class: "tag", title: labelOf(h.layer),
    style: `background:${evColor(step)};color:${evInk(step)}` }, shortOf(h.layer)));
  r.append(el("span", { class: "tier " + h.tier }, h.tier === "primary" ? "primary" : "suggestive"));
  // What this scan regressed on. Two of the four layers genotype the SV directly from the
  // assemblies and two impute it, and until now nothing on the record said which - the same
  // cv r2 sits beside both. It also changes what that cv r2 MEANS here: on a directly
  // genotyped association it is not evidence quality, it is how tightly local SNPs tag the
  // variant, which is the identifiability caveat rather than a strength.
  const expo = state.layerMeta.get(h.layer)?.exposure;
  if (expo) {
    r.append(el("span", { class: "expo " + expo },
      expo === "direct" ? "direct genotype" : "imputed"));
  }
  const title = el("div", { class: "ht" }, `${labelOf(h.layer)}: ${h.target ?? ""}`);
  // The reason a gate set an association aside, on the row it belongs to. Kept separate from
  // the tier chip on purpose: tier is significance, and a locus can be significant AND carry
  // a confound, which is exactly what the section means when it calls the chromosome 5, 9
  // and 19 hits significant while leaving their attribution open.
  if (h.tags) {
    h.tags.split(", ").forEach((t) => title.append(
      el("span", { class: "rtag" + (t.indexOf("length") >= 0 ? " strong" : "") }, t)));
  }
  const main = el("div", { class: "hitmain" }, title);
  const bits = [];
  if (h.scope && !["cis", "phewas", "cdr"].includes(h.scope)) bits.push(h.scope.toUpperCase());
  if (h.qval != null) bits.push("q = " + fmtQ(h.qval));
  if (h.qval == null && h.pval != null) bits.push("p = " + fmtQ(h.pval));
  // An odds ratio, because the ancestry chips below are odds ratios and this used to be a
  // log-odds next to them. Only where the layer is a case/control scan; a QTL beta is a slope
  // and exponentiating it would mean nothing.
  if (h.beta != null) {
    bits.push(h.layer === "aou" ? "OR = " + Math.exp(h.beta).toFixed(2)
      : "β = " + h.beta.toFixed(3));
  }
  if (h.susie_pip != null) bits.push("SuSiE PIP " + h.susie_pip.toFixed(3));
  if (h.n != null) bits.push("n = " + fmtInt(h.n));
  if (h.cases != null) bits.push(fmtInt(h.cases) + " cases");
  // What that q is a q OVER, in three words. Benjamini-Hochberg here is applied within
  // predictor tier, not across the scan, and the panel note below spells out what that
  // means; naming the tier on the row is what stops the q reading as scan-wide.
  if (h.layer === "aou" && h.ptier) {
    const t = state.meta?.aou_tiers?.[h.ptier];
    bits.push(`q within the ${t?.inline || h.ptier} tier`);
  }
  // The statistics, and under them what those statistics are OVER. The second explains the
  // first rather than adding to it - "permutation p, study-wide threshold 5.62e-07 over
  // 11,129 loci x 8 phenotypes" is what "p = 1.00e-7" means - so it hangs off it as a
  // disclosure. Not title=: the note at the ancestry chips records that a title is invisible
  // to a touch screen and unreachable by keyboard.
  if (bits.length && h.detail) {
    const nd = el("details", { class: "pnote" });
    nd.append(el("summary", { class: "muted num" }, bits.join(" · ")));
    nd.append(el("div", { class: "muted" }, h.detail));
    main.append(nd);
  } else {
    if (bits.length) main.append(el("div", { class: "muted num" }, bits.join(" · ")));
    if (h.detail) main.append(el("div", { class: "muted" }, h.detail));
  }
  r.append(main);
  const anc = h.layer === "aou" ? ancestryStrip(h) : null;
  if (anc) main.append(anc);
  return r;
}

/**
 * The same association re-tested inside each of the six ancestry strata.
 *
 * Numbers, not a forest and not bars. 610 of the 1,530 cells have no estimate, and a forest
 * would draw those as absent points while a bar chart would draw them as zero - both
 * asserting a measurement nobody has. A chip can say why instead, and since 2026-09-01 it
 * can say something specific: the Researcher Workbench released the full unthresholded grid
 * for these cells, so a dash is either a cell with fewer than 20 cases, whose count is
 * withheld, or one where the imputed predictor carries no usable variance in that stratum.
 * The second is not a sample-size limit and reads very differently.
 *
 * All six strata are drawn. Until that release EAS, SAS and MID could show nothing at all,
 * because only cells meeting the export rule left the workbench; they now carry 107, 38 and
 * 27 estimates on these cells.
 *
 * An interval appears only where the ETL shipped a standard error, which is only where the
 * estimator is the score test - there and nowhere else is the displayed beta the same fit the
 * SE belongs to. Pairing it with a Firth beta implies a p wrong by up to 2,564x.
 *
 * The strata are ordered by cohort size, because that ordering is the section's own power
 * argument: the European cohort is nearly three times the admixed-American one and carries a
 * twelfth as many of these associations.
 */
function ancestryStrip(h) {
  const meta = state.meta?.ancestry;
  if (!meta || !h.sv_locus || !h.phecode) return null;
  const rows = state.ancBySv.get(h.sv_locus + "|" + h.phecode) || [];
  const by = new Map(rows.map((r) => [r.stratum, r]));

  const wrap = el("div", { class: "anc" });
  const chips = el("div", { class: "ancchips num" });
  const detail = el("div", { class: "ancdetail muted small", hidden: true });

  // A chip is a button. Its numbers used to live in a title= attribute, which a touch screen
  // never shows and a keyboard never reaches, and this was the only place they appeared.
  const chip = (key, value, has, body) => {
    const b = el("button", {
      type: "button", class: "achip" + (has ? " has" : ""), "aria-expanded": "false",
      html: `<b>${esc(key)}</b> ${value}`,
      onclick: () => {
        const was = b.getAttribute("aria-expanded") === "true";
        [...chips.children].forEach((c) => c.setAttribute("aria-expanded", "false"));
        b.setAttribute("aria-expanded", was ? "false" : "true");
        detail.innerHTML = was ? "" : body;
        detail.hidden = was;
      },
    });
    return b;
  };

  // The whole-cohort model FIRST: it is the primary result and the strata are a breakdown of
  // it. In the same units as the chips beside it, which is why the row above now prints an
  // odds ratio too - it used to print beta, a log-odds, next to these.
  if (h.beta != null) {
    chips.append(chip("ALL", Math.exp(h.beta).toFixed(2), true,
      `<b>All participants</b> &middot; OR ${Math.exp(h.beta).toFixed(2)} &middot; ` +
      `P ${fmtQ(h.pval)} &middot; ${fmtInt(h.cases ?? 0)} cases of ` +
      `${fmtInt(meta.cohort_total ?? 0)} &middot; one model, 16 genotype PCs and five ` +
      "ancestry indicators"));
  }

  // All six, in cohort order. A stratum with no estimate still has a reason, and the reason
  // is the informative part - see this function's note.
  meta.strata.forEach((s) => {
    const r = by.get(s);
    const lab = esc(meta.labels[s] || s);
    const cohort = fmtInt(meta.cohort[s] ?? 0);
    if (r && r.beta != null) {
      const or = Math.exp(r.beta);
      // Only where an SE was shipped, which is only where the beta is the score beta.
      const ci = r.se != null
        ? ` &middot; 95% CI ${Math.exp(r.beta - 1.96 * r.se).toFixed(2)}\u2013` +
          `${Math.exp(r.beta + 1.96 * r.se).toFixed(2)}`
        : "";
      chips.append(chip(s, or.toFixed(2), true,
        `<b>${lab}</b> &middot; OR ${or.toFixed(2)}${ci} &middot; P ${fmtQ(r.p)} &middot; ` +
        `${fmtInt(r.cases ?? 0)} cases of ${cohort}`));
    } else {
      const why = r == null
        ? "no record for this cell"
        : r.na === 1
          ? `fewer than 20 cases here, so the count itself is withheld (cohort ${cohort})`
          : `tested, but the imputed predictor carries no usable variance in this stratum ` +
            `(${fmtInt(r.cases ?? 0)} cases of ${cohort})`;
      chips.append(chip(s, "&mdash;", false, `<b>${lab}</b> &middot; ${why}`));
    }
  });

  wrap.append(el("div", { class: "ancline" },
    el("span", { class: "eyebrow inline" }, "By ancestry"),
    chips), detail);
  return wrap;
}


/**
 * Population differentiation, from R9. Shown on the SV rather than as evidence: the
 * section's finding is that differentiation does NOT explain the associations, so a high
 * F_ST here is context for reading a hit, not a hit of its own.
 *
 * NUMBERS, NOT BARS, and labelled with their cohort. These genotypes are called directly
 * from 188 of the 196 HPRC assemblies in the genotype matrix - see NASM for which eight are
 * missing and why - while the carrier frequency higher up the panel is imputed over
 * the 1000 Genomes cohort. Different quantities on different cohorts, and they barely
 * correlate - the chr8 CDR lead is 0.553 imputed and 0.005 in the assemblies. A bar
 * normalised to its own row would render the largest of five tiny frequencies as full and
 * invite exactly the reading that is wrong.
 */
function popgen(d) {
  const wrap = el("div", { class: "popgen" },
    el("h3", { class: "eyebrow" }, "Population differentiation"));
  if (d.fst == null) {
    wrap.append(el("p", { class: "muted" },
      "Fₛₜ is unavailable for this SV — one of 11 of the 10,705 modelled here."));
    return wrap;
  }
  // "higher than 100.0% of the catalog" is a contradiction, and rounding produces it for
  // the top of the distribution. Name the rank instead once nothing sits above it.
  const pct = fstRank(d.fst);
  const rank = pct >= 99.95 ? "the highest of the SVs modelled here"
    : `higher than ${pct.toFixed(1)}% of the catalog`;

  // The Hudson estimator is unbiased, so where true differentiation is below sampling noise
  // it scatters through zero: 3,067 of the 10,694 values here are negative and the catalog
  // median is exactly 0. Printing "-0.013" reads as a broken number rather than as the
  // absence of differentiation, which is what it is.
  // "0" printed next to a super-population frequency of 0.029 reads as a contradiction.
  // It is not a zero difference; it is a bias-corrected estimate that has landed at or below
  // zero, which the "<=" says and the note below explains.
  const none = d.fst <= 0;
  wrap.append(el("div", { class: "num", html:
    "max pairwise F<sub>ST</sub> <b>" + (none ? "\u2264 0" : d.fst.toFixed(3)) + "</b> " +
    `<span class="muted">— ${none ? "differentiation within sampling noise" : rank}` +
    (!none && d.fst > 0.15 ? ", and above the 0.15 mark" : "") + "</span>" }));
  // Only where the estimate is actually negative. At exactly zero there is nothing to
  // explain away, and printing "returned 0.0000, a negative estimate means..." is confusing
  // about a number that is not negative.

  const top = Math.max(...POPS.map((p) => d["af_" + p] ?? 0));
  const row = el("div", { class: "pops num" });
  POPS.forEach((pop) => {
    const v = d["af_" + pop];
    const lead = v != null && v > 0 && v === top;
    row.append(el("span", { class: "pop" + (lead ? " has" : ""), html:
      `<b>${pop}</b> ${v == null ? "—" : v.toFixed(3)}<span class="n">/${NASM[pop]}</span>` }));
  });
  wrap.append(row);
  wrap.append(el("div", { class: "muted num" },
    `overall ${(d.af_hprc ?? 0).toFixed(3)} across ${N_ASM_MATCHED} assemblies`));

  // One disclosure for everything that explains those numbers rather than being one of them:
  // how the statistic is counted, why it can land at or below zero, and which cohort the
  // frequencies come from - which is NOT the cohort the allele frequency at the top is over.
  const fn = el("details", { class: "pnote" });
  fn.append(el("summary", { class: "muted" }, "How this is counted"));
  const fb = el("div", { class: "muted" });
  fb.innerHTML =
    "Maximum over the ten super-population pairs, bias-corrected Hudson estimator: " +
    "<span class='num'>N = (p<sub>1</sub>&minus;p<sub>2</sub>)² &minus; " +
    "p<sub>1</sub>(1&minus;p<sub>1</sub>)/(n<sub>1</sub>&minus;1) &minus; " +
    "p<sub>2</sub>(1&minus;p<sub>2</sub>)/(n<sub>2</sub>&minus;1);&ensp; " +
    "D = p<sub>1</sub>(1&minus;p<sub>2</sub>) + p<sub>2</sub>(1&minus;p<sub>1</sub>)</span>. " +
    `Frequencies are called from ${N_ASM_MATCHED} HPRC assemblies; the allele frequency ` +
    "above is imputed over the 1000 Genomes cohort.";
  fn.append(fb);
  wrap.append(fn);
  return wrap;
}

// ------------------------------------------------------------------ chrome
function crumbs(chrom, find) {
  const cr = document.getElementById("crumbs");
  cr.replaceChildren();
  if (!chrom && !find) return;
  cr.append(el("a", { href: "#/" }, "All centromeres"), el("span", { class: "sep" }, "/"),
    el("span", { "aria-current": "page" }, chrom || `“${find}”`));
}

function announce(msg) { if (say) say.textContent = msg; }

/**
 * Re-render without throwing the keyboard back to the top of the document.
 *
 * route() replaces the whole tree, so the control that was just used stops existing and
 * document.activeElement falls back to <body>. A reader narrowing by three analyses tabbed
 * in from the top three times. Every control that does this already carries a stable id -
 * `tier-<val>`, `dip-<val>`, `ldmode-<val>` - and the record panel already does the same
 * thing properly with `panelOpener`.
 */
function routeKeepingFocus() {
  const id = document.activeElement?.id;
  route();
  if (id) document.getElementById(id)?.focus();
}

// ------------------------------------------------------------------ haplotype layer

/**
 * The two halves of the haplotype layer, at the two addresses that ask for them.
 *
 * Both fetch the heavy per-chromosome file here and nowhere else, so a reader who stays on the
 * variant pages never loads one. The catalog rows main.js already built are handed straight
 * through, which is why the haplotype files carry no SV metadata of their own.
 */
async function hapFrame(chrom, host) {
  const base = import.meta.env.BASE_URL || "/";
  const ctx = await HAP.load(base, chrom);
  if (!ctx) {
    host.replaceChildren(el("div", { class: "notice" },
      el("b", {}, "The haplotype layer is absent from this build. "),
      "Run etl/build_haplotypes.py to write it."));
    return null;
  }
  return ctx;
}

/**
 * Which reading #/individuals is showing. Derived from the address every time, never held
 * across a navigation: the query says what is shown, so Back has to restore the reading
 * along with the address.
 */
const AXES = [["cohort", "Whole cohort"], ["genome", "Whole genome"]];
function readAxis(who) {
  if (who) return "genome";            // a named individual belongs to one reading only
  return new URLSearchParams(location.search).get("axis") === "genome"
    ? "genome" : "cohort";
}

/**
 * The switch, and the cohort it carries.
 *
 * The count travels with the axis because the two readings draw DIFFERENT PEOPLE: the
 * genotype panel is the 188 assembled genomes that also carry 1000 Genomes genotypes, a
 * strict subset of the 196 the haplotype layer covers. One page over both would otherwise
 * invite a reader to carry one denominator across the switch.
 */
function axisBar(axis, line) {
  return el("div", { class: "arrbar" },
    el("span", { class: "eyebrow" }, "axis"),
    el("div", { class: "arrmodes axisswitch", role: "group", "aria-label": "which reading" },
      ...AXES.map(([v, label]) => el("button", {
        type: "button", class: "arrmode" + (v === axis ? " on" : ""),
        "aria-pressed": v === axis ? "true" : "false",
        onclick: () => {
          if (v === axis) return;
          const u = new URL(location.href);
          if (v === "genome") u.searchParams.set("axis", "genome");
          else u.searchParams.delete("axis");
          // the individual lives in the hash and belongs to the genome reading, so
          // leaving it behind would drag this route straight back here
          u.hash = "#/individuals";
          setUrl(u);
          route();
        },
      }, label))),
    el("span", { class: "eyebrow num", html: line }));
}

/**
 * #/individuals[/<individual>] - the arrays, read either way.
 *
 * Whole genome paints one person across all 23 centromeres; Whole cohort ranks the cohort
 * along one. The heading belongs to neither side, because a title naming one reading would
 * read as a third name for it.
 */
async function renderIndividuals(who) {
  crumbs();
  const geom = ARR.geometry(state.ld, state.chroms);
  const axis = geom ? readAxis(who) : "cohort";
  if (who && geom && geom.samples.includes(who)) state.arrOpt.who = who;
  if (geom && !state.arrOpt.who) state.arrOpt.who = geom.samples[0];

  const head = () => el("header", { class: "detailhd" },
    el("h1", {}, "Centromeric arrays"));
  const nav = () => el("nav", { class: "crumbs sub" },
    el("a", { href: "#/" }, "Back to all centromeres"));

  if (axis === "genome") {
    const line = ARR.cohortLine(geom);
    const paint = () => app.replaceChildren(nav(), head(), axisBar(axis, line),
      ...ARR.page({
        geom, ld: state.ld, hapIndex: state.hapIndex, opt: state.arrOpt,
        onOpt: (k, v) => {
          state.arrOpt[k] = v;
          if (k === "who") { location.hash = "#/individuals/" + encodeURIComponent(v); return; }
          const u = new URL(location.href);
          if (v === ARR.DEFAULT_MODE) u.searchParams.delete("paint");
          else u.searchParams.set("paint", v);
          setUrl(u);
          paint();
        },
      }));
    const q = new URLSearchParams(location.search).get("paint");
    if (ARR.MODES.some(([v]) => v === q)) state.arrOpt.mode = q;
    paint();
    announce(`Whole genome: centromeric arrays painted for ${state.arrOpt.who}.`);
    return;
  }

  // The cohort reading across all 23 sits above the per-chromosome table, and the switch
  // stays at two positions. A third position would ask a reader to learn a taxonomy before
  // the first glance, where vertical order says the same thing for nothing. The chromosome
  // picker belongs to the table, so it travels in the table's own header.
  const trkQ = new URLSearchParams(location.search).get("trk");
  if (trkQ != null) state.arrOpt.trk = trkQ;
  const lede = el("div", { class: "arrlede" });
  const paintLede = () => {
    if (!geom || !state.tracks?.meth) { lede.replaceChildren(); return; }
    lede.replaceChildren(...ARR.cohortBlock({
      geom, tracks: state.tracks, trk: state.arrOpt.trk,
      onTrk: (v) => {
        state.arrOpt.trk = v;
        const u = new URL(location.href);
        if (v === ARR.DEFAULT_TRK) u.searchParams.delete("trk");
        else u.searchParams.set("trk", v);
        setUrl(u);
        paintLede();
      },
    }));
  };

  const chroms = state.chroms.map((c) => c.chrom);
  if (!state.hapOpt.chrom) state.hapOpt.chrom = chroms[0];
  const body = el("div", {}, el("p", { class: "loading" }, "Loading the haplotype layer…"));
  const line = state.hapIndex
    ? `<b>${state.hapIndex.samples.length}</b> individuals · ` +
      `<b>${state.hapIndex.n_tip}</b> assembled haplotypes`
    : "";
  app.replaceChildren(nav(), head(),
    geom ? axisBar(axis, line)
         : el("p", { class: "eyebrow num", html: line }), lede, body);
  paintLede();

  const ctx = await hapFrame(state.hapOpt.chrom, body);
  if (!ctx) return;
  const paint = () => {
    body.replaceChildren(...HAP.individualsPage({
      index: ctx.index, block: ctx.block, chroms, opt: state.hapOpt,
      onOpt: (k, v) => {
        state.hapOpt[k] = k === "n" ? (v === "Infinity" ? Infinity : +v) : v;
        if (k === "chrom") { route(); return; }
        paint();
      },
    }));
  };
  paint();
  announce(`Whole cohort: individual arrays on ${state.hapOpt.chrom}.`);
}

/**
 * The SV table's order, in the query string, as `hsort=r2` or `hsort=-r2` for descending.
 *
 * Display state belongs in the query string here and location belongs in the hash, so a link
 * carries the view it was written about. syncFilterUrl() mutates the params it owns rather
 * than rebuilding them from a list, so this key survives every other control.
 */
/** The methylation table's order, in the query string, as `msort=q` or `msort=-q`. */
function readMethSort() {
  const v = new URLSearchParams(location.search).get("msort");
  if (!v) return { ...METH.METH_SORT };
  const dir = v.startsWith("-") ? -1 : 1;
  const key = v.replace(/^-/, "");
  return METH.METH_COLS.some((c) => c.key === key) ? { key, dir } : { ...METH.METH_SORT };
}

function writeMethSort(sort) {
  const u = new URL(location.href);
  if (sort.key === METH.METH_SORT.key && sort.dir === METH.METH_SORT.dir) {
    u.searchParams.delete("msort");
  } else {
    u.searchParams.set("msort", (sort.dir < 0 ? "-" : "") + sort.key);
  }
  setUrl(u);
}

/** #/methylation - every SV the scan tested, ordered by whichever column a reader picks. */
function renderMethylation() {
  crumbs();
  state.methSort = readMethSort();
  const rows = METH.summarise(state.layers, state.catalog);
  const body = el("div", {});
  app.replaceChildren(el("nav", { class: "crumbs sub" },
    el("a", { href: "#/" }, "Back to all centromeres")), body);
  const paint = () => {
    body.replaceChildren(...METH.page({
      rows, layers: state.layers, sort: state.methSort,
      nSvs: state.meta?.meth?.n_svs, nChroms: state.meta?.meth?.n_chroms,
      note: (state.meta?.layers || []).find((l) => l.key === "mqtl")?.why,
      // A first click sorts a number highest-first, which is the useful end of every
      // column here except the two where small is strong.
      onSort: (key) => {
        const asc = key === "q" || key === "maxt" || key === "dist";
        state.methSort = state.methSort.key === key
          ? { key, dir: -state.methSort.dir }
          : { key, dir: asc ? 1 : -1 };
        writeMethSort(state.methSort);
        paint();
      },
    }));
  };
  paint();
  announce(`${rows.length} SVs tested for methylation.`);
}

function readHapSort() {
  const v = new URLSearchParams(location.search).get("hsort");
  if (!v) return { ...HAP.MONO_SORT };
  const dir = v.startsWith("-") ? -1 : 1;
  const key = v.replace(/^-/, "");
  return HAP.MONO_COLS.some((c) => c.key === key) ? { key, dir } : { ...HAP.MONO_SORT };
}

function writeHapSort(sort) {
  const u = new URL(location.href);
  if (sort.key === HAP.MONO_SORT.key && sort.dir === HAP.MONO_SORT.dir) {
    u.searchParams.delete("hsort");
  } else {
    u.searchParams.set("hsort", (sort.dir < 0 ? "-" : "") + sort.key);
  }
  setUrl(u);
}

/** #/chrN/haplotypes[/<sv_index>] - the tree, and the SVs that mark one clade of it. */
async function renderHaplotypes(chrom, svIndex) {
  const c = state.chroms.find((d) => d.chrom === chrom);
  if (!c) { location.hash = "#/"; return; }
  crumbs(chrom);
  const body = el("div", {}, el("p", { class: "loading" }, "Loading the haplotype layer…"));
  app.replaceChildren(el("nav", { class: "crumbs sub" },
    el("a", { href: `#/${chrom}` }, `Back to ${chrom} variants`)), body);

  const ctx = await hapFrame(chrom, body);
  if (!ctx) return;
  if (svIndex != null) state.hapSv = svIndex;
  state.hapSort = readHapSort();
  const chroms = state.chroms.map((d) => d.chrom);
  const rows = state.byChrom.get(chrom) || [];
  const paint = (scroll) => {
    body.replaceChildren(...HAP.treePage({
      index: ctx.index, block: ctx.block, rows, chroms, svIndex: state.hapSv,
      sort: state.hapSort,
      // A first click sorts a number highest-first and a name A-to-Z, which is the useful end
      // of each; clicking the column already sorted turns it round.
      onSort: (key) => {
        const col = HAP.MONO_COLS.find((c) => c.key === key);
        state.hapSort = state.hapSort.key === key
          ? { key, dir: -state.hapSort.dir }
          : { key, dir: col && col.num ? -1 : 1 };
        writeHapSort(state.hapSort);
        paint(false);
      },
      onChrom: (v) => { state.hapSv = null; location.hash = `#/${v}/haplotypes`; },
      onPick: (k) => {
        state.hapSv = k;
        setUrl(`#/${chrom}/haplotypes/${k}`);
        paint(false);
      },
      // Following an evidence count to its record marks the row it left from, so the back
      // button returns to this table at that row and scrolled to it. The address is all it
      // writes: a repaint here would take the link out of the document in the middle of its
      // own click, and the browser stops following a link it can no longer see.
      onMark: (k) => {
        state.hapSv = k;
        setUrl(`#/${chrom}/haplotypes/${k}`);
      },
    }));
    if (scroll && state.hapSv != null) {
      document.getElementById("hapsv-" + state.hapSv)
        ?.scrollIntoView({ block: "center", behavior: "auto" });
    }
  };
  paint(svIndex != null);
  const sum = state.hapIndex?.summary?.[chrom];
  announce(`${chrom} clade trees. ${sum ? sum.mono : 0} SVs mark one clade.`);
}

// ------------------------------------------------------------------ routing
/**
 * #/              overview
 * #/chr8          one centromere
 * #/chr8/30       that centromere with sv_index 30 open - a citable address for a single
 *                 variant, which is what a reader following a figure caption needs
 * #/find/<query>  search results
 */
function route(toTop = false) {
  // A hash that is not a route is not this function's business. "Skip to content" is an
  // in-page anchor to #app, and this is a hash router: `#app` parsed to ["app"], matched no
  // chromosome, and fell through to the overview - so the one control a keyboard reader
  // reaches first threw them off the page they were on and closed any open record. `#` and
  // the empty hash still mean the overview.
  if (location.hash && location.hash !== "#" && !location.hash.startsWith("#/")) return;
  hideTip();
  document.querySelector(".panel")?.remove();
  selKey = null;
  document.body.classList.remove("panelopen");
  // A `?...` tail on the HASH is set aside before the address is read. Four writers used
  // to copy location.search into the hash they wrote, so with any filter away from its
  // default every address a reader could reach carried one - and the two patterns below,
  // ^chr..$ for a chromosome and ^\d+$ for a record, both missed it. `#/chr1/250?cvr2=0.1`
  // drew chr1 with the record closed, `#/chr1?cvr2=0.1` drew the overview, and
  // `#/chr1/haplotypes/1996?cvr2=0.1` outlined whichever SV the sort put first. The writers
  // now write the route alone, which the browser resolves against the current address and
  // so keeps the query; this line keeps every address already written down working.
  const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean);
  if (parts[0] === "methylation") {
    renderMethylation();
    if (toTop) scrollTo(0, 0);
    return;
  }
  // #/arrays was this reading's own address before the two merged. Anything already
  // written down still has to land on the view it named.
  if (parts[0] === "arrays") {
    const u = new URL(location.href);
    u.searchParams.set("axis", "genome");
    u.hash = parts[1] ? "#/individuals/" + parts[1] : "#/individuals";
    setUrl(u);
    renderIndividuals(parts[1] ? decodeURIComponent(parts[1]) : null);
    if (toTop) scrollTo(0, 0);
    return;
  }
  if (parts[0] === "individuals") {
    renderIndividuals(parts[1] ? decodeURIComponent(parts[1]) : null);
    if (toTop) scrollTo(0, 0);
    return;
  }
  if (parts[0] === "find") {
    renderFind(decodeURIComponent(parts.slice(1).join("/")));
  } else if (parts[0] && /^chr([0-9]+|X|Y)$/.test(parts[0])) {
    if (parts[1] === "haplotypes") {
      renderHaplotypes(parts[0], /^\d+$/.test(parts[2] || "") ? +parts[2] : null);
      if (toTop) scrollTo(0, 0);
      return;
    }
    renderDetail(parts[0]);
    if (parts[1] != null && /^\d+$/.test(parts[1])) {
      const d = (state.byChrom.get(parts[0]) || []).find((x) => x.sv_index === +parts[1]);
      if (d) openPanel(d, true);
    }
  } else {
    renderOverview();
  }
  if (toTop) scrollTo(0, 0);
}

function go(target) {
  if (!target) return;
  if (target.find) location.hash = "#/find/" + encodeURIComponent(target.find);
  else if (target.sv_index != null) location.hash = `#/${target.chrom}/${target.sv_index}`;
  else if (target.chrom) location.hash = "#/" + target.chrom;
}

// ------------------------------------------------------------------ boot

/**
 * The catalog ships COLUMNAR - one array per field - because 21 key names repeated 10,705
 * times was 8.1% of the file. Rebuilt into rows once, here, so everything downstream sees the
 * row objects it always saw.
 *
 * The row form is rejected rather than accepted as an alternative: it would look identical
 * to a stale payload that never went through the new writer, and silently loading one is
 * the failure this change exists to prevent. etl/build_data.py asserts the transpose
 * rebuilds its own rows field by field before it writes anything.
 */
function colRows(c, name) {
  if (!c || !Array.isArray(c.columns) || !Array.isArray(c.data)) {
    throw new Error(`${name} must be columnar; rebuild it with etl/build_data.py`);
  }
  const { columns, data } = c;
  const n = c.rows;
  if (data.length !== columns.length || data.some((col) => col.length !== n)) {
    throw new Error(`${name} is ragged: ${columns.length} columns, ${data.length} arrays`
      + `, lengths ${[...new Set(data.map((col) => col.length))].join("/")} against ${n} rows`);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (let k = 0; k < columns.length; k++) r[columns[k]] = data[k][i];
    out[i] = r;
  }
  return out;
}

async function boot() {
  const base = import.meta.env.BASE_URL || "/";
  const j = async (n) => {
    const r = await fetch(base + "data/" + n);
    if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
    return r.json();
  };
  // ancestry and tracks are supplementary: the browser is still correct without them, so a
  // missing one degrades that section rather than failing the whole load.
  const opt = (n) => j(n).catch(() => null);
  const [chroms, catalogCols, layers, meta, ancestry, tracks, ld, hapIndex] =
    await Promise.all([
    j("chromosomes.json"), j("catalog.json"), j("layers.json"), j("meta.json"),
    opt("ancestry.json"), opt("tracks.json"), opt("ld.json"), opt("hap_index.json")]);

  // Rebuilt here, at the destructure, rather than where it is assigned to state: three later
  // lines in this function use `catalog` directly, and binding the rows to that name leaves
  // no columnar value in scope for one of them to reach.
  const catalog = colRows(catalogCols, "catalog.json");

  state.chroms = chroms;
  state.catalog = catalog;
  state.layers = layers;
  state.meta = meta;
  state.tracks = tracks;
  state.ld = ld;
  state.hapIndex = hapIndex;
  (meta.layers || []).forEach((l) => state.layerMeta.set(l.key, l));
  // Columnar since 2026-09-01: this went from 204 rows to 1,530 - every cell in every
  // stratum, blanks included, because a blank now carries a reason worth drawing.
  (ancestry ? colRows(ancestry, "ancestry.json") : []).forEach((r) => {
    const k = r.sv_locus + "|" + r.phecode;
    if (!state.ancBySv.has(k)) state.ancBySv.set(k, []);
    state.ancBySv.get(k).push(r);
  });

  catalog.forEach((d) => {
    if (!state.byChrom.has(d.chrom)) state.byChrom.set(d.chrom, []);
    state.byChrom.get(d.chrom).push(d);
  });
  layers.forEach((h) => {
    const k = h.chrom + ":" + h.sv_index;
    if (!state.hitsBySv.has(k)) state.hitsBySv.set(k, []);
    state.hitsBySv.get(k).push(h);
  });
  // primary first inside each SV, so the panel reads strongest-evidence-down
  state.hitsBySv.forEach((v) =>
    v.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "primary" ? -1 : 1)));
  state.fstSorted = catalog.map((d) => d.fst).filter((v) => v != null).sort((a, b) => a - b);

  // The hash carries location, the query carries what is shown - both floors, the analysis
  // selection, the dip mode, the LD panel, the region labels and the significance tier - so
  // that a link carries the view it was written about. readFilterUrl reads all of it.
  readFilterUrl();
  state.passes = passes;   // search.js filters through the app's own predicate, not a copy
  recomputeEvidence();

  search = mountSearch(document.getElementById("searchmount"), state, go);

  const built = (meta.layers || []).filter((l) => l.present).length;
  document.getElementById("provenance").innerHTML =
    `${fmtInt(catalog.length)} SVs · ${built}/${(meta.layers || []).length} analyses · ` +
    `analysis commit <code>${esc(meta.source_commit)}</code>`;

  // Read the query string again, not only at boot. Every display control writes it with
  // replaceState, so Back restored the ADDRESS while the controls stayed where they were:
  // the address read ?ld=all while the figure drew "SVs only", and `copy link` in the record
  // panel copies location.href, so it handed a colleague a link to a view nobody was looking
  // at. The tier is the one whose change needs the evidence counts rebuilt.
  //
  // BOTH events, because neither alone covers it. Setting location.hash fires hashchange and
  // no popstate. A history traversal fires popstate, and fires hashchange only when the
  // fragment is the ONLY thing that differs - and here it never is, because the display state
  // lives in the query string. Measured: Back from ?ld=sv#/chr1 to ?ld=all#/chr9 fired
  // popstate alone, which is why listening to hashchange changed nothing.
  const navigated = () => {
    if (location.href === navUrl) return;   // the pair, on a fragment-only traversal
    navUrl = location.href;
    const tier = state.tier;
    readFilterUrl();
    if (state.tier !== tier) recomputeEvidence();
    route(true);
  };
  addEventListener("hashchange", navigated);
  addEventListener("popstate", navigated);
  document.body.classList.remove("booting");
  route(true);
}

document.getElementById("theme").onclick = (e) => {
  const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", now);
  e.currentTarget.setAttribute("aria-pressed", now === "dark" ? "true" : "false");
  route();
};

boot().catch((e) => {
  document.body.classList.remove("booting");
  app.replaceChildren(el("div", { class: "notice", html:
    `<b>Could not load the catalog.</b> ${esc(e.message || e)}<br>` +
    "The browser needs its JSON files under <code>/data/</code>. If this is a local " +
    "checkout, run <code>etl/build_data.py</code> first." }));
});
