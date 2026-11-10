#!/usr/bin/env python3
"""Join Census metro definitions/population with EIA-861 service territories.

Inputs (not committed; see docs/DATA.md for download URLs):
  $FEDERAL_DIR/list1.xlsx                        Census CBSA delineation (2023)
  $FEDERAL_DIR/cbsa-est2025-alldata.csv          Census population estimates
  $FEDERAL_DIR/eia/Service_Territory_2025.xlsx   EIA-861 utility -> county
  $FEDERAL_DIR/eia/Sales_Ult_Cust_2025.xlsx      EIA-861 customers per utility

Outputs:
  data/metros.json     every metro >= MIN_POP in the 50 states and DC, with its counties and utilities
  data/utilities.json  every distribution utility in those metros
"""
import csv, json, os, re, sys, unicodedata
from collections import defaultdict
import openpyxl

FED = os.environ["FEDERAL_DIR"]
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
MIN_POP = int(os.environ.get("MIN_POP", 250_000))

# The 50 states and DC. Puerto Rico was dropped on 2026-11-02: San Juan's grid fails on its own
# so often that its outages drowned out everywhere else's.
STATE = {"Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","District of Columbia":"DC","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY"}

# Census moved Connecticut to planning regions in 2022; EIA-861 still reports the
# legacy counties. Regions and counties do not align exactly, so this is a
# best-fit map used only to attach utilities to CT metros.
CT_REGION_TO_COUNTIES = {
    "Capitol": ["hartford", "tolland"], "Greater Bridgeport": ["fairfield"],
    "Lower Connecticut River Valley": ["middlesex"], "Naugatuck Valley": ["newhaven", "litchfield"],
    "Northeastern Connecticut": ["windham"], "Northwest Hills": ["litchfield"],
    "South Central Connecticut": ["newhaven"], "Southeastern Connecticut": ["newlondon"],
    "Western Connecticut": ["fairfield"],
}

# Territory gaps found by review: EIA-861 omits these from the county list even
# though the utility serves the metro.
EXTRA_TERRITORY = {6452: ["12071"]}  # FPL -> Lee County, FL (Fort Myers)

def norm_county(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(county|parish|borough|census area|municipality|city and borough|planning region)\b", "", s)
    s = s.replace("saint ", "st ").replace("st. ", "st ").replace("ste. ", "ste ").replace("sainte ", "ste ")
    return re.sub(r"[^a-z]", "", s)

def rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    yield from wb[sheet or wb.sheetnames[0]].iter_rows(values_only=True)

# Metros
metros, county_to_cbsa = {}, {}
for i, r in enumerate(rows(f"{FED}/list1.xlsx")):
    if i < 3 or not r[0] or not r[9] or r[4] != "Metropolitan Statistical Area":
        continue
    fips = f"{r[9]}{r[10]}"
    st = STATE.get(r[8])
    if not st:
        continue
    m = metros.setdefault(r[0], {"cbsa": r[0], "name": r[3], "counties": []})
    m["counties"].append({"fips": fips, "name": r[7], "state": st})
    county_to_cbsa[fips] = r[0]

pop_cbsa, pop_county = {}, {}
with open(f"{FED}/cbsa-est2025-alldata.csv", encoding="latin-1") as f:
    for r in csv.DictReader(f):
        if r["LSAD"].strip() == "Metropolitan Statistical Area":
            pop_cbsa[r["CBSA"]] = int(r["POPESTIMATE2025"])
        if r["STCOU"].strip():
            pop_county[r["STCOU"].strip().zfill(5)] = int(r["POPESTIMATE2025"])

missing_pop = []
for m in metros.values():
    m["population"] = pop_cbsa.get(m["cbsa"], 0)
    if not m["population"]:
        missing_pop.append(m["name"])
    for c in m["counties"]:
        c["population"] = pop_county.get(c["fips"], 0)
print("metros w/o population:", len(missing_pop), missing_pop[:8], file=sys.stderr)

county_index = defaultdict(set)
for m in metros.values():
    for c in m["counties"]:
        county_index[(c["state"], norm_county(c["name"]))].add(c["fips"])
        if c["state"] == "CT":
            region = c["name"].replace(" Planning Region", "")
            for legacy in CT_REGION_TO_COUNTIES.get(region, []):
                county_index[("CT", legacy)].add(c["fips"])

# Customers per utility, split by state (Bundled + Delivery; Energy-only retail
# would double count delivery customers served by a competitive supplier).
customers, meta = defaultdict(lambda: defaultdict(int)), {}
hdr = None
for i, r in enumerate(rows(f"{FED}/eia/Sales_Ult_Cust_2025.xlsx", "States")):
    if i == 2:
        hdr = list(r)
        continue
    if i < 3 or not r[1]:
        continue
    uid, name, part, svc, st, own = r[1], r[2], r[3], r[4], r[6], r[7]
    if svc not in ("Bundled", "Delivery"):
        continue
    total = r[23] if isinstance(r[23], (int, float)) else 0
    customers[uid][st] += int(total)
    meta[uid] = {"name": name, "ownership": own}

# Texas TDUs and other wires-only companies report here, not in Sales_Ult_Cust.
for i, r in enumerate(rows(f"{FED}/eia/Delivery_Companies_2025.xlsx")):
    if i < 3 or not r[1] or not r[6]:
        continue
    uid, st = r[1], r[6]
    total = r[23] if isinstance(r[23], (int, float)) else 0
    customers[uid][st] = max(customers[uid][st], int(total))
    meta.setdefault(uid, {"name": r[2], "ownership": r[7]})

# Service territory
uc = defaultdict(set)
unmatched = defaultdict(int)
for i, r in enumerate(rows(f"{FED}/eia/Service_Territory_2025.xlsx", "Counties_States")):
    if i < 1 or not r[1]:
        continue
    uid, name, st, county = r[1], r[2], r[4], r[5]
    fipss = county_index.get((st, norm_county(county)))
    if not fipss:
        unmatched[st] += 1
        continue
    uc[uid] |= fipss
    meta.setdefault(uid, {"name": name, "ownership": "Unknown"})
for uid, extra in EXTRA_TERRITORY.items():
    uc[uid] |= set(extra)

major = {c: m for c, m in metros.items() if m["population"] >= MIN_POP}
major_counties = {c["fips"]: c for m in major.values() for c in m["counties"]}

utils = {}
for uid, fipss in uc.items():
    hit = fipss & major_counties.keys()
    if not hit:
        continue
    cust = sum(customers.get(uid, {}).values())
    utils[uid] = {
        "eiaId": uid,
        "name": meta[uid]["name"],
        "ownership": meta[uid]["ownership"],
        "states": sorted(customers.get(uid, {}).keys()) or sorted({major_counties[f]["state"] for f in hit}),
        "customers": cust,
        "metroCounties": sorted(hit),
    }

for m in major.values():
    fipss = {c["fips"] for c in m["counties"]}
    m["utilities"] = sorted(
        (u["eiaId"] for u in utils.values() if fipss & set(u["metroCounties"])),
        key=lambda x: -utils[x]["customers"],
    )

metro_list = sorted(major.values(), key=lambda m: -m["population"])
util_list = sorted(utils.values(), key=lambda u: -u["customers"])
for u in util_list:
    u["metros"] = [m["cbsa"] for m in metro_list if u["eiaId"] in m["utilities"]]

json.dump(metro_list, open(f"{OUT}/metros.json", "w"), indent=1)
json.dump(util_list, open(f"{OUT}/utilities.json", "w"), indent=1)

print(f"metros>={MIN_POP}: {len(metro_list)}  pop={sum(m['population'] for m in metro_list):,}")
print(f"utilities touching them: {len(util_list)}  customers={sum(u['customers'] for u in util_list):,}")
for t in (1_000_000, 500_000, 250_000, 100_000, 50_000, 25_000, 10_000):
    n = [u for u in util_list if u["customers"] >= t]
    print(f"  utilities >= {t:>9,} customers: {len(n):4d}  covering {sum(u['customers'] for u in n):,}")
print("unmatched county rows by state (top):", sorted(unmatched.items(), key=lambda x: -x[1])[:6])
