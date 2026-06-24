#!/usr/bin/env python3
"""Validate the map/ranking JSON exports against an INDEPENDENT recomputation.

This script does NOT import the notebook. It re-reads the source OKE xlsx files,
re-derives every per-year metric, every view aggregate (base / single_year / loo /
last_k), composite_min, and every rank/percentile from scratch, and checks the
JSON the app actually serves (docs/data/schools-base.json + schools-{metric}.json)
against it. A second, formula-internal check confirms the ranks/percentiles stored
in the JSON are the correct function of the JSON's own scores.

The JSON is kept as plain dicts keyed by rspo (no DataFrame) — convenient for the
nested score lookups.

Checks
  A. Subject raw values:  JSON single_year of metric 'mean'/'median' == the
     mean/median read straight from the xlsx for that (school, subject, year).
  B. Aggregates:          recomputed score == JSON score for every
     (metric, subject, view) — single_year, loo, base (all years), last_k,
     including composite_min.
  C. base.json:           its scores[metric][subject] == the per-metric file's
     base view (the two exports must agree).
  D. Ranks / percentiles: recomputed from the JSON's OWN scores per view
     population == the JSON's rank/pct (min-rank ties, average-rank percentile).
  E. Class sanity:        bucketing base scores into A/B/C by ±0.33σ (the map's
     colour rule), percentiles must not cross classes (A ≥ B ≥ C).

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
EXPORT_METRICS = ['mean', 'median', 'diff_mean', 'unit_norm_diff_mean']
WEIGHTED_METRICS = {'diff_mean', 'unit_norm_diff_mean'}  # rest use arithmetic mean
YEAR_FILE_RE = re.compile(r'^\d{4}')

SCORE_TOL = 5e-4   # JSON rounds score to 4 dp; allow rounding + float noise
PCT_TOL = 0.06     # JSON rounds pct to 1 dp
CLASS_BOUND = 0.33  # ±0.33σ, matching the map/ranking colour rule
# Scores within this are treated as a tie when validating ranks: the export ranks
# full-precision floats, so two schools equal to ~13 sig figs (e.g. from (v*n)/n
# round-off) get an arbitrary order that an independent recompute can't reproduce
# bit-for-bit. Genuine score precision is ~1e-4, so 1e-9 cleanly separates real
# differences from float noise.
TIE_EPS = 1e-9


# ── xlsx reading (independent re-implementation of the loader) ───────────────

def normalize_text(text: str) -> str:
    text = unicodedata.normalize('NFKD', str(text))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace('ł', 'l').replace('Ł', 'L').replace('\n', ' ')
    return re.sub(r'\s+', ' ', text).lower().strip()


def clean_header_value(value) -> str:
    if value is None:
        return ''
    text = str(value)
    if text.startswith('Unnamed:') or text == 'nan':
        return ''
    return re.sub(r'\s+', ' ', text.replace('\n', ' ')).strip()


def normalize_columns(columns: pd.MultiIndex) -> pd.MultiIndex:
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
    """Return one dict per (school, year) row that survives cleaning, with each
    core subject's n / mean / median. Cleaning matches the notebook:
      keep n_polski > 0, and require mean AND median present for all 3 core
      subjects (rows missing any are dropped from the analysis population)."""
    files = sorted(p for p in data_dir.glob('*.xlsx*')
                   if not p.name.startswith('.') and YEAR_FILE_RE.match(p.name))
    if not files:
        sys.exit(f'No source xlsx files in {data_dir}')

    rows: list[dict] = []
    for path in files:
        year = int(YEAR_FILE_RE.match(path.name).group(0))
        raw = pd.read_excel(path, sheet_name='SAS', header=[0, 1])
        raw.columns = normalize_columns(raw.columns)
        for _, r in raw.iterrows():
            rspo = r[('meta', 'rspo')]
            if pd.isna(rspo):
                continue
            n_polski = pd.to_numeric(r[(CORE_SUBJECTS[0], 'liczba zdajacych')], errors='coerce')
            if not (pd.notna(n_polski) and n_polski > 0):
                continue
            row = {'rspo': int(rspo), 'year': year}
            complete = True
            for s in CORE_SUBJECTS:
                n = pd.to_numeric(r[(s, 'liczba zdajacych')], errors='coerce')
                mean = pd.to_numeric(r[(s, 'wynik sredni (%)')], errors='coerce')
                median = pd.to_numeric(r[(s, 'mediana (%)')], errors='coerce')
                if pd.isna(mean) or pd.isna(median):
                    complete = False
                    break
                row[s] = {'n': float(n) if pd.notna(n) else np.nan,
                          'mean': float(mean), 'median': float(median)}
            if complete:
                rows.append(row)
    return rows


# ── independent metric / view / rank recomputation ──────────────────────────

def voivodeship_mean(rows: list[dict]) -> dict[str, dict[int, float]]:
    """{subject: {year: mean over schools of mean_subject}} on the clean rows."""
    acc: dict[str, dict[int, list]] = {s: defaultdict(list) for s in CORE_SUBJECTS}
    for row in rows:
        for s in CORE_SUBJECTS:
            acc[s][row['year']].append(row[s]['mean'])
    return {s: {y: float(np.mean(v)) for y, v in years.items()} for s, years in acc.items()}


def per_year_values(rows, voiv):
    """{(rspo, subject): {year: {'n': n, metric: value, ...}}} for valid rows
    (n > 0 and the metric defined). Mirrors school_years_for_subject."""
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
                'n': n,
                'mean': mean,
                'median': median,
                'diff_mean': diff_mean,
                'unit_norm_diff_mean': diff_mean / denom,
            }
    return out


def aggregate(metric, year_to_vals, years_used):
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
    """{(metric, subject, view_kind, param): {rspo: score}} for all metrics,
    core subjects, and composite_min."""
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

    # composite_min: min across the 3 core subjects, per (metric, view, param)
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
    """{rspo: (rank, pct)} with min-rank (desc) and average-rank percentile."""
    rspos = list(score_map)
    scores = np.array([score_map[r] for r in rspos])
    n = len(scores)
    rank = stats.rankdata(-scores, method='min').astype(int)
    pct = stats.rankdata(scores, method='average') / n * 100
    return {r: (int(rk), float(pc)) for r, rk, pc in zip(rspos, rank, pct)}


# ── JSON loading (kept as dicts keyed by rspo) ──────────────────────────────

def load_json_exports(docs_data: Path):
    base = json.loads((docs_data / 'schools-base.json').read_text())
    base_by_rspo = {int(s['rspo']): s for s in base['schools']}
    per_metric = {}
    for metric in EXPORT_METRICS:
        path = docs_data / f'schools-{metric}.json'
        payload = json.loads(path.read_text())
        per_metric[metric] = {int(r): d for r, d in payload['schools'].items()}
    return base['metadata'], base_by_rspo, per_metric


# ── checks ───────────────────────────────────────────────────────────────────

class Report:
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
    return abs(a - b) <= tol


def check_subjects_vs_xlsx(rows, per_metric, rep: Report):
    rep.section('A. Subject raw values vs xlsx (single_year of mean/median)')
    raw = {(r['rspo'], r['year']): r for r in rows}
    for metric, field in (('mean', 'mean'), ('median', 'median')):
        mism = []
        n = 0
        for (rspo, year), row in raw.items():
            school = per_metric[metric].get(rspo)
            if not school:
                continue
            for s in CORE_SUBJECTS:
                cell = school.get(s, {}).get('single_year', {}).get(str(year))
                if cell is None:
                    continue
                n += 1
                if not close(cell['score'], round(row[s][field], 4), SCORE_TOL):
                    mism.append(f'rspo={rspo} {s} {year}: json={cell["score"]} xlsx={row[s][field]}')
        rep.checked += n
        if mism:
            rep.fail(f'metric={metric}: {len(mism)}/{n} single-year values differ from xlsx', mism)
        else:
            rep.ok(f'metric={metric}: all {n} single-year subject values match the xlsx')


def check_aggregates(view, per_metric, base_by_rspo, rep: Report):
    rep.section('B. Aggregates recomputed from xlsx vs JSON (all views)')
    # index recomputed scores: {(metric, subject): {(kind, param): {rspo: score}}}
    by_ms = defaultdict(lambda: defaultdict(dict))
    for (metric, s, kind, param), sm in view.items():
        for rspo, sc in sm.items():
            by_ms[(metric, s)][(kind, param)][rspo] = sc

    per_kind_counts = defaultdict(lambda: [0, 0])  # kind -> [checked, failed]
    examples = defaultdict(list)
    for metric in EXPORT_METRICS:
        subjects = CORE_SUBJECTS + ['composite_min']
        for s in subjects:
            for rspo, school in per_metric[metric].items():
                node = school.get(s)
                if not node:
                    continue
                # base
                _cmp_one(by_ms, metric, s, 'base', None, rspo, node.get('base'),
                         per_kind_counts, examples)
                # nested views
                for kind in ('single_year', 'loo', 'last_k'):
                    for param, cell in (node.get(kind) or {}).items():
                        key_param = int(param)
                        _cmp_one(by_ms, metric, s, kind, key_param, rspo, cell,
                                 per_kind_counts, examples)
    total_fail = 0
    for kind, (chk, fail) in sorted(per_kind_counts.items()):
        rep.checked += chk
        total_fail += fail
        if fail:
            rep.fail(f'{kind}: {fail}/{chk} scores differ', examples[kind])
        else:
            rep.ok(f'{kind}: all {chk} aggregate scores match the recomputation')
    if total_fail == 0:
        rep.ok('every metric × subject × view aggregate matches')


def _cmp_one(by_ms, metric, s, kind, param, rspo, cell, counts, examples):
    if cell is None:
        return
    recomputed = by_ms.get((metric, s), {}).get((kind, param), {}).get(rspo)
    counts[kind][0] += 1
    if recomputed is None:
        counts[kind][1] += 1
        examples[kind].append(f'{metric}/{s}/{kind}/{param} rspo={rspo}: missing in recompute')
    elif not close(cell['score'], round(recomputed, 4), SCORE_TOL):
        counts[kind][1] += 1
        examples[kind].append(
            f'{metric}/{s}/{kind}/{param} rspo={rspo}: json={cell["score"]} recomp={recomputed:.4f}')


def check_base_consistency(base_by_rspo, per_metric, rep: Report):
    rep.section('C. base.json scores == per-metric file base view')
    mism = []
    n = 0
    for rspo, school in base_by_rspo.items():
        for metric, by_subject in school['scores'].items():
            for s, cell in by_subject.items():
                pm = per_metric.get(metric, {}).get(rspo, {}).get(s, {}).get('base')
                if pm is None:
                    continue
                n += 1
                if (cell['rank'] != pm['rank']
                        or not close(cell['score'], pm['score'], SCORE_TOL)
                        or not close(cell['pct'], pm['pct'], PCT_TOL)):
                    mism.append(f'rspo={rspo} {metric}/{s}: base={cell} perMetric={pm}')
    rep.checked += n
    if mism:
        rep.fail(f'{len(mism)}/{n} base entries disagree between the two files', mism)
    else:
        rep.ok(f'all {n} base entries agree between schools-base.json and the per-metric files')


def check_ranks(view, per_metric, rep: Report):
    rep.section('D. Ranks/percentiles match rankdata over the full-precision scores')
    # The export ranks the FULL-precision scores, then rounds to 4 dp for JSON.
    # Ranking the rounded scores would create spurious ties, so we rank our own
    # recomputed full-precision scores (check B confirmed they equal the JSON).
    stored = defaultdict(dict)     # key -> {rspo: (rank, pct)}
    json_pop = defaultdict(set)    # key -> {rspo}
    for metric, schools in per_metric.items():
        for rspo, school in schools.items():
            for s, node in school.items():
                if not isinstance(node, dict):
                    continue
                if isinstance(node.get('base'), dict):
                    key = (metric, s, 'base', None)
                    stored[key][rspo] = (node['base']['rank'], node['base']['pct'])
                    json_pop[key].add(rspo)
                for kind in ('single_year', 'loo', 'last_k'):
                    for param, cell in (node.get(kind) or {}).items():
                        key = (metric, s, kind, int(param))
                        stored[key][rspo] = (cell['rank'], cell['pct'])
                        json_pop[key].add(rspo)

    # For each school the stored rank must fall within the range allowed by
    # near-ties: schools clearly better (score > s + TIE_EPS) sit above for sure,
    # schools clearly worse sit below; anyone within TIE_EPS may go either way.
    pop_fail = rank_fail = pct_fail = total = ambiguous = 0
    examples = []
    for key, stored_map in stored.items():
        my_scores = view.get(key, {})
        if set(my_scores) != json_pop[key]:
            pop_fail += 1
            if len(examples) < 5:
                only_json = len(json_pop[key] - set(my_scores))
                only_mine = len(set(my_scores) - json_pop[key])
                examples.append(f'{key}: population differs (json-only {only_json}, recomp-only {only_mine})')
            continue
        n = len(my_scores)
        asc = sorted(my_scores.values())
        for rspo, sc in my_scores.items():
            total += 1
            n_better = n - bisect.bisect_right(asc, sc + TIE_EPS)  # clearly above
            n_worse = bisect.bisect_left(asc, sc - TIE_EPS)        # clearly below
            rank_lo, rank_hi = n_better + 1, n - n_worse
            if rank_lo != rank_hi:
                ambiguous += 1
            srk, spc = stored_map[rspo]
            if not (rank_lo <= srk <= rank_hi):
                rank_fail += 1
                if len(examples) < 5:
                    examples.append(f'{key} rspo={rspo}: json_rank={srk} not in [{rank_lo},{rank_hi}]')
                continue
            pct_lo = n_worse / n * 100 - PCT_TOL
            pct_hi = (n - n_better) / n * 100 + PCT_TOL
            if not (pct_lo <= spc <= pct_hi):
                pct_fail += 1
                if len(examples) < 5:
                    examples.append(f'{key} rspo={rspo}: json_pct={spc} not in [{pct_lo:.1f},{pct_hi:.1f}]')
    rep.checked += total
    if pop_fail or rank_fail or pct_fail:
        rep.fail(f'{pop_fail} population + {rank_fail} rank + {pct_fail} pct mismatches '
                 f'(of {total} ranked)', examples)
    else:
        rep.ok(f'all {total} (rank, pct) values consistent with the scores '
               f'({ambiguous:,} within near-tie tolerance)')


def check_class_sanity(metadata, base_by_rspo, rep: Report):
    rep.section('E. Class sanity: A/B/C buckets vs percentile ordering (base)')
    sigma = metadata['sigma']
    centre = metadata['sigma_centre']
    problems = []
    n = 0
    for metric in EXPORT_METRICS:
        for s in CORE_SUBJECTS + ['composite_min']:
            sig = sigma[metric][s]
            ctr = centre[metric][s]
            if not sig:
                continue
            buckets = {'A': [], 'B': [], 'C': []}  # pct values per class
            for school in base_by_rspo.values():
                cell = school['scores'].get(metric, {}).get(s)
                if not cell:
                    continue
                score = cell['score']
                if score > ctr + CLASS_BOUND * sig:
                    cls = 'A'
                elif score < ctr - CLASS_BOUND * sig:
                    cls = 'C'
                else:
                    cls = 'B'
                buckets[cls].append(cell['pct'])
            n += 1
            # Above-average class should not have a lower max percentile than the
            # around/below classes' min — i.e. classes must not invert vs pct.
            a_min = min(buckets['A']) if buckets['A'] else None
            b_max = max(buckets['B']) if buckets['B'] else None
            b_min = min(buckets['B']) if buckets['B'] else None
            c_max = max(buckets['C']) if buckets['C'] else None
            if a_min is not None and b_max is not None and a_min < b_max - 1e-9:
                problems.append(f'{metric}/{s}: class A min pct {a_min:.1f} < class B max {b_max:.1f}')
            if b_min is not None and c_max is not None and b_min < c_max - 1e-9:
                problems.append(f'{metric}/{s}: class B min pct {b_min:.1f} < class C max {c_max:.1f}')
    rep.checked += n
    if problems:
        rep.fail(f'{len(problems)} class/percentile inversions', problems)
    else:
        rep.ok(f'all {n} (metric, subject) class buckets order correctly by percentile')


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data-dir', default='data/egzamin-osmoklasisty', type=Path,
                    help='directory with the source OKE xlsx files')
    ap.add_argument('--docs-data', default='docs/data', type=Path,
                    help='directory with schools-base.json and schools-{metric}.json')
    args = ap.parse_args()

    print('Reading source xlsx …')
    rows = read_clean_rows(args.data_dir)
    years = sorted({r['year'] for r in rows})
    print(f'  {len(rows):,} clean (school, year) rows over years {years}')

    print('Recomputing metrics / views / ranks independently …')
    voiv = voivodeship_mean(rows)
    view = build_view_scores(rows, voiv)

    print('Loading JSON exports …')
    metadata, base_by_rspo, per_metric = load_json_exports(args.docs_data)
    print(f'  base.json: {len(base_by_rspo):,} schools; metrics {list(per_metric)}')

    if set(metadata['years_in_data']) != set(years):
        print(f'  NOTE: JSON years_in_data {metadata["years_in_data"]} != xlsx years {years} '
              f'(expected when validating a frozen export against newer source files)')

    rep = Report()
    check_subjects_vs_xlsx(rows, per_metric, rep)
    check_aggregates(view, per_metric, base_by_rspo, rep)
    check_base_consistency(base_by_rspo, per_metric, rep)
    check_ranks(view, per_metric, rep)
    check_class_sanity(metadata, base_by_rspo, rep)

    print(f'\n{"=" * 64}')
    if rep.failures == 0:
        print(f'ALL CHECKS PASSED  ({rep.checked:,} comparisons)')
        return 0
    print(f'{rep.failures} CHECK(S) FAILED  ({rep.checked:,} comparisons)')
    return 1


if __name__ == '__main__':
    sys.exit(main())
