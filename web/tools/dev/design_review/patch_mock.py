#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""One patch, three switches, so every option can be rendered from the real browser.

REVIEW MOCK-UPS. The switches live in a temporary module that ships with no build; the
published file is haplo.head.js and `python patch_mock.py restore` puts it back byte for byte.

  label  : above (as published) | halo | inside | right
  tier   : both (as published)  | short | table
  ribbon : one (as published)   | origin | union
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE_SRC = "haplo.head.js"
OUT = os.path.join(HERE, "out_mock")
os.makedirs(OUT, exist_ok=True)
base = io.open(os.path.join(HERE, REMOTE_SRC), encoding="utf-8", newline="").read()
s = base


def sub(old, new, what):
    global s
    if s.count(old) != 1:
        sys.exit("%s: expected one match, found %d" % (what, s.count(old)))
    s = s.replace(old, new, 1)


sub('import { el, css, esc, fmtInt } from "./dom.js";',
    'import { el, css, esc, fmtInt } from "./dom.js";\n'
    'import { MOCK } from "./_mock_opts.js";',
    "import")

# ---- ribbon: a per-haplotype origin column, or a dosage built from every origin
sub("""  const tipX = X(maxx) + 8;""",
    """  // MOCK. `union` rebuilds the per-sample dosage from every origin's carriers; `origin`
  // leaves the dosage alone and adds a per-HAPLOTYPE column, which is the unit origin
  // membership is actually defined on.
  const tipOrigin = new Map();
  if (clades.length > 1) {
    clades.forEach((c) => (c.carriers || new Set()).forEach((k) => tipOrigin.set(k, c.i)));
  }
  let dosDraw = dos;
  if (MOCK.ribbon === "union" && clades.length > 1) {
    const u = new Uint8Array(index.samples.length);
    tipOrigin.forEach((_o, k) => {
      const j = index.ix.get(tree.tips[k].replace(/_hap[12]$/, ""));
      if (j !== undefined) u[j] += 1;
    });
    dosDraw = u;
  }
  const showOrg = MOCK.ribbon === "origin" && clades.length > 1;

  const tipX = X(maxx) + 8;""",
    "ribbon prep")

sub("""    if (dos && si !== undefined) {
      svg.append(s("rect", { x: tipX + 26, y, width: 10, height: h,
        fill: carrierFill(dos[si]) }));
    }
  });
  [["ancestry", tipX + 5], ["ascAIRN", tipX + 18], ["carrier", tipX + 31]].forEach(([t, x]) => {""",
    """    if (dosDraw && si !== undefined) {
      svg.append(s("rect", { x: tipX + 26, y, width: 10, height: h,
        fill: carrierFill(dosDraw[si]) }));
    }
    if (showOrg) {
      const oi = tipOrigin.has(k) ? tipOrigin.get(k) : -1;
      svg.append(s("rect", { x: tipX + 39, y, width: 8, height: h,
        fill: oi < 0 ? tok("--grid") : originStroke(oi) }));
    }
  });
  [["ancestry", tipX + 5], ["ascAIRN", tipX + 18], ["carrier", tipX + 31]]
    .concat(showOrg ? [["origin", tipX + 44]] : []).forEach(([t, x]) => {""",
    "ribbon draw")

# ---- label: placement and the tier word
sub("""  clades.forEach((c) => {
    if (!c.tips.size) return;
    const ys = [...c.tips].map((k) => Y(k));
    const top = Math.min(...ys) - rowH, bot = Math.max(...ys) + rowH;
    const x0 = X(tree.x[c.node]) - 3;
    svg.append(s("rect", { x: x0, y: top, width: W - x0 - 4, height: bot - top,
      fill: "none", stroke: originStroke(c.i), "stroke-width": 1,
      "stroke-dasharray": originDash(c.i) }));
    if (clades.length > 1) {
      const n = c.carriers ? c.carriers.size : null;
      svg.append(s("text", { x: x0 + 2, y: Math.max(10, top - 2), "font-size": 10,
        fill: originStroke(c.i),
        text: `origin ${c.i + 1} · ${c.branch}` + (n == null ? "" : ` · ${n} carriers`)
          + (c.r2 == null ? "" : ` · r² ${c.r2.toFixed(3)}`)
          + (c.imputed == null ? ""
             : ` · ${c.imputed ? "imputed" : "assembly only"}`) }));
    }
  });""",
    """  const band = clades.map((c) => {
    if (!c.tips.size) return null;
    const ys = [...c.tips].map((k) => Y(k));
    return { top: Math.min(...ys) - rowH, bot: Math.max(...ys) + rowH,
      x0: X(tree.x[c.node]) - 3 };
  });
  const tierWord = (c) => {
    if (MOCK.tier === "table" || c.imputed == null) return "";
    if (MOCK.tier === "short") return c.imputed ? "" : " · assembly only";
    return c.imputed ? " · imputed" : " · assembly only";
  };
  // MOCK `text`: `bare` drops the origin number and the branch id, leaving the two
  // quantities. Identity then rests on the outline colour and on the table beside the tree,
  // whose columns are still named origin 1 and origin 2.
  const labelText = (c) => {
    const n = c.carriers ? c.carriers.size : null;
    const parts = [];
    if (MOCK.text !== "bare") parts.push(`origin ${c.i + 1} · ${c.branch}`);
    if (n != null) parts.push(`${n} carriers`);
    if (c.r2 != null) parts.push(`r² ${c.r2.toFixed(3)}`);
    return parts.join(" · ") + tierWord(c);
  };
  // MOCK `panel`: the width right of the ribbons is empty, so the label goes there, wrapped
  // to the space that is actually free and stacked so two panels never overlap.
  const panelX = tipX + (showOrg ? 52 : 42);
  const panelW = W - 6 - panelX;
  const perLine = Math.max(6, Math.floor(panelW / 5.15));
  const wrapLab = (txt) => {
    const out = [];
    let cur = "";
    txt.split(" · ").forEach((p) => {
      const t = cur ? cur + " · " + p : p;
      if (t.length <= perLine) { cur = t; return; }
      if (cur) out.push(cur);
      cur = p;
    });
    if (cur) out.push(cur);
    return out;
  };
  const panel = {};
  if (MOCK.label === "panel") {
    let cursor = -1e9;
    clades.map((c) => c.i).filter((i) => band[i])
      .sort((a, b) => band[a].top - band[b].top)
      .forEach((i) => {
        const lines = wrapLab(labelText(clades[i]));
        const y = Math.max(band[i].top + 9, cursor + 12);
        panel[i] = { y, lines };
        cursor = y + (lines.length - 1) * 11;
      });
  }
  clades.forEach((c) => {
    const b = band[c.i];
    if (!b) return;
    svg.append(s("rect", { x: b.x0, y: b.top, width: W - b.x0 - 4, height: b.bot - b.top,
      fill: "none", stroke: originStroke(c.i), "stroke-width": 1,
      "stroke-dasharray": originDash(c.i) }));
    if (clades.length <= 1) return;
    const n = c.carriers ? c.carriers.size : null;
    const txt = labelText(c);
    // Does the label's own line cross another origin's outline? That is the case the
    // published version draws straight through.
    const above = Math.max(10, b.top - 2);
    const crowded = band.some((o, j) => o && j !== c.i && above > o.top && above < o.bot);
    let x = b.x0 + 2, y = above, anchor = "start";
    if (MOCK.label === "outside") {
      // Each label on the side of its own outline that faces AWAY from the nearest other
      // clade: the top one above, the bottom one below, so two labels cannot meet.
      let up = 1e9, down = 1e9;
      band.forEach((o, j) => {
        if (!o || j === c.i) return;
        if (o.bot <= b.top) up = Math.min(up, b.top - o.bot);
        if (o.top >= b.bot) down = Math.min(down, o.top - b.bot);
      });
      y = up >= down ? Math.max(10, b.top - 3) : b.bot + 10;
    } else if (MOCK.label === "inside" || (MOCK.label === "halo" && crowded)) {
      y = b.top + 10;
    } else if (MOCK.label === "right") {
      x = W - 6; y = (b.top + b.bot) / 2 + 3; anchor = "end";
    }
    if (MOCK.label === "panel") {
      const p = panel[c.i];
      p.lines.forEach((ln, j) => svg.append(s("text", { x: panelX, y: p.y + j * 11,
        "font-size": 10, fill: originStroke(c.i), text: ln })));
      svg.append(s("line", { x1: panelX - 4, x2: panelX - 4, y1: p.y - 8,
        y2: p.y + (p.lines.length - 1) * 11 + 2, stroke: originStroke(c.i),
        "stroke-width": 2 }));
      return;
    }
    if (MOCK.label !== "above") {
      const w = txt.length * 5.15 + 5;
      svg.append(s("rect", { x: anchor === "end" ? x - w : x - 3, y: y - 9,
        width: w, height: 11, fill: tok("--surface-1"), opacity: 0.9 }));
    }
    svg.append(s("text", { x, y, "font-size": 10, fill: originStroke(c.i),
      "text-anchor": anchor, text: txt }));
  });""",
    "label block")

# ---- the composition header carries the tier when the label does not
sub("""      ...clades.map((c) => el("th", { class: "num" },
        multi ? `origin ${c.i + 1}` : "in the clade")),""",
    """      ...clades.map((c) => el("th", { class: "num" },
        multi ? `origin ${c.i + 1}`
          + (MOCK.tier === "table" && c.imputed != null
             ? ` · ${c.imputed ? "imputed" : "assembly only"}` : "")
          : "in the clade")),""",
    "composition header")

TARGET_SRC = "/tmp/haplo_variant.js"

if __name__ == "__main__":
    if sys.argv[1] == "restore":
        io.open(os.path.join(OUT, "haplo.js"), "w", encoding="utf-8",
                newline="").write(base)
        print("restore copy written")
        sys.exit(0)
    label, tier, ribbon = sys.argv[1], sys.argv[2], sys.argv[3]
    text = sys.argv[4] if len(sys.argv) > 4 else "full"
    io.open(os.path.join(OUT, "_mock_opts.js"), "w", encoding="utf-8", newline="").write(
        "// TEMPORARY review switches. No build ships this file.\n"
        'export const MOCK = { label: "%s", tier: "%s", ribbon: "%s", text: "%s" };\n'
        % (label, tier, ribbon, text))
    io.open(os.path.join(OUT, "haplo.js"), "w", encoding="utf-8", newline="").write(s)
    print("variant label=%s tier=%s ribbon=%s text=%s (%+d bytes)"
          % (label, tier, ribbon, text, len(s) - len(base)))
