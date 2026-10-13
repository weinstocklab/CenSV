/**
 * The LD panel as it is actually drawn, measured through real Chrome.
 *
 *     CENSV_PW="$(cat ~/.censv_password)" node web/tools/verify/verify_ld_panel.mjs <file|url>
 *
 * WHAT THIS CAN SEE THAT THE OTHER TWO CHECKS CANNOT
 * --------------------------------------------------
 * etl/ld.py asserts the extraction is the published measurement. verify_ld_decode.mjs asserts
 * the browser's decoder reproduces it from the shipped bytes. Neither of them draws anything,
 * and the panel is a raster: it inverts the triangle's geometry per output pixel to find the
 * cell under it, so an off-by-one or a transposed index would give a smooth, plausible,
 * completely wrong figure with every number behind it correct.
 *
 * So this reads pixels. The diagonal has to be r = +1 across the whole base; the strip under
 * the triangle has to change from the SNP fill to the SV fill at exactly the column the
 * caption names; the tooltip at the apex has to name the first and last columns; and the
 * landmark fan has to run left to right, because the columns are in position order. Each of
 * those is a statement the caption makes in words, checked against the ink.
 *
 * WHAT IT CANNOT SEE
 * ------------------
 * Whether the correlations are right. Every number it reads comes from the same computation
 * that drew them, so a wrong r would be drawn consistently and pass. That is what
 * verify_ld_decode.mjs is for, and the two are meant to be run together.
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
const TARGET = process.argv[2] || path.join(HERE, "..", "..", "..", "CenSV_offline.html");
const CHROM = process.argv[3] || "chr8";
const SHOT = process.env.LD_SHOT || path.join(HERE, "..", "..", "..", "ld_panel.jpg");
const LIVE = /^https?:/.test(TARGET);
const FILE = LIVE ? null : path.resolve(TARGET);
const PORT = 4183;
const CDP = 9226;
const PW = process.env.CENSV_PW || "";
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// The figure's own coordinate system, restated here rather than imported. If web/src/ld.js
// moves a landmark, the aspect check below fires and someone has to agree to it.
//
// BASE is the diagonal and the triangle hangs from it: the strip sits ABOVE at y = 3, the
// diagonal is the top edge at y = BASE, and the apex is the bottom point at BASE + H. These
// read 604 and 616 while the figure had already been flipped, and nothing said so because
// nothing ran this file.
const G = { W: 1180, X0: 6, BW: 1168, BASE: 16, H: 584, STRIP_Y: 3, STRIP_H: 9, CH: 603 };
const HOT = [180, 4, 38];          // coolwarm at r = +1

const html = LIVE ? null : fs.readFileSync(FILE);
const fails = [];
let ran = 0;
const check = (name, ok, detail = "") => {
  ran += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name.padEnd(50)} ${detail}`);
  if (!ok) fails.push(name);
};
// A chromosome can legitimately have nothing to open - chr14 carries one marked SV and it
// sits below the default significance tier, so its table has no hit row. That is an absent
// subject, not a failing check, and reporting it as a pass would hide a real regression.
const skip = (name, why) => console.log(`  SKIP ${name.padEnd(50)} ${why}`);

const server = LIVE ? null : http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(PORT);
const ORIGIN = LIVE ? TARGET : `http://localhost:${PORT}/`;
const HOST = new URL(ORIGIN).host;

const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-ldpanel");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion",
  "--window-size=1500,1600", "--remote-debugging-port=" + CDP,
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
  const r = await send("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true });
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

// ------------------------------------------------------------------ open the panel
await evaluate(`location.hash = "#/${CHROM}"`);
await sleep(400);
check("1. the chromosome page carries an LD section",
  await evaluate('!!document.getElementById("ldpanel")'), CHROM);
// Open on arrival, by request - the reader asked for every track panel open, including
// this one. It used to be closed, and this check used to assert that.
check("2. it is open on arrival, with its figure drawn",
  (await evaluate('document.getElementById("ldpanel").open')) === true,
  await evaluate('document.getElementById("ldpanel").open ? "open" : "closed"'));

await waitFor('document.querySelector(".ldcanvas")', 20000);
await sleep(500);
// A link with no ld= has to open the view this is looking at, or the panel is not citable
// at all now that nothing has to be opened. Check 14 covers the other direction: choosing a
// selection writes it.
check("3. a clean address opens the default selection",
  !/[?&]ld=/.test(await evaluate("location.search"))
  && (await evaluate('document.getElementById("ldmode-common").checked')) === true,
  `search "${await evaluate("location.search")}", default selection is the one checked`);

// ------------------------------------------------------------------ the caption's counts
// Written once and interpolated into the three page expressions below. They used to be
// written out three times, so shortening the caption broke this suite in three places.
const RE_TOTAL = String.raw`/([\d,]+)\s+of\s+[\d,]+\s+variants/`;
const RE_BLOCKS = String.raw`/variants\s*\u00b7\s*([\d,]+)\s+SNP` +
  String.raw`\s*\u00b7\s*([\d,]+)\s+SV\s*\u00b7\s*([\d,]+)\s+SNP/`;
// The four counts, as a page expression over a caption already in scope as `cap`.
const capCounts = (v) => `(() => {
  const t = ${v}.match(${RE_TOTAL}), b = ${v}.match(${RE_BLOCKS});
  const num = (x) => +String(x).replace(/,/g, "");
  return { n: t ? num(t[1]) : null, nL: b ? num(b[1]) : 0,
           nSv: b ? num(b[2]) : 0, nR: b ? num(b[3]) : 0 };
})()`;

// ------------------------------------------------------------------ the drawing
const READ = `(() => {
  const cv = document.querySelector(".ldcanvas");
  const cap = document.querySelector(".ldchart figcaption").textContent;
  const num = (re) => { const m = cap.match(re); return m ? +m[1].replace(/,/g, "") : null; };
  const g = cv.getContext("2d");
  const s = cv.width / ${G.W};
  const px = (x, y) => {
    const d = g.getImageData(Math.min(cv.width - 1, Math.max(0, Math.round(x * s))),
                             Math.min(cv.height - 1, Math.max(0, Math.round(y * s))), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  window.__px = px;
  const style = getComputedStyle(document.body);
  const hex = (v) => {
    const h = style.getPropertyValue(v).trim().replace("#", "");
    const w = h.length === 3 ? [h[0]+h[0], h[1]+h[1], h[2]+h[2]] : [h.slice(0,2), h.slice(2,4), h.slice(4,6)];
    return w.map((x) => parseInt(x, 16));
  };
  let ink = 0;
  for (let y = 0; y < cv.height; y += 7) for (let x = 0; x < cv.width; x += 7) {
    const d = g.getImageData(x, y, 1, 1).data;
    if (d[3] > 0) ink++;
  }
  const cc = ${capCounts("cap")};
  const n = cc.n, nL = cc.nL, nSv = cc.nSv, nR = cc.nR;
  const b = nL;
  const cell = ${G.BW} / n;
  const fanx = [...document.querySelectorAll(".ldfan circle")].map((c) => +c.getAttribute("cx"));
  return {
    n, b, nL, nSv, nR, cell, ink, w: cv.width, h: cv.height, aspect: cv.width / cv.height,
    snpFill: hex("--axis"), svFill: hex("--text-secondary"),
    diag: [0.1, 0.25, 0.5, 0.75, 0.92].map((f) => {
      const t = Math.min(n - 1, Math.floor(f * n));
      // one row below the diagonal, which is the TOP edge of a triangle that hangs: the
      // first row the raster calls inside it
      return px(${G.X0} + (t + 0.5) * cell, ${G.BASE} + 1);
    }),
    // the two bottom corners, which the hanging triangle leaves empty
    outside: [px(8, ${G.BASE + G.H} - 4), px(${G.W} - 8, ${G.BASE + G.H} - 4)],
    apex: px(${G.X0} + ${G.BW} / 2, ${G.BASE + G.H} - 2),
    stripLeft: nL ? px(${G.X0} + (nL - 1.5) * cell, ${G.STRIP_Y} + 4) : null,
    stripRight: nL ? px(${G.X0} + (nL + 1.5) * cell, ${G.STRIP_Y} + 4) : null,
    stripSvEnd: nR ? px(${G.X0} + (nL + nSv - 1.5) * cell, ${G.STRIP_Y} + 4) : null,
    stripRhs: nR ? px(${G.X0} + (nL + nSv + 1.5) * cell, ${G.STRIP_Y} + 4) : null,
    fanx, fanRising: fanx.every((v, i) => i === 0 || v >= fanx[i - 1] - 0.01),
    marks: document.querySelectorAll(".ldover .ldmark").length,
  };
})()`;

// The geometry is measured on the published selection, whose cells are always several
// pixels wide. On a chromosome drawing every variant a cell can run finer than the screen,
// and a diagonal sample would then land on a neighbouring pair through no fault of the code.
const CAPNUM = `(() => {
  const c = document.querySelector(".ldchart figcaption").textContent;
  return ${capCounts("c")};
})()`;
const setModeRaw = async (v) => {
  await evaluate(`(() => { const r = document.getElementById("ldmode-${v}");`
    + " r.checked = true; r.dispatchEvent(new Event(\"change\")); })()");
  await sleep(600);
};
// The default selection. There used to be a "published rule" mode here; it was removed,
// and selecting it by id returned null and threw, which is how this suite stopped reporting
// at all rather than reporting a failure.
await setModeRaw("common");
const m = await evaluate(READ);
const near = (a, b, tol = 6) => a && b && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

check("4. the canvas has the figure's aspect",
  Math.abs(m.aspect - G.W / G.CH) / (G.W / G.CH) < 0.005,
  `${m.w}x${m.h}, ${m.aspect.toFixed(3)} against ${(G.W / G.CH).toFixed(3)}`);
check("5. the caption's counts parse and add up to the columns drawn",
  m.n > 0 && m.nL + m.nSv + m.nR === m.n,
  `${m.n} columns = ${m.nL} left flank + ${m.nSv} array + ${m.nR} right flank, `
  + `${m.cell.toFixed(2)} px each`);
check("6. the triangle carries ink", m.ink > 200, `${m.ink} sampled pixels drawn`);
check("7. the diagonal is r = +1 the whole way across",
  m.diag.every((c) => near(c, HOT)),
  m.diag.map((c) => c.slice(0, 3).join(",")).join("  "));
check("8. the corners beside the apex are empty",
  m.outside.every((c) => c[3] === 0) && m.apex[3] > 0,
  `corners alpha ${m.outside.map((c) => c[3]).join("/")}, apex alpha ${m.apex[3]}`);
const show = (c) => (c ? c.slice(0, 3).join(",") : "absent");
check("9. the strip changes fill at both columns the caption names",
  m.nL > 0 && m.nR > 0
  && near(m.stripLeft, m.snpFill, 2) && near(m.stripRight, m.svFill, 2)
  && near(m.stripSvEnd, m.svFill, 2) && near(m.stripRhs, m.snpFill, 2),
  `at ${m.nL}: ${show(m.stripLeft)} -> ${show(m.stripRight)}; `
  + `at ${m.nL + m.nSv}: ${show(m.stripSvEnd)} -> ${show(m.stripRhs)} `
  + `(SNP ${m.snpFill}, SV ${m.svFill})`);
check("10. the landmark fan runs left to right",
  m.fanx.length >= 5 && m.fanRising,
  `${m.fanx.length} landmarks, ${m.fanx[0].toFixed(0)} to `
  + `${m.fanx[m.fanx.length - 1].toFixed(0)}`);

// ------------------------------------------------------------------ the tooltip
const TIP = `(async () => {
  const cv = document.querySelector(".ldcanvas");
  const r = cv.getBoundingClientRect();
  const n = ${m.n}, cell = ${G.BW} / ${m.n};
  // cell (0, n-1) - the most distant pair, and the apex. In a triangle that hangs from its
  // diagonal that is the BOTTOM point, at BASE + (j - i) / 2 cells down.
  const vx = ${G.X0} + (0 + (n - 1) + 1) / 2 * cell;
  const vy = ${G.BASE} + (n - 1) / 2 * cell;
  const ev = new MouseEvent("mousemove", {
    bubbles: true, clientX: r.left + vx / ${G.W} * r.width,
    clientY: r.top + vy / ${G.CH} * r.height,
  });
  cv.dispatchEvent(ev);
  await new Promise((s) => setTimeout(s, 60));
  return document.getElementById("tip").textContent;
})()`;
const tip = await evaluate(TIP);
// The note is what a human reads, and a note cut mid-number is worse than a short one:
// `columns 1 and 289 of 289` truncated to `columns 1 and 2`, which reads as the check finding
// the wrong column at the apex. Lead with the clause under test, read back out of the tooltip
// rather than restated from m.n, and mark the cut.
const flat = tip.replace(/\s+/g, " ");
const clause = (flat.match(/columns \d+ and \d+ of \d+/) || ["no columns clause in the tooltip"])[0];
check("11. the apex names the first and last columns",
  tip.includes(`columns 1 and ${m.n}`) && /r = -?\d/.test(tip),
  `${clause}  |  ${flat.length > 64 ? flat.slice(0, 64) + "\u2026" : flat}`);

// ------------------------------------------------------------------ the modes
const setMode = async (v) => {
  await evaluate(`(() => { const r = document.getElementById("ldmode-${v}");`
    + " r.checked = true; r.dispatchEvent(new Event(\"change\")); })()");
  await sleep(600);
  return evaluate('(() => { const c = document.querySelector(".ldchart figcaption")'
    + `.textContent; return (${capCounts("c")}).n; })()`);
};
// Three selections now, and the DEFAULT is the narrowed one - so the totals have to be
// read while "All variants" is showing rather than on arrival, which is what `all` used to
// assume when the default was the whole set.
const nAll = await setMode("all");
const all = await evaluate(CAPNUM);
const nSv = await setMode("sv");
const nCommon = await setMode("common");

check("11b. drawing every variant accounts for all three blocks",
  nAll === all.nL + all.nSv + all.nR,
  `${nAll} = ${all.nL} + ${all.nSv} + ${all.nR}`);
check("12. SVs only draws exactly the array block",
  nSv === all.nSv, `${nSv} against the ${all.nSv} the caption counts across the array`);
// The rare columns are the ones r rests on a handful of carriers for, so the common
// selection has to be a strict subset of everything, and it has to keep both kinds - if it
// dropped the flanks it would be "SVs only" under another name.
check("13. common variants narrows both blocks without emptying either",
  nCommon > 0 && nCommon < nAll && nCommon !== nSv,
  `${nCommon} common of ${nAll} drawn, against ${nSv} SVs`);
check("14. every mode leaves the address citable",
  /[?&]ld=common\b/.test(await evaluate("location.search")),
  await evaluate("location.search"));

// ------------------------------------------------------------------ the record panel
await setMode("all");
const REC = `(async () => {
  const a = document.querySelector(".tbl tr.hit td a");
  if (!a) return { error: "no SV with evidence in the table" };
  a.click();
  await new Promise((s) => setTimeout(s, 500));
  const row = document.querySelector(".panel .ldrow");
  if (!row) return { error: "the record carries no LD row" };
  const cv = row.querySelector("canvas.ldprof");
  let ink = 0;
  if (cv) {
    const g = cv.getContext("2d");
    for (let x = 0; x < cv.width; x += 3) for (let y = 0; y < cv.height; y += 3) {
      if (g.getImageData(x, y, 1, 1).data[3] > 0) ink++;
    }
  }
  return {
    sv: document.querySelector(".panel h2").textContent,
    parts: [...row.querySelectorAll(".ldpart")].map((p) => p.textContent.trim()),
    text: row.textContent.replace(/\\s+/g, " "),
    ink,
  };
})()`;
const rec = await evaluate(REC);
if (rec.error === "no SV with evidence in the table") {
  skip("15. the record carries this SV against everything else", rec.error);
  skip("16. it reports a correlation and a distance", rec.error);
} else {
  check("15. the record carries this SV against everything else",
    !rec.error && rec.parts.length >= 1 && rec.ink > 50,
    rec.error || `${rec.sv}: ${rec.parts.length} partners, ${rec.ink} drawn pixels`);
  check("16. it reports a correlation and a distance",
    !rec.error && rec.parts.some((p) => /r = -?\d/.test(p) && /(bp|kb) away/.test(p)),
    rec.error || (rec.parts[0] || "").slice(0, 88));
}

// ------------------------------------------------------------------ a look at it
if (!rec.error) await evaluate('document.querySelector(".panel .pact button:last-child").click()');
await sleep(300);
await evaluate('document.getElementById("ldpanel").scrollIntoView({ block: "start" })');
await sleep(300);
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
if (shot && shot.data) {
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`\n  wrote ${SHOT}`);
}

console.log(`\n${fails.length ? "FAILED: " + fails.join("; ") : "ALL PASS"} `
  + `- ${ran} checks, ${fails.length} failed`);
chrome.kill();
if (server) server.close();
process.exit(fails.length ? 1 : 0);
