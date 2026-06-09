# compare-primary-schools-mazowieckie

Analysis of 8th-grade exam (egzamin ósmoklasisty) results for primary schools in
the Mazowieckie voivodeship (Warsaw OKE district data), producing the data for an
interactive school-quality map.

> **Data scope:** the Warsaw OKE data covers **only the Mazowieckie voivodeship**,
> not all of Poland. All references ("voivodeship mean") are within this voivodeship.

## Getting started (uv)

1. Install `uv` (once, globally).
2. In the project directory run:

```bash
uv venv
uv sync
uv run jupyter lab
```

`uv` creates a local environment in `.venv`, so the libraries don't conflict with
other projects.

## Project layout

```
notebooks/   analysis (how_to_measure_school_quality.ipynb)
scripts/     geocode_schools.py — geocode school addresses
data/        input data (OKE xlsx files) + coordinate cache
output/      xlsx files for analysts
docs/        the map app (GitHub Pages); docs/data/ holds the JSON the app loads
```

## How to regenerate the map data

After a new year of results is published:

1. **Drop the new xlsx** from OKE into `data/egzamin-osmoklasisty/`.

2. **Run the notebook** end to end:

   ```bash
   cd notebooks
   uv run jupyter nbconvert \
       --to notebook --execute --inplace \
       --ExecutePreprocessor.record_timing=False \
       how_to_measure_school_quality.ipynb
   ```

   `record_timing=False` keeps the diff clean — without it nbconvert injects
   per-cell execution timestamps that change every run.

   The export cells overwrite files in `output/` **only if the data changed**
   (so git shows no changes on a re-run with unchanged data). Set
   `FORCE_REGENERATE = True` in section 6 to force regeneration.

3. **Geocode new school addresses** (coordinates are not in the OKE data):

   Nominatim requires a User-Agent that identifies the application **and** a way to
   contact whoever runs it — requests without a valid contact are rejected. The
   contact is **not** stored in this repo; you supply your own at runtime via the
   `NOMINATIM_CONTACT` environment variable (an email or a URL):

   ```bash
   # Inline, for a one-off run:
   NOMINATIM_CONTACT=you@example.com uv run python scripts/geocode_schools.py

   # Or set it once for the shell session:
   export NOMINATIM_CONTACT=you@example.com
   uv run python scripts/geocode_schools.py
   ```

   You can also pass it as a flag (`--contact you@example.com`), which overrides the
   env var. If neither is set, the script stops immediately with an explanatory
   error before making any request.

   The script reads `docs/data/schools-base.json`, geocodes new or changed addresses
   via OpenStreetMap (Nominatim), and writes the result to
   `data/school_coords.csv`. Unchanged addresses keep their cached coordinates.
   Geocoding is slow (~1 request/second), so run it only when new schools appear.

4. **Re-run the export cells** (or the whole notebook) so the fresh coordinates
   are merged into `schools-base.json`.

5. **Commit** the generated files in `docs/data/` and `output/`, plus
   `data/school_coords.csv`.

## Output files

For the map (JSON, written to `docs/data/` so GitHub Pages serves them directly):

- `docs/data/schools-base.json` — metadata + every school's base score/rank/pct
  for all metrics and subjects (loaded immediately when the map opens; ~0.4 MB
  gzipped)
- `docs/data/schools-{metric}.json` × 4 — all score views (base, leave-one-out,
  single-year, last-k) for a given metric (loaded on demand; ~0.8 MB gzipped each)

For analysts (Excel, in `output/`):

- `output/schools-{metric}.xlsx` × 4 — long format (one row = one data point),
  with a `legend` sheet and administrative metadata (powiat, gmina, typ_gminy)
  for filtering and pivot tables

Metrics: `mean`, `median`, `diff_mean`, `unit_norm_diff_mean` (default).

## The metric

The primary metric is `unit_norm_diff_mean`: the difference between a school's
mean and the voivodeship mean in a given year, normalised to the range [−1, +1],
averaged across years weighted by the number of students. Chosen via leave-one-out
stability testing among 8 metrics and 5 aggregation methods.

The map shows `composite_min` by default — the minimum of the three subject scores
(Polish, Maths, English), answering "is the school weak in any subject?". The app
lets you switch the view to a single subject.

For methodological and technical details, see `CLAUDE.md`.
