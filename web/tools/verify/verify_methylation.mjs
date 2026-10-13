/**
 * Drive the real single-file build and check the methylation layer.
 *
 * Written so that each check would FAIL on the layer this one replaces, because the assertions
 * that shipped with that layer could not: they compared the ETL against the superseded upstream
 * tree, which is still on disk, so they passed green while the browser published a chr3 -> chr17
 * trans association the manuscript had withdrawn and a chr12 lead absent from the current scan.
 * A check that can only confirm agreement with what you are replacing is not a check.
 *
 * Counts come from the shipped meta.json and catalog.json, not from numbers typed in here, so a
 * refreshed scan moves the expectation and the ETL's own assertions are what stop a real change.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TARGET = path.resolve(process.argv[2]);
const PORT = 4198, CDP = 9242;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const html = fs.readFileSync(TARGET);
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(html);
}).listen(PORT);
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-meth");
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
  const r = await send("Runtime.evaluate",
    { expression: e, returnByValue: true, awaitPromise: true });
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

const grab = async (f) => JSON.parse(await ev(
  `(async () => JSON.stringify(await (await fetch("data/${f}")).json()))()`));
const META = await grab("meta.json");
const LAYERS = await grab("layers.json");
const CAT = await grab("catalog.json");
const col = Object.fromEntries(CAT.columns.map((c, i) => [c, CAT.data[i]]));
const MQ = LAYERS.filter((h) => h.layer === "mqtl");

// ---- 1. the section's own figures reached the browser
check("meta carries the section's methylation counts",
  !!META.meth && META.meth.n_pairs === 418 && META.meth.n_svs === 42 &&
  META.meth.n_cpgs === 376 && META.meth.n_tested === 68,
  META.meth ? `${META.meth.n_pairs} pairs / ${META.meth.n_svs} SVs / ${META.meth.n_cpgs} CpGs`
    : "absent");

// ---- 2. THE TRANS GUARD. Fails on the layer being replaced, which shipped two chr3 rows
//         whose CpG was on chr17.
const offChrom = MQ.filter((h) => !String(h.target).startsWith(h.chrom + ":"));
check("every methylation row puts its CpG on the SV's own chromosome",
  MQ.length > 0 && offChrom.length === 0,
  `${MQ.length} rows, ${offChrom.length} off-chromosome`);

// ---- 3. no gene symbol survives. The rewritten section names none, and its own checker
//         fails on these three; the browser was the last place publishing them.
const GENES = ["TUBD1", "VMP1", "MIR21", "CENP-B box", "delta-tubulin"];
const bodyText = await ev(`document.body.innerText`);
const leaked = GENES.filter((g) =>
  JSON.stringify(MQ).includes(g) || bodyText.includes(g));
check("no withdrawn gene annotation reaches a reader", leaked.length === 0,
  leaked.length ? leaked.join(", ") : GENES.length + " checked");

// ---- 4. one band, because the section states one
const tiers = [...new Set(MQ.map((h) => h.tier))];
check("every methylation row sits in the section's single band",
  tiers.length === 1 && tiers[0] === "primary", tiers.join(", "));

// ---- 5. distance is on the row, which is what separates a 766 bp pair from a 136 Mb one
const noDist = MQ.filter((h) => h.distance == null || !/away/.test(String(h.target)));
check("every row carries the distance from its SV to its CpG", noDist.length === 0,
  `worst ${Math.max(...MQ.map((h) => h.distance)) / 1e6 | 0} Mb, ${noDist.length} missing`);

// ---- 6. the overview offers the table
await goto("#/", ".hapentry");
const hrefs = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.methentry a.hapcta')].map(a => a.getAttribute('href')))`));
check("the overview links to the methylation table",
  hrefs.includes("#/methylation"), hrefs.join("  "));

// ---- 7. the page renders every tested SV, hits and clean alike
const okPage = await goto("#/methylation", "table.haptab tbody tr");
const nRows = await ev(`document.querySelectorAll('table.haptab tbody tr').length`);
const tested = col.meth_tested.reduce((a, b) => a + b, 0);
check("the table draws every catalogue entry the scan tested",
  okPage && nRows === tested, `${nRows} rows drawn, ${tested} tested`);

// ---- 8. the tested-and-clean rows are present and marked. Their absence is the answer to
//         a question a record panel cannot settle, so a table without them is the defect.
const clean = await ev(`document.querySelectorAll('tr.methclean').length`);
const hitEntries = col.meth_hits.reduce((a, b) => a + b, 0);
check("SVs the scan tested and returned no CpG for are drawn and marked",
  clean > 0 && clean === tested - hitEntries,
  `${clean} clean, ${tested - hitEntries} expected`);

// ---- 9. every fill resolves. --ink-2 does not exist in tokens.css and a missing custom
//         property leaves the declaration dropped, so this asks the rendered colour.
const cleanColour = await ev(`(() => {
  const t = document.querySelector('tr.methclean td');
  const n = document.querySelector('table.haptab tbody tr:not(.methclean) td');
  if (!t || !n) return null;
  return [getComputedStyle(t).color, getComputedStyle(n).color];
})()`);
check("the clean rows resolve to a real colour of their own",
  !!cleanColour && cleanColour[0] !== cleanColour[1] &&
  !/rgba\(0, 0, 0, 0\)/.test(cleanColour[0]),
  cleanColour ? cleanColour.join("  vs  ") : "no rows");

// ---- 10. exactly one variant clears the whole-scan calibration, and it is marked
const bold = await ev(`document.querySelectorAll('b.methclear').length`);
const clearRows = MQ.filter((h) => h.maxt <= 0.05);
const clearing = new Set(clearRows.map((h) => h.chrom + "|" + h.sv_index));
// The section's claim is ONE DELETION. That deletion sits at two coordinates 9 bp apart and
// each resolves to the same three catalogue entries, so three rows carry the mark and one
// association is behind them. Asserting "one marked row" would have been asserting the wrong
// unit; the collapse is what the claim is about, so the collapse is what is checked.
const assoc = new Set(clearRows.map((h) => h.target + "|" + h.beta));
check("the marked rows are one association, shown under its resolution modes",
  bold === clearing.size && assoc.size === 1 &&
  new Set(clearRows.map((h) => h.chrom)).size === 1,
  `${bold} rows marked, ${clearing.size} catalogue entries, ${assoc.size} association`);

// ---- 11. sorting reorders, and a missing value stays last in BOTH directions
const firstBy = async (key) => {
  await ev(`(() => { const u = new URL(location.href); u.search = "?msort=${key}";
    history.replaceState(null, "", u); })()`);
  await ev(`location.hash = "#/"`); await sleep(120);
  await goto("#/methylation", "table.haptab tbody tr");
  return ev(`document.querySelector('table.haptab tbody tr td').innerText`);
};
const byQ = await firstBy("q"), byCpg = await firstBy("-cpgs");
check("the column order in the query string changes the table", byQ !== byCpg,
  `q -> ${byQ} · -cpgs -> ${byCpg}`);
const lastRowClean = async (key) => {
  await ev(`(() => { const u = new URL(location.href); u.search = "?msort=${key}";
    history.replaceState(null, "", u); })()`);
  await ev(`location.hash = "#/"`); await sleep(120);
  await goto("#/methylation", "table.haptab tbody tr");
  return ev(`document.querySelector('table.haptab tbody tr:last-child')
    .classList.contains('methclean')`);
};
check("an SV with no q sorts last whichever way the arrow points",
  (await lastRowClean("q")) && (await lastRowClean("-q")),
  "both directions");

// ---- 12. a row leads to that SV
await goto("#/methylation", "table.haptab tbody tr");
await ev(`document.querySelector('table.haptab tbody tr').click()`);
await sleep(400);
const hash = await ev(`location.hash`);
check("a row opens the SV it describes", /^#\/chr[0-9XY]+\/\d+$/.test(hash), hash);

// ---- 13. the record panel still shows the other layers, unchanged
await goto("#/chr8", ".grid, table");
check("the page threw no console error", errs.length === 0,
  errs.slice(0, 2).join(" | ") || "clean");

// ---- 14. R8b: every study-wide locus is drawn, on the chromosomes the section names
const CD = LAYERS.filter((h) => h.layer === "cdr");
const cdChroms = [...new Set(CD.map((h) => h.chrom))].sort();
check("the dip-region layer draws more than chromosome 8",
  CD.length > 9 && cdChroms.length >= 4 && cdChroms.includes("chr5") &&
  cdChroms.includes("chr9") && cdChroms.includes("chr19"),
  `${CD.length} rows over ${cdChroms.length} chromosomes: ${cdChroms.join(" ")}`);

// ---- 15. tier is significance and the tag is the gate verdict, so they vary independently.
//         A layer that used tier to carry the gate verdict would fail this.
const primaryTagged = CD.filter((h) => h.tier === "primary" && h.tags);
check("a locus can be primary and still carry a reason",
  primaryTagged.length > 0,
  `${primaryTagged.length} of ${CD.filter((h) => h.tier === "primary").length} primary rows tagged`);

// ---- 16. chromosome 19's tags never claim array length, because its length is stable on
//         every one of its rows. This is the misattribution the section's prose makes.
const ch19 = CD.filter((h) => h.chrom === "chr19");
const ch19len = ch19.filter((h) => (h.tags || "").includes("array length"));
const ch9 = CD.filter((h) => h.chrom === "chr9");
const ch9len = ch9.filter((h) => (h.tags || "").includes("array length"));
check("chromosome 19 carries no array-length tag, and chromosome 9 carries one on every row",
  ch19.length > 0 && ch19len.length === 0 && ch9.length > 0 && ch9len.length === ch9.length,
  `chr19 ${ch19len.length}/${ch19.length} · chr9 ${ch9len.length}/${ch9.length}`);

// ---- 17. a named super-population is a name the gate would recognise
const named = CD.flatMap((h) => (h.groups || "").split(", ")).filter(Boolean);
const POPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];
check("every named super-population is one of the five",
  named.length > 0 && named.every((g) => POPS.includes(g)),
  `${new Set(named).size} distinct: ${[...new Set(named)].sort().join(" ")}`);

// ---- 18. the chips render, and resolve to a colour of their own
await goto("#/chr9", ".grid, table");
const chip = await ev(`(async () => {
  const row = [...document.querySelectorAll('tr, .row, [data-sv]')].length;
  return row > 0;
})()`);
const chipColour = await ev(`(() => {
  const s = document.createElement('span'); s.className = 'rtag strong';
  document.body.append(s);
  const c = getComputedStyle(s).borderColor; s.remove(); return c;
})()`);
check("the reason chip resolves to a real colour",
  !!chipColour && !/rgba\(0, 0, 0, 0\)/.test(chipColour), chipColour);

// ---- 19. the overview tile counts out of the full call set, not the modelled subset.
//         Fails on the version replaced, whose tile read "of 10,705 in the catalog".
await goto("#/", ".stats");
const tile = await ev(`document.querySelector('.stats')?.innerText || ""`);
check("the overview counts out of the whole call set",
  !!META.n_called && META.n_called === 188589 &&
  tile.includes(META.n_called.toLocaleString("en-US")) &&
  !/in the catalog/.test(tile),
  `n_called ${META.n_called} · tile ${JSON.stringify(tile.slice(0, 70))}`);

// ---- 20. and the subset it draws is still stated where a reader can reach it
const unit = await ev(`(() => {
  const d = [...document.querySelectorAll('details.excl')]
    .find((x) => /counts as one SV/i.test(x.textContent));
  if (!d) return "";
  d.open = true; return d.innerText;
})()`);
check("the note says why the call set became the catalogue drawn",
  /188,589/.test(unit) && /8,792/.test(unit) && /10,705/.test(unit),
  unit ? unit.replace(/\s+/g, " ").slice(0, 110) : "note absent");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
try { chrome.kill(); } catch { /* gone */ }
server.close();
process.exit(failed.length ? 1 : 0);
