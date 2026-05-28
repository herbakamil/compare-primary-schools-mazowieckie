#!/usr/bin/env python3
"""Geocode school addresses to latitude/longitude using Nominatim (OpenStreetMap).

This script is meant to be run occasionally — only when new schools appear or
addresses change. Geocoding is slow (Nominatim rate-limits to ~1 request/second)
and the result is stable, so it is cached in a CSV that the notebook reads.

Workflow
--------
1. Reads the schools and their addresses from output/schools-base.json
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
SCHOOLS_BASE_JSON = PROJECT_ROOT / "output" / "schools-base.json"
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

    geocoded_count = 0
    kept_count = 0
    updated_count = 0
    new_count = 0

    # 1. Walk existing rows in order; keep or re-geocode in place.
    result_by_rspo: dict[int, dict] = {}
    for rspo in ordered_rspo:
        cached = cache_by_rspo[rspo]
        school = schools_by_rspo.get(rspo)
        if school is None:
            # School no longer present in data — keep the cached row as-is
            result_by_rspo[rspo] = cached
            kept_count += 1
            continue

        old_addr = normalize_address(cached.get("miejscowosc"), cached.get("ulica_nr"))
        new_addr = normalize_address(school["miejscowosc"], school["ulica_nr"])
        has_coords = bool(cached.get("latitude")) and bool(cached.get("longitude"))

        if old_addr == new_addr and has_coords:
            # Unchanged address with coordinates — keep cached row in its position
            result_by_rspo[rspo] = cached
            kept_count += 1
        else:
            # Changed address (or missing coords) — re-geocode, update in place
            if args.limit is not None and geocoded_count >= args.limit:
                result_by_rspo[rspo] = cached  # leave as-is for now
                continue
            print(f"  re-geocoding rspo={rspo}: {school['miejscowosc']}, {school['ulica_nr']}")
            coords = geocode_address(school["miejscowosc"], school["ulica_nr"])
            geocoded_count += 1
            updated_count += 1
            result_by_rspo[rspo] = {
                "rspo": rspo,
                "miejscowosc": school["miejscowosc"],
                "ulica_nr": school["ulica_nr"],
                "latitude": coords[0] if coords else "",
                "longitude": coords[1] if coords else "",
            }

    # 2. Append new schools (not in cache) at the end, in schools-base order.
    for school in schools:
        rspo = school["rspo"]
        if rspo in result_by_rspo:
            continue
        if args.limit is not None and geocoded_count >= args.limit:
            break
        print(f"  geocoding NEW rspo={rspo}: {school['miejscowosc']}, {school['ulica_nr']}")
        coords = geocode_address(school["miejscowosc"], school["ulica_nr"])
        geocoded_count += 1
        new_count += 1
        result_by_rspo[rspo] = {
            "rspo": rspo,
            "miejscowosc": school["miejscowosc"],
            "ulica_nr": school["ulica_nr"],
            "latitude": coords[0] if coords else "",
            "longitude": coords[1] if coords else "",
        }
        ordered_rspo.append(rspo)

    # 3. Assemble final ordered rows: existing positions first, then appended new.
    final_rows = [result_by_rspo[rspo] for rspo in ordered_rspo if rspo in result_by_rspo]
    # Include any new rspo that were appended but not yet in ordered_rspo
    for rspo in result_by_rspo:
        if rspo not in ordered_rspo:
            final_rows.append(result_by_rspo[rspo])

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
