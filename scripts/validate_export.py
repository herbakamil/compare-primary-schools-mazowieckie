#!/usr/bin/env python3
"""Validate the map/ranking JSON exports against an INDEPENDENT recomputation.

This script does NOT import the notebook. It re-reads the source OKE xlsx files,
re-derives every per-year metric, every view aggregate (base / single_year / loo /
last_k), composite_min, every rank/percentile, and the colour-scale metadata
(sigma, centre, slider ranges) from scratch, then checks the JSON the app actually
serves (docs/data/schools-base.json + schools-{metric}.json) against it.

It restricts the recomputation to the JSON's own `years_in_data`, so it validates
whatever export it is given (current or a year-pinned one) even when newer xlsx
files are already present in the data directory.

The JSON is kept as plain dicts keyed by rspo (no DataFrame) — convenient for the
nested score lookups.

Checks
  A. Subject raw values:  JSON single_year of metric 'mean'/'median' == the
     mean/median read straight from the xlsx for that (school, subject, year).
  B. Aggregates:          recomputed score == JSON score for every
     (metric, subject, view) — single_year / loo / base / last_k + composite_min.
  C. Completeness:        the set of (metric, subject, view, param, school) keys
     in the JSON equals the recomputed set (nothing dropped or invented).
  D. base.json:           its scores[metric][subject] == the per-metric file's
     base view (the two exports must agree).
  E. Ranks / percentiles: per view population, the stored rank/pct match rankdata
     over the recomputed scores (min-rank ties, average-rank percentile), up to a
     near-tie tolerance (the export ranks full-precision floats).
  F. Colour-scale metadata: recomputed sigma / centre / slider_ranges == metadata.
  G. Class spread:        bucketing base scores into A/B/C by ±0.33σ (the map's
     colour rule) leaves no class empty (a never-shown colour would be a red flag).

Usage
  uv run python scripts/validate_export.py
  uv run python scripts/validate_export.py --data-dir data/egzamin-osmoklasisty \
      --docs-data docs/data
Exit code 0 if everything passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

CORE_SUBJECTS = ['polski', 'matematyka', 'angielski']
ALL_SUBJECTS = CORE_SUBJECTS + ['composite_min']
EXPORT_METRICS = ['mean', 'median', 'diff_mean', 'unit_norm_diff_mean']
WEIGHTED_METRICS = {'diff_mean', 'unit_norm_diff_mean'}  # the rest use a plain mean
YEAR_FILE_RE = re.compile(r'^\d{4}')

# JSON stores scores at 4 dp and percentiles at 1 dp. Comparing the rounded JSON
# value to the UNROUNDED recomputation, the largest legitimate gap is half a
# rounding unit (5e-5) plus float noise — so 1e-4 / 0.06 are tight but safe.
SCORE_TOL = 1e-4
PCT_TOL = 0.06
CLASS_BOUND = 0.33  # ±0.33σ, matching the map/ranking colour rule
# Scores within this are treated as a tie when validating ranks: the export ranks
# full-precision floats, so two schools equal to ~13 sig figs (e.g. from (v*n)/n
# round-off) get an arbitrary order an independent recompute can't reproduce
# bit-for-bit. Genuine score precision is ~1e-4, so 1e-9 separates real from noise.
TIE_EPS = 1e-9

# Source-xlsx column names (after normalisation), needed to read the SAS sheet.
N_COL, MEAN_COL, MEDIAN_COL = 'liczba zdajacych', 'wynik sredni (%)', 'mediana (%)'


# ── xlsx reading (independent re-implementation of the notebook loader) ───────

def normalize_text(text: str) -> str:
    """Lower-case, strip Polish diacritics (incl. ł), collapse whitespace — the
    same header normalisation the notebook applies, so columns line up."""
    text = unicodedata.normalize('NFKD', str(text))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace('ł', 'l').replace('Ł', 'L').replace('\n', ' ')
    return re.sub(r'\s+', ' ', text).lower().strip()


def clean_header_value(value) -> str:
    """A raw header cell → trimmed string; pandas' 'Unnamed:'/'nan' fillers → ''."""
    if value is None:
        return ''
    text = str(value)
    if text.startswith('Unnamed:') or text == 'nan':
        return ''
    return re.sub(r'\s+', ' ', text.replace('\n', ' ')).strip()


def normalize_columns(columns: pd.MultiIndex) -> pd.MultiIndex:
    """Two-level SAS header → (subject, metric) MultiIndex. Level-0 (subject) is
    forward-filled across the merged header cells; blank groups become 'meta'."""
    subjects, metrics = [], []
    last_subject = 'meta'
    for raw0, raw1 in columns.to_list():
        c0, c1 = clean_header_value(raw0), clean_header_value(raw1)
        if c0:
            last_subject = normalize_text(c0).removeprefix('jezyk ')
        subjects.append(last_subject)
        metrics.append(normalize_text(c1) if c1 else 'value')
    return pd.MultiIndex.from_arrays([subjects, metrics], names=['subject', 'metric'])


def read_clean_rows(data_dir: Path) -> list[dict]:
    """Read the source xlsx and return one dict per surviving (school, year) row:
    {'rspo', 'year', <subject>: {'n', 'mean', 'median'}}.

    Cleaning matches the notebook: keep n_polski > 0 and require mean AND median
    present for all three core subjects (rows missing any are dropped). Column
    extraction is vectorised; a missing sheet/column fails with a clear message.
    """
    files = sorted(p for p in data_dir.glob('*.xlsx*')
                   if not p.name.startswith('.') and YEAR_FILE_RE.match(p.name))
    if not files:
        sys.exit(f'No source xlsx files (matching ^\\d{{4}}) in {data_dir}')

    needed = [(s, c) for s in CORE_SUBJECTS for c in (N_COL, MEAN_COL, MEDIAN_COL)]
    frames = []
    for path in files:
        year = int(YEAR_FILE_RE.match(path.name).group(0))
        try:
            raw = pd.read_excel(path, sheet_name='SAS', header=[0, 1])
        except ValueError as exc:
            sys.exit(f"Cannot read sheet 'SAS' in {path.name}: {exc}")
        raw.columns = normalize_columns(raw.columns)
        missing = [c for c in [('meta', 'rspo')] + needed if c not in raw.columns]
        if missing:
            sys.exit(f'{path.name}: expected columns not found after normalisation: {missing}')

        cols = {'rspo': pd.to_numeric(raw[('meta', 'rspo')], errors='coerce'), 'year': year}
        for s in CORE_SUBJECTS:
            cols[f'n_{s}'] = pd.to_numeric(raw[(s, N_COL)], errors='coerce')
            cols[f'mean_{s}'] = pd.to_numeric(raw[(s, MEAN_COL)], errors='coerce')
            cols[f'median_{s}'] = pd.to_numeric(raw[(s, MEDIAN_COL)], errors='coerce')
        frames.append(pd.DataFrame(cols))

    df = pd.concat(frames, ignore_index=True)
    mask = df['rspo'].notna() & df['n_polski'].notna() & (df['n_polski'] > 0)
    for s in CORE_SUBJECTS:
        mask &= df[f'mean_{s}'].notna() & df[f'median_{s}'].notna()
    df = df[mask]

    rows = []
    for rec in df.to_dict('records'):
        row = {'rspo': int(rec['rspo']), 'year': int(rec['year'])}
        for s in CORE_SUBJECTS:
            row[s] = {'n': rec[f'n_{s}'], 'mean': rec[f'mean_{s}'], 'median': rec[f'median_{s}']}
        rows.append(row)
    return rows


# ── independent metric / view / rank recomputation ──────────────────────────

def voivodeship_mean(rows: list[dict]) -> dict[str, dict[int, float]]:
    """{subject: {year: mean over schools of mean_subject}} on the clean rows —
    the per-year reference that diff_mean / unit_norm_diff_mean subtract off."""
    acc: dict[str, dict[int, list]] = {s: defaultdict(list) for s in CORE_SUBJECTS}
    for row in rows:
        for s in CORE_SUBJECTS:
            acc[s][row['year']].append(row[s]['mean'])
    return {s: {y: float(np.mean(v)) for y, v in years.items()} for s, years in acc.items()}


def per_year_values(rows, voiv):
    """{(rspo, subject): {year: {'n', 'mean', 'median', 'diff_mean',
    'unit_norm_diff_mean'}}} for valid rows (n > 0 and the metric defined).
    unit_norm uses the signed ceiling/floor normalisation to [-1, +1]."""
    out: dict[tuple, dict[int, dict]] = defaultdict(dict)
    for row in rows:
        y = row['year']
        for s in CORE_SUBJECTS:
            n, mean, median = row[s]['n'], row[s]['mean'], row[s]['median']
            if not (pd.notna(n) and n > 0):
                continue
            v_avg = voiv[s][y]
            diff_mean = mean - v_avg
            if diff_mean >= 0:
                denom = (100 - v_avg) if (100 - v_avg) > 0 else 1
            else:
                denom = v_avg if v_avg > 0 else 1
            out[(row['rspo'], s)][y] = {
                'n': n, 'mean': mean, 'median': median,
                'diff_mean': diff_mean, 'unit_norm_diff_mean': diff_mean / denom,
            }
    return out


def aggregate(metric: str, year_to_vals: dict, years_used) -> float:
    """Aggregate metric values across `years_used` for one school. Weighted by the
    student count for diff_mean / unit_norm_diff_mean, a plain mean otherwise.
    NaN inputs (and zero-weight years for the weighted case) are ignored; an empty
    selection returns NaN."""
    vals = np.array([year_to_vals[y][metric] for y in years_used if y in year_to_vals])
    weights = np.array([year_to_vals[y]['n'] for y in years_used if y in year_to_vals])
    if len(vals) == 0:
        return np.nan
    if metric in WEIGHTED_METRICS:
        valid = ~(np.isnan(vals) | np.isnan(weights)) & (weights > 0)
        if not valid.any() or weights[valid].sum() == 0:
            return np.nan
        return float((vals[valid] * weights[valid]).sum() / weights[valid].sum())
    valid = ~np.isnan(vals)
    return float(vals[valid].mean()) if valid.any() else np.nan


def build_view_scores(rows, voiv):
    """{(metric, subject, view_kind, param): {rspo: score}} for all metrics, core
    subjects, and composite_min. Each school's views use only its own years:
    base (all), loo (one excluded, ≥2 years), single_year (each), last_k (most
    recent k, k = 2..n-1). composite_min = min over the 3 core subjects, for the
    schools present in all three for that view."""
    pyv = per_year_values(rows, voiv)
    view: dict[tuple, dict[int, float]] = defaultdict(dict)

    for metric in EXPORT_METRICS:
        for (rspo, s), year_map in pyv.items():
            years = sorted(year_map)
            n_years = len(years)

            def store(kind, param, used):
                sc = aggregate(metric, year_map, used)
                if not np.isnan(sc):
                    view[(metric, s, kind, param)][rspo] = sc

            store('base', None, years)
            if n_years >= 2:
                for excl in years:
                    store('loo', excl, [y for y in years if y != excl])
            for y in years:
                store('single_year', y, [y])
            for k in range(2, n_years):
                store('last_k', k, years[-k:])

    params_per_metric: dict[str, set] = defaultdict(set)
    for (metric, s, kind, param) in list(view):
        if s in CORE_SUBJECTS:
            params_per_metric[metric].add((kind, param))
    for metric, params in params_per_metric.items():
        for kind, param in params:
            per_s = {s: view.get((metric, s, kind, param), {}) for s in CORE_SUBJECTS}
            common = set(per_s['polski']) & set(per_s['matematyka']) & set(per_s['angielski'])
            for rspo in common:
                view[(metric, 'composite_min', kind, param)][rspo] = min(
                    per_s[s][rspo] for s in CORE_SUBJECTS)
    return view


def ranks_and_pcts(score_map: dict[int, float]):
    """{rspo: (rank, pct)} with min-rank (1 = highest score) and average-rank
    percentile (100 = highest), matching the export."""
    rspos = list(score_map)
    scores = np.array([score_map[r] for r in rspos])
    n = len(scores)
    rank = stats.rankdata(-scores, method='min').astype(int)
    pct = stats.rankdata(scores, method='average') / n * 100
    return {r: (int(rk), float(pc)) for r, rk, pc in zip(rspos, rank, pct)}


# ── JSON loading (kept as dicts keyed by rspo) ──────────────────────────────

def load_json_exports(docs_data: Path):
    """Load the served JSON as dicts keyed by rspo. Returns
    (metadata, base_by_rspo, {metric: per_metric_by_rspo})."""
    base_path = docs_data / 'schools-base.json'
    if not base_path.exists():
        sys.exit(f'Missing {base_path}')
    base = json.loads(base_path.read_text())
    base_by_rspo = {int(s['rspo']): s for s in base['schools']}
    per_metric = {}
    for metric in EXPORT_METRICS:
        path = docs_data / f'schools-{metric}.json'
        if not path.exists():
            sys.exit(f'Missing {path}')
        per_metric[metric] = {int(r): d for r, d in json.loads(path.read_text())['schools'].items()}
    return base['metadata'], base_by_rspo, per_metric


def iter_json_views(per_metric):
    """Yield (metric, subject, view_kind, param, rspo, cell) for every score cell
    in the per-metric files (base param is None, others are ints)."""
    for metric, schools in per_metric.items():
        for rspo, school in schools.items():
            for s, node in school.items():
                if not isinstance(node, dict):
                    continue
                if isinstance(node.get('base'), dict):
                    yield metric, s, 'base', None, rspo, node['base']
                for kind in ('single_year', 'loo', 'last_k'):
                    for param, cell in (node.get(kind) or {}).items():
                        yield metric, s, kind, int(param), rspo, cell


# ── reporting ────────────────────────────────────────────────────────────────

class Report:
    """Collects PASS/FAIL lines and a running comparison count; tracks whether any
    check failed so main() can set the exit code."""

    def __init__(self):
        self.failures = 0
        self.checked = 0

    def section(self, name):
        print(f'\n── {name} ' + '─' * max(0, 60 - len(name)))

    def ok(self, msg):
        print(f'  PASS  {msg}')

    def fail(self, msg, examples=None):
        self.failures += 1
        print(f'  FAIL  {msg}')
        for ex in (examples or [])[:5]:
            print(f'          {ex}')


def close(a, b, tol):
    """True if two numbers are within `tol` (NaN-safe-ish: both must be finite)."""
    return a is not None and b is not None and abs(a - b) <= tol


# ── checks ───────────────────────────────────────────────────────────────────

def check_subjects_vs_xlsx(rows, per_metric, rep: Report):
    """A — the single-year scores of the 'mean'/'median' metrics must equal the
    mean/median read straight from the xlsx (ties the JSON to the raw source)."""
    rep.section('A. Subject raw values vs xlsx (single_year of mean/median)')
    raw = {(r['rspo'], r['year']): r for r in rows}
    for metric, field in (('mean', 'mean'), ('median', 'median')):
        mism, n, max_diff = [], 0, 0.0
        for (rspo, year), row in raw.items():
            school = per_metric[metric].get(rspo)
            if not school:
                continue
            for s in CORE_SUBJECTS:
                cell = school.get(s, {}).get('single_year', {}).get(str(year))
                if cell is None:
                    continue
                n += 1
                max_diff = max(max_diff, abs(cell['score'] - row[s][field]))
                if not close(cell['score'], row[s][field], SCORE_TOL):
                    mism.append(f'rspo={rspo} {s} {year}: json={cell["score"]} xlsx={row[s][field]}')
        rep.checked += n
        if mism:
            rep.fail(f'metric={metric}: {len(mism)}/{n} single-year values differ from xlsx', mism)
        else:
            rep.ok(f'metric={metric}: all {n} single-year values match the xlsx (max Δ {max_diff:.2e})')


def check_aggregates(view, per_metric, rep: Report):
    """B — every JSON aggregate score (all metrics × subjects × views) must equal
    the independent recomputation. Reports the largest deviation per view kind."""
    rep.section('B. Aggregates recomputed from xlsx vs JSON (all views)')
    counts = defaultdict(lambda: [0, 0, 0.0])  # kind -> [checked, failed, max_diff]
    examples = defaultdict(list)
    for metric, s, kind, param, rspo, cell in iter_json_views(per_metric):
        sc = view.get((metric, s, kind, param), {}).get(rspo)
        counts[kind][0] += 1
        if sc is None:
            counts[kind][1] += 1
            examples[kind].append(f'{metric}/{s}/{kind}/{param} rspo={rspo}: missing in recompute')
            continue
        diff = abs(cell['score'] - sc)
        counts[kind][2] = max(counts[kind][2], diff)
        if diff > SCORE_TOL:
            counts[kind][1] += 1
            examples[kind].append(
                f'{metric}/{s}/{kind}/{param} rspo={rspo}: json={cell["score"]} recomp={sc:.6f}')
    for kind, (chk, fail, max_diff) in sorted(counts.items()):
        rep.checked += chk
        if fail:
            rep.fail(f'{kind}: {fail}/{chk} scores differ (max Δ {max_diff:.2e})', examples[kind])
        else:
            rep.ok(f'{kind}: all {chk} aggregate scores match (max Δ {max_diff:.2e})')


def check_completeness(view, per_metric, rep: Report):
    """C — the JSON and the recomputation must contain exactly the same set of
    (metric, subject, view, param, school) score cells (nothing dropped/invented)."""
    rep.section('C. Completeness: JSON view set == recomputed view set')
    json_keys = {(m, s, k, p, r) for m, s, k, p, r, _ in iter_json_views(per_metric)}
    recomp_keys = {(m, s, k, p, r) for (m, s, k, p), sm in view.items() for r in sm}
    only_json = json_keys - recomp_keys
    only_recomp = recomp_keys - json_keys
    rep.checked += len(json_keys | recomp_keys)
    if only_json or only_recomp:
        ex = [f'in JSON only: {k}' for k in list(only_json)[:3]]
        ex += [f'in recompute only: {k}' for k in list(only_recomp)[:3]]
        rep.fail(f'{len(only_json)} JSON-only + {len(only_recomp)} recompute-only cells', ex)
    else:
        rep.ok(f'identical key sets ({len(json_keys):,} score cells)')


def check_base_consistency(base_by_rspo, per_metric, rep: Report):
    """D — schools-base.json and the per-metric files describe the same export, so
    their base score/rank/pct for each (school, metric, subject) must agree."""
    rep.section('D. base.json scores == per-metric file base view')
    mism, n = [], 0
    for rspo, school in base_by_rspo.items():
        for metric, by_subject in school['scores'].items():
            for s, cell in by_subject.items():
                pm = per_metric.get(metric, {}).get(rspo, {}).get(s, {}).get('base')
                if pm is None:
                    mism.append(f'rspo={rspo} {metric}/{s}: base entry missing from per-metric file')
                    continue
                n += 1
                if (cell['rank'] != pm['rank']
                        or not close(cell['score'], pm['score'], SCORE_TOL)
                        or not close(cell['pct'], pm['pct'], PCT_TOL)):
                    mism.append(f'rspo={rspo} {metric}/{s}: base={cell} perMetric={pm}')
    rep.checked += n
    if mism:
        rep.fail(f'{len(mism)} base entries disagree between the two files', mism)
    else:
        rep.ok(f'all {n} base entries agree between schools-base.json and the per-metric files')


def check_ranks(view, per_metric, rep: Report):
    """E — per view population, the stored rank/pct must match rankdata over the
    recomputed (full-precision) scores. A stored rank is accepted if it lies within
    the range allowed by near-ties: schools clearly better (score > s + TIE_EPS)
    sit above for sure, clearly worse sit below, anyone within TIE_EPS may go
    either way (the export ranks full-precision floats we can't reproduce bit-for-
    bit)."""
    rep.section('E. Ranks/percentiles match rankdata over the recomputed scores')
    stored = defaultdict(dict)   # key -> {rspo: (rank, pct)}
    json_pop = defaultdict(set)  # key -> {rspo}
    for metric, s, kind, param, rspo, cell in iter_json_views(per_metric):
        key = (metric, s, kind, param)
        stored[key][rspo] = (cell['rank'], cell['pct'])
        json_pop[key].add(rspo)

    pop_fail = rank_fail = pct_fail = total = ambiguous = 0
    examples = []
    for key, stored_map in stored.items():
        my_scores = view.get(key, {})
        if set(my_scores) != json_pop[key]:
            pop_fail += 1
            if len(examples) < 5:
                examples.append(f'{key}: population differs '
                                f'(json-only {len(json_pop[key] - set(my_scores))}, '
                                f'recomp-only {len(set(my_scores) - json_pop[key])})')
            continue
        n = len(my_scores)
        asc = sorted(my_scores.values())
        for rspo, sc in my_scores.items():
            total += 1
            n_better = n - bisect.bisect_right(asc, sc + TIE_EPS)
            n_worse = bisect.bisect_left(asc, sc - TIE_EPS)
            rank_lo, rank_hi = n_better + 1, n - n_worse
            if rank_lo != rank_hi:
                ambiguous += 1
            srk, spc = stored_map[rspo]
            if not (rank_lo <= srk <= rank_hi):
                rank_fail += 1
                if len(examples) < 5:
                    examples.append(f'{key} rspo={rspo}: json_rank={srk} not in [{rank_lo},{rank_hi}]')
                continue
            if not (n_worse / n * 100 - PCT_TOL <= spc <= (n - n_better) / n * 100 + PCT_TOL):
                pct_fail += 1
                if len(examples) < 5:
                    examples.append(f'{key} rspo={rspo}: json_pct={spc} out of range')
    rep.checked += total
    if pop_fail or rank_fail or pct_fail:
        rep.fail(f'{pop_fail} population + {rank_fail} rank + {pct_fail} pct mismatches '
                 f'(of {total} ranked)', examples)
    else:
        rep.ok(f'all {total} (rank, pct) values consistent with the scores '
               f'({ambiguous:,} within near-tie tolerance)')


def check_metadata(metadata, view, rep: Report):
    """F — recompute the colour-scale parameters and compare to the JSON metadata:
    sigma = std (sample) of base scores; centre = mean for mean/median and
    composite_min, 0 for the diff-based metrics; slider_ranges (min/max/p1/p99)
    from the base composite_min distribution. These drive the map's colours and
    value filter, so a wrong one would mis-colour the map silently."""
    rep.section('F. Colour-scale metadata (sigma / centre / slider_ranges)')
    sigma, centre = metadata['sigma'], metadata['sigma_centre']
    sliders = metadata.get('slider_ranges', {})
    problems, n = [], 0

    for metric in EXPORT_METRICS:
        for s in ALL_SUBJECTS:
            vals = np.array(list(view.get((metric, s, 'base', None), {}).values()))
            if len(vals) < 2:
                continue
            n += 1
            exp_sigma = round(float(vals.std(ddof=1)), 4)
            exp_centre = (round(float(vals.mean()), 4)
                          if s == 'composite_min' or metric in ('mean', 'median') else 0.0)
            if not close(sigma[metric][s], exp_sigma, SCORE_TOL):
                problems.append(f'sigma {metric}/{s}: json={sigma[metric][s]} recomp={exp_sigma}')
            if not close(centre[metric][s], exp_centre, SCORE_TOL):
                problems.append(f'centre {metric}/{s}: json={centre[metric][s]} recomp={exp_centre}')

    for metric in EXPORT_METRICS:
        vals = np.array(list(view.get((metric, 'composite_min', 'base', None), {}).values()))
        if len(vals) == 0 or metric not in sliders:
            continue
        n += 1
        expected = {'min': round(float(vals.min()), 4), 'max': round(float(vals.max()), 4),
                    'p1': round(float(np.quantile(vals, 0.01)), 4),
                    'p99': round(float(np.quantile(vals, 0.99)), 4)}
        for k, v in expected.items():
            if not close(sliders[metric].get(k), v, SCORE_TOL):
                problems.append(f'slider {metric}.{k}: json={sliders[metric].get(k)} recomp={v}')

    rep.checked += n
    if problems:
        rep.fail(f'{len(problems)} metadata mismatches', problems)
    else:
        rep.ok(f'sigma, centre and slider_ranges match the recomputation ({n} groups)')


def check_class_spread(metadata, base_by_rspo, rep: Report):
    """G — bucket the base scores into A / B / C by the map's ±0.33σ rule and flag
    any EMPTY class: a colour the map can never show usually means a degenerate
    centre/σ (e.g. the old 5-class scheme left median-English's top class empty)."""
    rep.section('G. Class A/B/C spread is non-degenerate (base)')
    sigma, centre = metadata['sigma'], metadata['sigma_centre']
    empty = []
    n = 0
    for metric in EXPORT_METRICS:
        for s in ALL_SUBJECTS:
            sig, ctr = sigma[metric][s], centre[metric][s]
            if not sig:
                continue
            n += 1
            counts = {'A': 0, 'B': 0, 'C': 0}
            for school in base_by_rspo.values():
                cell = school['scores'].get(metric, {}).get(s)
                if not cell:
                    continue
                score = cell['score']
                cls = ('A' if score > ctr + CLASS_BOUND * sig
                       else 'C' if score < ctr - CLASS_BOUND * sig else 'B')
                counts[cls] += 1
            for cls, c in counts.items():
                if c == 0:
                    empty.append(f'{metric}/{s}: class {cls} is empty ({counts})')
    rep.checked += n
    if empty:
        rep.fail(f'{len(empty)} (metric, subject) groups have an empty class', empty)
    else:
        rep.ok(f'all {n} (metric, subject) groups populate every class A/B/C')


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data-dir', default='data/egzamin-osmoklasisty', type=Path,
                    help='directory with the source OKE xlsx files')
    ap.add_argument('--docs-data', default='docs/data', type=Path,
                    help='directory with schools-base.json and schools-{metric}.json')
    args = ap.parse_args()

    print('Loading JSON exports …')
    metadata, base_by_rspo, per_metric = load_json_exports(args.docs_data)
    json_years = set(metadata['years_in_data'])
    print(f'  base.json: {len(base_by_rspo):,} schools; years {sorted(json_years)}; '
          f'metrics {list(per_metric)}')

    print('Reading source xlsx …')
    all_rows = read_clean_rows(args.data_dir)
    xlsx_years = {r['year'] for r in all_rows}
    missing = json_years - xlsx_years
    if missing:
        sys.exit(f'The JSON was built from years {sorted(json_years)} but the xlsx is '
                 f'missing {sorted(missing)} — cannot validate.')
    rows = [r for r in all_rows if r['year'] in json_years]  # validate the JSON's own years
    extra = xlsx_years - json_years
    note = f' (ignoring extra xlsx years {sorted(extra)})' if extra else ''
    print(f'  {len(rows):,} clean (school, year) rows over years {sorted(json_years)}{note}')

    print('Recomputing metrics / views / ranks / metadata independently …')
    voiv = voivodeship_mean(rows)
    view = build_view_scores(rows, voiv)

    rep = Report()
    check_subjects_vs_xlsx(rows, per_metric, rep)
    check_aggregates(view, per_metric, rep)
    check_completeness(view, per_metric, rep)
    check_base_consistency(base_by_rspo, per_metric, rep)
    check_ranks(view, per_metric, rep)
    check_metadata(metadata, view, rep)
    check_class_spread(metadata, base_by_rspo, rep)

    print(f'\n{"=" * 64}')
    if rep.failures == 0:
        print(f'ALL CHECKS PASSED  ({rep.checked:,} comparisons)')
        return 0
    print(f'{rep.failures} CHECK(S) FAILED  ({rep.checked:,} comparisons)')
    return 1


if __name__ == '__main__':
    sys.exit(main())
