/**
 * Search for a 6-hue stacked-bar palette that passes the dataviz validator in BOTH modes.
 *
 *   node web/tools/dev/find_stack_palette.mjs
 *
 * Why a search and not a hand-picked set. The stacked ancestry track needs six fills whose
 * ADJACENT pairs separate under colour-vision deficiency, on a light surface (#fcfcfb) and a
 * dark one (#1a1a19) whose accepted lightness band is only L 0.48-0.67 wide. Four hand
 * attempts failed: the conventional gnomAD palette outright, and three re-steppings of
 * Okabe-Ito collapsed to 2.6-5.3 dE under protanopia. Adjacency is fixed here - the stack
 * order is fixed - so the search is over hue assignment as well as hue choice, which is
 * exactly the part hand-picking is bad at.
 *
 * Prints the best palette per mode by worst adjacent dE, and the validator's verdict.
 */
import { validate } from "../../../AppData/Local/Temp/claude/bundled-skills/2.1.241/f868f5593094ee57ae211f7165de5b61/dataviz/scripts/validate_palette.js";

const SURF = { light: "#fcfcfb", dark: "#1a1a19" };
const N = 6;

// OKLCH -> sRGB hex, clipped. Enough for a search; the validator is the judge.
function hex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const to8 = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return "#" + lin.map(to8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Candidate slots: hues around the circle at a few lightness/chroma steps inside each
// mode's band. The band is the binding constraint, so it is sampled finely and hue coarsely.
function candidates(mode) {
  const Ls = mode === "dark" ? [0.52, 0.56, 0.60, 0.64] : [0.48, 0.55, 0.62, 0.70];
  const Cs = [0.11, 0.14, 0.17, 0.20];
  const out = [];
  for (let h = 0; h < 360; h += 12) {
    for (const L of Ls) for (const C of Cs) out.push({ h, hex: hex(L, C, h) });
  }
  return out;
}

// validate() returns report rows as [name, ok, detail] tuples, where ok is true, false, or
// the string "relief" for the conditional contrast relax.
const row = (rep, name) => rep.find((r) => String(r[0]).startsWith(name));
const failed = (rep, name) => { const r = row(rep, name); return r && r[1] === false; };

function worstAdjacent(rep) {
  const cvd = row(rep, "CVD");
  const m = cvd && /([\d.]+) \(/.exec(cvd[2] || "");
  return m ? parseFloat(m[1]) : 0;
}

for (const mode of ["light", "dark"]) {
  const pool = candidates(mode);
  let best = null, tried = 0, passed = 0;
  for (let start = 0; start < 360; start += 3) {
    for (const step of [48, 54, 60, 66, 72]) {
      const picks = [];
      for (let k = 0; k < N; k += 1) {
        const want = (start + k * step) % 360;
        let slot = null;
        for (const c of pool) {
          const d = Math.min(Math.abs(c.h - want), 360 - Math.abs(c.h - want));
          if (d > 18 || picks.includes(c.hex)) continue;
          const v = validate([c.hex], { mode, surface: SURF[mode] });
          if (!failed(v.report, "Lightness") && !failed(v.report, "Chroma")) { slot = c.hex; break; }
        }
        if (!slot) { picks.length = 0; break; }
        picks.push(slot);
      }
      // Six DISTINCT fills. The first version of this search happily returned a palette with
      // the same hex in two slots, which passes every pairwise check it is not adjacent to
      // and is obviously useless.
      if (picks.length !== N || new Set(picks).size !== N) continue;
      tried += 1;
      const v = validate(picks, { mode, surface: SURF[mode] });
      if (!v.ok) continue;          // v.ok already folds in the hard normal-vision floor
      passed += 1;
      const score = worstAdjacent(v.report);
      if (!best || score > best.score) best = { score, picks, v };
    }
  }
  console.log(`
=== ${mode}  (${passed} of ${tried} candidate assemblies pass)`);
  if (!best) { console.log("  NONE PASS - six categorical fills are not available here"); continue; }
  console.log("  " + best.picks.join(","));
  best.v.report.forEach(([name, ok, detail]) => console.log(
    `  [${ok === true ? "PASS" : ok === false ? "FAIL" : "WARN"}] ${name}  ${detail || ""}`));
  console.log("  verdict:", best.v.ok ? "ALL CHECKS PASS" : "FAILED");
}
