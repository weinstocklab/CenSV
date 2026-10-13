/**
 * Four checks that "Stacked by ancestry" decomposes the pooled dip track rather than
 * redrawing it, driven through real Chrome over the DevTools protocol.
 *
 *   CENSV_PW="$(cat ~/.censv_password)" node web/tools/verify/verify_dip_modes.mjs <file|url> [chrom...]
 *
 * The control tells the reader the stack is "the same total, split" and that "the silhouette
 * is identical to the pooled track". Nothing in the build checks a claim like that, and on
 * 2026-08-29 it was false: the stack drew in a 118 px panel against the pooled track's 78, so
 * the same data stood 1.51x taller and the figure below it moved 70 px down the page. Every
 * crypto and data check passed on that page, because none of them look at the drawing.
 *
 * So this measures the drawing. Both modes are rendered in one browser, and the pixel
 * geometry is compared: the figure's size, the dip axis, where the bars are, and how tall
 * each bin's column stands. Only the fills are allowed to differ.
 *
 * A local file is served over http://localhost rather than opened from disk, because an
 * encrypted build needs crypto.subtle and browsers expose it only in a secure context.
 * Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2] || path.join(HERE, "..", "..", "..", "CenSV_locked.html");
const CHROMS = process.argv.slice(3).length ? process.argv.slice(3)
  : ["chr20", "chr4", "chr8"];
const LIVE = /^https?:/.test(TARGET);
const FILE = LIVE ? null : path.resolve(TARGET);
const PORT = 4181;
const CDP = 9224;
const PW = process.env.CENSV_PW || "";
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const html = LIVE ? null : fs.readFileSync(FILE);
const fails = [];
let ran = 0;
const check = (name, ok, detail = "") => {
  ran += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name.padEnd(52)} ${detail}`);
  if (!ok) fails.push(name);
};

const server = LIVE ? null : http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(PORT);
const ORIGIN = LIVE ? TARGET : `http://localhost:${PORT}/`;
const HOST = new URL(ORIGIN).host;

const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-dipmodes");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion",
  "--window-size=1500,1400", "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + PROFILE, "--disk-cache-size=1", "--media-cache-size=1", ORIGIN,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception;
    throw new Error((e && e.description) || r.exceptionDetails.text);
  }
  return r.result.value;
};
const waitFor = async (expr, ms = 25000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await evaluate("!!(" + expr + ")")) return true;
    await sleep(100);
  }
  return false;
};

for (let i = 0; i < 80; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:" + CDP + "/json")).json();
    const page = targets.find((t) => t.type === "page" && t.url.includes(HOST));
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome is still coming up; the loop is the timeout */ }
  await sleep(250);
}
if (!ws) { console.error("could not attach to Chrome"); process.exit(2); }
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable"); await send("Runtime.enable");
console.log(LIVE ? `driving ${ORIGIN}\n` : `driving ${FILE}\n  served at ${ORIGIN}\n`);

// An encrypted build raises its gate once the script has armed the form; an open build never
// does. Both are legitimate targets, so which one this is decides whether a password is typed.
const gated = await waitFor(
  'document.getElementById("gate") && !document.getElementById("gate").hidden', 8000);
if (gated) {
  if (!PW) { console.error("this build is encrypted; set CENSV_PW"); process.exit(2); }
  await evaluate('(() => { const i = document.getElementById("pw"); i.value = '
    + JSON.stringify(PW) + '; document.getElementById("form")'
    + '.dispatchEvent(new Event("submit", { cancelable: true })); })()');
}
if (!await waitFor('document.querySelectorAll(".grid a.card").length === 23', 30000)) {
  console.error(gated ? "the password did not open it" : "the site did not draw");
  process.exit(2);
}

// The measurement. The baseline is read off the dip axis's own zero tick rather than from
// the rectangles, so a bar that is floored to a visible minimum cannot move it.
const MEASURE = `(() => {
  const r_fill = (e) => e.getAttribute("fill") || "";
  const lab = [...document.querySelectorAll("text.tlab")]
    .filter(t => t.textContent.indexOf("dips per haplotype") === 0)[0];
  if (!lab) return JSON.stringify({ error: "no dip track" });
  const gd = lab.parentNode;
  const svg = gd.ownerSVGElement;
  const axis = gd.querySelector("g.axis");
  const ticks = [...axis.querySelectorAll("g.tick")].map(t => ({
    v: t.querySelector("text").textContent,
    y: +(t.getAttribute("transform").split(",")[1] || "0").replace(")", ""),
  }));
  const zero = ticks.filter(t => parseFloat(t.v) === 0)[0];
  const byX = new Map();
  // The hover targets are rects in this group too, and they are identical in every mode -
  // counting them would dilute the comparison with columns that can never differ.
  [...gd.children].filter(e => e.tagName === "rect"
                          && r_fill(e) !== "transparent").forEach(r => {
    const x = +r.getAttribute("x");
    const c = byX.get(x) || { x, w: +r.getAttribute("width"), top: Infinity, ink: 0 };
    c.top = Math.min(c.top, +r.getAttribute("y"));
    c.ink += +r.getAttribute("height");
    byX.set(x, c);
  });
  const cols = [...byX.values()].sort((a, b) => a.x - b.x).map(c => ({
    x: +c.x.toFixed(4), w: +c.w.toFixed(4), h: +(zero.y - c.top).toFixed(4),
    ink: +c.ink.toFixed(4),
  }));
  return JSON.stringify({ viewBox: svg.getAttribute("viewBox"), ticks, cols });
})()`;

const mode = async (m) => {
  await evaluate('(() => { const r = document.getElementById("dip-' + m
    + '"); r.checked = true; r.dispatchEvent(new Event("change")); })()');
  await sleep(700);
  const o = JSON.parse(await evaluate(MEASURE));
  if (o.error) throw new Error(o.error);
  return o;
};

for (const chrom of CHROMS) {
  await evaluate(`location.hash = "#/${chrom}"`);
  if (!await waitFor(`document.querySelector('svg[aria-label^="${chrom}:"]')`, 15000)) {
    check(`${chrom} drew`, false, "no chart"); continue;
  }
  await sleep(400);
  const p = await mode("pooled");
  const a = await mode("ancestry");

  check(`${chrom}  the figure is the same size in both modes`,
    p.viewBox === a.viewBox, `pooled ${p.viewBox} · stacked ${a.viewBox}`);

  const axisSame = JSON.stringify(p.ticks) === JSON.stringify(a.ticks);
  check(`${chrom}  the dip axis is the same in both modes`, axisSame,
    `${p.ticks.map(t => t.v + "@" + t.y.toFixed(1)).join(" ")}` +
    (axisSame ? "" : ` vs ${a.ticks.map(t => t.v + "@" + t.y.toFixed(1)).join(" ")}`));

  // The stack omits bins with nothing in them; the pooled track draws them at zero height.
  // Those are the only bins allowed to be missing, and the check says so rather than
  // quietly intersecting.
  const A = new Map(a.cols.map(c => [c.x, c]));
  const dropped = p.cols.filter(c => !A.has(c.x));
  const shared = p.cols.filter(c => A.has(c.x));
  // Height above the zero TICK carries d3's half-pixel offset, so an empty bin reads 0.5
  // there; what says a bin is empty is that the pooled track drew no ink in it.
  const dTop = dropped.reduce((m, c) => Math.max(m, Math.abs(c.ink)), 0);
  const dH = shared.reduce((m, c) => Math.max(m, Math.abs(c.h - A.get(c.x).h)), 0);
  const dW = shared.reduce((m, c) => Math.max(m, Math.abs(c.w - A.get(c.x).w)), 0);
  // Both comparisons below are maxima over `shared`, and a maximum over an empty list is
  // 0, so both passed on a figure that drew no bars at all. The shipped tracks are 60 bins
  // on every chromosome - build.yml asserts `[.meth[] | length] | unique == [60]` - so a
  // floor of 30 is generous and still catches a collapse.
  check(`${chrom}  the pooled track drew bins to compare`, shared.length >= 30,
    `${shared.length} of ${p.cols.length} pooled columns shared with the stack`);
  check(`${chrom}  every bin stands at the same height`, dH < 0.01,
    `${shared.length} bins compared, largest difference ${dH.toFixed(3)} px`);
  check(`${chrom}  the bars are in the same places`, dW < 0.01 && dTop < 0.01,
    `${dropped.length} empty bins undrawn (most ink ${dTop.toFixed(3)} px), ` +
    `widths differ by ${dW.toFixed(3)} px`);
}

console.log(`\n${fails.length ? fails.length + " FAILED" : "ALL PASS"}`
  + ` - ${ran} checks over ${CHROMS.length} chromosomes`);
chrome.kill();
if (server) server.close();
process.exit(fails.length ? 1 : 0);
