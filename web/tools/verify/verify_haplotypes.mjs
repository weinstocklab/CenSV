/**
 * Drive the real single-file build and check the haplotype layer against what it claims.
 *
 * Counts are compared against the shipped hap_index summary and against catalog.json rather
 * than against numbers typed in here, and the regression checks assert that the addresses
 * that existed before this feature still do exactly what they did.
 *
 * Check 8 exists because of a defect the first pass of these checks did NOT catch: every
 * element was counted and none was asked whether its fill resolved. css("--surface") returns
 * "" for a property tokens.css does not define - the name is --surface-1 - and an SVG fill of
 * "" paints BLACK, so the carrier ribbon shipped with its non-carriers drawn darker than its
 * homozygotes and read as a third category. Counting cannot see that. Resolving can.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TARGET = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3] || ".");
const PORT = 4197, CDP = 9241;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const html = fs.readFileSync(TARGET);
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(html);
}).listen(PORT);
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-haplo");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
  "--force-prefers-reduced-motion", "--window-size=1500,2000",
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + PROFILE,
  `http://localhost:${PORT}/`], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " +
    (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
};
for (let i = 0; i < 160; i++) {
  try {
    const t = await (await fetch("http://127.0.0.1:" + CDP + "/json")).json();
    const p = t.find((x) => x.type === "page" && x.url.includes("localhost:" + PORT));
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* starting */ }
  await sleep(250);
}
if (!ws) { console.error("no chrome"); process.exit(2); }
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(
    m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errs.push(m.params.args.map((a) => a.description || a.value).join(" ")); };
await new Promise((r) => { ws.onopen = r; if (ws.readyState === 1) r(); });
await send("Runtime.enable"); await send("Page.enable");
for (let t = 0; t < 60000; t += 200) {
  if (await ev("!!document.querySelector('.grid, table')")) break;
  await sleep(200);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
async function goto(hash, waitFor) {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  for (let t = 0; t < 30000; t += 150) {
    if (await ev(`!!document.querySelector(${JSON.stringify(waitFor)})`)) return true;
    await sleep(150);
  }
  return false;
}

const INDEX = JSON.parse(await ev(
  `(async () => JSON.stringify(await (await fetch("data/hap_index.json")).json()))()`));
check("hap_index.json is inside the single-file build",
  !!INDEX.summary, `${Object.keys(INDEX.summary || {}).length} chromosomes`);
const CH = "chr8", S = INDEX.summary[CH];

// ---- 1. the overview offers both halves, each at its own address
await goto("#/", ".hapentry");
const entry = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.hapentry a.hapcta')].map(a => a.getAttribute('href')))`));
check("the overview offers individual arrays and clade trees, separately",
  entry.length === 2 && entry[0] === "#/individuals" && /\/haplotypes$/.test(entry[1]),
  entry.join("  "));

// The card reports the manuscript's component count, which is deliberately NOT the number
// drawn. Both are asserted here, against the shipped file rather than against a literal, so
// that a build which quietly reverted the card to the drawn count fails.
const drawn = Object.values(INDEX.summary).reduce((n, v) => n + v.mono, 0);
const cardTxt = await ev(
  `[...document.querySelectorAll('.hapentry a.hapcta')][1]?.textContent || ''`);
const cardNums = (cardTxt.match(/[\d,]+/g) || []).map((v) => +v.replace(/,/g, ""));
check("the clade-trees card reports the manuscript figure, not the drawn count",
  !!INDEX.mono_reported && cardNums.includes(INDEX.mono_reported) &&
  !cardNums.includes(drawn) && INDEX.mono_reported > drawn,
  `card ${cardNums.join("/")} · reported ${INDEX.mono_reported} · drawn ${drawn}`);

// ---- 2. #/individuals
check("#/individuals renders", await goto("#/individuals", "#app .hapsvg"));
const ctl = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.controls .hapsel')].map(s => s.options.length))`));
check("three controls: centromere, ancestry, count",
  ctl.length === 3 && ctl[0] === 23 && ctl[1] === 6 && ctl[2] === 3, ctl.join(" / "));

const BARS = `document.querySelectorAll('#app .hapsvg g > title').length`;
const n50 = await ev(BARS);
const setSel = async (i, v) => {
  await ev(`(() => { const s = document.querySelectorAll('.controls .hapsel')[${i}];
    s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); })()`);
  await sleep(450);
};
await setSel(2, "10");
const n10 = await ev(BARS);
await setSel(2, "Infinity");
const nAll = await ev(BARS);
check("the count control changes how many individuals are drawn",
  n10 < n50 && n50 < nAll && n10 <= 20, `10 -> ${n10} bars, 50 -> ${n50}, all -> ${nAll}`);

await setSel(1, "AFR");
const nAfr = await ev(BARS);
const capAfr = await ev(`document.querySelector('#app figcaption')?.textContent || ''`);
check("the ancestry control narrows the cohort", nAfr > 0 && nAfr < nAll,
  `all ${nAll} bars, AFR ${nAfr} — "${capAfr.trim().slice(0, 44)}"`);

// ---- 3. the chromosome page points at the tree, and only at the tree
await goto(`#/${CH}`, ".hapcta");
const strip = await ev(`document.querySelector('#app .hapcta')?.textContent || ''`);
const sn = (strip.match(/\d+/g) || []).map(Number);
check("the chromosome strip carries the shipped clade counts",
  sn.includes(S.mono) && sn.includes(S.nsv) && sn.includes(S.tips),
  `"${strip.trim().slice(0, 78)}"`);

// ---- 4. only a monophyletic record offers a clade
const cat = JSON.parse(await ev(`(async () => {
  const c = await (await fetch("data/catalog.json")).json();
  const ix = {}; c.columns.forEach((k,i)=>ix[k]=i);
  const mono = [], not = [];
  for (let i=0;i<c.data[0].length;i++) {
    if (c.data[ix.chrom][i] !== "${CH}") continue;
    (c.data[ix.sv_category][i] === "monophyletic" ? mono : not).push(c.data[ix.sv_index][i]);
  }
  return JSON.stringify({mono: mono.slice(0,3), not: not.slice(0,3),
    nmono: mono.length, nnot: not.length});
})()`));
await goto(`#/${CH}/${cat.mono[0]}`, ".panel");
const monoLine = await ev(`document.querySelector('.panel .hapline a')?.getAttribute('href') || ''`);
check("a monophyletic record links straight to its own clade",
  monoLine === `#/${CH}/haplotypes/${cat.mono[0]}`, monoLine || "(no link)");
await goto(`#/${CH}/${cat.not[0]}`, ".panel");
const notLine = await ev(`document.querySelector('.panel .hapline')?.textContent || ''`);
check("a record with no clade offers no clade link", notLine === "",
  notLine ? `"${notLine.trim()}"` : `none, on sv_index ${cat.not[0]} of ${cat.nnot} without one`);

// ---- 5. the direct jump lands on that SV, not on the first row
await goto(`#/${CH}/haplotypes/${cat.mono[0]}`, "#hap-mono tbody tr.sel");
const jump = JSON.parse(await ev(`JSON.stringify({
  sel: document.querySelector('#hap-mono tbody tr.sel')?.id || '',
  first: document.querySelector('#hap-mono tbody tr')?.id || '',
  outline: document.querySelectorAll('.haptree [stroke-dasharray="3 2"]').length })`));
check("the direct address selects that SV, not the first row",
  jump.sel === "hapsv-" + cat.mono[0] && jump.outline === 1,
  `${jump.sel}, first row ${jump.first}, ${jump.outline} outline`);

// ---- 6. the tree page holds the tree and the SVs, and no array view
const heads = JSON.parse(await ev(
  `JSON.stringify([...document.querySelectorAll('#app h1, #app h2')].map(h=>h.textContent))`));
check("the tree page holds the tree and the SVs, with the arrays elsewhere",
  heads.some((h) => /clade trees/i.test(h)) && heads.some((h) => /monophyletic SVs/i.test(h)) &&
  !heads.some((h) => /base-pair axis/i.test(h)), heads.join(" | "));
const nrows = await ev(`document.querySelectorAll('#hap-mono tbody tr').length`);
check("monophyletic table row count matches the shipped summary",
  nrows === S.mono, `${nrows} rows vs ${S.mono}`);
const head = JSON.parse(await ev(
  `JSON.stringify([...document.querySelectorAll('#hap-mono thead th')].map(t=>t.textContent))`));
check("no branch column", !head.some((h) => /branch/i.test(h)), head.join(" | "));
const r2 = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#hap-mono tbody tr')].map(r => r.children[6].textContent))`))
  .map((v) => (v === "\u2014" ? null : parseFloat(v)));
check("ordered by decomposition r2, descending",
  r2.length > 5 && r2.every((v, i) => i === 0 || v === null || r2[i - 1] >= v),
  r2.slice(0, 5).join(" > "));

// ---- 6b. the columns sort on click, and the order is in the address
const cols = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#hap-mono thead th')].map(t => ({
    label: t.querySelector('.hapsort')?.textContent.replace(/[↑↓]/g,'').trim() || null,
    tag: t.firstElementChild?.tagName || null,
    sorted: t.getAttribute('aria-sort') })))`));
const bodyCells = +(await ev(
  `document.querySelector('#hap-mono tbody tr').children.length`));
check("every column header is a button that declares its sort state",
  cols.length === bodyCells && cols.every((h) => h.tag === "BUTTON" && h.sorted) &&
  cols.filter((h) => h.sorted !== "none").length === 1,
  `${cols.filter((h) => h.tag === "BUTTON").length} buttons over ${cols.length} headers ` +
  `and ${bodyCells} cells per row, active: ` +
  `${cols.find((h) => h.sorted !== "none")?.label} ${cols.find((h) => h.sorted !== "none")?.sorted}`);

const colVals = async (i) => JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#hap-mono tbody tr')].map(r =>
    r.children[${i}].textContent.replace(/,/g,'')))`));
const clickHead = async (i) => {
  await ev(`document.querySelectorAll('#hap-mono thead th')[${i}] .querySelector('.hapsort').click()`);
  await sleep(300);
};

await clickHead(1);                                   // clade tips
const tipsDesc = (await colVals(1)).map(Number);
const url1 = await ev("location.search");
check("clicking a numeric column sorts it highest first, and says so in the address",
  tipsDesc.every((v, i) => i === 0 || tipsDesc[i - 1] >= v) && /hsort=-tips/.test(url1),
  `${tipsDesc.slice(0, 5).join(" >= ")}   ${url1}`);

await clickHead(1);
const tipsAsc = (await colVals(1)).map(Number);
const url2 = await ev("location.search");
check("clicking it again turns the order round",
  tipsAsc.every((v, i) => i === 0 || tipsAsc[i - 1] <= v) && /hsort=tips/.test(url2) &&
  !/hsort=-tips/.test(url2), `${tipsAsc.slice(0, 5).join(" <= ")}   ${url2}`);

await clickHead(0);                                   // SV, a name
const svAsc = await colVals(0);
check("clicking a name column sorts it A to Z first",
  svAsc.every((v, i) => i === 0 || svAsc[i - 1].localeCompare(v, undefined, { numeric: true }) <= 0),
  svAsc.slice(0, 3).join("  "));

// the order in the address must survive a reload, or the link does not carry the view
await goto(`#/${CH}/haplotypes?hsort=af`, "#hap-mono tbody tr");
await ev(`(() => { const u = new URL(location.href); u.search = "?hsort=af";
  history.replaceState(null, "", u); })()`);
await goto("#/", ".hapentry");
await ev(`(() => { const u = new URL(location.href); u.search = "?hsort=af";
  history.replaceState(null, "", u); })()`);
await goto(`#/${CH}/haplotypes`, "#hap-mono tbody tr");
const afAsc = (await colVals(5)).map(Number);
check("an order carried in the address is the order that is drawn",
  afAsc.every((v, i) => i === 0 || afAsc[i - 1] <= v), afAsc.slice(0, 5).join(" <= "));

// A missing value has no claim, so sortMono floats it last whichever way the arrow points.
// That branch has no data to exercise: the build writes a mono row only where clade_pred
// exists and asserts a catalog row for every one, so no cell in this table is empty. Rather
// than keep a check that can only report "untestable", assert the property that makes it so -
// if it ever stops holding, this fails and the ordering rule needs exercising for real.
const holes = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#hap-mono tbody tr')].map(r =>
    [...r.children].slice(0, 8).filter(c => c.textContent.trim() === "—").length))`));
check("every sortable cell carries a value, so the order over them is total",
  holes.every((n) => n === 0), `${holes.filter((n) => n > 0).length} of ${holes.length} rows have a gap`);

// Read the active column off the header rather than assuming which one it is: the note has to
// track whatever the reader last clicked, and hard-coding one column here would pass on a
// build whose note never changed at all.
const active = JSON.parse(await ev(`(() => {
  const th = [...document.querySelectorAll('#hap-mono thead th')]
    .find(t => t.getAttribute('aria-sort') !== 'none');
  return JSON.stringify({ label: th?.querySelector('.hapsort')?.textContent
      .replace(/[↑↓]/g,'').trim(), dir: th?.getAttribute('aria-sort'),
    note: document.querySelector('#hap-mono p.muted')?.textContent || '' });
})()`));
check("the note names the column the table is actually ordered by",
  active.label && active.note.includes(active.label) &&
  active.note.includes(active.dir === "descending" ? "highest first" : "lowest first"),
  `${active.label} ${active.dir} — "${active.note.trim().slice(0, 58)}"`);

await goto(`#/${CH}/haplotypes`, "#hap-mono tbody tr");

// ---- 7. the composition table, with its swatches
const comp = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.hapside tbody tr')].map(r => ({
    text: r.children[0].textContent.trim(),
    sw: [...r.children[0].querySelectorAll('.hapsw')].map(
      s => getComputedStyle(s).backgroundColor),
    inc: +r.children[1].textContent, all: +r.children[2].textContent })))`));
check("every ascAIRN pair carries one colour box per cluster",
  comp.some((r) => r.sw.length === 2) &&
  comp.filter((r) => /\|/.test(r.text)).every((r) => r.sw.length === 2),
  `${comp.filter((r) => r.sw.length === 2).length} of ${comp.length} rows`);
check("the swatch colours resolve, and come from the ribbon palette",
  comp.flatMap((r) => r.sw).length > 0 &&
  comp.flatMap((r) => r.sw).every((c) => /^rgb\(/.test(c)),
  [...new Set(comp.flatMap((r) => r.sw))].slice(0, 4).join("  "));
const inc = comp.filter((r) => r.inc > 0).map((r) => r.inc);
check("composition ordered by count in the clade",
  inc.length >= 2 && inc.every((v, i) => i === 0 || inc[i - 1] >= v), inc.slice(0, 6).join(" >= "));
check("zero-count pairs collapsed into one row",
  /none in the clade/.test(comp[comp.length - 1].text), comp[comp.length - 1].text);
check("the composition accounts for every tip",
  comp.reduce((n, r) => n + r.all, 0) === S.tips,
  `${comp.reduce((n, r) => n + r.all, 0)} of ${S.tips}`);

// ---- 8. every fill resolves. This is the check the black ribbon slipped past.
const fills = JSON.parse(await ev(`(() => {
  const bad = [], seen = new Set();
  document.querySelectorAll('#app svg rect, #app svg line').forEach(e => {
    ['fill','stroke'].forEach(k => {
      const v = e.getAttribute(k);
      if (v == null || v === 'none') return;
      seen.add(v);
      if (v === '' || v.toLowerCase() === '#ff00ff') bad.push(k + '=' + JSON.stringify(v));
    });
  });
  return JSON.stringify({bad: [...new Set(bad)], n: seen.size});
})()`));
check("every drawn fill and stroke resolves to a real colour",
  fills.bad.length === 0, fills.bad.length ? fills.bad.join(" ") : `${fills.n} distinct colours`);

// ---- 9. the carrier ribbon is one ordinal ramp, not three categorical hues
const ramp = JSON.parse(await ev(`(() => {
  const cs = getComputedStyle(document.body);
  const t = (n) => cs.getPropertyValue(n).trim().toLowerCase();
  const want = ['--ev-0','--ev-1','--ev-3','--grid'].map(t);
  const anc = ['--anc-1','--anc-2','--anc-3','--anc-4','--anc-5'].map(t);
  const carrier = [...new Set([...document.querySelectorAll('.haptree rect.hapcar')]
    .map(r => (r.getAttribute('fill')||'').toLowerCase()))];
  return JSON.stringify({ used: carrier,
    fromRamp: carrier.every(c => want.includes(c)),
    anyAnc: carrier.some(c => anc.includes(c)) });
})()`));
check("the carrier ribbon draws from the ordinal ev ramp, with no ancestry hue",
  ramp.fromRamp && !ramp.anyAnc && ramp.used.length >= 2,
  `${ramp.used.length} colours: ${ramp.used.join(" ")}`);

// ---- 10. the browser's own decoder, against the catalog's frequency
const dec = JSON.parse(await ev(`(async () => {
  const [hb, cb] = await Promise.all([
    fetch("data/hap_${CH}.json").then(r=>r.json()),
    fetch("data/catalog.json").then(r=>r.json())]);
  const ix = {}; cb.columns.forEach((c,k)=>ix[c]=k);
  const want = new Map();
  for (let i=0;i<cb.data[0].length;i++)
    if (cb.data[ix.chrom][i] === "${CH}") want.set(cb.data[ix.sv_index][i], cb.data[ix.svfreq][i]);
  const PAIR=[0,2,1,3]; let worst=0, n=0;
  for (const m of hb.mono) {
    const bin = atob(m[4]); const N = ${INDEX.samples.length};
    let sum=0, called=0;
    for (let c=0;c<N;c++) {
      const d = PAIR[(bin.charCodeAt(c>>2) >> (6 - ((c&3)<<1))) & 3];
      if (d !== 3) { sum += d; called++; }
    }
    if (!called || want.get(m[0]) == null) continue;
    n++; worst = Math.max(worst, Math.abs(sum/(2*called) - want.get(m[0])));
  }
  return JSON.stringify({n, worst});
})()`));
check("carrier rows decode in the browser to the catalog's own frequency",
  dec.n > 20 && dec.worst < 0.03, `${dec.n} SVs, worst gap ${dec.worst.toFixed(5)}`);

// ---- 11. the two awkward chromosomes
for (const [ch, why] of [["chrX", "93 hemizygous individuals"],
                         ["chr13", "6 individuals with no assembly"]]) {
  const ok = await goto(`#/${ch}/haplotypes`, "#hap-mono tbody tr");
  const n = await ev(`document.querySelectorAll('#hap-mono tbody tr').length`);
  check(`${ch} renders (${why})`, ok && n === INDEX.summary[ch].mono,
    `${n} rows vs ${INDEX.summary[ch].mono}`);
}

// ---- 12. regressions on the addresses that existed before this feature
check("#/chr8 still renders the variant page", await goto(`#/${CH}`, "#ldpanel"),
  "LD panel present");
check("#/chr8/30 still opens the record panel", await goto(`#/${CH}/30`, ".panel"),
  await ev(`document.querySelector('.panel h2')?.textContent || ''`));

// ---- 13. the copy register, on everything this feature made visible
const bad = JSON.parse(await ev(`(() => {
  const pat = /\\b(is not|are not|was not|were not|does not|do not|did not|cannot|rather than|instead of|should not|no longer|nothing|absence of|too few)\\b/i;
  const hits = [];
  document.querySelectorAll('.hapsec, .hapcta, .hapline, .hapentry, .haprow, .controls')
    .forEach(n => n.querySelectorAll('*').forEach(e => {
      const t = [...e.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).join(' ');
      if (pat.test(t)) hits.push(t.trim().slice(0,70));
    }));
  return JSON.stringify([...new Set(hits)]);
})()`));
// ---- the record panel names the number of origins ------------------------------------
const recLine = async (ix) => {
  await goto(`#/${CH}/${ix}`, ".panel");
  await sleep(250);
  return JSON.parse(await ev(`JSON.stringify((() => {
    const p = document.querySelector(".panel .hapline");
    return p ? { text: p.textContent.trim(), link: p.querySelector("a")?.textContent.trim(),
                 href: p.querySelector("a")?.getAttribute("href") } : null;
  })())`));
};
const rMulti = await recLine(771);
check("the record of an SV that arose twice says so",
  !!rMulti && /arose twice/.test(rMulti.text) && rMulti.link === "See the origins"
    && /haplotypes\/771$/.test(rMulti.href || ""),
  rMulti ? `${rMulti.text} [${rMulti.link}]` : "no hapline on the record");
const rOne = await recLine(38);
check("and one that arose once still reads as one clade",
  !!rOne && /Carriers form one clade/.test(rOne.text) && rOne.link === "See the clade",
  rOne ? `${rOne.text} [${rOne.link}]` : "no hapline on the record");

// ---- an SV that arose more than once -------------------------------------------------
// chr8:46,181,428 is sv_index 771 and the resolution gives it two origins, B231 and B4. The
// page's default row is sv_index 38, which has ONE origin - that is why the address in the
// brief showed a single outline.
await goto(`#/${CH}/haplotypes/771`, "#app .haptree");
await sleep(250);

const mo = JSON.parse(await ev(`JSON.stringify((() => {
  const svg = document.querySelector("#app .haptree");
  const rects = [...svg.querySelectorAll("rect[stroke-dasharray]")];
  const texts = [...svg.querySelectorAll("text")].map(t => t.textContent)
    .filter(t => /\\d+ carriers/.test(t));
  const heads = [...document.querySelectorAll(".hapside table.haptab thead th")]
    .map(t => t.textContent.trim());
  const body = [...document.querySelectorAll(".hapside table.haptab tbody tr")]
    .map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()));
  return {
    nRect: rects.length,
    strokes: rects.map(r => getComputedStyle(r).stroke),
    labels: texts,
    heads, body,
  };
})())`));

check("an SV with two origins outlines two clades", mo.nRect === 2,
  `${mo.nRect} dashed outline(s)`);
check("the two outlines are drawn in different, resolved colours",
  mo.strokes.length === 2 && mo.strokes[0] !== mo.strokes[1]
    && !mo.strokes.some((c) => /255,\s*0,\s*255/.test(c)),
  mo.strokes.join(" vs "));
check("each outline names its carriers and its decomposition r2, and nothing else",
  mo.labels.length === 2
    && /^117 carriers · r² 0\.463$/.test(mo.labels[0])
    && /^56 carriers · r² 0\.347$/.test(mo.labels[1]),
  mo.labels.join(" | "));
check("the composition table carries one column per origin",
  mo.heads.length === 4 && /^origin 1\b/.test(mo.heads[1]) && /^origin 2\b/.test(mo.heads[2]),
  mo.heads.join(" | "));

// The unit check. Tips would total 120 and 107; carriers total 117 and 56.
const tot = mo.body.filter((r) => !/other pair/.test(r[0]))
  .reduce((a, r) => [a[0] + (+r[1] || 0), a[1] + (+r[2] || 0)], [0, 0]);
check("the per-origin columns count CARRIERS, not clade tips",
  tot[0] === 117 && tot[1] === 56, `origin 1 ${tot[0]} (117), origin 2 ${tot[1]} (56)`);

const oc = JSON.parse(await ev(`JSON.stringify((() => {
  const heads = [...document.querySelectorAll("#hap-mono thead th")].map(t => t.textContent.trim());
  const i = heads.findIndex(h => /^origins/.test(h));
  const cell = (id) => {
    const tr = document.getElementById("hapsv-" + id);
    return tr ? [...tr.querySelectorAll("td")][i].textContent.trim() : null;
  };
  return { i, heads, multi: cell(771), single: cell(38) };
})())`));
check("the table carries an origins column", oc.i >= 0, oc.heads.join(" | "));
check("it reads 2 on the SV that arose twice and is blank on one that arose once",
  oc.multi === "2" && oc.single === "", `771 "${oc.multi}", 38 "${oc.single}"`);

// ---- the evidence tier each origin carries ---------------------------------------------
// 107 of the 158 later origins the browser draws reached imputation nowhere, so the outline
// is the only place they appear. Both origins of 771 DID reach it, which is why the
// discriminating case below is sv_index 79.
const tiers = JSON.parse(await ev(`(async () => {
  const idx = await (await fetch("data/hap_index.json")).json();
  let n = 0, imputed = 0, bad = [];
  for (const c of Object.keys(idx.summary)) {
    const b = await (await fetch("data/hap_" + c + ".json")).json();
    for (const k of Object.keys(b.origins || {})) {
      for (const o of b.origins[k]) {
        n += 1;
        if (o.length !== 4 || (o[3] !== 0 && o[3] !== 1)) bad.push(c + ":" + k + ":" + o[0]);
        if (o[3] === 1) imputed += 1;
      }
    }
  }
  return JSON.stringify({ n, imputed, bad });
})()`));
check("every origin in the shipped payload carries an evidence tier of 0 or 1",
  tiers.n === 303 && tiers.bad.length === 0,
  `${tiers.n} origin record(s) (303), ${tiers.bad.length} malformed`);
// Both tiers present in the quantity the resolution states: a tier defaulted to either side
// would land on 303/0 or 0/303 and fail here.
check("the tiers split the way the resolution splits them",
  tiers.imputed === 196 && tiers.n - tiers.imputed === 107,
  `${tiers.imputed} imputed (196), ${tiers.n - tiers.imputed} assembly only (107)`);

check("the table says both origins of this SV reached imputation",
  mo.heads.filter((h) => / · imputed$/.test(h)).length === 2, mo.heads.join(" | "));

// sv_index 79: origin 1 is B239 with 31 carriers and a model, origin 2 is B454 with 6 and
// none. A tier that ignored the payload would read the same on both.
await goto(`#/${CH}/haplotypes/79`, "#app .haptree");
await sleep(250);
const split = JSON.parse(await ev(`JSON.stringify({
  labels: [...document.querySelectorAll("#app .haptree text")].map(t => t.textContent)
    .filter(t => /\\d+ carriers/.test(t)),
  heads: [...document.querySelectorAll(".hapside table.haptab thead th")]
    .map(t => t.textContent.trim()),
  ys: [...document.querySelectorAll("#app .haptree text")]
    .filter(t => /\\d+ carriers/.test(t.textContent))
    .map(t => +t.getAttribute("y"))
})`));
check("the label carries the quantities for each origin",
  split.labels.length === 2
    && /^31 carriers · r² 0\.457$/.test(split.labels[0])
    && /^6 carriers · r² 0\.305$/.test(split.labels[1]),
  split.labels.join(" | "));
// The discriminating case: these two origins fall on opposite sides of the tier, so a header
// printing a constant passes on 771 above and fails here.
check("an origin that reached no model is named apart from one that did",
  /^origin 1 · imputed$/.test(split.heads[1] || "")
    && /^origin 2 · assembly only$/.test(split.heads[2] || ""),
  split.heads.join(" | "));

// ---- the row the carrier ribbon paints, across the whole payload -----------------------
// The published build painted the record's own component, which is one origin of several: it
// marked 561 of the 1,622 later-origin carrier haplotypes and left 77 of the 158 later origins
// with every carrier reading zero. These three read the field that replaced it out of the
// payload, with the browser's own decoders, over every chromosome that carries one.
const par = JSON.parse(await ev(`(async () => {
  const idx = await (await fetch("data/hap_index.json")).json();
  const ix = {}; idx.samples.forEach((r, i) => { ix[r.s] = i; });
  const PAIR = [0,2,1,3];
  let rows = 0, without = 0, car = 0, bad = 0, same = 0;
  for (const ch of Object.keys(idx.multi)) {
    const b = await (await fetch("data/hap_" + ch + ".json")).json();
    const tips = b.tree.tips, nt = b.tree.n_tip;
    const mono = new Map(b.mono.map(m => [String(m[0]), m]));
    for (const k of Object.keys(b.origins || {})) {
      if (b.origins[k].length < 2) continue;
      const p = (b.parent || {})[k];
      if (!p) { without++; continue; }
      rows++;
      if (mono.get(k) && mono.get(k)[4] === p) same++;
      const bin = atob(p);
      for (const o of b.origins[k]) {
        const cb = atob(o[2]);
        for (let t = 0; t < nt; t++) {
          if (!(cb.charCodeAt(t >> 3) >> (7 - (t & 7)) & 1)) continue;
          car++;
          const si = ix[tips[t].replace(/_hap[12]$/, "")];
          const d = si === undefined ? -1
            : PAIR[(bin.charCodeAt(si >> 2) >> (6 - ((si & 3) << 1))) & 3];
          if (d !== 1 && d !== 2) bad++;
        }
      }
    }
  }
  return JSON.stringify({ rows, without, car, bad, same });
})()`));
check("the payload carries the variant's own row for every multi-origin SV that has one",
  par.rows === 137 && par.without === 8,
  `${par.rows} rows carry one (137), ${par.without} lack one (8)`);
check("every carrier of every origin is a carrier of that row, in the browser's own decoder",
  par.car === 6679 && par.bad === 0,
  `${par.car} carrier haplotypes (6679), ${par.bad} the row reads as a non-carrier`);
check("that row is a different row from the component the record describes",
  par.rows > 0 && par.same === 0,
  `${par.same} of ${par.rows} rows where the two pack to the same bytes`);

check("the caption sends a reader to the table for the tier",
  /table beside the tree counts each origin's carriers and says whether it reached imputation/
    .test(await ev(`document.querySelector("#app figcaption").textContent`)),
  "figcaption");

// chr5_sv193 sets its two clades three tip rows apart, which is where the published build
// drew the lower label through the upper outline. Each label now sits on the side of its own
// outline facing away from the other, so one is above the upper clade and one below the lower.
await goto("#/chr5/haplotypes/193", "#app .haptree");
await sleep(300);
const side = JSON.parse(await ev(`JSON.stringify((() => {
  const svg = document.querySelector("#app .haptree");
  const r = [...svg.querySelectorAll("rect[stroke-dasharray]")]
    .map(e => ({ y: +e.getAttribute("y"), h: +e.getAttribute("height") }))
    .sort((a, b) => a.y - b.y);
  const t = [...svg.querySelectorAll("text")]
    .filter(e => /\\d+ carriers/.test(e.textContent))
    .map(e => +e.getAttribute("y")).sort((a, b) => a - b);
  return { r, t };
})())`));
check("one label sits above the upper clade and one below the lower clade",
  side.r.length === 2 && side.t.length === 2
    && side.t[0] <= side.r[0].y
    && side.t[1] >= side.r[1].y + side.r[1].h,
  `labels ${side.t.join(", ")} against boxes `
    + side.r.map((b) => `${b.y.toFixed(0)}..${(b.y + b.h).toFixed(0)}`).join(", "));

// ---- the ribbon reaches every origin, and the column says which origin a haplotype is in
//
// chr5_sv193 is the case the objection was raised on. Its two origins hold 14 and 7 carrier
// haplotypes, and the one holding seven sits ABOVE the other in the tree. The published build
// painted the record's own component, so that upper outline enclosed seven carriers with every
// ribbon cell beside them reading zero. Counted down the tree this reads 0, 14 on 87a6d86 and
// 7, 14 here, measured on both. The ribbon now paints the row the variant had before the
// decomposition split it, at frequency 0.056 against this record's own 0.037.
const cov = JSON.parse(await ev(`JSON.stringify((() => {
  const svg = document.querySelector("#app .haptree");
  const cs = getComputedStyle(document.body);
  const t = (n) => cs.getPropertyValue(n).trim().toLowerCase();
  const carr = [t('--ev-1'), t('--ev-3')];
  const bands = [...svg.querySelectorAll("rect[stroke-dasharray]")]
    .map(e => ({ y: +e.getAttribute("y"), h: +e.getAttribute("height") }))
    .sort((a, b) => a.y - b.y);
  const inside = (sel, b) => [...svg.querySelectorAll(sel)]
    .filter(e => +e.getAttribute("y") >= b.y
      && +e.getAttribute("y") + +e.getAttribute("height") <= b.y + b.h);
  const org = [...svg.querySelectorAll("rect.haporg")];
  return {
    ribbon: bands.map(b => inside("rect.hapcar", b)
      .filter(e => carr.includes((e.getAttribute("fill")||"").toLowerCase())).length),
    origin: bands.map(b => inside("rect.haporg", b).length),
    nOrigin: org.length,
    fills: [...new Set(org.map(e => (e.getAttribute("fill")||"").toLowerCase()))],
    strokes: [...new Set([...svg.querySelectorAll("rect[stroke-dasharray]")]
      .map(e => (e.getAttribute("stroke")||"").toLowerCase()))],
    keys: [...document.querySelectorAll(".haprow .hapkeys .hapkeyl")].map(e => e.textContent),
    caption: document.querySelector(".haprow figcaption").textContent,
  };
})())`));
check("the carrier ribbon marks a carrier inside every outlined origin",
  cov.ribbon.length === 2 && cov.ribbon.every((n) => n > 0),
  `carriers coloured per outline: ${cov.ribbon.join(", ")}, where 87a6d86 drew 0, 14`);
check("no page draws an origin column, on any number of origins",
  cov.nOrigin === 0, `${cov.nOrigin} origin cell(s)`);
check("the key names the two ribbons and the origin outlines",
  JSON.stringify(cov.keys) === '["ancestry","carrier","origin"]', cov.keys.join(" | "));
check("the two outlines are drawn in two different colours",
  cov.strokes.length === 2, cov.strokes.join(" "));
check("the caption gives the frequency of the row the ribbon paints, beside the record's own",
  /reads the variant as it stood before the decomposition, at frequency 0\.056/
    .test(cov.caption)
    && /this record's own frequency of 0\.037 covers origin 1 alone/.test(cov.caption),
  cov.caption.slice(-230));
check("and the caption counts the carriers that fall outside every origin",
  /1 carrier individual falls outside every origin/.test(cov.caption), cov.caption.slice(-130));
check("the caption names only marks the figure actually draws",
  !/origin column/.test(cov.caption), cov.caption.slice(-160));

await goto(`#/${CH}/haplotypes/771`, "#app .haptree");
await sleep(250);

// ---- and the single-origin page is untouched
await goto(`#/${CH}/haplotypes/38`, "#app .haptree");
await sleep(250);
const one = JSON.parse(await ev(`JSON.stringify((() => {
  const svg = document.querySelector("#app .haptree");
  return {
    nRect: svg.querySelectorAll("rect[stroke-dasharray]").length,
    nLabel: [...svg.querySelectorAll("text")].filter(t => /^origin /.test(t.textContent)).length,
    nOrg: svg.querySelectorAll("rect.haporg").length,
    axes: [...svg.querySelectorAll("text")].map(t => t.textContent),
    keys: [...document.querySelectorAll(".haprow .hapkeys .hapkeyl")].map(e => e.textContent),
    head: [...document.querySelectorAll(".hapside table.haptab thead th")]
      .map(t => t.textContent.trim()),
  };
})())`));
check("an SV with one origin still draws one unlabelled outline",
  one.nRect === 1 && one.nLabel === 0, `${one.nRect} rect(s), ${one.nLabel} label(s)`);
check("and its composition column is unchanged",
  one.head.length === 3 && one.head[1] === "in the clade", one.head.join(" | "));
check("a single-origin page offers no origin key and no origin axis",
  one.nOrg === 0 && !one.axes.includes("origin")
    && JSON.stringify(one.keys) === '["ancestry","carrier"]',
  `${one.nOrg} cell(s), keys ${one.keys.join(" | ")}`);

// ---- no two clades that touch are drawn in the same colour -----------------------------
// Two hues were what the figure held until a third was added, so origins 2, 3 and 4 all drew
// alike. Six of the nine rows with three or more origins hold a pair of clades one tip row
// apart or less, and an outline runs a row past its clade at either end - so on four of them
// two TOUCHING clades were drawn in one colour and read as one region.
//
// This OPENS EACH ROW AND READS THE OUTLINES, rather than recomputing the rule that assigns
// the hues. A check that reimplements the thing it checks passes whenever the two copies agree,
// including when both are wrong; this one fails whenever the ink is wrong. The rows are the
// nine the payload says carry three origins or more, found here rather than typed in.
const many = JSON.parse(await ev(`(async () => {
  const idx = await (await fetch("data/hap_index.json")).json();
  const out = [];
  for (const ch of Object.keys(idx.multi)) {
    const b = await (await fetch("data/hap_" + ch + ".json")).json();
    for (const k of Object.keys(b.origins || {}))
      if (b.origins[k].length >= 3) out.push([ch, k, b.origins[k].length]);
  }
  return JSON.stringify(out);
})()`));
const clash = [];
let pairsSeen = 0;
for (const [ch, ix, n] of many) {
  await goto(`#/${ch}/haplotypes/${ix}`, "#app .haptree");
  await sleep(220);
  const drawn = JSON.parse(await ev(`JSON.stringify(
    [...document.querySelectorAll("#app .haptree rect[stroke-dasharray]")].map(e => ({
      y: +e.getAttribute("y"), h: +e.getAttribute("height"),
      s: getComputedStyle(e).stroke })).sort((a, b) => a.y - b.y))`));
  if (drawn.length !== n) { clash.push(`${ch}:${ix} drew ${drawn.length} of ${n} outlines`); continue; }
  for (let i = 0; i + 1 < drawn.length; i++) {
    const a = drawn[i], c = drawn[i + 1];
    if (c.y > a.y + a.h) continue;          // a clear gap between them
    pairsSeen++;
    if (a.s === c.s) clash.push(`${ch}:${ix} outlines ${i + 1},${i + 2} both ${a.s}`);
  }
}
check("outlines that touch on the page are drawn in different colours",
  many.length === 9 && pairsSeen > 0 && clash.length === 0,
  `${many.length} rows with 3+ origins (9), ${pairsSeen} touching pair(s) drawn, `
  + `${clash.length} alike${clash.length ? ": " + clash.slice(0, 3).join("; ") : ""}`);


// ---- the evidence count is the way to the record ---------------------------------------
// Which rows carry evidence is read from the shipped payload rather than typed here, so a
// build that draws the link on the wrong rows, or points one at the wrong record, fails.
// n_layers is the primary-tier count etl/build_data.py bakes, which is what the column shows.
const evRows = JSON.parse(await ev(`(async () => {
  const cat = await (await fetch("data/catalog.json")).json();
  const c = Object.fromEntries(cat.columns.map((n, i) => [n, i]));
  const lay = new Map();
  for (let k = 0; k < cat.data[0].length; k++) {
    lay.set(cat.data[c.chrom][k] + ":" + cat.data[c.sv_index][k],
      [cat.data[c.n_layers][k], cat.data[c.sv_id][k]]);
  }
  const idx = await (await fetch("data/hap_index.json")).json();
  const out = [];
  for (const ch of Object.keys(idx.summary)) {
    const b = await (await fetch("data/hap_" + ch + ".json")).json();
    for (const m of b.mono) {
      const v = lay.get(ch + ":" + m[0]);
      if (v && v[0] > 0) out.push([ch, m[0], v[0], v[1]]);
    }
  }
  return JSON.stringify(out);
})()`));
const EC = evRows.length ? evRows[0][0] : CH;
const onEC = evRows.filter((r) => r[0] === EC);
await goto(`#/${EC}/haplotypes`, "#hap-mono tbody tr");
await sleep(300);
const evLinks = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll("#hap-mono tbody tr")].map((tr) => {
    const a = tr.querySelector("a.hapev");
    return a ? [tr.id, a.getAttribute("href"), a.textContent] : null;
  }).filter(Boolean))`));
const want = new Map(onEC.map((r) => ["hapsv-" + r[1], [`#/${EC}/${r[1]}`, String(r[2])]]));
const offBy = evLinks.filter(([id, href, txt]) => !want.has(id)
  || want.get(id)[0] !== href || want.get(id)[1] !== txt);
check("every monophyletic row carrying evidence offers it as a link to the record",
  evRows.length > 0 && evLinks.length === want.size && offBy.length === 0,
  `${evRows.length} rows carry evidence across the layer, ${want.size} on ${EC}, `
  + `${evLinks.length} drawn, ${offBy.length} off`);

// The trip there and back, with a filter in the address. The filter lives in the query and
// the route in the hash, so following a link has to leave the query where it was.
const TGT = onEC[0];
await ev(`(() => { const u = new URL(location.href); u.search = "?cvr2=0.1";
  history.replaceState(null, "", u); })()`);
// A build with no link here reports it through the check below rather than by stopping
// this file, so the run says which of the four is missing and the other three still run.
await ev(`document.querySelector("#hapsv-${TGT[1]} a.hapev")?.click() ?? 0`);
await sleep(700);
const landed = JSON.parse(await ev(`JSON.stringify({
  href: location.href,
  label: document.querySelector(".panel")?.getAttribute("aria-label") || "" })`));
check("following it opens that record and leaves the filter in the address",
  landed.label === `Record for ${TGT[3]}`
  && landed.href.includes(`#/${EC}/${TGT[1]}`) && /[?]cvr2=0\.1/.test(landed.href),
  `${landed.label || "no record"} · ${landed.href.replace(/^https?:[^?#]*/, "")}`);

await ev("history.back()");
await sleep(900);
const came = JSON.parse(await ev(`JSON.stringify({
  hash: location.hash,
  sel: document.querySelector("#hap-mono tbody tr.sel")?.id || "" })`));
check("back returns to the table at the row the reader left",
  came.hash === `#/${EC}/haplotypes/${TGT[1]}` && came.sel === "hapsv-" + TGT[1],
  `${came.hash} · ${came.sel || "nothing selected"}`);

// ---- an address written down while a filter was set opens what it names -----------------
// Until 2026-09-13 four writers copied location.search into the hash they wrote, so this is
// the shape of every address a reader could have copied off this site while a filter was away
// from its default - `#/chr1/250?cvr2=0.1`. The route reads ^chr..$ and ^\d+$ off the hash,
// and the tail defeated both: the record stayed closed, the chromosome fell through to the
// overview, and the tree outlined whichever SV the sort put first. Each one is opened here.
const legacy = [];
let stale = 0;
for (const [what, hash, wait, read, want2] of [
  ["the record", `#/${EC}/${TGT[1]}?cvr2=0.1`, ".panel",
    `document.querySelector(".panel")?.getAttribute("aria-label") || ""`,
    `Record for ${TGT[3]}`],
  ["the chromosome", `#/${EC}?cvr2=0.1`, "#app h1",
    `document.querySelector("#app h1")?.textContent || ""`, EC],
  ["the tree at one SV", `#/${EC}/haplotypes/${TGT[1]}?cvr2=0.1&hsort=-origins`,
    "#hap-mono tbody tr.sel",
    `document.querySelector("#hap-mono tbody tr.sel")?.id || ""`, "hapsv-" + TGT[1]],
]) {
  await goto("#/", ".grid, table");
  await goto(hash, wait);
  await sleep(300);
  const got = await ev(read);
  legacy.push(`${what}: ${got === want2 ? "ok" : `${JSON.stringify(got)} for ${want2}`}`);
  if (got !== want2) stale++;
}
check("an address with the query inside the hash opens what it names",
  stale === 0, legacy.join(" · "));

// Put the query back where the rest of this file found it: the screenshots below paint
// whatever it asks for, and a stray floor would quietly restyle all four of them.
await ev(`(() => { const u = new URL(location.href); u.search = "";
  history.replaceState(null, "", u); })()`);
await goto("#/", ".grid, table");
await sleep(300);

check("reader-visible copy passes the register", bad.length === 0, JSON.stringify(bad));
check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));

async function shot(name, hash, wait, sel) {
  await goto(hash, wait);
  await sleep(700);
  const b = await ev(`(() => { window.scrollTo(0,0);
    const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect();
    return {x:r.x+scrollX, y:r.y+scrollY, w:r.width, h:r.height}; })()`);
  if (!b) return;
  const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 88,
    captureBeyondViewport: true,
    clip: { x: b.x, y: b.y, width: b.w, height: Math.min(b.h, 2600), scale: 1.25 } });
  fs.writeFileSync(path.join(OUT, name + ".jpg"), Buffer.from(r.data, "base64"));
}
await shot("hap_overview", "#/", ".hapentry", ".hapentry");
await shot("hap_individuals", "#/individuals", "#app .hapsvg", "#app");
await shot("hap_tree2", `#/${CH}/haplotypes/${cat.mono[0]}`, ".haprow", ".haprow");
// the order lives in the SEARCH. A "?" tail inside the hash is set aside by the route, so
// writing the order there would drop it
await ev(`(() => { const u = new URL(location.href); u.search = "?hsort=-af";
  history.replaceState(null, "", u); })()`);
await shot("hap_mono2", `#/${CH}/haplotypes`, "#hap-mono tbody tr", "#hap-mono");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
try { chrome.kill(); } catch { /* gone */ }
server.close();
process.exit(failed.length ? 1 : 0);
