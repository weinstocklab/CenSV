# `web/tools/dev/design_review/` — render a design option from the real browser

Built for the origin-figure review of 2026-09-12, where four label placements, three ribbon
readings and three label texts had to be compared. Describing them in prose was useless; every
choice turned on what the figure actually looked like at a three-tip-row gap.

The rule this encodes: **a design option is reviewed from the real browser against the real
payload, never from a drawing.** Two of the four defects found in that round were invisible in
prose — the right-aligned label lands on the ancestry ribbon, and dropping the origin outline
sends the composition table back to counting clade tips instead of carriers, silently changing
what the column means.

## Why it builds on the server

`node_modules` under the mount was installed for Linux, so `vite` cannot run from Windows. The
patch is written locally, uploaded, built on the server, and only `dist/` comes back. Chrome
and the screenshots are local.

## The loop

| file | what it does |
|---|---|
| `patch_mock.py` | One patch over the current `haplo.js`, four switches: `label` (placement), `tier` (where the evidence tier appears), `ribbon` (what the carrier colour means), `text` (whether the label carries the origin number and branch id). Writes `out_mock/haplo.js` and a temporary `_mock_opts.js` that no build ships. Every substitution asserts exactly one match, so a variant stops instead of half-applying. |
| `run_mock.sh` | `run_mock.sh <name> <label> <tier> <ribbon> [text]` — patch, upload, build on the server, sync `dist/`, screenshot two example rows. |
| `shot_local.sh` | One route to JPG, cropped. Adapted from `../shot.sh`. |
| `mkdeck.py` | Assembles the rendered options into one HTML deck with a radio and a notes box per option, images embedded as base64. |

## Things that cost time, so they are written down

- **Restore from a fetched copy of HEAD, never from the working tree.** `patch_mock.py` keeps
  `haplo.head.js` as its base and `restore` puts the file back byte for byte. Re-running a
  variant after a restore re-applies the mock, so check `git status` before building to publish.
- **Screenshot the page tall.** The haplotype page scrolls the selected row into view, so on a
  chromosome with hundreds of monophyletic rows the figure lands above the viewport and the
  capture comes out blank. A 3200 px window keeps the row in view; short pages (chr5 at 38
  rows, chr8 at 28, chr16 at 23) are the ones worth using. `code/origins/origin_tiers.py` in
  the analysis repository names them.
- **A 1100 px window collapses the figure.** 2000 and above renders the settled layout.
- **Refresh the mount after a server-side write.** A stale `verify_haplotypes.mjs` returned the
  same check count as before the change, which is what gave it away; a stale `hap_index.json`
  arrived truncated and read as a manifest bug that did not exist.
- **CSS percent signs collide with `%` formatting.** Build the deck by replacement, not
  `str.format` or `%`.
