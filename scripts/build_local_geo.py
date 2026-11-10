#!/usr/bin/env python3
"""Build data/local-geo.json: town and ZIP lookups for feeds with no county level.

Inputs in $FEDERAL_DIR (URLs in docs/DATA.md):
  national_cousub2020.txt              towns, townships and other minor divisions
  national_place_by_county2020.txt     cities, villages and boroughs
  tab20_zcta520_county20_natl.txt      ZIP code tabulation areas by county

Town keys must match normalizeTown in lib/local-geo.ts.
"""
import csv, json, os, re, unicodedata
from collections import defaultdict

FED = os.environ["FEDERAL_DIR"]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "local-geo.json")

SUFFIX = re.compile(r"\s+(charter township|charter twp|township|twp|town|city|village|borough|boro|cdp|municipality|plantation|gore|grant|location|\(balance\)|metropolitan government|consolidated government|unified government)$")
PREFIX = re.compile(r"^(town|city|village|borough|boro|township|twp) of\s+")

def norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower().strip()
    s = re.sub(r"\(.*?\)", "", s).strip()
    s = PREFIX.sub("", s)
    for _ in range(2):
        s = SUFFIX.sub("", s).strip()
    s = re.sub(r"\bsaint\b", "st", s)
    s = re.sub(r"\bmt\b\.?", "mount", s)
    s = re.sub(r"\bft\b\.?", "fort", s)
    s = re.sub(r"\bst\.", "st", s)
    return re.sub(r"[^a-z]", "", s)

towns = defaultdict(list)

def add(state, fips, name):
    key = norm(name)
    if key and fips not in towns[f"{state}|{key}"]:
        towns[f"{state}|{key}"].append(fips)

with open(f"{FED}/national_cousub2020.txt", encoding="utf-8") as f:
    for r in csv.DictReader(f, delimiter="|"):
        # Census county divisions and unorganized areas aren't places anyone names.
        if r["CLASSFP"].startswith("Z") or "unorganized" in r["COUSUBNAME"].lower():
            continue
        add(r["STATE"], r["STATEFP"] + r["COUNTYFP"], r["COUSUBNAME"])

with open(f"{FED}/national_place_by_county2020.txt", encoding="utf-8") as f:
    for r in csv.DictReader(f, delimiter="|"):
        add(r["STATE"], r["STATEFP"] + r["COUNTYFP"], r["PLACENAME"])

# A ZIP can span counties; assign it to the one holding most of its land.
best = {}
with open(f"{FED}/tab20_zcta520_county20_natl.txt", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f, delimiter="|"):
        zcta = r["GEOID_ZCTA5_20"]
        if not zcta:
            continue
        land = int(r["AREALAND_PART"] or 0)
        if zcta not in best or land > best[zcta][0]:
            best[zcta] = (land, r["GEOID_COUNTY_20"])

out = {
    "towns": {k: (v[0] if len(v) == 1 else v) for k, v in towns.items()},
    "zips": {z: v[1] for z, v in best.items()},
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print("towns", len(out["towns"]), "zips", len(out["zips"]), "bytes", os.path.getsize(OUT))
