# Project: School Quality Analysis — Warsaw OKE District

## What this project is

Analysis of 8th-grade exam results (egzamin ósmoklasisty) from the Warsaw OKE district,
2021–2025 (new year added annually). Goal: produce a public interactive map where parents
can see how schools in their area perform, with honest uncertainty communication.

Two outputs:
1. `how_to_measure_school_quality.ipynb` — methodology notebook, readable by a
   mathematically literate parent (understands median/mean). Written in English,
   published on GitHub. Explains every methodological decision including rejected alternatives.
2. `docs/index.html` — standalone interactive map (Leaflet.js), hosted on GitHub Pages.
   No backend, no server, no API keys required.

---

## Repository structure

```
analiza-egzaminow/
├── data/
│   ├── egzamin-osmoklasisty/    # raw xlsx files, one per year (YYYY_*.xlsx)
│   ├── geocode_cache.json       # cached lat/lon per RSPO — commit this to repo
│   └── school_scores.csv        # exported by notebook, consumed by build_map.py
├── docs/
│   ├── index.html               # the public map — GitHub Pages serves this directory
│   └── schools.json             # pre-built data file for the map (~1 MB)
├── notebooks/
│   └── how_to_measure_school_quality.ipynb
├── scripts/
│   └── build_map.py             # geocoding + schools.json generation, run locally once/year
├── CLAUDE.md
└── pyproject.toml               # managed by uv
```

Run notebook with: `uv run jupyter lab`
Build map with: `uv run python scripts/build_map.py`

---

## Annual update workflow (when new year's data arrives)

1. Drop new xlsx into `data/egzamin-osmoklasisty/`
2. Re-run notebook → new `school_scores.csv`
3. Run `build_map.py` → geocodes only new schools (cache handles the rest),
   outputs new `docs/schools.json`
4. Commit and push → GitHub Pages auto-deploys

Geocoding is a one-time cost (~30 min for 1,663 schools via Nominatim at 1 req/s).
Subsequent years add only new schools (~50–100 per year), taking < 2 minutes.
`geocode_cache.json` must be committed to the repo so other machines skip geocoding.

---

## Data structure

- Source: Excel files, sheet `SAS`, two-row header (MultiIndex after loading)
- Column structure after loading:
  - `('meta', 'rok')` — year
  - `('meta', 'rspo')` — unique school ID, stable across years
  - `('meta', 'nazwa szkoły')` — school name
  - `('meta', 'miejscowosc')` + `('meta', 'ulica nr')` — address for geocoding
  - `('jezyk polski'|'matematyka'|'jezyk angielski', 'liczba zdajacych')` — n students
  - `('jezyk polski'|'matematyka'|'jezyk angielski', 'mediana (%)')` — median score
  - `('jezyk polski'|'matematyka'|'jezyk angielski', 'wynik sredni (%)')` — mean score
  - `('jezyk polski'|'matematyka'|'jezyk angielski', 'odchylenie standardowe (%)')` — loaded but unused in main metric
- One row = one school × one year
- 8,260 rows total across 5 years, ~1,663 unique schools per year

**On load, immediately drop:**
- All columns where metric contains `modalna` — artifact of 1pp scoring grid, no value

**Subject short codes used throughout:**
- `polski` → `jezyk polski`
- `matematyka` → `matematyka`
- `angielski` → `jezyk angielski`

**Geocoding:** use address from the most recent year available for each school
(schools occasionally relocate). Key = RSPO number.

---

## Final metric — what we use and why

### Per-subject score (pp above/below national median)

```
diff_year(school, subject, year) =
    school_median(subject, year) − national_median(subject, year)

score(school, subject) =
    Σ_year [ n_students(year) × diff_year ] / Σ_year [ n_students(year) ]
```

Result is in percentage points. Positive = above national average. Zero = exactly average.
Years are weighted by student count — a year with 50 students counts 10× more than a year
with 5. This is both statistically correct and eliminates the need for separate shrinkage.

### Composite score

Mean of the three per-subject percentile ranks (0–100).
Additionally flag `good_in_all_3`: school is ≥ 60th percentile in ALL three subjects.
Note: the 60th percentile threshold is somewhat arbitrary — see open questions below.

### Map colour scale

Diverging green–yellow–red gradient, computed per subject:
- Yellow zone: ±0.33σ from zero (school is not meaningfully different from national average)
- Gradient: linear from ±0.33σ to ±1.5σ
- Saturates at ±1.5σ (deep green / deep red) — schools beyond this are all the same colour
- σ values (from data): Polish ≈ 9 pp, Maths ≈ 17 pp, English ≈ 19 pp
- Saturation is intentional: differences between rank #1 and #15 are within statistical noise

```python
def score_to_color(score_pp, sigma):
    # t in [-1, 1], where ±1 = ±1.5σ
    t = np.clip(score_pp / (1.5 * sigma), -1, 1)
    if t >= 0:
        r = int(255 * (1 - t))
        g = int(255 - 75 * t)
        b = 0
    else:
        r = int(220 + 35 * t)
        g = int(255 * (1 + t))
        b = 0
    return f'#{r:02x}{g:02x}{b:02x}'
```

---

## Key empirical facts (verified on actual data, 2021–2025)

- 51% of schools have ≤ 20 students sitting any exam in a given year
- 25% have ≤ 10 students
- National Maths median swings 14 pp between 2021 (46 pp) and 2022 (60 pp)
- Within-school year-to-year std of percentile rank: median ≈ 6.4 pp for schools
  with 5 years of data; 12.6% of schools have std > 10 pp
- A school missing the hard 2021 Maths year gets a +2.9 pp bonus with raw scores,
  but only +0.16 pp bonus with diff_median — key reason we use diff_median
- Top 30 schools: median max rank swing across LOO folds = 13 positions;
  30% of top-50 schools swing > 20 positions when one year is dropped
- LOO std comparison for Maths, n 20–49: diff_median = 1.83 pp vs raw median = 2.22 pp
  (diff_median more stable for schools with ≥ 10 students, which is 75% of schools)

---

## Rejected approaches — DO NOT reintroduce without discussion

### Raw median or mean score (not normalised by year)
**Rejected because:** National difficulty changes dramatically year to year (+14 pp in Maths).
A school missing 2021 gets a systematic +2.9 pp bonus with raw scores (only +0.16 pp
with diff_median). LOO stability is worse than diff_median for n ≥ 10 (75% of schools).

### Percentile rank as intermediate aggregation metric
**Rejected because:** Percentile is sensitive to the entire national distribution shifting
each year. LOO std for pct_median is 4.87 pp vs 3.18 pp for raw median at n < 10.
Around the 50th percentile, 175 schools are clustered — a 2 pp score difference
maps to dozens of percentile positions, implying false precision.
**Use percentile ONLY as the final display step** (map colour), never as an intermediate.

### Bayesian shrinkage per year before aggregation
**Rejected as primary approach** (may be revisited as a secondary display metric).
Problem: a school consistently at the 90th percentile with n=8 every year gets
penalised every year independently. The penalty never diminishes because shrinkage
operates per-year, not on pooled data. A school that is consistently small and good
receives a permanent downward bias. The n-weighted aggregation already provides
regularisation — years with small n contribute less automatically.

### Median of years (instead of weighted mean across years)
**Rejected because:** With 5 years, median = 3rd sorted value, discarding 40% of data.
Ignores that a year with 50 students is more informative than a year with 5.
Weighted mean consistently wins or ties LOO stability across all school sizes.

### Trimmed mean across years
**Tested, marginally worse than weighted mean** in LOO stability. No advantage over
weighted mean; adds complexity for no gain.

### Ratio normalisation (school_median / national_median)
**Rejected because:** Non-comparable scale across subjects. Ceiling effects distort
the ratio when national median is high. Range 0.17–2.09 is unintuitive. Multiplicative
model not justified for percentage-point scores with hard floor/ceiling.

### odchylenie standardowe (within-school std) in the main metric
**Not used in main metric.** Within-school std reflects student intake composition
(selective vs non-selective admissions), not teaching quality. Without baseline student
ability data we cannot separate the two effects.
**May be used in exploratory analysis:** scatter of median vs std, coloured by
public/private, to show that "top" schools are often selective rather than better
at teaching. This is an important caveat for the map's readers.

### Modalna (modal score)
**Removed on load.** Artifact of 1pp scoring grid, no analytical value.

### Google Maps for the interactive map
**Rejected:** Requires API key with billing enabled, rate limits, ongoing cost.

### Folium for the interactive map
**Rejected for production** (fine for notebook exploration).
Folium embeds all data as a single HTML blob — 1,663 markers with no lazy loading
causes slow initial render. No native clustering, no viewport filtering, no easy
annual update workflow. Replaced by Leaflet.js with MarkerCluster.

### RSPO API for geocoding
**Rejected:** Requires formal written application, 14-day approval process,
institutional affiliation. Not appropriate for a hobby project.

---

## Open methodological questions (not yet resolved)

These have not been fully analysed. Do not silently assume an answer.

1. **Independence of years.** We treat each year as an independent observation.
   But a school with a weak Maths teacher for 3 consecutive years produces correlated
   results, not 3 independent observations. Does this affect the optimal aggregation?

2. **good_in_all_3 threshold.** The 60th percentile cutoff is arbitrary. Sensitivity
   to this threshold has not been tested. Consider adding a section to the notebook
   showing how the count of flagged schools changes with the threshold (50th, 60th, 70th).

3. **Student intake composition vs teaching quality.** The metric measures outcomes,
   not value added. Private/selective schools likely rank high due to student selection,
   not better teaching. We have `czy publiczna` and `typ gminy` in the data — could
   be used for a caveat analysis but not for score adjustment (no baseline ability data).

---

## Uncertainty communication — design decisions

- Schools with n_total < 20 across all years: show ⚠️ warning in popup
- Do NOT show ranking positions (e.g. "#3 in district") — top-30 rankings shift
  by 13+ positions when one year is removed. Show the score in pp above/below national.
- Percentile colour saturates at ±1.5σ intentionally — the difference between
  the #1 and #15 school is within statistical noise given the sample sizes
- `good_in_all_3` flag is more conservative and reliable than composite score alone
- Popup should show: school name, type (public/private), score per subject (pp),
  n_students total per subject, n_years of data, composite percentile,
  ⚠️ if low data

---

## Map architecture (Leaflet.js)

**Data pipeline:**
```
notebook → school_scores.csv → build_map.py → docs/schools.json
```

**schools.json structure per school:**
```json
{
  "rspo": 12345,
  "name": "SP nr 5 ...",
  "lat": 52.23,
  "lon": 21.01,
  "is_public": true,
  "n_years": 5,
  "subjects": {
    "polski":    {"score": 4.2, "pct": 68, "n_total": 95},
    "matematyka": {"score": -2.1, "pct": 44, "n_total": 94},
    "angielski": {"score": 8.7, "pct": 79, "n_total": 96}
  },
  "composite_pct": 64,
  "good_in_all_3": false
}
```

**UX behaviour:**
- Default view: Warsaw, zoom 11, all schools as clusters
- Subject switcher: [Polish] [Maths] [English] [Composite] — changes marker colours
- Address search field: single Nominatim query → zoom to location → highlight 30 nearest
- Min students slider (1–50, default 10): filters out unreliable small schools
- Marker click: popup with full details
- No rank numbers shown anywhere in the UI

---

## Tech stack

- Python 3.12, managed by `uv`
- `pandas`, `numpy`, `scipy` — data processing
- `matplotlib`, `seaborn` — notebook charts
- `geopy` + Nominatim — geocoding
  - Rate limit: 1 req/s (sleep 1.1s between requests)
  - User-agent: `"analiza-e8-szkoly"`
  - Cache: `data/geocode_cache.json` — commit to repo
  - Address source: most recent year's `miejscowosc` + `ulica nr` per RSPO
  - On geocoding failure: log to stderr, skip school (never invent coordinates)
- Leaflet.js + Leaflet.markercluster (CDN) — interactive map
- GitHub Pages (serves `docs/` directory) — hosting

All variable names, function names, and code comments: English.
Notebook markdown cells: English (GitHub audience).
