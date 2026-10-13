/**
 * The cohort reading across all 23, checked against a frame rebuilt from scratch.
 *
 *   node verify_cohort.mjs [CenSV_offline.html | https://.../CenSV/]
 *   CENSV_PW="$(cat ~/.censv_password)" node verify_cohort.mjs https://.../CenSV/
 *
 * The figure lays three quantities on one abscissa: variants binned onto the covered-base
 * fraction of each array's active blocks, and the methylation and dip tracks that are
 * already computed on that fraction. If the walk over the blocks is wrong, all three still
 * draw, the correlations still print, and every number stays plausible - so the only check
 * worth running is one that walks the blocks again, independently, and demands the page
 * print what this file computed.
 *
 * That is what the correlation checks do. They re-merge the CenSat blocks from
 * chromosomes.json, re-bin all 10,691 positions, and recompute Pearson r against
 * tracks.json. A page that binned on linear span instead of covered bases would pass every
 * other check here and fail these on the ten chromosomes whose blocks leave gaps.
 *
 * Two further checks exist because of defects found while building this. The stroke colours
 * were first written as var(--del) and var(--ins), which tokens.css has never defined - the
 * lines would have drawn in the inherited colour with no error anywhere. And the toggle has
 * to REMOVE marks, not draw over them, so the counts are taken before and after.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DATA = process.env.CENSV_DATA || path.join(ROOT, "web/public/data");
const ARG = process.argv[2] || path.join(ROOT, "CenSV_offline.html");
const LIVE = /^https?:/.test(ARG);
const TARGET = LIVE ? ARG : path.resolve(ARG);
const PW = process.env.CENSV_PW || "";
const PORT = 4322, CDP = 9322;
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BANNED = /\b(is not|are not|does not|do not|cannot|rather than|instead of|no longer|absence of|too few)\b/i;
const DELC = "rgb(184,80,30)", INSC = "rgb(47,125,158)";

let bad = 0;
const fail = (m) => { bad++; console.log("FAIL  " + m); };
const pass = (m) => console.log("PASS  " + m);
const sig = (v) => (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(2);
const norm = (s) => String(s).replace(/\u2212/g, "-").replace(/\u00b7/g, "·");

// ----------------------------------------------------------- rebuilt from the payload
const ld = JSON.parse(fs.readFileSync(path.join(DATA, "ld.json"), "utf8"));
const chroms = JSON.parse(fs.readFileSync(path.join(DATA, "chromosomes.json"), "utf8"));
const tracks = JSON.parse(fs.readFileSync(path.join(DATA, "tracks.json"), "utf8"));
const recOf = new Map(chroms.map((c) => [c.chrom, c.arrays || []]));

/** The active blocks a chromosome covers, merged, written out again here. */
function blocksOf(chrom) {
  const out = [];
  for (const a of [...(recOf.get(chrom) || [])].sort((p, q) => p.start - q.start)) {
    const last = out[out.length - 1];
    if (last && a.start <= last.end) last.end = Math.max(last.end, a.end);
    else out.push({ start: a.start, end: a.end });
  }
  return out;
}

function coveredFrac(blocks, pos) {
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

function pearson(a, b) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(b[i])) continue;
    n++; sa += a[i]; sb += b[i];
  }
  if (n < 3) return null;
  const ma = sa / n, mb = sb / n;
  let aa = 0, bb = 0, ab = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(b[i])) continue;
    const da = a[i] - ma, db = b[i] - mb;
    aa += da * da; bb += db * db; ab += da * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
}

const order = Object.keys(ld.chrom).sort((a, b) => {
  const na = +a.slice(3), nb = +b.slice(3);
  if (Number.isNaN(na) || Number.isNaN(nb)) return Number.isNaN(na) ? 1 : -1;
  return na - nb;
});
const mine = new Map();
let placed = 0, total = 0, offFrame = 0;
for (const c of order) {
  const blocks = blocksOf(c);
  const meth = tracks?.meth?.[c] || null;
  const dips = tracks?.density?.[c] || null;
  const nb = (meth && meth.length) || 60;
  const n = new Array(nb).fill(0);
  let hit = 0;
  for (const p of ld.chrom[c].sv.pos) {
    total++;
    const f = coveredFrac(blocks, p);
    if (f == null) { offFrame++; continue; }
    n[Math.min(nb - 1, Math.floor(f * nb))] += 1;
    hit++; placed++;
  }
  mine.set(c, { nb, n, hit, blocks: blocks.length,
    rMeth: meth ? pearson(n, meth) : null, rDips: dips ? pearson(n, dips) : null });
}
const rs = [...mine.values()].map((v) => v.rMeth).filter((x) => x != null)
  .sort((a, b) => a - b);
const med = rs[rs.length >> 1];
const ranked = order.slice().sort((a, b) => mine.get(b).rMeth - mine.get(a).rMeth);
const hiC = ranked[0], loC = ranked[ranked.length - 1];

if (placed === total && offFrame === 0) {
  pass(`all ${total.toLocaleString()} catalogued positions land inside an active block, `
    + `so the covered-base frame loses none of them`);
} else {
  fail(`${offFrame} of ${total} positions fall outside every active block`);
}
const multi = order.filter((c) => mine.get(c).blocks > 1);
if (multi.length >= 2) {
  pass(`${multi.length} chromosomes carry more than one active block (${multi.join(", ")}), `
    + `so the covered walk and a linear span disagree where it matters`);
} else {
  fail(`only ${multi.length} chromosome carries more than one block; the frame check has `
    + `no subject`);
}
pass(`rebuilt here: median r against methylation ${sig(med)}, `
  + `${sig(mine.get(loC).rMeth)} on ${loC} to ${sig(mine.get(hiC).rMeth)} on ${hiC}`);

// ------------------------------------------------------------------ the browser
const server = LIVE ? null : http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(fs.readFileSync(TARGET));
}).listen(PORT);
const ORIGIN = LIVE ? TARGET : `http://localhost:${PORT}/`;
const HOST = new URL(ORIGIN).host;
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-cohort");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1400,2200", "--remote-debugging-port=" + CDP, "--disk-cache-size=1",
  "--user-data-dir=" + PROFILE, ORIGIN + "#/individuals"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => {
  const r = await send("Runtime.evaluate",
    { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " :: "
      + (r.exceptionDetails.exception?.description || "").slice(0, 400));
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

let gated = false;
for (let t = 0; t < 9000; t += 200) {
  gated = await ev(`!!(document.getElementById("gate") && !document.getElementById("gate").hidden)`);
  if (gated) break;
  if (await ev(`!!document.querySelector(".arrlede svg, .grid a.card")`)) break;
  await sleep(200);
}
if (gated) {
  if (!PW) { console.error("this build is encrypted; set CENSV_PW"); process.exit(2); }
  await ev(`(() => { const i = document.getElementById("pw"); i.value = ${JSON.stringify(PW)};
    document.getElementById("form").dispatchEvent(new Event("submit", { cancelable: true })); })()`);
  for (let t = 0; t < 30000; t += 250) {
    if (await ev(`!!document.querySelector(".grid a.card, .arrlede svg")`)) break;
    await sleep(250);
  }
  await ev(`history.replaceState(null, "", location.pathname);
    location.hash = "#/"; location.hash = "#/individuals";`);
}
const waitFig = async () => {
  for (let t = 0; t < 60000; t += 250) {
    if (await ev(`!!document.querySelector(".arrlede .arrfig svg")`)) return true;
    await sleep(250);
  }
  return false;
};
if (!(await waitFig())) {
  fail("the Whole cohort side drew no cohort figure");
  console.log(`\n${bad} failed`);
  process.exit(1);
}

const read = () => ev(`(() => {
  const fig = document.querySelector(".arrlede .arrfig svg");
  const paths = [...fig.querySelectorAll("path")];
  const rowsOf = (sel) => [...fig.querySelectorAll("text")].map(t => t.textContent);
  const gut = [...fig.querySelectorAll("text")].map(t => t.textContent);
  const btns = [...document.querySelectorAll(".arrlede .trackswitch .arrmode")]
    .map(b => ({ label: b.textContent, on: b.getAttribute("aria-pressed") === "true" }));
  return {
    meth: paths.filter(p => (p.getAttribute("stroke")||"").replace(/\\s/g,"") === "rgb(184,80,30)").length,
    dips: paths.filter(p => (p.getAttribute("stroke")||"").replace(/\\s/g,"") === "rgb(47,125,158)").length,
    bars: fig.querySelectorAll("rect").length,
    texts: gut,
    btns,
    note: (document.querySelector(".arrlede .note")||{}).textContent || "",
    eyebrow: (document.querySelector(".arrlede .arrbar .eyebrow.num")||{}).textContent || "",
    q: location.search,
    lede: document.querySelectorAll(".arrlede .arrfig svg").length,
    strokes: [...new Set(paths.map(p => (p.getAttribute("stroke")||"none").replace(/\\s/g,"")))],
  };
})()`);

let s = await read();

// 1. the default draws all three
if (s.meth === order.length && s.dips === order.length && s.btns.length === 2
    && s.btns.every((b) => b.on)) {
  pass(`the cohort figure opens with all three: ${s.meth} methylation lines, `
    + `${s.dips} dip lines, and both switches on`);
} else {
  fail(`opened with ${s.meth} methylation and ${s.dips} dip lines over ${order.length} `
    + `rows, switches ${JSON.stringify(s.btns)}`);
}

// 2. the stroke colours resolve. var(--del) would leave no rgb() here at all.
if (s.strokes.includes("rgb(184,80,30)") && s.strokes.includes("rgb(47,125,158)")) {
  pass(`both track colours resolve to real values (${s.strokes.filter(x => x !== "none").join(", ")})`);
} else {
  fail(`the track strokes are ${JSON.stringify(s.strokes)}; a var() the tokens never `
    + `defined would read like this`);
}

// 3. the count it prints is the count that was placed
const eyeN = +(norm(s.eyebrow).match(/([\d,]+)\s+variants/) || [])[1]?.replace(/,/g, "");
if (eyeN === placed) {
  pass(`the figure prints ${placed.toLocaleString()} variants, the number placed on the `
    + `frame here`);
} else {
  fail(`the figure prints ${eyeN} variants against ${placed} placed here`);
}

// 4. the sentence carries the median and both extremes, as computed here
const note = norm(s.note);
const wantMed = sig(med), wantLo = sig(mine.get(loC).rMeth), wantHi = sig(mine.get(hiC).rMeth);
if (note.includes(wantMed) && note.includes(wantLo) && note.includes(loC)
    && note.includes(wantHi) && note.includes(hiC)) {
  pass(`the caption reads back the median ${wantMed} and both ends, ${wantLo} on ${loC} `
    + `and ${wantHi} on ${hiC}, all recomputed here`);
} else {
  fail(`the caption "${note.slice(0, 150)}" misses one of ${wantMed}, ${wantLo} ${loC}, `
    + `${wantHi} ${hiC}`);
}

// 5. every row's own pair of correlations, against the rebuild
const rowvals = await ev(`(() => {
  const t = [...document.querySelectorAll(".arrlede .arrfig svg text")].map(e => ({
    x: +e.getAttribute("x"), y: +e.getAttribute("y"), s: e.textContent }));
  const byY = new Map();
  for (const e of t) { if (!byY.has(e.y)) byY.set(e.y, []); byY.get(e.y).push(e); }
  return [...byY.values()].map(g => g.sort((a, b) => a.x - b.x).map(e => e.s))
    .filter(g => /^chr(\\d+|X)$/.test(g[0]));
})()`);
let rowBad = [];
for (const g of rowvals) {
  const c = g[0], m = mine.get(c);
  if (!m) { rowBad.push(c + " unknown"); continue; }
  const got = g.map(norm);
  if (!got.includes(sig(m.rMeth))) rowBad.push(`${c} meth ${got[2]} vs ${sig(m.rMeth)}`);
  if (!got.includes(sig(m.rDips))) rowBad.push(`${c} dips ${got[3]} vs ${sig(m.rDips)}`);
}
if (rowvals.length === order.length && !rowBad.length) {
  pass(`all ${order.length} rows print both correlations, and every one matches the `
    + `frame rebuilt here`);
} else {
  fail(`${rowvals.length} rows read, ${rowBad.length} disagree: ${rowBad.slice(0, 4).join("; ")}`);
}

// 6. the rows are ordered by the correlation they print
const drawn = rowvals.map((g) => g[0]);
if (JSON.stringify(drawn) === JSON.stringify(ranked)) {
  pass(`rows run in order of that correlation, ${drawn[0]} down to ${drawn[drawn.length - 1]}`);
} else {
  fail(`row order ${drawn.slice(0, 4).join(",")}… against ${ranked.slice(0, 4).join(",")}…`);
}

// 7. turning methylation off REMOVES it, and says so in the address
const click = async (label) => {
  await ev(`[...document.querySelectorAll(".arrlede .trackswitch .arrmode")]
    .find(b => b.textContent === ${JSON.stringify(label)}).click()`);
  await sleep(140);
  return read();
};
const bars0 = s.bars;
s = await click("methylation");
if (s.meth === 0 && s.dips === order.length && s.bars === bars0
    && s.q.includes("trk=d") && s.lede === 1) {
  pass(`turning methylation off removes all ${order.length} of its lines, keeps the `
    + `${order.length} dip lines and every bar, and the address reads trk=d`);
} else {
  fail(`after turning methylation off: ${s.meth} methylation, ${s.dips} dips, `
    + `${s.bars} rects against ${bars0}, query "${s.q}", ${s.lede} figures`);
}
if (!norm(s.note).includes("r meth") && !s.texts.includes("r meth")) {
  pass(`the r meth column leaves with its track`);
} else {
  fail(`the r meth column is still drawn with the track off`);
}

// 8. both off leaves the variants alone
s = await click("dip density");
if (s.meth === 0 && s.dips === 0 && s.bars === bars0 && s.q.includes("trk=none")) {
  pass(`both off leaves the bars alone, ${s.bars} of them, and the address reads trk=none`);
} else {
  fail(`both off: ${s.meth}/${s.dips} lines, ${s.bars} rects against ${bars0}, "${s.q}"`);
}

// 9. back on, and the address returns to carrying nothing
s = await click("methylation");
s = await click("dip density");
if (s.meth === order.length && s.dips === order.length && s.bars === bars0
    && !s.q.includes("trk") && s.lede === 1) {
  pass(`both back on restores ${s.meth} and ${s.dips} lines with no redraw left over, `
    + `and the default leaves the address clean`);
} else {
  fail(`restored to ${s.meth}/${s.dips} lines, ${s.bars} rects, "${s.q}", ${s.lede} figures`);
}

// 10. the address alone sets the state on a cold load
await ev(`history.replaceState(null, "", "?trk=none"); location.hash = "#/";
  location.hash = "#/individuals";`);
await waitFig();
s = await read();
if (s.meth === 0 && s.dips === 0 && s.btns.every((b) => !b.on)) {
  pass(`arriving at ?trk=none opens with both tracks off, so the address carries the state`);
} else {
  fail(`?trk=none opened with ${s.meth}/${s.dips} lines and switches `
    + `${JSON.stringify(s.btns)}`);
}

// 11. it belongs to one side of the switch
await ev(`history.replaceState(null, "", "?axis=genome"); location.hash = "#/";
  location.hash = "#/individuals";`);
for (let t = 0; t < 30000; t += 250) {
  if (await ev(`!!document.querySelector(".arrfig svg")`)) break;
  await sleep(250);
}
await sleep(200);
const onGenome = await ev(`({
  lede: document.querySelectorAll(".arrlede .arrfig svg").length,
  fig: document.querySelectorAll(".arrfig svg").length,
  axis: (document.querySelector(".axisswitch .arrmode.on")||{}).textContent || "" })`);
if (onGenome.lede === 0 && onGenome.fig >= 1 && onGenome.axis === "Whole genome") {
  pass(`the cohort figure belongs to Whole cohort alone; Whole genome draws its own `
    + `figure and none of this one`);
} else {
  fail(`on Whole genome: ${onGenome.lede} cohort figures, ${onGenome.fig} total, `
    + `axis "${onGenome.axis}"`);
}

// 12. the copy stays affirmative
await ev(`history.replaceState(null, "", location.pathname); location.hash = "#/";
  location.hash = "#/individuals";`);
await waitFig();
const copy = await ev(`(() => {
  const n = document.querySelector(".arrlede");
  return n ? n.textContent.replace(/\\s+/g, " ") : "";
})()`);
const hit = copy.match(BANNED);
if (!hit) pass(`register is affirmative throughout the new copy (${copy.length} characters)`);
else fail(`the new copy carries "${hit[0]}"`);

if (errs.length) fail(`${errs.length} console error(s): ${errs.slice(0, 3).join(" | ")}`);
else console.log(`\nconsole errors: 0`);

console.log(bad ? `\n${bad} failed` : `\nthe cohort figure reads the frame it claims`);
chrome.kill();
if (server) server.close();
process.exit(bad ? 1 : 0);
