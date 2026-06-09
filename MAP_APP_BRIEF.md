# Build brief — interactive school-quality map

This is a complete, self-contained specification for building the public map
application. It consumes data files produced by the analysis notebook (already
generated, in `output/`). You do **not** need to read the notebook or regenerate
data to build the app — everything about the data shape is described below.

---

## 1. What we're building

A public, static, client-side web map where a parent can look up primary schools
in the Mazowieckie voivodeship (Poland) and see how they perform on the 8th-grade
exam (egzamin ósmoklasisty), 2021–2025.

- **Hosting:** GitHub Pages, serving a `docs/` directory. No backend, no server,
  no API keys, no build step required at runtime.
- **Tech:** vanilla JavaScript + Leaflet.js + Leaflet.markercluster (from CDN).
  No framework, no bundler. Keep it simple enough to open `docs/index.html` and
  have it work.
- **Tiles:** Carto Positron (muted basemap so the coloured school markers stand
  out). Free, attribution required. Do not use a keyed provider.
- **Audience:** Polish parents, mostly on mobile. Polish UI by default.

The whole point is the **colour** of each school marker, which encodes a quality
score. The map must communicate uncertainty honestly (see §7) — it deliberately
does **not** show numeric rankings on the map itself.

---

## 2. Data files (already generated, in `docs/data/`)

The analysis notebook writes the JSON files straight into `docs/data/`, so they
are already in place for the app to fetch — no copy step. Paths below are relative
to `docs/` (where `index.html` lives), so the app fetches them as `data/...`.
There are two kinds the app uses (plus xlsx files in `output/` it ignores).

### 2a. `data/schools-base.json` — loaded immediately on page open

~3.8 MB raw, ~0.4 MB gzipped (GitHub Pages gzips automatically). This is the only
file the map needs for its core function. Shape:

```json
{
  "metadata": {
    "generated_at": "2026-...",
    "default_metric": "unit_norm_diff_mean",
    "metrics":  ["mean", "median", "diff_mean", "unit_norm_diff_mean"],
    "subjects": ["polski", "matematyka", "angielski", "composite_min"],
    "years_in_data": [2021, 2022, 2023, 2024, 2025],
    "sigma":        { "mean": {"polski": 9.31, "matematyka": 14.02, "angielski": 15.91, "composite_min": 13.30}, ... },
    "sigma_centre": { "mean": {"polski": 63.76, "matematyka": 53.83, "angielski": 66.21, "composite_min": 53.14}, ... },
    "slider_ranges": {
      "mean":                {"min": 10.22, "max": 87.07, "p1": 18.31, "p99": 82.01, "step": 0.77},
      "unit_norm_diff_mean": {"min": -0.85, "max": 0.64, "p1": -0.67, "p99": 0.51, "step": 0.015},
      ...
    }
  },
  "schools": [
    {
      "rspo": 8847,
      "name": "SZKOŁA PODSTAWOWA W RACZYNACH",
      "is_public": "Tak",          // "Tak" = public, "Nie" = private/non-public
      "n_years": 5,
      "miejscowosc": "Raczyny",
      "ulica_nr": "ul. Kopernika 5",
      "lat": 52.26853,             // null if not geocoded
      "lon": 22.63428,             // null if not geocoded
      "scores": {
        "mean":                { "polski": {"score": 68.05, "rank": 529, "pct": 69.3}, "matematyka": {...}, "angielski": {...}, "composite_min": {...} },
        "median":              { ... },
        "diff_mean":           { ... },
        "unit_norm_diff_mean": { ... }
      }
    },
    ...
  ]
}
```

Key points:
- `schools` is an **array**. ~1,720 schools.
- Every school has **base** score/rank/pct for **all 4 metrics × 4 subjects** in
  `scores[metric][subject]`. So switching metric or subject, filtering by value,
  and showing base ranks all work from this one file — no extra download.
- `rank` is 1 = best. `pct` is 0–100, 100 = best. `score` scale depends on metric
  (see §4).
- `lat`/`lon` may be `null` (geocoding failed). Such schools are **not placed on
  the map** but still appear in the ranking page (§6) marked "not on map".

### 2b. `data/schools-{metric}.json` × 4 — loaded on demand (year-by-year history)

One per metric: `schools-mean.json`, `schools-median.json`,
`schools-diff_mean.json`, `schools-unit_norm_diff_mean.json`. ~7 MB raw / ~0.8 MB
gzipped each. **Only needed for the per-school year-by-year history and for the
ranking page's LOO / single-year / last_k views.** Do not load on page open.

Here `schools` is an **object keyed by rspo (string)**:

```json
{
  "metadata": { "metric": "unit_norm_diff_mean", "years_in_data": [...] },
  "schools": {
    "2880": {
      "polski":        { "base": {...}, "loo": {...}, "single_year": {...}, "last_k": {...} },
      "matematyka":    { ... },
      "angielski":     { ... },
      "composite_min": {
        "base":        { "score": -0.18, "rank": 1023, "pct": 34.9 },
        "loo":         { "2022": {"score": ..., "rank": ..., "pct": ...}, "2023": {...}, ... },
        "single_year": { "2022": {...}, "2023": {...}, "2024": {...}, "2025": {...} },
        "last_k":      { "2": {...}, "3": {...} }
      }
    },
    ...
  }
}
```

View kinds:
- **base** — flat `{score, rank, pct}`, over all the school's years.
- **loo** — leave-one-out; keyed by the *excluded* year. Only present if the
  school has ≥ 2 years. Only the school's real years appear.
- **single_year** — keyed by year; the raw score from that one year.
- **last_k** — keyed by k (string "2", "3", ...); score over the most recent k
  years. k ranges 2 … (n_years − 1).

All keys that look like years/numbers are **strings** ("2021", "3").

### 2c. `output/schools-{metric}.xlsx` × 4 — NOT used by the app

These live in `output/` (not `docs/`), are for human analysts (Excel), and are
not served by the site. Ignore them in the web app.

---

## 3. Coordinates

`lat`/`lon` are already in `data/schools-base.json` (geocoded offline by a
separate Python script). The app does **not** geocode schools.

The offline geocoder (see `scripts/geocode_schools.py` and CLAUDE.md "Geocoding")
**never plants a school on its town's centroid** as a fallback. If it can't
find a street-level match inside the Mazowieckie bbox after multiple attempts,
the school keeps `lat`/`lon` = null and stays off the map. So a missing-coords
school is genuinely missing — not "approximately somewhere in town".

The app may use a geocoding API for **one thing only**: the **address search box**
(turning a user-typed address into a map location to pan/zoom to). Use Nominatim
(OpenStreetMap), subject to its usage policy — and note these specifics, which
differ from the offline script:

- **Identification is automatic in the browser.** Nominatim requires *either* a
  valid `Referer` *or* a `User-Agent`. JavaScript cannot set `User-Agent` (browsers
  block it), but the browser automatically sends `Referer` (the page URL), which
  satisfies the policy. **So the in-browser search needs no email, no API key, and
  no User-Agent config** — do not hardcode any contact in the frontend. (The
  offline `geocode_schools.py` script is different: it runs server-side, has no
  Referer, so it sets a User-Agent with a contact from an env var. That is the
  script's concern, not the app's.)
- **No auto-complete / search-as-you-type.** Nominatim's policy explicitly forbids
  client-side auto-complete against the public API. The search box must fire **only
  on submit** (Enter key or a "Szukaj" button), exactly one request per submit —
  never one request per keystroke.
- **One request per user action**, end-user-triggered only (which an address search
  is). Display OSM attribution as the policy requires.
- **Bias results to Poland and Mazowieckie.** Pass `countrycodes=pl` so "Kraków"
  doesn't lose to a Kraków in another country, and a `viewbox` covering Mazowieckie
  (approximately `19.2,53.6,23.2,51.0` as `left,top,right,bottom`) with
  `bounded=0` so the box prefers but does not require results inside it. This
  keeps "Krakowska 5" inside Warszawa rather than the literal city of Kraków.
- This is a **deliberate** choice to use the public Nominatim API, made here with
  knowledge of its policy — not a default to reach for automatically. If the app's
  search traffic ever grows beyond light/moderate, switch to a self-hosted
  Nominatim or a commercial geocoder.

**Never invent or approximate a school's coordinates.** If `lat`/`lon` is null,
the school is simply absent from the map (see §7).

---

## 4. Metrics and the colour scale

Four metrics, exposed as a toggle. `unit_norm_diff_mean` is the default.

| Metric | Scale | Meaning |
|--------|-------|---------|
| `mean` | 0–100 | Raw mean exam score (%). Baseline, easiest to read. |
| `median` | 0–100 | Raw median exam score (%). Baseline. |
| `diff_mean` | ≈ −15…+15 | School mean minus voivodeship mean, in percentage points. |
| `unit_norm_diff_mean` | −1…+1 | `diff_mean` normalised by ceiling/floor distance. **Primary.** |

Four subjects, also a toggle: `polski`, `matematyka`, `angielski`, and
`composite_min` (the minimum of the three subject scores — "is the school weak in
*any* subject?"). `composite_min` is the default subject.

### Colour computation (client-side)

For the selected (metric, subject), read `centre = metadata.sigma_centre[metric][subject]`
and `sigma = metadata.sigma[metric][subject]`. Map a school's
`score = scores[metric][subject].score` to one of 5 classes:

| Class | Condition | Colour |
|-------|-----------|--------|
| Saturated red | score ≤ centre − 1.5σ | `#d6604d` |
| Red | centre − 1.5σ < score < centre − 0.33σ | `#f4a582` |
| Yellow | centre − 0.33σ ≤ score ≤ centre + 0.33σ | `#fde08a` |
| Green | centre + 0.33σ < score < centre + 1.5σ | `#a6dba0` |
| Saturated green | score ≥ centre + 1.5σ | `#1a9850` |

(You may interpolate a continuous gradient between centre and ±1.5σ instead of 5
discrete classes, saturating beyond ±1.5σ — but 5 classes is the baseline.)

The centre differs by metric: for `mean`/`median` it's the voivodeship average
(~54–66), for the diff-based metrics it's 0 (and composite_min uses its own
empirical mean). That's why you must read centre/sigma from metadata rather than
assuming 0.

---

## 5. Map view (the main page — `index.html`)

- **Layout:** full-screen map + a side panel (school search/list). On mobile the
  panel collapses to a drawer or bottom sheet. **Mobile must work well** — most
  users are on phones.
- **Top nav:** link to the ranking page (`ranking.html`). Carry the current
  metric/subject/language through the link as URL params (§9) so switching pages
  preserves the user's selection.
- **Initial view:** fit-to-bounds across all geocoded schools (`map.fitBounds`
  on the lat/lon array). This covers Mazowieckie naturally and adapts if the
  dataset is ever extended. No hard-coded centre/zoom.
- **Markers:** fixed-size coloured circles, colour from §4. Cluster at low zoom
  (Leaflet.markercluster) — ~1,400 plotted markers need it. Do **not** size
  markers by student count.
- **Cluster colour:** the cluster's circle is coloured by the **mean of its
  children's scores** for the currently-selected (metric, subject), mapped
  through the same 5-class scale from §4. This lets the user see "this area is
  broadly red / green" at low zoom without expanding the cluster. Note this is
  intentionally a mean of `composite_min` values when that subject is selected —
  conceptually a "mean of mins", which is fine for a quick area read.
- **No numeric ranks on the map.** Colour only. (Rationale in §7.)
- **Toggles:**
  - Subject: Polish / Maths / English / composite_min → recolours markers.
  - Metric: mean / median / diff_mean / unit_norm_diff_mean → recolours markers.
  - Both work instantly from `schools-base.json`.
- **Filters:**
  - **Public / private** (`is_public` == "Tak" / "Nie"). Important — see §7.
  - **Score threshold:** "show only schools scoring above X" for the current
    (metric, subject). Use `metadata.slider_ranges[metric]` for the slider:
    `min`/`max` as hard bounds, `p1`/`p99` as sensible default handle positions,
    `step` as the increment.
    - **Reset the threshold when the user switches metric.** The scales differ
      (`mean` is 10–87, `unit_norm_diff_mean` is −0.85…0.64), so a numeric value
      that filtered out the bottom 1% on one metric is meaningless on another.
      Snap back to the default handle position (`p1` of the new metric).
      Subject changes do *not* reset the threshold — same metric, comparable scale.
  - **Minimum n_years:** hide schools with little history.
- **Zoom + address search:** native Leaflet zoom, plus a search box that
  geocodes a typed address (Nominatim) and pans/zooms there so the user can see
  nearby schools. Fire the geocode **only on submit** (Enter / button), one
  request per submit — no search-as-you-type (Nominatim policy; see §3).
- **Popup (on marker click):** show the rich base stats this school has —
  name, public/private, town + street, n_years, and for the selected metric the
  per-subject score / rank / pct plus composite_min. Show a warning badge if
  applicable (§7).
  - **Year-by-year history:** a button inside the popup ("Pokaż historię
    roczną") triggers the on-demand load (§8) and then shows, for this school
    under the selected metric:
    - a small **per-subject sparkline** (one line per subject including
      composite_min, x = year, y = score) — quick visual of the trend.
    - a small **table** below the sparkline with rows = years, columns =
      subjects, values = single-year score; final row(s) summarise `last_k`
      (k = 2 … n_years − 1) and `loo` ranges.
    - If this layout reads poorly in practice, the spec will be revised — but
      both forms exist by default so the user sees shape *and* numbers.

---

## 6. Ranking page (separate `ranking.html`)

A separate page — **not** a tab inside `index.html`. Reason: it must be
deep-linkable in its own right (you can share a ranking-page URL with filters
applied without the map's state mixed in). The two pages share styling and a
top nav (Mapa / Ranking), and they pass state to each other via URL params and
localStorage (§9).

A sortable, filterable **table** — this is where numeric ranks are allowed (the
map is not). Supports both browsing the full list and searching by name (e.g.
"Vizja", "STO").

Per school row, show:
- School name, town, public/private, n_years.
- **Base rank** for the selected (metric, subject).
- **LOO rank range** — min and max rank across the LOO folds, e.g. "234 (198–267)".
- **Single-year rank range** — min and max rank across single-year views.

Controls:
- Metric selector and subject selector.
- **View selector**, including **last_k** — this lets the user compare against
  external rankings. For instance, rankingedukacji.pl uses the arithmetic mean of
  the **last 3 years**, which is `metric=mean`, `view=last_k`, `view_param="3"`.
  (Their ranking also includes non-exam factors, so it won't match exactly, but
  the exam-based part is comparable.)
- Public/private filter, name search, column sorting.

Data sources for the ranking page:
- Base ranks: from `schools-base.json` (already loaded).
- LOO / single-year / last_k ranges: from `schools-{metric}.json` — load on
  demand when the user opens the ranking page or picks a non-base view (§8).

**Schools without coordinates** (lat/lon null) are excluded from the map but
**must still appear** in the ranking page, marked e.g. "📍✗ brak lokalizacji",
since they have valid scores.

---

## 7. Uncertainty communication (important — this is a design principle, not a nicety)

The data has real uncertainty and the UI must not overstate precision.

- **Map shows colour, never a numeric rank.** A school's rank in the dense middle
  of the distribution swings by ~10% of all positions (100+ places) when a single
  year is added or removed — a density artifact, not a real difference. A number
  like "#234" implies precision the data can't support. The colour scale
  saturates at ±1.5σ precisely so the muddy middle looks muddy. Numeric ranks live
  only in the ranking page, always shown *with* their LOO/single-year ranges.

- **Public/private filter matters.** Empirically the very top of every subject is
  dominated by private schools, so a parent looking for a strong *public* school
  needs to filter private ones out. **Do not editorialise about why** private
  schools rank high — the metric measures exam *outcomes*, not value added, and we
  have no data on student intake. Do not state or imply that it's due to selection
  (or to better teaching) — we cannot tell. Just provide the filter.

- **Warning badge** in a school's popup if any of these holds (one ⚠️ badge, with
  hover/tap text listing which triggered):
  - `n_years < 3` — short history, limited certainty.
  - LOO score range > 1σ **and** `n_years ≥ 3` — many years but high volatility;
    the score depends a lot on which year is included. (Needs a metric file
    loaded to compute the LOO range; if not loaded yet, you can compute this
    lazily when history is fetched, or skip it until then.)

- **Never invent coordinates** (repeat of §3) — a missing-coords school is off the
  map, not placed approximately.

---

## 8. Data loading strategy

All data is under `data/` relative to `index.html` — fetch
`data/schools-base.json` and `data/schools-{metric}.json`.

- **On page load:** fetch `data/schools-base.json` only (~0.4 MB gzipped). The map,
  both toggles, all three filters, popups' base stats, and base ranks in the
  ranking page all work from this.
- **Year-by-year history** (single_year / last_k / loo) and **non-base ranking
  views** require the per-metric files (`data/schools-{metric}.json`, ~0.8 MB
  gzipped each, ~3 MB for all four). **Do not prefetch these automatically** — on
  a fresh visit that would burn ~3 MB of mobile data. Instead gate them behind a
  **visible control**, e.g. a checkbox/button: "Pokaż szczegółową historię
  (pobiera ~3 MB)". Once the user opts in, fetch the needed file(s) once and keep
  them in memory for the session.
- Browser HTTP caching (ETag) covers repeat visits from the same browser for
  free; incognito / a different device re-downloads, which is why the opt-in
  matters.
- You may load just the currently-selected metric's file rather than all four, if
  that's simpler — but loading all four on opt-in is also fine (~3 MB total).

---

## 9. URL state and persistence

The app's selections (metric, subject, filters, selected school) are shareable
via URL. Visiting the same URL from another browser must reproduce the same view.

### Parameters

**`index.html`** (map):
- `metric` — one of `mean`, `median`, `diff_mean`, `unit_norm_diff_mean`.
- `subject` — one of `polski`, `matematyka`, `angielski`, `composite_min`.
- `public` — `tak` (show only public), `nie` (show only private), or omitted (all).
- `threshold` — number; minimum score for the current (metric, subject). Schools
  with score below this are hidden.
- `min_years` — integer; minimum `n_years` to show.
- `school` — rspo (integer); if present, pan to the school, open its popup.
- `lang` — `pl` or `en` (omitted = use stored default).

**`ranking.html`** (table):
- `metric`, `subject` — same as above.
- `view` — `base`, `last_k`, `single_year`, or `loo`.
- `view_param` — for non-base views: year (e.g. `2023`) or k (e.g. `3`).
- `public` — same as above.
- `q` — free-text name search query.
- `sort` — column key (e.g. `base_rank`); `dir` — `asc` or `desc`.
- `school` — rspo to highlight/scroll to.
- `lang` — same.

Unknown or out-of-range param values are ignored (fall back to defaults), not
errors — be liberal in what you accept.

### Resolution order (precedence)

On page load, for each setting independently:

1. **URL param wins** if present and valid. The tab is then "sealed" — see below.
2. Otherwise **localStorage** value, if present.
3. Otherwise the **built-in default** (`unit_norm_diff_mean`, `composite_min`,
   no filters, `pl`).

After load, the tab writes its resolved state into its URL immediately (via
`history.replaceState`), so a reload of this tab preserves what the user is
looking at — even if localStorage has since changed in another tab.

### Writes

When the user changes a setting:
- Update the URL via `history.replaceState` (not `pushState` — we don't want
  every slider tick to add a history entry).
- Update localStorage with the new value.

### Multi-tab behaviour

- **localStorage is the "fresh visit default", not live shared state.**
- **Do not listen to the `storage` event.** Each tab is sealed after load —
  another tab changing its selection does *not* affect this tab.
- Two tabs can hold different selections simultaneously without conflict
  because each tab's state lives in its own URL.

### What is persisted in localStorage

- `metric`, `subject`, `lang` — the user's preferred view (carries across visits).
- `history_optin` — boolean; if the user has clicked "Pokaż szczegółową historię"
  before, remember the consent so they don't have to re-click on every visit.

Filters (`public`, `threshold`, `min_years`, `q`, `sort`) and the selected
school are *not* persisted across visits — they are URL-only. Visiting fresh
should show the unfiltered set so the user isn't confused by an old filter
hiding most schools.

---

## 10. Internationalisation

- **Default language: Polish.** Provide a **toggle to English** (some users are
  English-speaking).
- Translate only **UI labels** (buttons, headers, filter names, metric/subject
  labels, warning text, legend). The data files use English technical keys
  (`mean`, `composite_min`, `view_kind`, etc.) — map them to localised display
  labels in both languages.
- **Do not translate proper nouns:** school names, town names, addresses,
  administrative fields stay in Polish in both languages.
- **Persistence:** the language choice follows the same URL > localStorage >
  default rule as other settings (§9). A `?lang=en` link overrides storage;
  toggling the language updates both URL and localStorage.
- Suggested label mapping (PL / EN):
  - metrics: `mean` → "Średnia" / "Mean", `median` → "Mediana" / "Median",
    `diff_mean` → "Różnica od średniej" / "Difference from mean",
    `unit_norm_diff_mean` → "Wynik znormalizowany" / "Normalised score".
  - subjects: `polski` → "Polski" / "Polish", `matematyka` → "Matematyka" /
    "Maths", `angielski` → "Angielski" / "English", `composite_min` →
    "Najsłabszy przedmiot" / "Weakest subject".

---

## 11. Repository placement

```
compare-primary-schools-mazowieckie/
├── docs/                       # GitHub Pages serves this
│   ├── index.html              # the map page
│   ├── ranking.html            # the ranking page
│   ├── app.js                  # shared code (or split as you like)
│   ├── style.css               # shared styles
│   └── data/                   # the notebook writes these directly — do not edit by hand
│       ├── schools-base.json
│       ├── schools-mean.json
│       ├── schools-median.json
│       ├── schools-diff_mean.json
│       └── schools-unit_norm_diff_mean.json
└── output/                     # xlsx for analysts (not served by the site)
```

The notebook generates the JSON straight into `docs/data/`, so there is no copy
step — the app fetches `data/schools-base.json` etc. relative to `index.html`
(and the same relative path works from `ranking.html` since they sit
side-by-side). Put your two HTML files, JS, and CSS at the `docs/` root
(alongside the `data/` folder). The HTML pages share `app.js` and `style.css`
so common code (loading `schools-base.json`, colour mapping, URL state, i18n)
lives in one place.

---

## 12. Suggested build order

1. Static page + Leaflet + Carto Positron tiles, load `data/schools-base.json`, plot
   markers coloured by the default (unit_norm_diff_mean, composite_min).
2. Subject + metric toggles (recolour from base).
3. Popup with base stats + warning badge for `n_years < 3`.
4. Filters: public/private, score threshold (using slider_ranges), min n_years.
5. Clustering (with cluster colour = mean of children) + address search + zoom.
6. Ranking page (`ranking.html`) from base ranks (sortable/filterable table, name search).
7. URL state & persistence (§9): wire up `history.replaceState` + localStorage
   for both pages, plus the cross-page nav that carries metric/subject/language
   through.
8. On-demand loading (§8): opt-in fetch of per-metric files; add year-by-year
   history (sparkline + table) to popups and LOO/single-year ranges + last_k
   view to the ranking page.
9. The LOO-range warning badge (needs a metric file loaded).
10. Polish/English toggle.
11. Mobile layout pass.

Build incrementally; steps 1–7 give a fully useful, shareable map and ranking
from a single 0.4 MB download.
