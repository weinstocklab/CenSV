# CenSV

Interactive browser for centromeric structural variation — source, data pipeline and
deployment.

**Browser:** https://yikaidong-git.github.io/CenSV/ · **Published artefact:**
[`YikaiDong-git/CenSV`](https://github.com/YikaiDong-git/CenSV)

CenSV presents the structural variants imputed inside the active α-satellite higher-order
repeat array of each of the 23 human centromeres, positioned on **T2T-CHM13 v2.0**, together
with the molecular and disease associations reported for each. It is the companion browser to
the preprint below, from the [Weinstock Lab](https://github.com/weinstocklab) at Emory
University.

> Dong Y, Cutler D, Weinstock JS. **Common centromeric variation associates with molecular and
> complex traits in humans.** *medRxiv* 2026.
> [10.64898/2026.10.09.26365154](https://doi.org/10.64898/2026.10.09.26365154)

This repository holds the source: the ETL, the browser, the verification suites and the
deployment. The browser it produces is a single self-contained HTML file, published from the
repository linked above.

## What the browser shows

The browser opens on 23 chromosome cards. Each card carries three panels on one shared CHM13
abscissa — the variant scatter, and the 5mC methylation and dip-density tracks at 60 bins
each — so a position reads straight across all three. The covered-base frame follows the
reference's own active blocks. The dip track also offers a **Stacked by ancestry** mode, which
decomposes the pooled track into 1000 Genomes super-populations at an identical silhouette.

**Colour encodes how many independent analyses converge** on a position, as a one-hue ordinal
ramp, with significance in two tiers, primary and suggestive. The categorical palette for the
ancestry stack was found by search, and both it and the ramp are validated for colour-vision
deficiency in light and dark modes.

Each centromere also carries a **haplotype layer** at `#/chrN/haplotypes`, where the unit is
the assembled haplotype rather than the variant: one individual's two arrays at their own
lengths on a CHM13 base-pair axis, each anchored at the array start; the Jaccard-NJ tree of the
392 assembled haplotypes with the clade a chosen SV marks outlined, tips ribboned by ancestry,
ascAIRN haplogroup and carrier state; and the SVs whose carriers form exactly one clade, ordered
by decomposition r². A strip below the LD panel carries the counts, and each record states
whether that SV marks a clade before a reader follows the link.

**Search covers everything the browser knows** — genes and Ensembl identifiers, diseases and
phecodes, CpGs, variant identifiers, haplogroups, variant classes, chromosomes and genomic
coordinates. Coordinates are parsed as intervals, so `chr8:44.2-44.5Mb` resolves to the
variants in that interval.

## Requirements

- **[pixi](https://pixi.sh)** pins the node and python toolchain for the ETL, the front-end
  build and the verification suites. `pixi install` provides the rest.
- **A current browser** to read it: Chrome 80, Firefox 113, Safari 16.4 or newer.
- **An `https://` origin**, where browsers expose the decryption API. A copy opened from a
  local folder reports this on the page.
- **Chrome** for the two browser-driven verification suites, which drive it over the DevTools
  protocol and run from a workstation.

## Quick start

```bash
pixi install                                      # node and python, pinned

# 1. build the browser's JSON from the analysis results tree
pixi run python etl/build_data.py <PROJECT_ROOT> web/public/data

# 2. develop
cd web && pixi run npm ci && pixi run npm run dev  # http://localhost:5173

# 3. build and publish
bash infra/pages/deploy_pages.sh
```

| step | produces |
|---|---|
| `etl/build_data.py` | the browser's JSON under `web/public/data`, including `meta.json` with the source commit of the analysis repository |
| `etl/build_haplotypes.py` | `hap_index.json` and one `hap_<chrom>.json` per centromere, for the haplotype layer. Reads the trees, dip calls and ascAIRN typing from the analysis repository and joins them against `catalog.json`; every disagreement fails the build. Run by hand, and its output is committed. `--multi` and `--resolution` name the resolution vintage, which has to be the one `catalog.json` came from — see `discovery/2026-08-03_cdr_qtl_full_substrate/output/_archive/2026-09-11_resolution_prerebuild/README.md` for the pair published today |
| `npm run dev` | the browser at http://localhost:5173 |
| `infra/pages/deploy_pages.sh` | builds the single file, publishes it through GitHub Pages, then downloads the served copy and checks it |

`etl/build_data.py` reads the analysis results tree, the CenSat v2.1 array boundaries, and
four released sample-metadata tables that supply the super-population labels. The methylation
QTL results sit outside the project tree; their path is recorded in `meta.meqtl_root` and the
build requires it to resolve. `--allow-missing` produces a partial build, which the browser
reports on the page.

## Repository layout

```
etl/            builds the browser's JSON from the analysis results (one module per section)
  checks/         negative controls: corrupted input each loader must reject
web/            the browser — static, runs entirely in the reader's browser
  src/            views and routing, search, shared DOM helpers, design tokens
  tools/          single-file build, verification suites, screenshotting
docker/         multi-stage build: node compiles the front end, nginx serves it
infra/          Terraform (ECR, ECS, ALB, state backend) and the publishing scripts
.github/        build and smoke-test, deploy, infrastructure
```

## The data

> Paths beginning `discovery/` or `code/` name the private analysis repository. The
> commit each build was made from is recorded in `meta.json`.

Coordinates are **T2T-CHM13 v2.0** throughout, against **CenSat v2.1** array boundaries. The
variants were called on HPRC assemblies against CHM13 and imputed over the 1000 Genomes
cohort; in the QTL pipeline each centromeric variant carries its chromosome's GRCh38
centromere *midpoint* as its GRCh38 coordinate. Every variant lies within its chromosome's
active higher-order repeat array, checked at build time.

The catalog's unit is **(variant × resolution mode)**: 10,705 rows over 8,792 distinct
variants, since a variant called at more than one resolution appears once per mode and the
associations were tested per mode. The assembly cohort is 188 samples — HPRC, HGSVC3 and the
Platinum pedigree — labelled by super-population from four released tables.

479 hits are drawn, 342 primary and 137 suggestive, across five analysis layers:

| layer | primary tier |
|---|---|
| expression QTL | 86 eGenes at cis q ≤ 0.05 |
| splicing QTL | 74 sGenes at cis q ≤ 0.05 |
| methylation QTL | the cross-panel-robust cis pair and the focused trans pair, per-variant family-wise p = 0.0099 |
| centromere dip region | the 9 study-wide survivors, all chr8, within 213.6 kb |
| disease PheWAS | 170 associations over 61 predictors and 27 diseases |

Expression and splicing together contribute 141 unique genes, and every hit resolves to a
catalog row. Population differentiation (maximum pairwise F_ST) and 204 per-ancestry re-tests
across six strata are carried as attributes of the variant. The two substrate tracks, 5mC
methylation and dip density, are cross-checked against one another at **r = −0.93**.

Every layer's counts are asserted against the paper's at build time, so the browser ships the
numbers the paper reports. `meta.json` records the source commit of the analysis repository,
so a deployed build traces back to the analysis state it was built from.

## Related repositories

| repository | holds |
|---|---|
| `weinstocklab/CenSV` (this one) | the ETL, the browser source, the verification suites and the deployment |
| [`YikaiDong-git/CenSV`](https://github.com/YikaiDong-git/CenSV) | the published browser: one self-contained `index.html` served through GitHub Pages |

## Contact

Correspondence: [yikai.dong@emory.edu](mailto:yikai.dong@emory.edu),
[josh.weinstock@emory.edu](mailto:josh.weinstock@emory.edu)

## Citation

> Dong Y, Cutler D, Weinstock JS. **Common centromeric variation associates with molecular
> and complex traits in humans.** *medRxiv* 2026.
> [10.64898/2026.10.09.26365154](https://doi.org/10.64898/2026.10.09.26365154)

## License

Released under the [MIT License](LICENSE).
