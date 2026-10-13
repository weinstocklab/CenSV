/** Shared DOM and formatting helpers, so main.js and search.js agree on both. */
import { format } from "d3-format";

export const MB = 1e6;
export const fmtMb = format(".2f");
export const fmtInt = format(",");
export const fmtP = format(".2e");

/** A p- or q-value the way a reader expects it: plain below 3 digits, scientific past it. */
export function fmtQ(v) {
  if (v == null) return "—";
  if (v === 0) return "0";
  return v >= 0.001 ? v.toFixed(3) : fmtP(v);
}

export const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().filter((c) => c != null && c !== false).forEach((c) => n.append(c));
  return n;
}

/** Escape before interpolating anything data-derived into innerHTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Wrap the matched span of a label so a reader can see WHY a result matched. */
export function mark(text, query) {
  const t = String(text ?? "");
  if (!query) return esc(t);
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + query.length)) + "</mark>" +
    esc(t.slice(i + query.length));
}
