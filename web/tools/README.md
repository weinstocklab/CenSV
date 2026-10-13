# web/tools

Three jobs, one directory each. Nothing here is imported by the site — these build it, check
it, or measure it.

## The build tool

| | |
|---|---|
| `build_singlefile.py` | The whole site as one HTML file. |

```bash
python web/tools/build_singlefile.py CenSV_offline.html                        # what ships
python web/tools/build_singlefile.py CenSV_locked.html --password-env CENSV_PW # encrypted
```

Markup, stylesheet, application and all seven JSON files become one JSON container,
compressed once with zopfli, base64'd into a `<script type="text/plain">`. With a password the
container is first encrypted with AES-256-GCM under PBKDF2-HMAC-SHA256 at 600,000 iterations.

**The open build is what ships.** The encrypted form carried the site from 2026-08 until the
preprint posted on 2026-10-13, and the password path is kept for a future preview; the deploy
holds what it publishes to the open form through `verify/verify_open.py`.

## `verify/` — the checks

Run in this order; the first three need no browser. `infra/pages/build_local.sh` runs all of
those and prints the browser commands.

| | what it holds |
|---|---|
| `verify_open.py` | the published file opens with nothing in front of it, with a gated build as its control |
| `verify_shipped_data.py` | the numbers a reader opens, read out of the container |
| `verify_ld_decode.mjs` | the browser's own LD decoder against the published reference panels |
| `scan_copy_register.py` | reader-visible copy that defines itself by a denial |
| `verify_dip_modes.mjs` | the ancestry stack decomposes the pooled dip track |
| `verify_ld_panel.mjs` | the LD figure's ink against its own caption, by pixel |
| `verify_interactions.mjs` | state, focus, contrast and the drawer — what no data check sees |

```bash
python web/tools/verify/verify_open.py CenSV_offline.html --self-test
python web/tools/verify/verify_shipped_data.py CenSV_locked.html
python web/tools/verify/scan_copy_register.py web/src/*.js web/index.html
( cd web && node tools/verify/verify_ld_decode.mjs )

CENSV_PW=... node web/tools/verify/verify_dip_modes.mjs      <file|url>
             node web/tools/verify/verify_ld_panel.mjs       <offline file>
             node web/tools/verify/verify_interactions.mjs   <offline file>
```

The four Chrome suites default to `C:\Program Files\Google\Chrome\Application\chrome.exe`;
set `CHROME` to override. They serve a local file over `http://localhost` rather than opening
it from disk, because an encrypted build needs `crypto.subtle` and browsers expose it only in
a secure context. Each exits non-zero on any failure and each counts the checks it ran rather
than stating a total.

## `dev/` — measurement and one-offs

| | |
|---|---|
| `measure_size_ladder.py` | **the size ladder** — what each candidate saving is worth |
| `shot.sh` | screenshots of a route into `shots/current/`, from the preview server |
| `shot_singlefile.mjs` | screenshots a route of a **single-file build** — the artefact a reader opens, carrying the payload as shipped. Serves it over localhost, because a locked build needs `crypto.subtle` and browsers expose it only in a secure context, and writes JPEG straight out of Chrome. Under Git Bash prefix it with `MSYS_NO_PATHCONV=1`, or the shell rewrites a `#/chr5/...` route into a Windows path and the capture silently lands on the overview |
| `screenshot_search.mjs` | a screenshot of the search panel |
| `origin_palette_search.mjs` | **the palette instrument for the origin outlines.** sRGB to OKLab and the Vienot dichromat simulations, written out in full. Run with no arguments it scores the shipped pair in both themes and exits non-zero if any floor is missed; `search <theme>` walks every hue band. Its own first line is an instrument check: the deficiency simulation has to map red to a dark yellow and keep blue blue, which is what caught a version that turned magenta into saturated green. |
| `find_stack_palette.mjs` | how the ancestry palette was searched. **Does not run** — it imports the dataviz validator from a path inside one machine's temp directory. Kept for the record, not as a tool. |
| [`design_review/`](dev/design_review/README.md) | **render a design option from the browser.** One patch with four switches over `haplo.js`, built on the server because `node_modules` under the mount is Linux-only, screenshotted locally, assembled into an HTML deck with a radio per option. Built for the origin-figure round of 2026-09-12, where two of the four defects found were invisible in prose. Its README carries the traps: the page scrolls the selected row into view, so a long chromosome screenshots blank; a 1100 px window collapses the figure; and the mount needs refreshing after a server-side write. |

The ladder is the instrument behind the size measurements. Its row 0 has to
reproduce a reference build's length **to the byte** or it exits non-zero and prints no rungs,
because rungs hanging off an unanchored base are not measurements. A run is ~14 minutes of
zopfli, so it goes to SLURM:

```bash
sbatch -c 1 --mem=8G -t 0:40:00 -o _ladder.log \
  --wrap="cd $PWD && ~/.pixi/bin/pixi run python \
          web/tools/dev/measure_size_ladder.py CenSV_offline.html"
```

Note `-o` must point at shared storage — a path under `/tmp` is written on the compute node
and is not readable afterwards.
