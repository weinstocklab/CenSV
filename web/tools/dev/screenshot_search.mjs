/**
 * Drive the real search box over the DevTools protocol, report its state, and screenshot
 * the dropdown.
 *
 * WHY THIS EXISTS. Headless Chrome cannot type, so `--screenshot` can reach every other
 * view in this site but never the search dropdown - the one piece a reader touches first.
 * Everything here is a real event through the app's own listeners: the field is focused,
 * characters are dispatched one at a time, and the resulting DOM is read back.
 *
 * It has already earned its keep twice. It caught that the opening result was visibly
 * highlighted while `aria-activedescendant` was still null, so a screen reader was told
 * nothing was selected; and it caught that dispatching keyDown with `text` alongside
 * `char` types every letter twice, which is a trap for anyone extending this.
 *
 *   # one terminal
 *   npm run preview
 *   # another
 *   chrome --headless --disable-gpu --window-size=1500,760  *          --remote-debugging-port=9222 --user-data-dir=/tmp/cdp  *          "http://localhost:4173/#/"
 *   node web/tools/dev/screenshot_search.mjs 9222 "dip" out.jpg
 *
 * Prints a JSON line: the field value, whether the list opened, how many options and
 * groups, the first option's text, and the two aria attributes that make it a combobox.
 */
const [,, port, query, out] = process.argv;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.enable");
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 3500));   // let the 3.8 MB catalog land

// focus the field and type, event by event, so the app's own listeners run
await send("Runtime.evaluate", { expression: `(()=>{const i=document.getElementById("q");i.value="";i.dispatchEvent(new Event("input"));i.focus();})()` });
for (const ch of query) {
  // char alone. keyDown with `text` ALSO inserts, which typed every letter twice.
  await send("Input.dispatchKeyEvent", { type: "char", text: ch });
}
await new Promise((r) => setTimeout(r, 700));
const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    value: document.getElementById("q").value,
    open: !document.getElementById("qlist").hidden,
    options: [...document.querySelectorAll(".qopt")].length,
    groups: [...document.querySelectorAll(".qgroup span:first-child")].map(e => e.textContent),
    first: document.querySelector(".qopt")?.textContent || null,
    expanded: document.getElementById("q").getAttribute("aria-expanded"),
    activedesc: document.getElementById("q").getAttribute("aria-activedescendant"),
  })`, returnByValue: true });
console.log(state.result.value);
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
ws.close();
