# CLAUDE.md — Technical reference for the school quality project

This file is the technical reference for an AI agent (Claude Code) working on this
project. It documents the data, conventions, methodology decisions, and output
formats. For a human-facing overview, see `README.md`.

---

## What this project does

Analyses results of the Polish 8th-grade exam (**egzamin ósmoklasisty**) published
by the **Warsaw OKE district** and produces data for an external school-quality map.

**Critical scope fact:** the OKE Warszawa data covers **only the Mazowieckie
voivodeship** (1,663–1,720 schools depending on year), *not* all of Poland.
Always use **"voivodeship"** rather than "national" in code, comments, variable
names, chart labels, and markdown. For example: `voivodeship_mean`, not
`national_mean`; "Voivodeship median per year", not "National median per year".

If the data is ever extended to other OKE districts, the metric is still
well-defined per voivodeship, but the reference-computing functions should be
made parametric over the grouping level.

---

## Repository layout

```
compare-primary-schools-mazowieckie/
├── notebooks/
│   └── how_to_measure_school_quality.ipynb   # the analysis + export (run end to end)
├── scripts/
│   └── geocode_schools.py                      # geocode addresses → data/school_coords.csv
├── data/                                       # INPUT (read-only source data)
│   ├── egzamin-osmoklasisty/                   # OKE xlsx files, one per year
│   │   ├── 2021_-_*.xlsx
│   │   ├── 2022_-_*.xlsx
│   │   └── ...
│   └── school_coords.csv                       # geocoding cache (rspo, address, lat, lon)
├── output/                                     # OUTPUT (generated — singular, mirrors `data`)
│   ├── schools-base.json
│   ├── schools-{metric}.json   × 4
│   └── schools-{metric}.xlsx   × 4
├── README.md
└── CLAUDE.md
```

`data/` and `output/` are both singular mass nouns (input data / output data),
paralleling each other. `notebooks/` and `scripts/` are plural (countable files).

---

## Source data format

Each OKE xlsx has a sheet named `SAS` with a two-level header. After loading and
normalising (lowercase, strip Polish diacritics, collapse whitespace), the
relevant columns are:

**Metadata columns** (level-0 group is blank / "meta"):
- `rspo` — unique school identifier (stable across years)
- `nazwa szkoly` — school name
- `czy publiczna` — public/private flag
- `powiat - nazwa`, `gmina - nazwa`, `typ gminy` — administrative geography
- `miejscowosc`, `ulica nr` — address (used for geocoding)
- `wojewodztwo - nazwa` — always "Mazowieckie" (sanity-check this)

**Per-subject columns** (level-0 group is the subject name):
- `liczba zdajacych` — number of students who sat the exam
- `wynik sredni (%)` — mean score
- `mediana (%)` — median score
- (also `odchylenie standardowe (%)`, `modalna (%)` — not currently used)

Subjects present: `polski`, `matematyka`, `angielski`, and several minor foreign
languages (`francuski`, `hiszpanski`, `niemiecki`, `rosyjski`, `wloski`).

---

## Working DataFrame conventions

The notebook builds a flat `df` with one row per (school, year) and these columns:

- `rspo`, `year`, `school_name`, `is_public`
- `gmina`, `powiat`, `typ_gminy`, `miejscowosc`, `ulica_nr`
- Per subject `s`: `n_{s}`, `mean_{s}`, `median_{s}`
  (e.g. `n_polski`, `mean_matematyka`, `median_angielski`)

Only **3 core subjects** are usable for quality scoring: `polski`, `matematyka`,
`angielski`. The minor languages are taken by too few students per school to be
statistically meaningful (`core_short = ['polski', 'matematyka', 'angielski']`).

`ALL_YEARS` is the sorted list of years present in the data. `rspo_all_years` is
the set of schools with data in every year (used for stability analysis that needs
a constant fold population).

---

## The metric (final decision)

### Per-year, per-subject normalised score

```
diff_mean_year(school, subject, year) =
    school_mean(subject, year) − voivodeship_mean(subject, year)

unit_norm_diff_mean_year =
    diff_mean_year / (100 − voivodeship_mean)   if diff_mean_year ≥ 0
    diff_mean_year / voivodeship_mean           if diff_mean_year < 0
```

Range [−1, +1]: 0 = at the voivodeship mean, +1 = at the ceiling (100%),
−1 = at the floor (0%). In practice values rarely exceed ±0.5.

`voivodeship_mean(subject, year)` = mean of all schools' `mean_{subject}` in that
year (a per-year reference that neutralises exam-difficulty drift — e.g. the
Maths voivodeship mean jumped ~14 pp between 2021 and 2022).

### Aggregation across years

The per-school score aggregates the yearly values. **The aggregation method
depends on whether the metric is a baseline or an advanced one:**

| Metric | Aggregation across years | Why |
|--------|--------------------------|-----|
| `mean` (baseline) | arithmetic mean (equal weight) | simplest, for users who want a plain baseline |
| `median` (baseline) | arithmetic mean (equal weight) | same |
| `diff_mean` (advanced) | weighted mean by `n_students` | more evidence from larger cohorts |
| `unit_norm_diff_mean` (advanced, **primary**) | weighted mean by `n_students` | same |

This is encoded in `AGGREGATION_BY_METRIC` in the export section.

### Why `unit_norm_diff_mean` with weighted mean

Chosen by **leave-one-out (LOO) jackknife stability** testing: for each school
with ≥ 2 years, compute the score with each year left out; the metric whose LOO
estimates are closest together (lowest LOO standard deviation, normalised by the
metric's overall spread) is the most stable. Tested 8 per-year metrics × 5
aggregation methods. `unit_norm_diff_mean` + weighted-mean-by-n wins across all
subjects and school sizes ≥ 10 students, and the result holds on the larger
2022-onward population (1,297 schools, including small schools that started
reporting after 2021).

`diff_mean` and `unit_norm_diff_mean` correlate at Spearman 1.000 — identical
rankings, different scales. `diff_median` (median-based) is consistently *worse*
than `diff_mean`, because the median responds more violently to year-to-year
difficulty shifts (the median student moves the full shift, while the mean is
damped by floor/ceiling effects).

---

## Composite across subjects

```
composite_min(school) = min(
    unit_norm_diff_mean_polski,
    unit_norm_diff_mean_matematyka,
    unit_norm_diff_mean_angielski,
)
```

The **minimum** (not mean) of the three subject scores — answers "is this school
weak in *any* subject?". This is the **primary value shown on the map**.

`good_in_all_3` has been **removed** — do not reintroduce it.

The three subjects correlate ~0.7–0.8 (Pearson), so they are informative but not
redundant; the min captures the bottleneck subject.

---

## Colour scale (for the map)

Diverging green–yellow–red gradient, 5 classes, computed **per (metric, subject)**:

| Class | Condition |
|-------|-----------|
| Saturated red | score ≤ centre − 1.5σ |
| Red | centre − 1.5σ < score < centre − 0.33σ |
| Yellow | centre − 0.33σ ≤ score ≤ centre + 0.33σ |
| Green | centre + 0.33σ < score < centre + 1.5σ |
| Saturated green | score ≥ centre + 1.5σ |

σ and centre are computed **per metric and per subject**, because the metrics
live on different scales (`mean`/`median` are 0–100; `diff_mean` and
`unit_norm_diff_mean` are difference scales). The rules:

- **`mean` and `median`** (raw 0–100 scale): centre = the mean of school scores
  for that subject (the voivodeship average, ≈ 54–69 depending on subject), σ =
  std across schools. Centring at 0 would make no sense — no school scores 0%.
- **`diff_mean` and `unit_norm_diff_mean`** (difference scales): centre = 0 for
  the three subjects (already centred by construction), σ = std across schools.
- **`composite_min`** (any metric): centre = the empirical *mean* of composite_min
  for that metric. composite_min's distribution is shifted left (the minimum of 3
  draws is systematically below each draw), so centring on its own mean gives a
  usable map instead of one where almost everything is red.

All of these (`sigma[metric][subject]`, `sigma_centre[metric][subject]`) are
written into `schools-base.json` → `metadata`, so the frontend can colour the
map for **any** selected metric, not just the primary one.

Indicative `unit_norm_diff_mean` σ (recomputed each run):
polski ≈ 0.192, matematyka ≈ 0.284, angielski ≈ 0.361, composite_min ≈ 0.245.

The **app defaults to `composite_min`** under the primary metric, but all four
metrics × four subjects are exported, so the user can toggle both the metric and
the subject that colours the map.

---

## Notebook structure (`how_to_measure_school_quality.ipynb`)

- **0. Setup** — imports, `DATA_DIR`, `OUTPUT_DIR`, helper `render_min_highlighted_table`
- **1. Load data** — read all xlsx, build flat `df`, drop rows missing core subjects
- **2. Why only 3 subjects** — student-count distributions justify dropping minor languages
- **3. Choosing the best per-year metric** — the LOO stability analysis:
  - why the median jumps more than the mean (difficulty shifts)
  - within-school year-to-year swing vs voivodeship swing
  - candidate metrics + aggregation methods (joint LOO test, 8 × 5)
  - rank-swing analysis + the density-effect explanation
- **4. Final metric definition** — formulas, why, colour scale; subsection
  "Combining all three subjects" (correlation, composite_min, colour-class counts)
- **5. How school level and rank changes** — base vs LOO vs single-year views;
  lollipop charts for two samples (12 schools = 4 top/4 mid/4 bottom; 15 schools
  = 3 each at P10/30/50/70/90); population-wide scatter of range and min/max
- **6. Export data to external map** — computes alternative views, writes JSON + xlsx

### Helper: `render_min_highlighted_table(df, caption, value_fmt='{:.3f}', axis=1)`

Renders a DataFrame as an HTML table with the **minimum cell highlighted green**,
using **inline `<td style="...">`** (not a `<style>` block). This is required
because VS Code and nbconvert strip `<style>` blocks from notebook outputs, so
pandas `Styler.highlight_min` / `.apply` colouring does not survive. `axis=1`
highlights the min per row; `axis=0` per column.

---

## Export (Section 6)

### Views

For each (school, subject, metric), four **views** are exported — each computed
only over the **years the school actually has** (no meaningless folds):

| view_kind | view_param | meaning |
|-----------|-----------|---------|
| `base` | — | score over all the school's years |
| `loo` | excluded year | score with one year left out (only if ≥ 2 years) |
| `single_year` | year | score from one year alone |
| `last_k` | k | score over the most recent k years, k = 2 … (n_years − 1) |

Each view carries `score`, `rank` (1 = best, among schools present in that view),
`pct` (percentile), and `n_students` (the **median** number of students per year
in that view — the school's typical cohort size, rounded. Median rather than sum
or mean: summing across overlapping views is meaningless and would drift up as
years accumulate; the median is robust to anomalous years — e.g. a
home-schooling-linked school that grew from 5 to 1200 students should report its
typical size, not a mean dragged by the extremes (~16% of schools have mean and
median diverging by >5 students). For `composite_min`, the cohort of the subject
that produced the minimum — so a validator knows which subject and how many
students the composite value came from).

### Output files

- **`schools-base.json`** (~3.8 MB raw, ~0.4 MB gzipped — GitHub Pages serves
  gzip) — loaded on map open. Per school: metadata (name, address, is_public,
  n_years, lat/lon) plus **base score/rank/pct for ALL four metrics × four
  subjects** under `scores[metric][subject]`. This lets the frontend switch
  metric and filter by value **without** downloading the big per-metric files.
  `lat`/`lon` come from the geocoding cache (`null` if missing). `metadata` holds:
  `default_metric`, `metrics`, `subjects`, `years_in_data`, `sigma[metric][subject]`,
  `sigma_centre[metric][subject]`, and `slider_ranges[metric]` (see below).
- **`schools-{metric}.json`** × 4 (~7 MB each, ~0.8 MB gzipped) — all *views* for
  all schools, loaded on demand only when the user opens a school's year-by-year
  history (the map and value-filtering work from base alone). `base` is a flat
  `{score, rank, pct}`; other views are `{param: {score, rank, pct}}` with
  integer-string param keys (`"2021"`, `"2"`).
- **`schools-{metric}.xlsx`** × 4 (~6.5 MB each) — long format for analysts, one
  row per (school, subject, view), in two sheets:
  - **`data`** sheet columns: `rspo, school_name, miejscowosc, ulica_nr, powiat,
    gmina, typ_gminy, is_public, n_years, metric, subject, view_kind, view_param,
    score, rank_overall, pct_overall, n_in_view, n_students`.
  - **`legend`** sheet: a human-readable description of the metric, the
    across-years aggregation method, and every column / view_kind / subject — so
    someone validating a school's number knows exactly how it was computed.

### Slider ranges (value filter config)

`metadata.slider_ranges[metric] = {min, max, p1, p99, step}` gives the frontend
the range for the map's "show schools with score above X" filter, per metric
(the scale differs: `mean` is 0–100, `unit_norm_diff_mean` is ≈ −0.85…+0.64).
`p1`/`p99` are robust default slider ends; `min`/`max` are hard limits. The
config is computed at export time (data and config generated together, so they
can't drift) rather than recomputed in the browser.

Naming: **English** for technical fields, **Polish** for geographic fields
(miejscowosc, ulica_nr, powiat, gmina, typ_gminy).

### Idempotence

`FORCE_REGENERATE = False` (top of Section 6). On each run the export compares
new data with the existing file and **skips writing if unchanged**, so git stays
clean on no-op runs:
- JSON: compares parsed payloads, ignoring `metadata.generated_at`.
- XLSX: reads the existing file (`dtype={'view_param': str}` to avoid `'2'`→`2.0`
  drift) and compares with `dataframes_equal` (floats via `np.isclose`,
  `rtol=1e-6`). `view_param` is written as text format so Excel doesn't coerce it.

`FORCE_REGENERATE = True` rewrites everything. `created` timestamps reflect the
real generation time when a file is actually written.

---

## Geocoding (`scripts/geocode_schools.py`)

Coordinates are **not** in the OKE data, so they are geocoded separately:

- **Input**: `output/schools-base.json` (rspo + address).
- **Cache**: `data/school_coords.csv` with columns
  `rspo, miejscowosc, ulica_nr, latitude, longitude`.
- **Logic**: if an rspo is in the cache and its address is unchanged, keep the
  cached row **in its original CSV position**; if the address changed, re-geocode
  in place; new schools are **appended at the end**.
- **Geocoder**: Nominatim (OpenStreetMap), 1.1 s between requests, tries
  "street, town, Polska" then falls back to "town, Polska".
- **Flags**: `--limit N` (cap new requests, for testing), `--force` (ignore cache).

Run it after adding new schools, then re-run the notebook's export cells so the
fresh coordinates land in `schools-base.json`.

---

## Uncertainty communication (frontend guidance)

The export carries `rank`, `pct`, and per-view `score` for every school. **How the
frontend uses these matters — they communicate different levels of certainty.**

### Map view

- **Show colour only, not numeric ranks.** Rank position in the middle of the
  distribution swings by ~10% of the ranking (100+ positions) when one year is
  excluded — pure density effect, not a metric flaw. A numeric rank ("#234 in
  the voivodeship") implies precision the data cannot support.
- **Colour reflects score, not rank.** The score is well-estimated everywhere;
  the rank is misleadingly precise in the middle. The diverging colour scale
  saturates at ±1.5σ so the extremes are visually distinct while the middle
  band is honestly muddy.
- **Default view: `composite_min` under the primary metric.** The app exposes
  two toggles: a **subject toggle** (Polish / Maths / English / composite_min)
  and a **metric toggle** (mean / median / diff_mean / unit_norm_diff_mean). All
  metric × subject combinations are in `schools-base.json`, so both toggles
  recolour the map instantly with no extra download.
- **Filters on the map:**
  - **Public / private** (`is_public`: "Tak"/"Nie") — important. Empirically the
    top of every subject is dominated by private schools, so a parent looking for
    a strong *public* school needs to filter them out to see a useful map. Do not
    annotate *why* private schools rank high — the data measures outcomes, not
    value added, and we have no intake data to attribute the difference to any
    cause.
  - **Score threshold** — "show only schools scoring above X" for the selected
    metric, using `metadata.slider_ranges[metric]` for the slider bounds. Lets a
    user watch the map thin out as they raise the bar (e.g. only schools above
    0.1 in `unit_norm_diff_mean`, or above 60 in `mean`).
  - **Min n_years** — hide low-data schools.
- **Zoom + address search.** Native Leaflet zoom plus an address search box
  (one Nominatim query → zoom to location) so a user can see schools near a
  specific area; 1,400 markers at full extent is not useful on its own.
- **Markers**: fixed-size coloured circles (colour = the quality scale) with
  clustering at low zoom (~1,400 plotted schools need it). Do **not** size markers
  by student count — it would conflate "many students" with "good".

### Ranking tab (separate from the map)

A search-by-name table (e.g. "Vizja", "STO", or unfiltered list) is fine to
include — but with full uncertainty context. Per school, show:

- **Base rank** — score over all years
- **Best / worst LOO rank** — min and max rank across the LOO folds
  (e.g. "base #234, LOO range #198–#267")
- **Best / worst single-year rank** — min and max rank across single-year views
  (e.g. "in any single year, ranged from #112 to #389")

This is honest: the table shows where the school sits *and* how much that
position depends on which year is included. All these numbers are already in
`schools-{metric}.json` under `loo.{year}.rank` and `single_year.{year}.rank`
— the frontend just computes min/max.

The ranking tab should also let the user:
- **Filter public / private** (same `is_public` field).
- **Pick the metric** (mean / median / diff_mean / unit_norm_diff_mean) and a
  **view** — in particular `last_k`. This enables comparison with external
  rankings: e.g. rankingedukacji.pl uses the arithmetic mean of the last 3 years,
  which corresponds to `metric=mean, view=last_k, view_param=3`. (Their ranking
  also folds in non-exam factors, so positions won't match exactly, but the
  exam-based part is comparable.) The base `rank`/`pct` for all metrics are in
  `schools-base.json`; the `last_k` and other views come from the per-metric
  files, loaded on demand (see below).

### Warning badges in school popup

Three independent signals; show ⚠️ if any fires (combine into one badge with
hover-text listing which conditions triggered):

| Condition | Meaning |
|-----------|---------|
| `n_years < 3` | Short history — limited certainty about the school's long-term level |
| LOO range > 1σ AND `n_years ≥ 3` | Many years of data but large year-to-year volatility — score depends on which year is included |
| (geocoding failed: no `lat`/`lon`) | The school isn't shown on the map at all; no popup |

`n_total < 20` was considered but rejected — schools with low total student count
almost always also trigger `n_years < 3` or have other low-quality signals, so a
separate threshold would add complexity without catching additional cases.

The LOO-range threshold is intentionally combined with `n_years ≥ 3`: schools
with only 2 years would *always* have a wide LOO range (each fold uses only 1
year), which is small-sample noise, not real volatility. Empirically with the
current data, the combined rule flags ~6 schools out of ~1,400 with 3+ years —
rare but real signals of true year-to-year instability.

### Data loading strategy

- **On map open:** load `schools-base.json` only (~0.4 MB gzipped). This is
  enough for the map, all metric/subject toggles, value filtering, public/private
  filtering, and base ranks in the ranking tab.
- **Year-by-year history** (LOO / single-year / last_k views) lives in the four
  `schools-{metric}.json` files (~0.8 MB gzipped each, ~3 MB for all four). These
  are **not** prefetched automatically — fetching ~3 MB on every fresh visit
  would burn mobile data (browser HTTP caching via ETag covers repeat visits from
  the same browser, but not incognito or a different browser/device). Instead,
  gate the richer history behind a **visible checkbox / button**: "Show detailed
  year-by-year history (downloads ~3 MB)". Fetch all four files once on demand,
  keep them in memory for the session.
- Computing colour classes client-side from `metadata.sigma` + `sigma_centre`
  needs only base — no per-metric file required for the map.

### Internationalisation

Default UI language **Polish**, with a toggle to **English** (some users may be
English-speaking). Translate only interface labels (buttons, headers, metric
names, warning text). Leave proper nouns in Polish: school names, town names,
addresses, administrative fields. The data files use English technical field
names (`mean`, `view_kind`, etc.); the UI maps them to localized labels. The
methodology notebook stays English-only (GitHub / technical audience).

### Never invent coordinates

If geocoding fails, the school's `lat`/`lon` stay `null` and it is omitted from
the map. **Never substitute plausible-looking coordinates** (e.g. town centre,
voivodeship centre) — they would misplace markers and undermine trust in the
map. The user should be able to assume that every marker on the map is at the
school's real location.

---

## Global coding rules (apply everywhere)

- **Exact column names** — never substring-match (`df[f'mean_{s}']`, not
  `next(c for c in cols if 'mean' in c)`).
- **`pd.to_numeric(errors='raise')`** by default; use `'coerce'` only when
  non-numeric values are expected, and then assert/log how many were coerced.
- **Log dropped rows** with counts; never silently filter.
- **Assertions** for structural assumptions (e.g. RSPO unique per school name).
- **No `try/except`** to suppress errors during data loading.
- **Explore before analysing** — check shape/dtypes, `value_counts(dropna=False)`
  on key columns, cross-check related columns (if `n_students > 0`, verify
  mean/median are non-null); stop and report on unexpected nulls.

### Polish characters

Always preserve Polish characters literally in output: use
`json.dump(..., ensure_ascii=False)` and write files with `encoding='utf-8'`.

### Notebook outputs

Always **execute the notebook and embed outputs** (charts, tables) so results are
visible without re-running. Use `--ExecutePreprocessor.record_timing=False` to
keep the diff clean — without it nbconvert injects per-cell `execution` metadata
(timestamps for `iopub.execute_input`, `iopub.status.busy`, etc.) that change
every run:

```bash
cd notebooks
uv run jupyter nbconvert \
    --to notebook --execute --inplace \
    --ExecutePreprocessor.record_timing=False \
    how_to_measure_school_quality.ipynb
```

Run from the project root's `notebooks/` dir so the relative paths
(`../data`, `../output`) resolve. Warn before executing if long-running cells
changed (the export reads/writes several MB of xlsx).

If you forgot the flag and want to clean an already-recorded notebook, this
one-liner strips the metadata:

```bash
uv run python -c "
import json, pathlib
p = pathlib.Path('notebooks/how_to_measure_school_quality.ipynb')
nb = json.loads(p.read_text())
for c in nb['cells']:
    c.get('metadata', {}).pop('execution', None)
p.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + '\n')
"
```
