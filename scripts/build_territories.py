#!/usr/bin/env python3
"""Build data/territories.json: every county each feed's utility serves, metro or not.

Feeds often name a county with no state. A name found in two of a utility's states can only be
placed by knowing which one it serves, and metro counties alone can't say.

usage: python3 scripts/build_territories.py eia/Service_Territory_2025.xlsx
"""
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RELS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

SUFFIX = re.compile(r"\b(county|parish|borough|census area|municipality|city and borough|planning region|co\.)\b")


def norm(name):
    """Must stay in step with normalizeCounty() in lib/geo.ts."""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"\bsaint\b", "st", s)
    s = re.sub(r"\bsainte\b", "ste", s)
    s = re.sub(r"\bst\.", "st", s)
    s = re.sub(r"\bste\.", "ste", s)
    return re.sub(r"[^a-z]", "", SUFFIX.sub("", s))


def sheet_rows(path, name):
    """Rows of one sheet, read straight from the file so this needs nothing installed."""
    with zipfile.ZipFile(path) as z:
        strings = ["".join(t.text or "" for t in si.iter(f"{NS}t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
        rid = next(s.get(RELS) for s in ET.fromstring(z.read("xl/workbook.xml")).iter(f"{NS}sheet") if s.get("name") == name)
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in rels if r.get("Id") == rid).lstrip("/").removeprefix("xl/")
        with z.open(f"xl/{target}") as f:
            for _, row in ET.iterparse(f):
                if row.tag != f"{NS}row":
                    continue
                cells = {}
                for c in row:
                    value = c.find(f"{NS}v")
                    if value is None:
                        continue
                    column = ord(c.get("r")[0]) - ord("A")
                    cells[column] = strings[int(value.text)] if c.get("t") == "s" else value.text
                row.clear()
                yield [cells.get(i) for i in range(max(cells, default=-1) + 1)]


index = json.load(open("data/geo.json"))["index"]
wanted = {i for s in json.load(open("data/sources.json")) for i in s.get("eiaIds", [])}

out = {}
missed = {}
for i, row in enumerate(sheet_rows(sys.argv[1], "Counties_States")):
    if i < 1 or len(row) < 6 or not row[1] or not str(row[1]).isdigit() or int(row[1]) not in wanted:
        continue
    uid, state, county = int(row[1]), row[4], row[5]
    # EIA writes "Staunton City" where the county list has just "Staunton".
    fips = index.get(f"{state}|{norm(county)}") or index.get(f"{state}|{norm(re.sub(r' city$', '', county, flags=re.I))}")
    if fips:
        out.setdefault(uid, set()).add(fips)
    else:
        missed[f"{state}|{county}"] = missed.get(f"{state}|{county}", 0) + 1

json.dump({str(k): sorted(v) for k, v in sorted(out.items())}, open("data/territories.json", "w"), separators=(",", ":"))
print(f"{len(out)} of {len(wanted)} utilities, {sum(len(v) for v in out.values())} county rows; unmatched names: {dict(list(missed.items())[:20])}")
