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
Nominatim requires a contact (email or URL) in the User-Agent. Supply your own
via the NOMINATIM_CONTACT env var (or the --contact flag); it is never stored in
this repo. The script exits with an error if no contact is set.

    NOMINATIM_CONTACT=you@example.com uv run python scripts/geocode_schools.py
    NOMINATIM_CONTACT=you@example.com uv run python scripts/geocode_schools.py --limit 50  # only 50 new (testing)
    NOMINATIM_CONTACT=you@example.com uv run python scripts/geocode_schools.py --force      # re-geocode everything
    uv run python scripts/geocode_schools.py --contact you@example.com                      # contact via flag

Requirements: requests (already a project dependency via jupyter stack, or add it).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
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
REQUEST_DELAY_SECONDS = 1.1  # Nominatim usage policy: max 1 request/second

# Mazowieckie voivodeship bounding box (lon_min, lat_min, lon_max, lat_max).
# Source: rough envelope around the official borders.
MAZ_LON_MIN, MAZ_LAT_MIN = 19.2, 51.0
MAZ_LON_MAX, MAZ_LAT_MAX = 23.2, 53.6
# Nominatim viewbox format: "left,top,right,bottom" (west_lon,north_lat,east_lon,south_lat).
MAZ_VIEWBOX = f"{MAZ_LON_MIN},{MAZ_LAT_MAX},{MAZ_LON_MAX},{MAZ_LAT_MIN}"

# Street prefixes the OKE data tacks on (e.g. "ul. Marszałkowska 1"). Nominatim
# fares better when we either drop them or also try a stripped form.
STREET_PREFIXES = ("ul.", "Ul.", "UL.", "al.", "Al.", "AL.", "pl.", "Pl.", "os.", "Os.")

# Nominatim requires a User-Agent identifying the application AND a way to
# contact whoever runs it (stock HTTP-library User-Agents are blocked). The app
# id lives in source, but the contact must NOT be hardcoded — this repo is
# public. It is supplied at runtime via the NOMINATIM_CONTACT env var (or the
# --contact flag), and slotted into this template. See README "Geocoding".
CONTACT_ENV_VAR = "NOMINATIM_CONTACT"
USER_AGENT_TEMPLATE = "compare-primary-schools-mazowieckie/1.0 (school quality map; contact: {contact})"

CSV_COLUMNS = ["rspo", "miejscowosc", "ulica_nr", "latitude", "longitude"]


def normalize_address(miejscowosc: str | None, ulica_nr: str | None) -> str:
    """Build a normalized address key for comparison (lowercased, stripped)."""
    parts = [str(miejscowosc or "").strip(), str(ulica_nr or "").strip()]
    return "|".join(p.lower() for p in parts)


def resolve_user_agent(cli_contact: str | None) -> str:
    """Build the Nominatim User-Agent from a runtime-supplied contact.

    Contact precedence: --contact flag, then the NOMINATIM_CONTACT env var.
    Exits with a clear message if neither is set, because Nominatim rejects
    requests that lack a valid contact.
    """
    contact = (cli_contact or os.environ.get(CONTACT_ENV_VAR) or "").strip()
    if not contact:
        sys.exit(
            f"ERROR: no Nominatim contact set. Nominatim requires a valid contact "
            f"(email or URL) and rejects requests without one.\n"
            f"  Pass it inline:   {CONTACT_ENV_VAR}=you@example.com uv run python scripts/geocode_schools.py\n"
            f"  Or via the flag:  uv run python scripts/geocode_schools.py --contact you@example.com\n"
            f"See the README \"Geocoding\" section for details."
        )
    return USER_AGENT_TEMPLATE.format(contact=contact)


def _strip_street_prefix(street: str) -> str:
    """Drop the leading 'ul.'/'al.'/'pl.'/'os.' tag and collapse whitespace."""
    s = street.strip()
    for prefix in STREET_PREFIXES:
        if s.startswith(prefix):
            s = s[len(prefix):].strip()
            break
    return s


def _in_mazowieckie(lat: float, lon: float) -> bool:
    return MAZ_LAT_MIN <= lat <= MAZ_LAT_MAX and MAZ_LON_MIN <= lon <= MAZ_LON_MAX


def _nominatim_request(params: dict, user_agent: str) -> list:
    """One Nominatim request. Returns the parsed JSON list (possibly empty)."""
    url = f"{NOMINATIM_URL}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": user_agent, "Accept-Language": "pl"})
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        print(f"    request failed: {exc}", file=sys.stderr)
        return []
    finally:
        time.sleep(REQUEST_DELAY_SECONDS)


def geocode_address(miejscowosc: str | None, ulica_nr: str | None, user_agent: str) -> tuple[float, float] | None:
    """Geocode a single address via Nominatim, biased to Mazowieckie.

    Strategy (try in order, accept first result that lands inside Mazowieckie):
      1. Structured query: street + city + state=Mazowieckie + country=Polska.
      2. Free-text with viewbox-bounded Mazowieckie: "<street>, <city>, Mazowieckie".
      3. Free-text with original prefixed street ("ul. X"), still viewbox-bounded.

    There is **no** fallback to a town-only query. If no street-level match is
    found within Mazowieckie, return None — the school will appear in the
    ranking but stay off the map. Better than planting it on a city centroid
    (the previous behaviour silently put 773 of 1,720 schools on top of each
    other at the Pałac Kultury location and similar).
    """
    miejscowosc = (miejscowosc or "").strip()
    ulica_raw = (ulica_nr or "").strip()
    if not miejscowosc or not ulica_raw:
        return None  # no street → no street-level match possible

    street_clean = _strip_street_prefix(ulica_raw)
    queries: list[dict] = []

    # 1. Structured query — Nominatim prefers `street=<housenumber> <streetname>`
    #    or `street=<streetname> <housenumber>`; both forms work in practice.
    queries.append({
        "street": street_clean,
        "city": miejscowosc,
        "state": "województwo mazowieckie",
        "country": "Polska",
        "countrycodes": "pl",
        "format": "json",
        "limit": "1",
    })

    # 2. Free-text, viewbox-bounded to Mazowieckie.
    queries.append({
        "q": f"{street_clean}, {miejscowosc}, województwo mazowieckie, Polska",
        "format": "json",
        "limit": "1",
        "countrycodes": "pl",
        "viewbox": MAZ_VIEWBOX,
        "bounded": "1",
    })

    # 3. Original "ul. X" form — some streets disambiguate better with the tag.
    if street_clean != ulica_raw:
        queries.append({
            "q": f"{ulica_raw}, {miejscowosc}, województwo mazowieckie, Polska",
            "format": "json",
            "limit": "1",
            "countrycodes": "pl",
            "viewbox": MAZ_VIEWBOX,
            "bounded": "1",
        })

    for params in queries:
        data = _nominatim_request(params, user_agent)
        if not data:
            continue
        try:
            lat = float(data[0]["lat"])
            lon = float(data[0]["lon"])
        except (KeyError, ValueError, TypeError):
            continue
        if not _in_mazowieckie(lat, lon):
            # The query had a Mazowieckie hint but the chosen result drifted
            # outside the bbox (this can happen with `state=` if Nominatim
            # treats it as a soft preference). Reject and try next strategy.
            continue
        return lat, lon

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
    parser.add_argument("--contact", default=None,
                        help=f"Contact (email or URL) for the Nominatim User-Agent. "
                             f"Overrides the {CONTACT_ENV_VAR} env var.")
    args = parser.parse_args()

    user_agent = resolve_user_agent(args.contact)

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
        coords = geocode_address(school["miejscowosc"], school["ulica_nr"], user_agent)
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
