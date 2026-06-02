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
output/      generated files for the map (JSON) and for analysts (XLSX)
```

## How to regenerate the map data

After a new year of results is published:

1. **Drop the new xlsx** from OKE into `data/egzamin-osmoklasisty/`.

2. **Run the notebook** end to end:

   ```bash
   cd notebooks
   uv run jupyter nbconvert --to notebook --execute --inplace how_to_measure_school_quality.ipynb
   ```

   The export cells overwrite files in `output/` **only if the data changed**
   (so git shows no changes on a re-run with unchanged data). Set
   `FORCE_REGENERATE = True` in section 6 to force regeneration.

3. **Geocode new school addresses** (coordinates are not in the OKE data):

   ```bash
   uv run python scripts/geocode_schools.py
   ```

   The script reads `output/schools-base.json`, geocodes new or changed addresses
   via OpenStreetMap (Nominatim), and writes the result to
   `data/school_coords.csv`. Unchanged addresses keep their cached coordinates.
   Geocoding is slow (~1 request/second), so run it only when new schools appear.

4. **Re-run the export cells** (or the whole notebook) so the fresh coordinates
   are merged into `schools-base.json`.

5. **Commit** the contents of `output/` and `data/school_coords.csv`.

## Output files

For the map (JSON):

- `output/schools-base.json` — metadata + each school's primary score (loaded
  immediately when the map opens, ~1 MB)
- `output/schools-{metric}.json` × 4 — all score views for a given metric (loaded
  on demand, ~8 MB each)

For analysts (Excel):

- `output/schools-{metric}.xlsx` × 4 — long format (one row = one data point),
  with administrative metadata (powiat, gmina, typ_gminy) for filtering and pivot
  tables

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
