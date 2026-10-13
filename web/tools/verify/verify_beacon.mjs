/**
 * Does the visit beacon actually fire, and does it send one row?
 *
 *   CENSV_GOATCOUNTER=censv node web/tools/verify/verify_beacon.mjs <build.html>
 *
 * WHY THIS EXISTS. The beacon's first home was web/index.html, before `</body>`. It survived
 * every check: the tag was in the source, it was in the built container, and the check written
 * to guard it searched the decoded container and found it. It could never have fired. boot()
 * does `document.body.innerHTML = doc.body.innerHTML`, and a script that arrives through
 * innerHTML never executes - so the published page would have carried a beacon that was
 * markup and nothing else, and no amount of reading the file would have said so.
 *
 * The lesson is narrow and worth keeping: PRESENCE IS NOT RUNNING. The only instrument that
 * can tell the difference is a browser, so this drives one and watches the network.
 *
 * The vendor's count.js is allowed to load, since the question is what GoatCounter's own code
 * does with this page and a stand-in would only test the stand-in. The COUNT request is failed
 * at the protocol layer, so the real logic runs, its request is read in full, and no dashboard
 * receives anything. Needs the network for that one script; with none, the first check says so.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TARGET = path.resolve(process.argv[2] || "CenSV_offline.html");
const WANT = (process.env.CENSV_GOATCOUNTER || "").trim();
const PORT = 4201, CDP = 9245;
const CHROME = process.env.CHROME
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// count.js declines to count a page served from localhost - that is what GoatCounter's
// `allow_local` setting exists for - so the SERVED COPY gets it and the file on disk keeps
// its shipped configuration. One property, the one whose whole purpose is local testing, and
// the run prints whether it had to be added.
const LOCAL = 'window.goatcounter = { path: "/", allow_local: true }';
const onDisk = fs.readFileSync(TARGET, "utf8");
const html = Buffer.from(
  onDisk.replace('window.goatcounter = { path: "/" }', LOCAL), "utf8");
const fixture = html.includes(LOCAL);
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); r.end(html);
}).listen(PORT);
const PROFILE = path.join(process.env.TEMP || "/tmp", "cdp-beacon-" + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1400,1800", "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + PROFILE, `http://localhost:${PORT}/`], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const seen = [];
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p })); });
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  // Every outbound request is recorded. The vendor's script is allowed to LOAD, because the
  // question is what GoatCounter's own code does with this page - a stand-in would only test
  // the stand-in. The count itself is failed at the protocol layer, so the real logic runs,
  // its request is observed in full, and nobody's dashboard receives anything.
  if (m.method === "Fetch.requestPaused") {
    const u = m.params.request.url;
    if (!u.includes("localhost:" + PORT)) seen.push(u);
    if (/goatcounter\.com\/count/.test(u)) {
      send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" });
    } else {
      send("Fetch.continueRequest", { requestId: m.params.requestId });
    }
  }
};
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await send("Page.enable");
await send("Page.navigate", { url: `http://localhost:${PORT}/` });
await sleep(4500);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name.padEnd(54)} ${detail}`);
};

const cards = await new Promise(async (res) => {
  const r = await send("Runtime.evaluate", {
    expression: 'document.querySelectorAll(".grid a.card").length', returnByValue: true });
  res(r.result?.value);
});
check("the page booted", cards === 23,
  `${cards} chromosome cards${WANT ? ", allow_local " + (fixture ? "added for the test" : "ABSENT") : ""}`);

// Deduplicated: a protocol-relative src on an http test origin is requested, redirected and
// requested again, which is an artefact of the harness and not of the page.
const urls = [...new Set(seen)];
const beacons = urls.filter((u) => u.includes("goatcounter.com") || u.includes("gc.zgo.at"));
const stray = urls.filter((u) => !beacons.includes(u));

if (WANT) {
  const script = beacons.filter((u) => u.includes("gc.zgo.at"));
  // The count, which is the goatcounter.com host - gc.zgo.at serves the SCRIPT and its path
  // is /count.js, so a bare "/count" test matches the script too and reads the wrong request.
  const counts = beacons.filter((u) => /goatcounter\.com\/count\?/.test(u));
  check("the beacon's script is fetched", script.length >= 1,
    script.length ? script.join(" ") : "no request to gc.zgo.at - a tag that cannot run");
  console.log("    outbound: " + (urls.length ? urls.join(" | ") : "none"));
  check("it counts against the site it was built for",
    counts.length === 1 && counts[0].includes(`${WANT}.goatcounter.com`),
    counts.length ? counts[0].slice(0, 110) : "no count request");
  const one = counts[0] || "";
  const p = /[?&]p=([^&]*)/.exec(one);
  check("it sends one row, at /", p ? decodeURIComponent(p[1]) === "/" : false,
    p ? `p=${decodeURIComponent(p[1])}` : "no path parameter to read");
} else {
  check("a build with no code reaches no beacon", beacons.length === 0,
    beacons.length ? beacons.join(" ") : "none attempted");
}
check("nothing else leaves the page", stray.length === 0,
  stray.length ? stray.slice(0, 3).join(" ") : "no other outbound request");

const bad = results.filter((r) => !r).length;
console.log(`\n${bad ? bad + " FAILED" : "ALL PASS"}  -  ${results.length} checks, ${bad} failed`);
try { chrome.kill(); } catch { /* gone */ }
server.close();
process.exit(bad ? 1 : 0);
