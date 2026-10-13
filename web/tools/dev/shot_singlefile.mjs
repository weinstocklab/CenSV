/**
 * Screenshot one route of a SINGLE-FILE build, as JPG.
 *
 *   node web/tools/dev/shot_singlefile.mjs <build.html> <route> <out.jpg> [w] [h] [sel] [theme]
 *
 * `sel` clips the capture to the first element matching it, which is what a figure for a
 * README or a deck wants; without it the whole page is captured. `theme` is light or dark,
 * and sets the attribute the theme toggle sets, so the capture shows the palette a reader
 * on that setting sees.
 *   node web/tools/dev/shot_singlefile.mjs ../CenSV_offline.html "#/chr5/haplotypes/193" \
 *        /c/temp/shots/chr5_193.jpg 1600 3200
 *
 * `shot.sh` beside this one drives the preview server, which is the right tool while editing.
 * This one drives the artefact a reader opens, which is the thing to look at before publishing
 * and the only one that carries the payload as shipped. The file is served over
 * http://localhost rather than opened from disk, because a locked build needs crypto.subtle
 * and browsers expose it only in a secure context.
 *
 * Chrome writes the JPG directly through Page.captureScreenshot, so no PNG is ever produced.
 *
 * Three things learned the hard way, all still true here:
 *   * the haplotype page scrolls the selected row into view, so on a chromosome with hundreds
 *     of monophyletic rows the figure lands above the viewport and the capture comes out
 *     blank. Give it a tall window, or pick a short page - chr5 has 38 rows, chr8 28,
 *     chr16 23.
 *   * a window under about 1200 px collapses the figure; 1600 and above renders the settled
 *     layout.
 *   * reduced motion is forced, so the capture lands after the 160 ms entrance animation
 *     rather than inside it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [TARGET, ROUTE, OUT, W = "1600", H = "3200", SEL = "", THEME = "light"] =
  process.argv.slice(2);
if (!TARGET || !ROUTE || !OUT) {
  console.error("usage: shot_singlefile.mjs <build.html> <route> <out.jpg> [w] [h]");
  process.exit(2);
}
const PORT = 4198, CDP = 9242;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const html = fs.readFileSync(path.resolve(TARGET));
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(html);
}).listen(PORT);
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-shot-singlefile");
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
  "--force-prefers-reduced-motion", `--window-size=${W},${H}`,
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + PROFILE,
  `http://localhost:${PORT}/`], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true,
    awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
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
await new Promise((r) => { ws.onopen = r; if (ws.readyState === 1) r(); });
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await send("Runtime.enable"); await send("Page.enable");
for (let t = 0; t < 60000; t += 200) {
  if (await ev("!!document.querySelector('.grid, table')")) break;
  await sleep(200);
}
// The theme goes on before the route, so nothing is drawn twice.
if (THEME === "dark") await ev(`document.documentElement.setAttribute("data-theme", "dark")`);
await ev(`location.hash = ${JSON.stringify(ROUTE)}`);
for (let t = 0; t < 30000; t += 200) {
  if (await ev("!!document.querySelector('#app .hapsvg, #app svg, #app table')")) break;
  await sleep(200);
}
await sleep(900);
await ev("window.scrollTo(0, 0)");
// The box to capture. Read after the route has settled, so a figure that lays itself out on
// the data - the tree, the stacked tracks - is measured at the size it ends up.
const box = SEL ? await ev(`(() => {
  const e = document.querySelector(${JSON.stringify(SEL)});
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 };
})()`) : null;
if (SEL && !box) {
  console.error(`nothing matches ${SEL} on ${ROUTE}`);
  process.exit(3);
}
const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 90,
  captureBeyondViewport: true, ...(box ? { clip: box } : {}) });
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), Buffer.from(r.data, "base64"));
console.log(`${OUT}  ${box ? Math.round(box.width) + "x" + Math.round(box.height)
  : W + "x" + H}  ${ROUTE}  ${THEME}${SEL ? "  " + SEL : ""}`);
try { chrome.kill(); } catch { /* gone */ }
server.close();
process.exit(0);
