#!/usr/bin/env python3
"""Build data/geo.json: county name lookup and county -> metro map.

Uses the county names shipped with us-atlas plus data/metros.json. Connecticut
needs both vintages because feeds and us-atlas use legacy counties while Census
metro definitions use planning regions.
"""
import json, os, re, unicodedata

ROOT = os.path.join(os.path.dirname(__file__), "..")
metros = json.load(open(f"{ROOT}/data/metros.json"))
atlas = json.load(open(f"{ROOT}/node_modules/us-atlas/counties-10m.json"))

ST = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY"}

# Legacy Connecticut county -> the metro most of it now falls in.
CT_LEGACY = {"09001":"14860","09003":"25540","09005":"45860","09007":"25540","09009":"35300","09011":"35980","09013":"25540","09015":"49340"}

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("saint ", "st ").replace("st. ", "st ").replace("ste. ", "ste ").replace("sainte ", "ste ")
    s = re.sub(r"\b(county|parish|borough|census area|municipality|city and borough|planning region)\b", "", s)
    return re.sub(r"[^a-z]", "", s)

population = {c["fips"]: c.get("population", 0) for m in metros for c in m["counties"]}

index, names = {}, {}
# The city is larger, but feeds here publish "Richmond City" and "Richmond" as separate rows,
# so the plain name is the county.
COUNTY_OVER_CITY = {"VA|richmond": "51159", "VA|roanoke": "51161"}

def claim(key, fips):
    """Give a name to the most populous place using it (Fairfax -> the county)."""
    if key in COUNTY_OVER_CITY:
        index[key] = COUNTY_OVER_CITY[key]
        return
    current = index.get(key)
    if current is None or population.get(fips, 0) > population.get(current, 0):
        index[key] = fips

for g in atlas["objects"]["counties"]["geometries"]:
    fips, name = g["id"], g["properties"]["name"]
    st = ST.get(fips[:2])
    if not st:
        continue
    names[fips] = name
    claim(f"{st}|{norm(name)}", fips)

metro_of = {}
for m in metros:
    for c in m["counties"]:
        metro_of[c["fips"]] = m["cbsa"]
        st, name = c["state"], c["name"]
        names[c["fips"]] = re.sub(r" (County|Parish|Planning Region)$", "", name)
        claim(f"{st}|{norm(name)}", c["fips"])
        if name.lower().endswith(" city"):
            claim(f"{st}|{norm(re.sub(r' city$', '', name, flags=re.I))}", c["fips"])

# Feeds name New York's boroughs, not their counties.
index.update({"NY|manhattan": "36061", "NY|brooklyn": "36047", "NY|statenisland": "36085", "NY|rockawaypeninsula": "36081"})

known = {m["cbsa"] for m in metros}
for fips, cbsa in CT_LEGACY.items():
    if cbsa in known:
        metro_of[fips] = cbsa

json.dump({"index": index, "names": names, "metroOf": metro_of}, open(f"{ROOT}/data/geo.json", "w"), separators=(",", ":"))
print("index", len(index), "names", len(names), "metroOf", len(metro_of), "bytes", os.path.getsize(f"{ROOT}/data/geo.json"))
