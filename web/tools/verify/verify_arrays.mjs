/**
 * Does the painted-array page read the individual it names?
 *
 * The failure this exists for is silent by construction. ld.json ships one genotype column
 * per individual and, until this feature, no way to say which; chr13 carries 182 of the 188,
 * so a view resolving a column by POSITION reads six people's genotypes under their
 * neighbours' names from chr13 onward, and every number on the page stays plausible.
 *
 * So the arithmetic here is deliberately NOT the page's. This file decodes the two-bit
 * payload again, from scratch, bins it again, and then drives the page to the same
 * individual and requires the caption to print the number this file computed. Two
 * implementations agreeing on a name-resolved count is evidence; the page checking itself
 * would be a restatement.
 *
 * The second failure it catches is geometric: 356 of the 10,691 variants sit outside the
 * active array they belong to, so a row drawn on the active bounds alone loses them.
 *
 * usage:                          node verify_arrays.mjs [built.html]
 *        CENSV_PW="$(cat ~/.censv_password)" node verify_arrays.mjs https://.../CenSV/
 *
 * A URL target drives the published copy through its password gate, which is the only way
 * to check the bytes a reader receives; a file target is served over http://localhost
 * rather than opened from disk, so the page runs under the origin rules it will live under.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
// The payload checks run anywhere. The page checks need Chrome, which lives on the
// workstation and not on the cluster, so both halves accept a directory and a file.
const DATA = process.env.CENSV_DATA || path.join(ROOT, "web/public/data");
const ARG = process.argv[2] || path.join(ROOT, "CenSV_offline.html");
const LIVE = /^https?:/.test(ARG);
const TARGET = LIVE ? ARG : path.resolve(ARG);
const PW = process.env.CENSV_PW || "";
const PORT = 4321, CDP = 9321;
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BANNED = /\b(is not|are not|does not|do not|cannot|rather than|instead of|no longer|absence of|too few)\b/i;
const BIN = 25000;

let bad = 0;
const fail = (m) => { bad++; console.log("FAIL  " + m); };
const pass = (m) => console.log("PASS  " + m);

// ------------------------------------------------------------------ the payload, decoded
const ld = JSON.parse(fs.readFileSync(path.join(DATA, "ld.json"), "utf8"));
const hap = JSON.parse(fs.readFileSync(path.join(DATA, "hap_index.json"), "utf8"));

/** Two bits per call, the pair read back reversed. Written out again, not imported. */
const PAIR = [0, 2, 1, 3];
function decode(b64, nrow, m) {
  const s = Buffer.from(b64, "base64");
  const out = new Uint8Array(nrow * m);
  for (let cell = 0; cell < nrow * m; cell++) {
    out[cell] = PAIR[(s[cell >> 2] >> (6 - ((cell & 3) << 1))) & 3];
  }
  return out;
}

// ---- 1. every column is named, once, by somebody who exists
{
  const problems = [];
  const n = (ld.samples || []).length;
  if (!Array.isArray(ld.samples) || !n) problems.push("ld.samples is absent");
  if (new Set(ld.samples || []).size !== n) problems.push("a name is shipped twice");
  const known = new Set((hap.samples || []).map((x) => x.s));
  const strangers = (ld.samples || []).filter((s) => !known.has(s));
  if (strangers.length) problems.push(`${strangers.length} named individuals are absent from hap_index (${strangers.slice(0, 3)})`);
  let widest = 0;
  for (const [c, f] of Object.entries(ld.chrom)) {
    if (!f.cols) { problems.push(`${c} ships no cols`); continue; }
    if (f.cols.length !== f.n_samples) problems.push(`${c}: ${f.cols.length} cols against n_samples ${f.n_samples}`);
    if (f.cols.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) problems.push(`${c} indexes outside the cohort`);
    if (new Set(f.cols).size !== f.cols.length) problems.push(`${c} names one individual twice`);
    widest = Math.max(widest, f.cols.length);
  }
  if (widest !== n) problems.push(`the widest frame holds ${widest} of ${n}`);
  const partial = Object.fromEntries(Object.entries(ld.chrom)
    .filter(([, f]) => f.cols && f.cols.length !== n).map(([c, f]) => [c, f.cols.length]));
  if (problems.length) fail("shipped columns: " + problems.slice(0, 5).join(" | "));
  else pass(`ld.json names ${n} individuals, every frame indexes into them, and ` +
    `${JSON.stringify(partial)} carries fewer`);
}

// ---- 2. the decode lands on the panel's own shape
//
// An identity against the shipped `maf` was the obvious check and it is the wrong one:
// `sv.maf` is measured over the 196-individual assembly cohort while `gt` holds the 188
// those cohorts share with 1000 Genomes, so the two differ by design - 1,658 of chr19's
// 2,007 rows by more than 1e-3, and the worst by 1.5e-2, with the allele COUNTS agreeing
// wherever the eight extra individuals carry nothing. Measured, not assumed: the decoded
// matrix was compared cell for cell against the upstream frame and matched exactly.
//
// What does discriminate a bad decode is the panel's shape. A wrong bit order puts state 3
// into an SV block that has none, and a wrong column width shifts every row, which moves a
// carrier floor that sits at exactly 10 by construction.
{
  const problems = [];
  let floor = Infinity, atFloor = 0, mono = 0, three = 0, n = 0;
  const decoded = [], shipped = [];
  for (const [c, f] of Object.entries(ld.chrom)) {
    const d = decode(f.gt, f.n_sv + f.n_snp, f.n_samples);
    for (let r = 0; r < f.n_sv; r++) {
      let alt = 0, carriers = 0;
      for (let k = 0; k < f.n_samples; k++) {
        const v = d[r * f.n_samples + k];
        if (v === 3) three += 1;
        else { alt += v; if (v) carriers += 1; }
      }
      if (!carriers) { mono += 1; if (problems.length < 3) problems.push(`${c} ${f.sv.sv_id[r]} has no carrier`); }
      if (carriers < floor) { floor = carriers; atFloor = 0; }
      if (carriers === floor) atFloor += 1;
      const af = alt / (2 * f.n_samples);
      decoded.push(Math.min(af, 1 - af));      // `sv.maf` is folded; compare like with like
      shipped.push(f.sv.maf[r]); n += 1;
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const [ma, mb] = [mean(decoded), mean(shipped)];
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const u = decoded[i] - ma, v = shipped[i] - mb;
    sab += u * v; sa += u * u; sb += v * v;
  }
  const r = sab / Math.sqrt(sa * sb);
  if (three) problems.push(`${three} SV calls decode to the open state, which the SV block has none of`);
  if (floor !== 10) problems.push(`the carrier floor sits at ${floor}, where the panel was built at 10`);
  if (r < 0.99) problems.push(`decoded frequency correlates with the shipped MAF at r = ${r.toFixed(4)}`);
  if (problems.length) fail("decoded payload: " + problems.slice(0, 4).join(" | "));
  else pass(`${n} SV rows decode to whole dosages, every one carried, the floor at exactly ` +
    `${floor} carriers on ${atFloor} rows, and frequency tracking the shipped MAF at r = ${r.toFixed(4)}`);
}

// ---- 3. geometry: the drawn span holds every variant and covers the active array
const geom = [];
{
  const problems = [];
  let outside = 0, nsv = 0, span = 0, active = 0;
  for (const [c, f] of Object.entries(ld.chrom)) {
    let lo = f.active_start, hi = f.active_end;
    for (const p of f.sv.pos) { if (p < lo) lo = p; if (p > hi) hi = p; }
    if (lo > f.active_start || hi < f.active_end) problems.push(`${c} span excludes its active array`);
    const out = f.sv.pos.filter((p) => p < f.active_start || p > f.active_end).length;
    outside += out; nsv += f.n_sv; span += hi - lo; active += f.active_end - f.active_start;
    geom.push({ chrom: c, lo, hi, nb: Math.max(1, Math.ceil((hi - lo) / BIN)), f, out });
  }
  if (problems.length) fail("array geometry: " + problems.join(" | "));
  else pass(`${outside} of ${nsv} variants sit beyond an active array, so the drawn span ` +
    `runs to ${(span / 1e6).toFixed(2)} Mb against ${(active / 1e6).toFixed(2)} Mb of active array`);
}

/** One individual's carried total, resolved by NAME on every array. Independent of the page. */
function carriedOf(who) {
  const at = ld.samples.indexOf(who);
  let total = 0, del = 0, other = 0;
  const missing = [];
  for (const g of geom) {
    const col = g.f.cols.indexOf(at);
    if (col < 0) { missing.push(g.chrom); continue; }
    const d = decode(g.f.gt, g.f.n_sv + g.f.n_snp, g.f.n_samples);
    for (let r = 0; r < g.f.n_sv; r++) {
      if (!d[r * g.f.n_samples + col]) continue;
      total += 1;
      if (g.f.sv.svtype[r] === "DEL") del += 1; else other += 1;
    }
  }
  return { total, del, other, missing };
}

// ---- 3b. every drawn array is drawn whole
//
// A row's span used to stop at its last variant, which cut thirteen records short of the
// array they outline - hor_4_1 by 8,047 bp - so an outlined box measured less than the
// length its own hover text gave. The span now grows to cover every record it draws.
{
  const ch = JSON.parse(fs.readFileSync(path.join(DATA, "chromosomes.json"), "utf8"));
  const recOf = Object.fromEntries(ch.map((c) => [c.chrom, c.arrays || []]));
  const problems = [];
  let widened = 0, extra = 0;
  for (const [c, f] of Object.entries(ld.chrom)) {
    let lo = f.active_start, hi = f.active_end;
    for (const p of f.sv.pos) { if (p < lo) lo = p; if (p > hi) hi = p; }
    const before = hi - lo;
    for (let pass = 0; pass < 4; pass++) {
      let lo2 = lo, hi2 = hi;
      for (const a of recOf[c] || []) {
        if (a.end > lo && a.start < hi) { lo2 = Math.min(lo2, a.start); hi2 = Math.max(hi2, a.end); }
      }
      if (lo2 === lo && hi2 === hi) break;
      lo = lo2; hi = hi2;
    }
    if (hi - lo > before) { widened += 1; extra += (hi - lo) - before; }
    for (const a of recOf[c] || []) {
      if (a.end > lo && a.start < hi && (a.start < lo || a.end > hi)) {
        problems.push(`${c} ${a.name} still reaches outside the span`);
      }
    }
  }
  if (problems.length) fail("clipped records: " + problems.slice(0, 4).join(" | "));
  else pass(`every HOR record a row draws fits inside that row's span; ${widened} rows widen ` +
    `to make room, by ${(extra / 1e3).toFixed(1)} kb in total`);
}

// ---- 4. the page prints the number this file computed, for the individual it names
if (!LIVE && !fs.existsSync(TARGET)) {
  fail("no built page at " + TARGET + "; run infra/pages/build_local.sh");
  process.exit(bad ? 1 : 0);
}
const server = LIVE ? null : http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(fs.readFileSync(TARGET));
}).listen(PORT);
const ORIGIN = LIVE ? TARGET : `http://localhost:${PORT}/`;
const HOST = new URL(ORIGIN).host;
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-arrays");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1400,2000", "--remote-debugging-port=" + CDP, "--disk-cache-size=1",
  "--user-data-dir=" + PROFILE, ORIGIN + "?axis=genome#/individuals"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => {
  const r = await send("Runtime.evaluate",
    { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " :: " +
      (r.exceptionDetails.exception?.description || "").slice(0, 400));
  }
  return r.result.value;
};
for (let i = 0; i < 240; i++) {
  const t = await fetch("http://127.0.0.1:" + CDP + "/json").then((r) => r.json(), () => null);
  const p = t && t.find((x) => x.type === "page" && x.url.includes(HOST));
  if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  await sleep(250);
}
if (!ws) { console.error("chrome did not come up"); process.exit(2); }
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push(m.params.exceptionDetails.exception?.description
      || m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errs.push(m.params.args.map((a) => a.description || a.value).join(" "));
  }
};
await new Promise((r) => { ws.onopen = r; if (ws.readyState === 1) r(); });
await send("Page.enable"); await send("Runtime.enable");
console.log(LIVE ? `\ndriving ${ORIGIN}` : `\ndriving ${TARGET}`);

// The published build raises a password gate once its script has armed the form; the open
// build never does. Both are legitimate targets, so which one this is decides whether a
// password is typed at all.
let gated = false;
for (let t = 0; t < 9000; t += 200) {
  gated = await ev(`!!(document.getElementById("gate") && !document.getElementById("gate").hidden)`);
  if (gated) break;
  if (await ev(`!!document.querySelector(".arrfig svg, .grid a.card")`)) break;
  await sleep(200);
}
if (gated) {
  if (!PW) { console.error("this build is encrypted; set CENSV_PW"); process.exit(2); }
  await ev(`(() => { const i = document.getElementById("pw"); i.value = ${JSON.stringify(PW)};
    document.getElementById("form").dispatchEvent(new Event("submit", { cancelable: true })); })()`);
  // the gate replaces the document, so the route has to be asked for again
  for (let t = 0; t < 30000; t += 250) {
    if (await ev(`!!document.querySelector(".grid a.card, .arrfig svg")`)) break;
    await sleep(250);
  }
  await ev(`history.replaceState(null, "", "?axis=genome");
    location.hash = "#/"; location.hash = "#/individuals";`);
}
for (let t = 0; t < 60000; t += 250) {
  if (await ev(`!!document.querySelector(".arrfig svg")`)) break;
  await sleep(250);
}
if (!(await ev(`!!document.querySelector(".arrfig svg")`))) {
  fail(gated ? "the password opened the site and #/arrays drew nothing"
             : "#/arrays drew nothing");
}

const drew = await ev(`(() => {
  const f = document.querySelector(".arrfig svg");
  return { marks: f ? f.querySelectorAll("rect, line, text").length : -1,
           modes: document.querySelectorAll(".paintswitch .arrmode").length,
           axes: [...document.querySelectorAll(".axisswitch .arrmode")].map(b => b.textContent),
           axisOn: (document.querySelector(".axisswitch .arrmode.on")||{}).textContent || "",
           heading: (document.querySelector("h1")||{}).textContent || "",
           opts: document.querySelectorAll(".arrpick option").length };
})()`);
if (drew.marks < 200) fail(`the painted figure drew ${drew.marks} marks`);
else if (drew.modes !== 2) fail(`${drew.modes} paint readings are offered, expected 2`);
else if (drew.axes.join("|") !== "Whole cohort|Whole genome") fail(`the axis switch reads ${JSON.stringify(drew.axes)}`);
else if (drew.axisOn !== "Whole genome") fail(`the axis switch opened on "${drew.axisOn}"`);
else if (/Arrays by individual|Individual arrays/.test(drew.heading)) fail(`the heading "${drew.heading}" names one of the two readings`);
else if (drew.opts !== ld.samples.length) fail(`the picker lists ${drew.opts} of ${ld.samples.length} individuals`);
else pass(`under the heading "${drew.heading}" the axis switch offers ${JSON.stringify(drew.axes)} ` +
  `with "${drew.axisOn}" on; the figure draws ${drew.marks} marks and lists all ${drew.opts} individuals`);

// three individuals, one of them among those with no chr13 assembly
const shortest = Object.entries(ld.chrom)
  .sort((a, b) => a[1].cols.length - b[1].cols.length)[0];
const absentee = ld.samples.find((s, i) => !shortest[1].cols.includes(i));
const caption = async () =>
  ev(`(document.querySelector(".arrfig ~ .note")||{}).textContent || ""`);
for (const who of [ld.samples[0], ld.samples[94], absentee].filter(Boolean)) {
  const want = carriedOf(who);
  await ev(`(() => { const s = document.querySelector(".arrpick select");
    s.value = ${JSON.stringify(who)}; s.dispatchEvent(new Event("change")); })()`);
  await sleep(650);
  const c = await caption();
  const n = want.total.toLocaleString("en-US");
  if (!c.includes(who)) fail(`the caption skips ${who}: "${c.slice(0, 90)}"`);
  else if (!c.includes(n)) fail(`${who} carries ${n} by an independent count; the caption reads "${c.slice(0, 130)}"`);
  else if (!c.includes(want.del.toLocaleString("en-US"))) fail(`${who}'s deletion count ${want.del} is absent from the caption`);
  else {
    pass(`${who}: the page prints ${n} carried and ${want.del} deletions, matching a ` +
      `count decoded here` + (want.missing.length ? ` (no ${want.missing.join(", ")} assembly)` : ""));
  }
}

// the reading toggle has to change the picture, or it is decorative
const before = await caption();
await ev(`[...document.querySelectorAll(".paintswitch .arrmode")].find(b => !b.classList.contains("on")).click()`);
await sleep(600);
const after = await caption();
if (before === after || !after) fail("switching the reading left the caption unchanged");
else pass(`switching the reading rewrites the caption — "${after.slice(0, 84).trim()}…"`);

// the point of the layout: every active array begins at the same x. Beyond that, the
// three treatments have to be distinguishable, and a dash pattern that cannot resolve is
// the defect this replaced - four records rendered at or under 1.5 px, where "3 2" draws
// as a tick on the neighbouring box. So: no dash is used below 3 px, ever.
const align = await ev(`(() => {
  const svg = document.querySelector(".arrfig svg");
  const vb = svg.getAttribute("viewBox").split(" ").map(Number);
  const scale = svg.getBoundingClientRect().width / vb[2];
  const boxes = [...svg.querySelectorAll("rect")].filter(r => r.getAttribute("fill") === "none");
  const dashed = boxes.filter(r => r.getAttribute("stroke-dasharray") === "3 2");
  const solid = boxes.filter(r => !r.getAttribute("stroke-dasharray"));
  const kindOf = (r) => ((r.querySelector("title") || {}).textContent || "").split(" · ")[2] || "";
  const active = solid.filter(r => /the active array/.test(kindOf(r)));
  const xs = [...new Set(active.map(r => Math.round(+r.getAttribute("x") * 10) / 10))];
  const ticks = [...svg.querySelectorAll("line")].filter(l =>
    l.getAttribute("stroke") === "var(--text-muted)" && l.getAttribute("stroke-width") === "0.7");
  const gaps = [...svg.querySelectorAll("text")].filter(t => t.textContent === "no assembly").length;
  return {
    nActive: active.length, distinctX: xs, gaps, ticks: ticks.length,
    nDashed: dashed.length,
    dashedMinPx: dashed.length ? +Math.min(...dashed.map(r => +r.getAttribute("width") * scale)).toFixed(1) : null,
    nJoined: solid.filter(r => /continuing from the active one/.test(kindOf(r))).length,
    kinds: [...new Set(boxes.map(kindOf))].filter(Boolean).length,
    who: (document.querySelector(".arrpick select") || {}).value || "",
  };
})()`);
if (align.distinctX.length !== 1) {
  fail(`the ${align.nActive} active arrays start at ${align.distinctX.length} different x positions: ${align.distinctX.slice(0, 5)}`);
} else if (align.nActive + align.gaps !== 23) {
  fail(`${align.nActive} active arrays outlined plus ${align.gaps} unassembled rows, expected 23`);
} else if (align.dashedMinPx !== null && align.dashedMinPx < 3) {
  fail(`a dashed record renders at ${align.dashedMinPx} px, below the width where "3 2" resolves`);
} else if (align.nJoined < 5 || align.ticks < 5) {
  fail(`${align.nJoined} records continue from an active array and ${align.ticks} boundary ticks drawn; seven records share a boundary`);
} else if (align.kinds !== 3) {
  fail(`${align.kinds} kinds of record named on hover, expected 3`);
} else {
  pass(`for ${align.who}, all ${align.nActive} active arrays begin at one x ` +
    `(${align.distinctX[0]})${align.gaps ? `, ${align.gaps} row(s) unassembled` : ""}; ` +
    `${align.nJoined} further arrays continue from one with ${align.ticks} boundary ticks, ` +
    `${align.nDashed} stand apart dashed and none narrower than ${align.dashedMinPx} px`);
}

// the other reading, and the address this page replaced
// the cohort sits beside the switch, which is the control that changes it
const line = async () => ev(`(document.querySelector(".arrbar .eyebrow.num")||{}).textContent || ""`);
const genomeLine = await line();
await ev(`[...document.querySelectorAll(".axisswitch .arrmode")].find(b => !b.classList.contains("on")).click()`);
await sleep(1400);
const cohortLine = await line();
const cohortDrew = await ev(`!!document.querySelector(".haprow, .hapsec, .controls .hapsel")`);
const nInd = ld.samples.length;
if (!cohortDrew) fail("flipping to Whole cohort drew no gallery");
else if (cohortLine === genomeLine) fail(`the cohort line stayed "${cohortLine}" across the switch`);
else if (!genomeLine.includes(String(nInd)) || !cohortLine.includes(String(hap.samples.length))) {
  fail(`the two readings report "${genomeLine}" and "${cohortLine}"; expected ${nInd} and ${hap.samples.length}`);
} else {
  pass(`the switch carries its cohort: Whole genome reads "${genomeLine.trim()}", ` +
    `Whole cohort reads "${cohortLine.trim()}"`);
}

await ev(`location.hash = "#/arrays/" + ${JSON.stringify(ld.samples[3])}`);
await sleep(1400);
const back = await ev(`(() => ({ fig: !!document.querySelector(".arrfig svg"),
  who: (document.querySelector(".arrpick select")||{}).value || "",
  hash: location.hash, q: location.search }))()`);
if (!back.fig || back.who !== ld.samples[3]) {
  fail(`the old #/arrays address landed on ${JSON.stringify(back)}`);
} else {
  pass(`the retired #/arrays/<individual> address still opens ${back.who} on the painted ` +
    `reading, now at ${back.hash}${back.q}`);
}

// the side the page lands on has to be the side the switch opens with, or the control
// contradicts the view underneath it on first sight
await ev(`history.replaceState(null, "", location.pathname);
  location.hash = "#/"; location.hash = "#/individuals";`);
await sleep(1600);
const landed = await ev(`(() => {
  const b = [...document.querySelectorAll(".axisswitch .arrmode")];
  return { first: (b[0]||{}).textContent || "", on: (b.find(x => x.classList.contains("on"))||{}).textContent || "",
           gallery: !!document.querySelector(".haprow, .hapsec, .controls .hapsel"),
           line: (document.querySelector(".arrbar .eyebrow.num")||{}).textContent || "" };
})()`);
if (landed.on !== "Whole cohort" || landed.first !== "Whole cohort") {
  fail(`#/individuals with no axis opens on "${landed.on}" while the switch starts at "${landed.first}"`);
} else if (!landed.gallery) {
  fail("#/individuals with no axis selected Whole cohort and drew no gallery");
} else {
  pass(`#/individuals with no axis opens on the leftmost side, Whole cohort, reading ` +
    `"${landed.line.trim()}"`);
}

const words = await ev(`[...document.querySelectorAll("h1, .note, .arrkey, .pnote, .eyebrow")]
  .map(e => e.textContent).join(" ")`);
if (BANNED.test(words)) {
  const i = words.search(BANNED);
  fail(`banned register: "${words.slice(Math.max(0, i - 55), i + 55).replace(/\s+/g, " ")}"`);
} else {
  pass("register is affirmative throughout");
}

console.log(`\nconsole errors: ${errs.length}`);
errs.slice(0, 4).forEach((e) => console.log("      " + String(e).split("\n")[0].slice(0, 150)));
if (errs.length) bad++;
console.log(bad ? `\n${bad} problem(s)` : "\nthe painted arrays read the individual they name");
try { chrome.kill(); } catch { /* already gone */ }
if (server) server.close();
process.exit(bad ? 1 : 0);
