// Interaction and contrast checks: the things no data check can see.
//
//     node web/tools/verify/verify_interactions.mjs [CenSV_offline.html | https://...]
//
// The other browser suites answer "does the figure draw what the data says". This one answers
// "does the page keep what the reader chose, and can the reader read it" - the class of defect
// that leaves every number on the page correct.
//
// Every assertion here was measured the other way round on the build it was written against:
// the evidence-only checkbox reset on every re-render (it lives in the DOM, not in state), the
// legend never followed it, the record drawer hid 24.2% of the chart at 1440 px and 31.0% at
// 1280, --text-muted was 3.50:1 on the light theme every reader lands on, the association tag
// was 2.11:1 white-on-orange, the record dialog's Tab trap did not know about the <summary>
// inside it, the "/" hotkey walked straight out of the open dialog, and a coordinate search
// rendered a bare lowercase "position" because the results page had its own label map.
//
// Needs Chrome, so it runs from a workstation rather than from the build host.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || path.join(HERE_DIR, "..", "..", "..",
  "CenSV_offline.html");
const PORT = 4330, CDP = 9330;
const html = fs.readFileSync(FILE);
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(html);
}).listen(PORT);
const PROFILE = path.join(process.env.TEMP, "cdp-w1-" + process.pid);
const CHROME = process.env.CHROME
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chrome = spawn(CHROME,
  ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,2600",
   "--remote-debugging-port=" + CDP, "--user-data-dir=" + PROFILE,
   "http://localhost:" + PORT + "/"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (e) => {
  const r = await send("Runtime.evaluate",
    { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description);
  return r.result.value;
};
const wait = async (e, ms = 60000) => {
  for (let t = 0; t < ms; t += 50) { if (await ev("!!(" + e + ")")) return true; await sleep(50); }
  return false;
};
for (let i = 0; i < 120; i++) {
  try {
    const ts = await (await fetch("http://127.0.0.1:" + CDP + "/json")).json();
    const p = ts.find((t) => t.type === "page" && t.url.includes("localhost:" + PORT));
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { }
  await sleep(250);
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable"); await send("Page.enable"); await send("Emulation.enable");
await wait('document.querySelectorAll(".grid a.card").length === 23');

const fails = [];
let ran = 0;
const check = (n, ok, d = "") => {
  ran += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${n.padEnd(56)} ${d}`);
  if (!ok) fails.push(n);
};

// contrast, computed in the page against the colours the browser actually resolves
await ev(`window.__cr = (fg, bg) => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const L = (s) => { const m = s.match(/-?\\d+(\\.\\d+)?/g).map(Number);
    return 0.2126*lin(m[0]) + 0.7152*lin(m[1]) + 0.0722*lin(m[2]); };
  const a = L(fg), b = L(bg);
  return +(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2));
};
window.__hex = (v) => { const d = document.createElement("span");
  d.style.color = v; document.body.appendChild(d);
  const c = getComputedStyle(d).color; d.remove(); return c; };
"ok"`);

console.log("\n--- b4  the checkbox and the legend ---");
await ev(`location.hash = "#/chr16"`);
await wait(`document.querySelectorAll(".trackpanel").length >= 3`);
await sleep(900);
const before = JSON.parse(await ev(`JSON.stringify({
  legend: [...document.querySelectorAll(".legend .it")].map(e => e.textContent),
  marks: document.querySelectorAll(".chart circle").length })`));
await ev(`(() => { const b = document.getElementById("onlyhits");
  b.checked = true; b.dispatchEvent(new Event("change")); })()`);
await sleep(1200);
const ticked = JSON.parse(await ev(`JSON.stringify({
  legend: [...document.querySelectorAll(".legend .it")].map(e => e.textContent),
  marks: document.querySelectorAll(".chart circle").length,
  url: location.search })`));
check("ticking it removes the evidence-free marks",
  ticked.marks > 0 && ticked.marks < before.marks, `${before.marks} circles -> ${ticked.marks}`);
check("the legend counts follow it",
  JSON.stringify(ticked.legend) !== JSON.stringify(before.legend),
  `${before.legend.join(" ")}  ->  ${ticked.legend.join(" ")}`);
check("the choice is in the address", ticked.url.includes("hits=1"), `search "${ticked.url}"`);

// fold a track panel: this is the re-render that used to untick it
await ev(`(() => { const d = [...document.querySelectorAll(".trackpanel")]
  .find(x => x.querySelector(".tname")?.textContent === "Methylation"); d.open = false; })()`);
await sleep(1400);
const afterFold = JSON.parse(await ev(`JSON.stringify({
  checked: document.getElementById("onlyhits")?.checked,
  marks: document.querySelectorAll(".chart circle").length })`));
check("folding a track panel does not untick it", afterFold.checked === true,
  `checkbox reads ${afterFold.checked}, ${afterFold.marks} circles still drawn`);

await ev(`(() => { const t0 = performance.now(); document.getElementById("theme").click();
  return performance.now() - t0; })()`);
await sleep(1200);
check("nor does the theme toggle",
  (await ev(`document.getElementById("onlyhits")?.checked`)) === true);
await ev(`document.getElementById("theme").click()`); await sleep(900);
await ev(`(() => { const b = document.getElementById("onlyhits");
  b.checked = false; b.dispatchEvent(new Event("change")); })()`);
await sleep(900);

console.log("\n--- b6  contrast, from the colours the browser resolves ---");
for (const mode of ["light", "dark"]) {
  await ev(`document.documentElement.setAttribute("data-theme", "${mode}")`);
  await sleep(400);
  const r = JSON.parse(await ev(`JSON.stringify((() => {
    const cs = getComputedStyle(document.body);
    const g = (v) => window.__hex(cs.getPropertyValue(v).trim());
    return { muted: window.__cr(g("--text-muted"), g("--surface-1")),
             mutedPage: window.__cr(g("--text-muted"), g("--page")),
             accent: window.__cr(g("--accent"), g("--page")),
             ev1: window.__cr(g("--text-primary"), g("--ev-1")),
             ev3: window.__cr(g("--surface-1"), g("--ev-3")) };
  })())`));
  check(`${mode}: --text-muted clears 4.5:1`, r.muted >= 4.5 && r.mutedPage >= 4.5,
    `${r.muted}:1 on surface, ${r.mutedPage}:1 on page`);
  check(`${mode}: links clear 4.5:1`, r.accent >= 4.5, `${r.accent}:1`);
  check(`${mode}: the tag's ink clears 4.5:1 on both ramp steps`,
    r.ev1 >= 4.5 && r.ev3 >= 4.5, `ev-1 ${r.ev1}:1, ev-3 ${r.ev3}:1`);
}
await ev(`document.documentElement.setAttribute("data-theme", "light")`);
await sleep(300);

console.log("\n--- u6  the drawer and the chart ---");
await ev(`location.hash = "#/chr16"`);
await wait(`document.querySelectorAll(".trackpanel").length >= 3`);
await sleep(800);
const wide = await ev(`document.querySelector(".trackpanel svg").getBoundingClientRect().width`);
await ev(`(() => { const a = [...document.querySelectorAll("table.tbl tbody tr.hit td a")][0];
  if (a) a.click(); })()`);
await wait(`document.querySelector(".panel")`);
await sleep(900);
const cov = JSON.parse(await ev(`JSON.stringify((() => {
  const p = document.querySelector(".panel").getBoundingClientRect();
  const c = document.querySelector(".trackpanel svg").getBoundingClientRect();
  return { hidden: +Math.max(0, c.right - p.left).toFixed(1), chart: +c.width.toFixed(0),
           cls: document.body.classList.contains("panelopen") };
})())`));
check("the page moves aside for the record rather than being covered",
  cov.hidden < 1 && cov.cls,
  `chart ${wide.toFixed(0)} -> ${cov.chart} px, ${cov.hidden} px hidden (was 286 px, 24.2%)`);
await ev(`document.querySelector(".panel [aria-label='Close record']")?.click()`);
await sleep(700);
check("closing it gives the width back",
  Math.abs((await ev(`document.querySelector(".trackpanel svg").getBoundingClientRect().width`))
    - wide) < 1 && !(await ev(`document.body.classList.contains("panelopen")`)));

console.log("\n--- b7 / b9  the dialog and the label map ---");
await ev(`location.hash = "#/chr16"`);
await wait(`document.querySelectorAll(".trackpanel").length >= 3`); await sleep(700);
await ev(`(() => { const a = [...document.querySelectorAll("table.tbl tbody tr.hit td a")][0];
  if (a) a.click(); })()`);
await wait(`document.querySelector(".panel")`); await sleep(800);
// The trap's selector is the subject, not whatever the panel happens to render today. A
// <details> is inserted and the selector has to pick its <summary> up; the panel's own content
// used to supply one, and when that disclosure was removed the check failed for the wrong
// reason - it had lost its subject rather than found a regression.
const dlg = JSON.parse(await ev(`JSON.stringify((() => {
  const p = document.querySelector(".panel");
  // The selector the SHIPPED application uses, lifted out of the bundle rather than restated
  // here. A copy of it in this file would agree with itself no matter what main.js did.
  const js = [...document.querySelectorAll("script")].map(s => s.textContent).join("\\n");
  const m = js.match(/button,a\\[href\\][^\`]*/);
  if (!m) return { err: "the trap's selector is not in the shipped bundle" };
  const SEL = m[0];
  const before = [...p.querySelectorAll(SEL)].filter(x => x.offsetParent !== null).length;
  const d = document.createElement("details");
  d.innerHTML = "<summary>probe</summary><p>probe</p>";
  p.append(d);
  const f = [...p.querySelectorAll(SEL)].filter(x => x.offsetParent !== null);
  const got = f.includes(d.querySelector("summary"));
  d.remove();
  return { modal: p.getAttribute("aria-modal"), sel: SEL,
           summaries: got ? 1 : 0, before,
           focusables: f.length, kinds: f.map(x => x.tagName).join(",") };
})())`));
check("the dialog declares itself modal", dlg.modal === "true");
check("the shipped tab trap's own selector reaches a <summary>",
  !dlg.err && dlg.summaries > 0 && dlg.kinds.includes("SUMMARY")
    && /(^|,)summary(,|$)/.test(dlg.sel || ""),
  dlg.err || `${dlg.focusables} focusable, ${dlg.summaries} summary, from the bundle's own `
    + `"${(dlg.sel || "").slice(0, 46)}..."`);
await ev(`document.querySelector(".panel").focus()`);
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key:"/", bubbles:true}))`);
await sleep(400);
check("the / hotkey does not walk out of the open dialog",
  (await ev(`document.activeElement.id`)) !== "q",
  `focus is on ${await ev(`document.activeElement.tagName + "#" + document.activeElement.id`)}`);
await ev(`document.querySelector(".panel [aria-label='Close record']")?.click()`);
await sleep(600);

console.log("\n--- a1 / a2 / a4  the ancestry strip ---");
// chr16 carries the All of Us cluster, so its first association has a strip to read.
await ev(`location.hash = "#/chr16"`);
await wait(`document.querySelectorAll(".trackpanel").length >= 3`); await sleep(700);
await ev(`(() => { const a = [...document.querySelectorAll("table.tbl tbody tr.hit td a")][0];
  if (a) a.click(); })()`);
await wait(`document.querySelector(".panel")`); await sleep(800);

const strip = JSON.parse(await ev(`JSON.stringify((() => {
  const w = document.querySelector(".panel .anc");
  if (!w) return { none: true };
  const c = [...w.querySelectorAll(".achip")];
  return {
    tags: c.map(x => x.tagName),
    keys: c.map(x => (x.querySelector("b") || {}).textContent),
    dashes: c.filter(x => !x.classList.contains("has"))
             .map(x => (x.querySelector("b") || {}).textContent),
    first: (c[0] || {}).textContent,
    detailHidden: w.querySelector(".ancdetail").hidden,
  };
})())`));

check("the whole-cohort estimate is the first chip, with a number",
  !strip.none && strip.keys[0] === "ALL" && /\d\.\d\d/.test(strip.first || ""),
  strip.none ? "no ancestry strip on this association" : `chips: ${strip.keys.join(" ")}`);
// All six, since the workbench released the unthresholded grid. This fails on every build
// before 2026-09-01, which drew EUR/AFR/AMR only.
check("all six strata are drawn, in cohort order",
  !strip.none && String(strip.keys.slice(1)) === String(["EUR","AFR","AMR","EAS","SAS","MID"]),
  strip.none ? "no ancestry strip on this association" : `chips: ${strip.keys.join(" ")}`);

const opened = JSON.parse(await ev(`JSON.stringify((() => {
  const w = document.querySelector(".panel .anc");
  const b = w.querySelectorAll(".achip")[1] || w.querySelector(".achip");
  b.click();
  const d = w.querySelector(".ancdetail");
  return { tag: b.tagName, expanded: b.getAttribute("aria-expanded"),
           hidden: d.hidden, text: d.textContent.slice(0, 80) };
})())`));
check("a chip is a button and clicking it shows its numbers",
  opened.tag === "BUTTON" && opened.expanded === "true" && !opened.hidden
    && /OR |fewer than 20 cases|no usable variance/.test(opened.text),
  `${opened.tag}, ${opened.text.trim()}`);

const closed = JSON.parse(await ev(`JSON.stringify((() => {
  const w = document.querySelector(".panel .anc");
  const b = w.querySelectorAll(".achip")[1] || w.querySelector(".achip");
  b.click();
  return { hidden: w.querySelector(".ancdetail").hidden,
           expanded: b.getAttribute("aria-expanded") };
})())`));
check("clicking it again puts them away",
  closed.hidden && closed.expanded === "false");

// A dash without a reason is the thing the unthresholded grid was requested to remove. Open
// every blank chip on this record and require each to say WHY - either fewer than 20 cases or
// a predictor with no usable variance there. Before the grid the only sentence available named
// a P threshold that was not even the real export rule, so this could not have passed.
const reasons = JSON.parse(await ev(`JSON.stringify((() => {
  const w = document.querySelector(".panel .anc");
  const d = w.querySelector(".ancdetail");
  return [...w.querySelectorAll(".achip")].filter(b => !b.classList.contains("has"))
    .map(b => { b.click(); const t = d.textContent; b.click(); return t; });
})())`));
check("every dash says why it is a dash",
  reasons.every(t => /fewer than 20 cases|no usable variance/.test(t)),
  reasons.length ? `${reasons.length} blank chip(s): ${reasons[0].slice(0, 70)}`
                 : "no blank chips on this record");

await ev(`document.querySelector(".panel [aria-label='Close record']")?.click()`);
await sleep(500);

console.log("\n--- s1 / s2  the mark for the record that is open ---");
// The drawer takes its width out of the page above 1100 px, so the chart stays beside the
// reader while a record is open. Which of chr1's 1,904 marks the record belongs to was
// unsayable from the figure until now. Two cases, because they are drawn differently: a mark
// that carries evidence (5.5 px, on the ramp) and one that does not (2 px, grey, half
// transparent) - the second is the one most addresses land on.
const selState = async (key) => JSON.parse(await ev(`JSON.stringify((() => {
  const dot = document.querySelector('#app .chart svg circle[data-sv="${key}"]');
  const m = document.querySelector("#app .chart .selmark");
  if (!m || !dot) return { mark: !!m, dot: !!dot };
  const rings = [...m.querySelectorAll("circle")];
  const texts = [...m.querySelectorAll("text")];
  const cx = +dot.getAttribute("cx"), cy = +dot.getAttribute("cy");
  const b = dot.getBoundingClientRect();
  return {
    mark: true, dot: true, rings: rings.length,
    name: texts.length ? texts[texts.length - 1].textContent : "",
    texts: texts.length,
    off: Math.max(...rings.map(c => Math.abs(+c.getAttribute("cx") - cx)
      + Math.abs(+c.getAttribute("cy") - cy))),
    grew: Math.min(...rings.map(c => +c.getAttribute("r"))) > +dot.getAttribute("r"),
    anchor: texts.length ? texts[0].getAttribute("text-anchor") : "",
    side: texts.length ? Math.sign(+texts[0].getAttribute("x") - cx) : 0,
    ring: getComputedStyle(rings[rings.length - 1]).stroke,
    accent: window.__hex(getComputedStyle(document.body)
      .getPropertyValue("--accent").trim()),
    hidden: m.getAttribute("aria-hidden"),
    hit: (() => { const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return e === dot ? "the mark" : (e ? e.tagName : "nothing"); })(),
  };
})())`));

await ev(`location.hash = "#/chr1/1996"`);
await wait(`!!document.querySelector(".panel")`);
await sleep(1100);
await ev(`document.querySelector("#app .chart")?.scrollIntoView({ block: "center" })`);
await sleep(400);
const hitSel = await selState("chr1:1996");
check("opening a record rings its mark on the chart",
  hitSel.mark === true && hitSel.rings === 2 && hitSel.off === 0 && hitSel.grew === true,
  `${hitSel.rings} ring(s), centre off by ${hitSel.off}px, outside the mark: ${hitSel.grew}`);
check("and names the variant the drawer names",
  hitSel.name === "chr1_sv1996_DEL" && hitSel.texts === 2,
  `"${hitSel.name}", ${hitSel.texts} pass(es) counting the halo`);
check("the ring is drawn in the accent, resolved rather than written down",
  !!hitSel.accent && hitSel.ring === hitSel.accent, `${hitSel.ring} against ${hitSel.accent}`);
// chr1_sv1996_DEL sits 126.26 Mb, inside 120 px of the right edge, so its name turns round.
check("a name near the right edge turns round rather than running off",
  hitSel.anchor === "end" && hitSel.side < 0,
  `anchor ${hitSel.anchor}, name drawn ${hitSel.side < 0 ? "left" : "right"} of the mark`);
check("it takes no pointer events, so the mark underneath still answers",
  hitSel.hidden === "true" && hitSel.hit === "the mark",
  `aria-hidden ${hitSel.hidden}, the point over the mark reaches ${hitSel.hit}`);

// The repaint case: the marks are rebuilt from scratch whenever a filter moves, and the
// drawer stays open across it.
await ev(`(() => { const b = document.getElementById("onlyhits");
  b.checked = true; b.dispatchEvent(new Event("change")); })()`);
await sleep(1200);
const afterPaint = await selState("chr1:1996");
await ev(`(() => { const b = document.getElementById("onlyhits");
  b.checked = false; b.dispatchEvent(new Event("change")); })()`);
await sleep(1000);
check("a repaint under the open drawer puts it back",
  afterPaint.mark === true && afterPaint.off === 0 && afterPaint.name === "chr1_sv1996_DEL",
  `after the evidence-only filter: ${afterPaint.mark ? "still marked" : "gone"}`);

// The case the whole thing is for: 10,467 of the 10,705 catalogued SVs carry no evidence and
// are drawn 2 px wide, and every one of them has a record the table view links to.
await ev(`document.querySelector(".panel [aria-label='Close record']")?.click()`);
await sleep(500);
await ev(`location.hash = "#/chr1/565"`);
await wait(`!!document.querySelector(".panel")`);
await sleep(1100);
await ev(`document.querySelector("#app .chart")?.scrollIntoView({ block: "center" })`);
await sleep(400);
const greySel = await selState("chr1:565");
check("a variant with no evidence is marked the same way",
  greySel.mark === true && greySel.rings === 2 && greySel.off === 0
  && greySel.name === "chr1_sv565_DEL" && greySel.grew === true,
  `2 px grey mark: ${greySel.rings} ring(s), "${greySel.name}"`);

// Counted before as well as after, so this says the mark went away rather than that it was
// never there: on the build before it, the pair reads 0 and 0 and the check fails.
const selBefore = await ev(`document.querySelectorAll("#app .chart .selmark").length`);
await ev(`document.querySelector(".panel [aria-label='Close record']")?.click()`);
await sleep(600);
const selAfter = await ev(`document.querySelectorAll("#app .chart .selmark").length`);
check("closing the drawer takes the mark off again",
  selBefore === 1 && selAfter === 0, `${selBefore} mark open -> ${selAfter} closed`);

await ev(`location.hash = "#/find/" + encodeURIComponent("chr8:44300221")`);
await sleep(1400);
const kinds = await ev(`[...document.querySelectorAll(".hitlist .kind")].map(e => e.textContent)`);
check("a coordinate search names its kind properly",
  kinds.length > 0 && kinds.every(k => k && k[0] === k[0].toUpperCase()),
  `kinds: ${JSON.stringify(kinds)}`);

console.log(`\n${fails.length ? fails.length + " FAILED" : "ALL PASS"}`
  + ` - ${ran} checks, ${fails.length} failed`);
chrome.kill(); server.close();
process.exit(fails.length ? 1 : 0);
