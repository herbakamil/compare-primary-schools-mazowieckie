#!/usr/bin/env python3
"""Geocode school addresses to latitude/longitude using Nominatim (OpenStreetMap).

This script is meant to be run occasionally — only when new schools appear or
addresses change. Geocoding is slow (Nominatim rate-limits to ~1 request/second)
and the result is stable, so it is cached in a CSV that the notebook reads.

Workflow
--------
1. Reads the schools and their addresses from docs/data/schools-base.json
   (which the analysis notebook produces).
2. Reads the existing cache data/school_coords.csv (if present).
3. For each school:
   - if the RSPO already exists in the cache AND its address is unchanged,
     the cached coordinates are kept (and stay in their original CSV position);
   - otherwise (new RSPO, or changed address) the address is geocoded and
     either updated in place (changed address) or appended at the end (new RSPO).
4. Writes the updated cache back to data/school_coords.csv.

CSV columns: rspo, miejscowosc, ulica_nr, latitude, longitude

Usage
-----
    uv run python scripts/geocode_schools.py
    uv run python scripts/geocode_schools.py --limit 50      # only geocode 50 new ones (testing)
    uv run python scripts/geocode_schools.py --force         # re-geocode everything

Requirements: requests (already a project dependency via jupyter stack, or add it).
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# ── Paths (relative to project root; script lives in scripts/) ──────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCHOOLS_BASE_JSON = PROJECT_ROOT / "docs" / "data" / "schools-base.json"
COORDS_CSV = PROJECT_ROOT / "data" / "school_coords.csv"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "porownanie-podstawowek-mazowsze/1.0 (school quality map; contact: herba.kamil@gmail.com)"
REQUEST_DELAY_SECONDS = 1.1  # Nominatim usage policy: max 1 request/second

CSV_COLUMNS = ["rspo", "miejscowosc", "ulica_nr", "latitude", "longitude"]


def normalize_address(miejscowosc: str | None, ulica_nr: str | None) -> str:
    """Build a normalized address key for comparison (lowercased, stripped)."""
    parts = [str(miejscowosc or "").strip(), str(ulica_nr or "").strip()]
    return "|".join(p.lower() for p in parts)


def geocode_address(miejscowosc: str | None, ulica_nr: str | None) -> tuple[float, float] | None:
    """Geocode a single address via Nominatim. Returns (lat, lon) or None."""
    # Try the most specific query first (street + town), then fall back to town only.
    queries = []
    if ulica_nr and str(ulica_nr).strip():
        queries.append(f"{ulica_nr}, {miejscowosc}, Polska")
    queries.append(f"{miejscowosc}, Polska")

    for query in queries:
        params = {
            "q": query,
            "format": "json",
            "limit": "1",
            "countrycodes": "pl",
        }
        url = f"{NOMINATIM_URL}?{urlencode(params)}"
        request = Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # network error, timeout, JSON error
            print(f"    request failed for '{query}': {exc}", file=sys.stderr)
            time.sleep(REQUEST_DELAY_SECONDS)
            continue

        time.sleep(REQUEST_DELAY_SECONDS)  # respect rate limit between requests

        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])

    return None


def load_existing_cache(path: Path) -> list[dict]:
    """Load existing coordinate cache as an ordered list of row dicts."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_schools(path: Path) -> list[dict]:
    """Load schools (rspo, miejscowosc, ulica_nr) from schools-base.json."""
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Run the analysis notebook first to generate it."
        )
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        {
            "rspo": school["rspo"],
            "miejscowosc": school.get("miejscowosc"),
            "ulica_nr": school.get("ulica_nr"),
        }
        for school in payload["schools"]
    ]


def write_cache(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in CSV_COLUMNS})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None,
                        help="Maximum number of NEW geocoding requests (for testing).")
    parser.add_argument("--force", action="store_true",
                        help="Re-geocode every school, ignoring the cache.")
    args = parser.parse_args()

    schools = load_schools(SCHOOLS_BASE_JSON)
    print(f"Loaded {len(schools):,} schools from {SCHOOLS_BASE_JSON.name}")

    existing_rows = [] if args.force else load_existing_cache(COORDS_CSV)
    print(f"Existing cache: {len(existing_rows):,} rows"
          + (" (ignored due to --force)" if args.force else ""))

    # Index existing rows by rspo, preserving their original order/position.
    cache_by_rspo = {int(row["rspo"]): row for row in existing_rows}
    # Ordered list of rspo as they currently appear in the CSV (to preserve position).
    ordered_rspo = [int(row["rspo"]) for row in existing_rows]

    schools_by_rspo = {s["rspo"]: s for s in schools}

    kept_count = 0
    updated_count = 0
    new_count = 0

    # 1. Plan: collect every school that needs geocoding (changed address or new).
    all_to_geocode: list[tuple[int, dict, str]] = []  # (rspo, school, action)
    for rspo in ordered_rspo:
        cached = cache_by_rspo[rspo]
        school = schools_by_rspo.get(rspo)
        if school is None:
            continue
        old_addr = normalize_address(cached.get("miejscowosc"), cached.get("ulica_nr"))
        new_addr = normalize_address(school["miejscowosc"], school["ulica_nr"])
        has_coords = bool(cached.get("latitude")) and bool(cached.get("longitude"))
        if not (old_addr == new_addr and has_coords):
            all_to_geocode.append((rspo, school, "update"))

    for school in schools:
        if school["rspo"] not in cache_by_rspo:
            all_to_geocode.append((school["rspo"], school, "new"))

    to_geocode = all_to_geocode if args.limit is None else all_to_geocode[: args.limit]
    n_total = len(to_geocode)
    to_geocode_rspos = {rspo for rspo, _, _ in to_geocode}
    deferred_count = len(all_to_geocode) - n_total

    # 2. Pre-populate result_by_rspo with rows that will NOT be re-geocoded
    #    (kept rows + deferred updates fall through with their cached values).
    deferred_rspos = {rspo for rspo, _, _ in all_to_geocode[n_total:]}
    result_by_rspo: dict[int, dict] = {}
    for rspo in ordered_rspo:
        if rspo in to_geocode_rspos:
            continue
        result_by_rspo[rspo] = cache_by_rspo[rspo]
        if rspo not in deferred_rspos:
            kept_count += 1

    # 3. Geocode with progress, saving every SAVE_EVERY processed schools.
    SAVE_EVERY = 50

    def assemble_rows() -> list[dict]:
        rows = [result_by_rspo[r] for r in ordered_rspo if r in result_by_rspo]
        for r in result_by_rspo:
            if r not in ordered_rspo:
                rows.append(result_by_rspo[r])
        return rows

    print(
        f"\nGeocoding {n_total:,} schools"
        + (f" ({deferred_count:,} deferred due to --limit)" if deferred_count else "")
    )

    for index, (rspo, school, action) in enumerate(to_geocode, start=1):
        pct = index / n_total * 100 if n_total else 100.0
        label = "re-geocoding" if action == "update" else "geocoding NEW"
        print(
            f"  [{index:>4,}/{n_total:,} ({pct:5.1f}%)] {label} rspo={rspo}: "
            f"{school['miejscowosc']}, {school['ulica_nr']}"
        )
        coords = geocode_address(school["miejscowosc"], school["ulica_nr"])
        if action == "update":
            updated_count += 1
        else:
            new_count += 1
            ordered_rspo.append(rspo)
        result_by_rspo[rspo] = {
            "rspo": rspo,
            "miejscowosc": school["miejscowosc"],
            "ulica_nr": school["ulica_nr"],
            "latitude": coords[0] if coords else "",
            "longitude": coords[1] if coords else "",
        }

        if index % SAVE_EVERY == 0 and index < n_total:
            write_cache(COORDS_CSV, assemble_rows())
            print(f"    [partial cache saved — {index:,}/{n_total:,} done]")

    # 4. Final save.
    final_rows = assemble_rows()
    write_cache(COORDS_CSV, final_rows)

    missing = sum(1 for r in final_rows if not r.get("latitude"))
    print()
    print(f"Done. Cache written to {COORDS_CSV}")
    print(f"  kept (unchanged):   {kept_count:,}")
    print(f"  updated (changed):  {updated_count:,}")
    print(f"  new (appended):     {new_count:,}")
    print(f"  total rows:         {len(final_rows):,}")
    print(f"  still missing coords: {missing:,}")


if __name__ == "__main__":
    main()
