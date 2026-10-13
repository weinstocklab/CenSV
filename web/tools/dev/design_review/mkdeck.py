#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The origin-figure decisions, every image rendered from the real browser."""
import base64
import io
import os

SHOTS = "C:/temp/shots"
OUT = "C:/Users/59827/OneDrive - Emory/Desktop/CenSV_origin_fixes.html"

TIGHT = ("chr5_sv193_DUP:TANDEM &mdash; two clades three tip rows apart. Origin 1 B376 with "
         "14 carriers, origin 2 B358 with 7, assembly only.")
ROW2 = ("chr8_sv20_DEL &mdash; the catalog row is B118, which is <b>origin 2</b>. Origin 1 "
        "B233 holds 93 carriers and the dosage ribbon marks 7 of them.")


def img(name, alt):
    with open(os.path.join(SHOTS, name), "rb") as fh:
        b = base64.b64encode(fh.read()).decode("ascii")
    return ('<figure><img alt="%s" src="data:image/jpeg;base64,%s">'
            '<figcaption>%s</figcaption></figure>' % (alt.replace('"', "'"), b, alt))


def opt(group, key, tag, title, why, shots, checked=False):
    return """
<section class="opt">
 <label class="pick"><input type="radio" name="%s" value="%s"%s>
  <span class="tag">%s</span><span class="title">%s</span></label>
 <p class="why">%s</p>
 <div class="pair">%s</div>
 <textarea rows="2" placeholder="Notes"></textarea>
</section>""" % (group, key, " checked" if checked else "", tag, title, why,
                 "".join(img(n, a) for n, a in shots))


B = []

B.append("""
<div class="card">
<p><b>First, correcting how I put it.</b> The ribbon showing one component is not a decision
that later origins should be blank. This page has always been a view of <b>one catalog
row</b>, and that row is one component, so the ribbon paints that component's dosage. When a
second outline was added to the same figure, nothing told the ribbon to follow. It is an
invariant that stopped being right once the figure started drawing more than one origin, and
it predates the deploy: the mono rows are identical to <code>da38889</code>, 1,711 identical
and 0 changed.</p>
</div>

<h2>0 &mdash; With &ldquo;origin N&rdquo; and the branch id removed</h2>
<div class="card good">
<p>The label now carries the two quantities and nothing else. Identity comes from the outline
colour and from the table beside the tree, whose columns are still named <code>origin 1</code>
and <code>origin 2</code> and now carry the evidence tier. Pick where the label sits.</p>
</div>
<div class="card warnc">
<p><b>What goes with it.</b> The branch id leaves the figure entirely, and it is named
nowhere else on the page &mdash; the monophyletic table has no haplogroup column. If you want
it reachable, the table can gain one. Two other things follow: the caption still reads
&ldquo;labelled with its branch&rdquo; and would be rewritten, and four browser checks assert
the branch inside the label and would be re-pointed at what the label says instead.</p>
</div>""")
B.append(opt("place", "panel", "Option A", "In the right margin, beside its own clade",
             "Uses the empty width you pointed at. Two short lines per origin, in the "
             "origin's colour, with a bar tying each to its outline, plus the per-haplotype "
             "<code>origin</code> column.",
             [("BarePanel_row2.jpg", ROW2), ("BarePanel_tight.jpg", TIGHT)], checked=True))
B.append(opt("place", "above", "Option B", "Above the outline, as now",
             "With the label this short the old position mostly works again: one line, on a "
             "backing, dropping inside its own box where another outline crosses that line.",
             [("Bare_tight.jpg", TIGHT), ("Bare_row2.jpg", ROW2)]))

# ------------------------------------------------------------------ ribbon
B.append("""
<h2>2 &mdash; What the carrier colour should mean</h2>
<div class="card bad">
<p>Measured over the shipped payload: of 1,622 carrier haplotypes across later origins the
ribbon marks <b>561 (34.6%)</b>, and <b>77 of 158</b> later origins have nothing marked at
all. For first origins it is 4,323 of 5,651 and 5 of 145.</p>
<p class="why">There is a unit problem under it. The ribbon is a <b>per-sample diploid
dosage</b>, so both haplotypes of one person take one colour, while origin membership is
<b>per haplotype</b>. That column cannot say which haplotype sits in which origin, whatever
it is filled from.</p>
</div>
<div class="card warnc">
<p><b>And a caution about the obvious fix.</b> Painting the ribbon from every origin does not
give &ldquo;the carriers of this SV&rdquo;. The decomposition leaves a <code>residual</code>
of carriers no branch explained, so the union of the drawn origins sits <b>below</b> the
pre-decomposition parent in <b>129 of 137</b> rows, by a median of 0.0077 and up to 0.0485 in
allele frequency. The parent variant does survive in the catalog as
<code>original_decomposed</code>, and it is already inside the haplotype block for
<b>137 of the 145</b> rows, so painting the true whole-SV carriers is available too.</p>
</div>""")

B.append(opt("ribbon", "origin", "Option A", "Add a per-haplotype origin column",
             "Leaves the dosage ribbon alone and adds a thin column painting each haplotype "
             "in its origin's colour. It answers what the dosage column structurally cannot, "
             "and the record's dosage keeps its present meaning.",
             [("Rorigin_row2.jpg", ROW2)], checked=True))
B.append(opt("ribbon", "union", "Option B", "Fill the ribbon from every drawn origin",
             "One column, both clades marked. It shows the carriers the origins EXPLAIN, "
             "which is short of the SV's own carriers by the residual, and the figure then "
             "disagrees with the record beside it.",
             [("Runion_row2.jpg", ROW2)]))
B.append(opt("ribbon", "parent", "Option B&prime;", "Fill the ribbon from the SV before decomposition",
             "The truest reading of the word <code>carrier</code>: the parent "
             "<code>original_decomposed</code> genotype, every carrier the SV has. Available "
             "for 137 of 145 rows. A reader would then see carrier marks OUTSIDE both "
             "outlines, which is honest &mdash; those are carriers no origin explains. "
             "<b>Not rendered yet</b>: it needs the parent row carried in the payload, about "
             "an hour. Say the word and I will render it before you choose.",
             [("now_row2.jpg", ROW2)]))

# ------------------------------------------------------------------ labels
B.append("""
<h2>3 &mdash; The same placements, with the full label, for comparison</h2>
<div class="card">
<p>The published label sits two pixels above its outline, so where clades are a few tip rows
apart the lower label is drawn through the upper box and the tree. Your suggestion &mdash;
the empty margin right of the ribbons &mdash; measures about 76 px inside the outline, which
is roughly 14 characters a line at the current size, so the label wraps and stacks there.</p>
</div>""")
B.append(opt("label", "now", "As published", "Above the outline",
             "What is live. The origin 1 label is drawn straight through the pink outline.",
             [("now_tight.jpg", TIGHT)]))
B.append(opt("label", "panel", "Option A", "In the right margin, wrapped and stacked",
             "Each label beside its own clade in the free width, on its origin's colour, with "
             "a coloured bar tying it to its outline. Panels are stacked so two never "
             "overlap. It costs vertical stacking: four or five short lines rather than one.",
             [("Lpanel_tight.jpg", TIGHT)], checked=True))
B.append(opt("label", "halo", "Option B", "Keep it above, with a backing, and move inside when tight",
             "Smallest change. The label keeps its place wherever there is clear space and "
             "drops inside its own box where another outline crosses that line.",
             [("Lhalo_tight.jpg", TIGHT)]))
B.append(opt("label", "right", "Option C", "Right-aligned on one line",
             "Clears the tree, and lands on the ancestry, ascAIRN and carrier ribbons instead.",
             [("Lright_tight.jpg", TIGHT)]))

# ------------------------------------------------------------------ tier
B.append("""
<h2>4 &mdash; The tier word, if the label keeps any of it</h2>
<div class="card">
<p>196 of the 303 origins drawn reached imputation, so <code>imputed</code> is the common
case and it is the longer label. You were right to question it.</p>
</div>""")
B.append(opt("tier", "table", "Option A", "Carry the tier in the composition table header",
             "The label returns to branch, carriers and r&sup2;; the header reads "
             "<code>origin 2 &middot; assembly only</code>. Shortest label, which matters "
             "most in the right margin.",
             [("Ttable_tight.jpg", TIGHT)], checked=True))
B.append(opt("tier", "short", "Option B", "Mark only the origins with no model",
             "<code>assembly only</code> where it applies and nothing where it does not, so "
             "the word lands on 107 of 303 origins rather than all of them.",
             [("Tshort_tight.jpg", TIGHT)]))

# ------------------------------------------------------------------ ordering
B.append("""
<h2>5 &mdash; What orders origin 1 before origin 2</h2>
<div class="card good">
<p><b>Allele count, largest first.</b>
<code>code/resolution/multiorigin_trees.py:146</code> sorts the components with
<code>sort_values("ac", ascending=False)</code> and numbers them in that order. Over all 145
flagged rows:</p>
<table>
 <thead><tr><th>candidate rule</th><th>origin 1 first</th><th>origin 1 second</th></tr></thead>
 <tbody class="n">
  <tr><td>carriers, largest first</td><td><b>143</b></td><td>0</td></tr>
  <tr><td>position, highest in the figure</td><td>61</td><td>84</td></tr>
  <tr><td>decomposition r&sup2;, highest first</td><td>61</td><td>84</td></tr>
 </tbody>
</table>
<p class="why">So it is neither the one drawn on top nor the better-fitting one. Origin 1
carries the <b>lower</b> r&sup2; more often than not, because iteration 0 is scored against
the full carrier vector including the carriers it leaves behind, while a later component is
scored only against the residual. On <code>chr5_sv193</code> above, origin 2 fits at 0.761
against origin 1's 0.539 and is still origin 2, on half the carriers.</p>
</div>""")

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CenSV - the origin figure, four decisions</title>
<style>
 :root{--page:#f6f6f4;--surface:#fff;--ink:#16171a;--muted:#5b6068;--line:#e2e2de;
   --accent:#2470cc;--good-bg:#eaf4ec;--good-line:#3c8a55;--warn-bg:#fff6e5;
   --warn-line:#c98a12;--bad-bg:#fdecec;--bad-line:#b23b3b;}
 @media (prefers-color-scheme:dark){:root{--page:#141518;--surface:#1c1e22;--ink:#eceef1;
   --muted:#a3a9b3;--line:#2c2f35;--accent:#9fb0ee;--good-bg:#1e3324;--good-line:#6cc189;
   --warn-bg:#33280f;--warn-line:#e0ac3c;--bad-bg:#3a1e1e;--bad-line:#e07272;}}
 *{box-sizing:border-box}
 body{margin:0;padding:2.2rem 1.2rem 6rem;background:var(--page);color:var(--ink);
   font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 main{max-width:80rem;margin:0 auto}
 h1{font-size:1.5rem;margin:0 0 .2rem}
 h2{font-size:1.08rem;margin:2.8rem 0 .8rem}
 .sub{color:var(--muted);margin:0 0 1.6rem}
 .card{background:var(--surface);border:1px solid var(--line);border-radius:10px;
   padding:1.05rem 1.2rem;margin:0 0 1.2rem}
 .good{background:var(--good-bg);border-left:3px solid var(--good-line)}
 .warnc{background:var(--warn-bg);border-left:3px solid var(--warn-line)}
 .bad{background:var(--bad-bg);border-left:3px solid var(--bad-line)}
 section.opt{background:var(--surface);border:1px solid var(--line);border-radius:12px;
   padding:1.1rem 1.2rem 1.3rem;margin:0 0 1.1rem}
 section.opt:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
 label.pick{display:flex;align-items:baseline;gap:.6rem;cursor:pointer;margin:0 0 .4rem}
 .tag{font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);
   border:1px solid var(--line);border-radius:20px;padding:.1rem .55rem;white-space:nowrap}
 .title{font-weight:600;font-size:1.05rem}
 .why{color:var(--muted);font-size:14.5px;margin:.2rem 0 .9rem}
 .pair{display:grid;grid-template-columns:1fr;gap:1rem}
 figure{margin:0}
 img{width:100%;max-width:1215px;display:block;border:1px solid var(--line);
   border-radius:8px;background:#fff}
 figcaption{color:var(--muted);font-size:12.5px;margin-top:.35rem}
 textarea{width:100%;margin-top:.9rem;background:var(--page);color:var(--ink);
   border:1px solid var(--line);border-radius:6px;padding:.45rem .6rem;font:inherit;
   font-size:13.5px;min-height:2.4rem;resize:vertical}
 code{font-size:.92em}
 table{border-collapse:collapse;width:100%;background:var(--surface);
   border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px;
   margin:.6rem 0 0}
 th,td{padding:.4rem .7rem;border-bottom:1px solid var(--line);text-align:right}
 th:first-child,td:first-child{text-align:left}
 thead th{background:var(--page);color:var(--muted);font-weight:600}
 tbody tr:last-child td{border-bottom:0}
 .n{font-variant-numeric:tabular-nums}
</style></head><body><main>

<h1>The origin figure, four decisions</h1>
<p class="sub">CenSV &middot; 2026-09-11 &middot; every image rendered from the real browser
against the shipped payload; the working tree is back at <code>872a32d</code> and none of
this is committed</p>

@@BODY@@

</main></body></html>
"""

io.open(OUT, "w", encoding="utf-8").write(HTML.replace("@@BODY@@", "".join(B)))
print("wrote %s  (%.1f MB)" % (OUT, os.path.getsize(OUT) / 1e6))
