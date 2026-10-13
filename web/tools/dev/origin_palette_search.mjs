/**
 * The colours the origins are drawn in, and whether they may be.
 *
 *   node web/tools/dev/origin_palette_search.mjs
 *       score the shipped pair, both themes. This is the run to make after editing tokens.css.
 *   node web/tools/dev/origin_palette_search.mjs light "#be2377" "#3a6740"
 *       score candidates against one theme.
 *   node web/tools/dev/origin_palette_search.mjs search light
 *       the calmest colour in each hue band that clears that theme.
 *
 * SELF-CONTAINED, deliberately. `find_stack_palette.mjs` beside this one searched the ancestry
 * palette and cannot run anywhere, because it imports a validator from a path inside one
 * machine's temp directory. Everything needed here - sRGB to OKLab, and the Vienot dichromat
 * simulations - is written out below, so the numbers in tokens.css can be re-derived on any
 * machine with node and nothing else.
 *
 * WHAT IT MEASURES, and why each floor exists.
 *
 *   >= 15   OKLab distance x100 from every ancestry hue, every carrier-ramp step and the grid,
 *           IN ITS OWN THEME. The ancestry ribbon and the carrier ramp are drawn a few pixels
 *           from the origin outlines, so a colour that lands on one of them is a colour that
 *           says the wrong thing.
 *   >= 15   from --accent, which origin 1 is drawn in, under simulated protanopia, deuteranopia
 *           and tritanopia. Two colours that a quarter of readers cannot separate are one
 *           colour, and origin 1 against origin 2 is the comparison the figure exists to make.
 *   >= 8    between origin 2 and origin 3 under the same simulations - lower, and legitimately
 *           so: those two also carry a dash pattern and a numbered label, and 8 is the
 *           documented floor for a pair with a second channel. In normal vision they still
 *           need 15.
 *   >= 3:1  contrast against the surface. Added after looking at renders rather than numbers:
 *           a soft green cleared every distance floor and was still wrong, because the outline
 *           is a one-pixel dashed stroke on a near-white surface and it disappeared.
 *
 * ONE VALUE PER THEME. Until 2026-09-13 a single value served both, and that was the whole
 * constraint on the palette: a colour legible on near-white and on near-black sits at middle
 * lightness, where the ancestry hues and the carrier ramp already are. Swept over every hue,
 * exactly three bands passed and all three were red. Scoring a light-theme value against the
 * dark theme is therefore meaningless now, and this tool will not do it - `mode` is required.
 */

// ---------------------------------------------------------------- colour

const hex = (s) => {
  const h = s.replace("#", "").trim();
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const toHex = (rgb) => "#" + rgb.map((v) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const unlin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** sRGB hex -> OKLab. Bjorn Ottosson's matrices. */
function oklab(s) {
  const [r, g, b] = hex(s).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q,
  ];
}
const oklch = (s) => {
  const [L, a, b] = oklab(s);
  return [L, Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
};
function fromOklch(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const q = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    unlin(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * q),
  ];
}
const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
const dE = (x, y) => {
  const [a, b] = [oklab(x), oklab(y)];
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const relLum = (s) => {
  const [r, g, b] = hex(s).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const [a, b] = [relLum(x), relLum(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};

// Vienot, Brettel & Mollon 1999, on LINEAR sRGB. A dichromat's two remaining cone classes fix
// the third, so each simulation is one linear substitution in LMS.
//
// The matrix and the substitution coefficients are a MATCHED PAIR and cannot be mixed. A first
// version of this paired the normalised Smith-Pokorny matrix with the coefficients below, which
// are calibrated for the unnormalised one, and turned #df0c6b into a saturated green under
// protanopia. A dichromat simulation that invents a hue is wrong on its face, which is what
// caught it; the sanity block further down now asserts the three textbook cases.
const M = [[17.8824, 43.5161, 4.11935],
           [3.45565, 27.1554, 3.86714],
           [0.0299566, 0.184309, 1.46709]];
const MI = [[0.0809444479, -0.130504409, 0.116721066],
            [-0.0102485335, 0.0540193266, -0.113614708],
            [-0.000365296938, -0.00412161469, 0.693511405]];
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function cvd(s, kind) {
  let [L, m, S] = mul(M, hex(s).map(lin));
  if (kind === "protan") L = 2.02344 * m - 2.52581 * S;
  else if (kind === "deutan") m = 0.494207 * L + 1.24827 * S;
  else if (kind === "tritan") S = -0.395913 * L + 0.801109 * m;
  return toHex(mul(MI, [L, m, S]).map(unlin));
}
const KINDS = ["protan", "deutan", "tritan"];

// ---------------------------------------------------------------- the figure's own colours

// From web/src/tokens.css. The ascAIRN swatches draw from the same --anc-* list, so they add
// no colour of their own.
const THEME = {
  light: {
    accent: "#2470cc",
    anc: ["#009E73", "#0072B2", "#D55E00", "#56B4E9", "#E69F00", "#CC79A7"],
    ev: ["#d8d7d0", "#efa070", "#b8501e"],
    grid: "#e1e0d9",
    surface: "#fcfcfb",
  },
  dark: {
    accent: "#3987e5",
    anc: ["#009E73", "#0072B2", "#D55E00", "#4899c7", "#865b00", "#c676a2"],
    ev: ["#3a3a37", "#c25520", "#ef9a63"],
    grid: "#2c2c2a",
    surface: "#1a1a19",
  },
};

// The shipped pair. tokens.css is the source of truth; this is a copy so the default run has
// something to score, and every run prints the hexes it used, so a copy that has drifted is
// visible in the output rather than silent.
const SHIPPED = {
  light: { o2: "#be2377", o3: "#3a6740" },
  dark: { o2: "#f0a9e1", o3: "#90dbac" },
};

const FLOOR_NEIGHBOUR = 15;
const FLOOR_CVD_ACCENT = 15;
const FLOOR_CVD_PAIR = 8;
const FLOOR_CONTRAST = 3;

/** Everything one colour has to clear in one theme, or null with the reason. */
function score(c, mode) {
  const T = THEME[mode];
  const out = { hex: c, mode };
  const near = [["accent", T.accent], ...T.anc.map((h, i) => [`anc-${i + 1}`, h]),
    ...T.ev.map((h, i) => [`carrier ${[0, 1, 2][i]}`, h]), ["grid", T.grid]];
  out.near = Infinity;
  for (const [n, h] of near) {
    const d = dE(c, h);
    if (d < out.near) { out.near = d; out.who = n; }
  }
  out.cvd = Infinity;
  for (const k of KINDS) {
    const d = dE(cvd(c, k), cvd(T.accent, k));
    if (d < out.cvd) { out.cvd = d; out.cvdKind = k; }
  }
  out.contrast = contrast(c, T.surface);
  const [L, C, h] = oklch(c);
  out.L = L; out.C = C; out.h = h;
  out.fails = [];
  if (out.near < FLOOR_NEIGHBOUR) out.fails.push(`${out.near.toFixed(1)} to ${out.who}`);
  if (out.cvd < FLOOR_CVD_ACCENT) out.fails.push(`${out.cvd.toFixed(1)} to origin 1 under ${out.cvdKind}`);
  if (out.contrast < FLOOR_CONTRAST) out.fails.push(`contrast ${out.contrast.toFixed(2)}`);
  out.pass = out.fails.length === 0;
  return out;
}

/** Origin 2 against origin 3, which has the lower deficiency floor. */
function pair(a, b) {
  let c = Infinity, kind = "";
  for (const k of KINDS) {
    const d = dE(cvd(a, k), cvd(b, k));
    if (d < c) { c = d; kind = k; }
  }
  const n = dE(a, b);
  return { n, c, kind, pass: n >= FLOOR_NEIGHBOUR && c >= FLOOR_CVD_PAIR };
}

const row = (s) => `${s.hex}  L ${s.L.toFixed(2)} C ${s.C.toFixed(3)} h ${s.h.toFixed(0)}`
  + `   nearest ${s.near.toFixed(1)} (${s.who})`
  + `   vs origin 1 ${s.cvd.toFixed(1)} under ${s.cvdKind}`
  + `   contrast ${s.contrast.toFixed(2)}`
  + `   ${s.pass ? "PASS" : "FAIL: " + s.fails.join(", ")}`;

// ---------------------------------------------------------------- run

// The simulation has to reproduce the three cases every reference states before it rules on
// anything: a dichromat who cannot see long wavelengths reads red as a dark yellow, and blue is
// what both red-green deficiencies keep.
for (const [c, kind, want] of [["#ff0000", "protan", "dark yellow"],
                               ["#ff0000", "deutan", "yellow-brown"],
                               ["#0000ff", "protan", "blue"]]) {
  const [, , h] = oklch(cvd(c, kind));
  const ok = want === "blue" ? (h > 220 && h < 300) : (h > 60 && h < 115);
  if (!ok) {
    console.error(`the ${kind} simulation maps ${c} to hue ${h.toFixed(0)}, and every reference `
      + `says ${want}. The tool is wrong; nothing below it means anything.`);
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "search") {
  const mode = argv[1] === "dark" ? "dark" : "light";
  console.log(`the calmest colour in each hue band that clears the ${mode} theme\n`);
  const best = new Map();
  for (let h = 0; h < 360; h += 2)
    for (let L = 0.26; L <= 0.94; L += 0.01)
      for (let C = 0.03; C <= 0.30; C += 0.01) {
        const rgb = fromOklch(L, C, h);
        if (!inGamut(rgb)) continue;
        const s = score(toHex(rgb), mode);
        if (!s.pass) continue;
        const b = Math.floor(h / 10) * 10;
        if (!best.has(b) || s.C < best.get(b).C) best.set(b, s);
      }
  for (const b of [...best.keys()].sort((x, y) => x - y)) console.log("  " + row(best.get(b)));
  console.log(`\n${best.size} of 36 hue bands hold a usable colour in this theme`);
} else if (argv.length >= 2) {
  const mode = argv[0] === "dark" ? "dark" : "light";
  const cs = argv.slice(1);
  console.log(`against the ${mode} theme`);
  for (const c of cs) console.log("  " + row(score(c, mode)));
  if (cs.length === 2) {
    const p = pair(cs[0], cs[1]);
    console.log(`  the two clear each other by ${p.n.toFixed(1)} in normal vision and `
      + `${p.c.toFixed(1)} under ${p.kind}   ${p.pass ? "PASS" : "FAIL"}`);
  }
} else {
  let bad = 0;
  for (const mode of ["light", "dark"]) {
    const { o2, o3 } = SHIPPED[mode];
    console.log(`${mode} theme, as tokens.css ships it`);
    for (const c of [o2, o3]) {
      const s = score(c, mode);
      if (!s.pass) bad++;
      console.log("  " + row(s));
    }
    const p = pair(o2, o3);
    if (!p.pass) bad++;
    console.log(`  origin 2 vs origin 3: ${p.n.toFixed(1)} in normal vision, `
      + `${p.c.toFixed(1)} under ${p.kind}   ${p.pass ? "PASS" : "FAIL"}\n`);
  }
  console.log(bad ? `${bad} FAILURE(S) - the shipped palette does not clear its own floors`
    : "the shipped palette clears every floor in both themes");
  process.exit(bad ? 1 : 0);
}
