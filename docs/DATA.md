# Data sources and rebuilding the registry

GridAlert's list of metros and utilities comes from federal data, so it can be
rebuilt each year rather than maintained by hand.

| Input | Used for | URL |
|---|---|---|
| Census CBSA delineation (`list1_2023.xlsx`) | Metro definitions | https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx |
| Census population (`cbsa-est2025-alldata.csv`) | Metro and county population | https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/metro/totals/cbsa-est2025-alldata.csv |
| EIA-861 (`f8612025.zip`, unzip to `eia/`) | Utilities, customers, service counties | https://www.eia.gov/electricity/data/eia861/zip/f8612025.zip |
| Census county subdivisions | Town to county | https://www2.census.gov/geo/docs/reference/codes2020/national_cousub2020.txt |
| Census places by county | City to county | https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt |
| Census ZCTA to county | ZIP to county | https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt |
| DOE-417 annual summaries (one file per year, named `2024.xlsx` or `2023.xls`) | Cause backtest only | https://doe417.pnnl.gov/summaries/2024_Annual_Summary.xlsx |
| EAGLE-I outages, CC BY 4.0, about 1.4 GB a year | Alert calibration only | https://doi.org/10.6084/m9.figshare.24237376 |
| GDELT 15-minute files, free with a citation, read live and not stored | News timeline and its backtest | https://storage.googleapis.com/data.gdeltproject.org/gdeltv2/lastupdate.txt |
| EIA-930 six-month files, about 290 MB with no key | Demand backtest only, kept in `.cache/backtest` | https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/ |
| Iowa State airport weather archive, about 680 MB for 1,012 stations | Wind station list and gust backtest, kept in `.cache/backtest` | https://mesonet.agron.iastate.edu/request/download.phtml |

Download these into one directory, then:

```bash
export FEDERAL_DIR=/path/to/downloads
python3 -m venv .venv && .venv/bin/pip install openpyxl
.venv/bin/python scripts/build_registry.py
python3 scripts/build_geo.py
python3 scripts/build_local_geo.py
node scripts/build_map.mjs
node scripts/build_centroids.mjs
node scripts/merge-sources.ts
```

To refresh the cause backtest's data, install `xlrd` and run
`python3 scripts/build_doe417.py <folder of DOE summaries>`.

To refresh which grid operator serves each utility, run
`python3 scripts/build_operators.py eia/Sales_Ult_Cust_2025.xlsx`. It's the one EIA-861 table
that gives a balancing authority per utility and state. The operators' own notices are read
live, so nothing is stored.

A feed can only place customers in the metros EIA says its utility serves. Where EIA's
territory data misses a corner, the feed's entry lists it in `alsoMetros`. A utility missing
from EIA sets `metros` and `customers` itself.

`data/territories.json` lists every county each feed's utility serves, metro or not, which is
what tells two same-named counties apart in a feed with no state. It comes from EIA-861's
service territory table: `python3 scripts/build_territories.py eia/Service_Territory_2025.xlsx`.
EIA's list has gaps, so it settles a name but never rules a county out.

Connecticut's planning regions replaced its counties in 2022. Metros here use the new codes,
while NWS, SPC, NIFC and the town and ZIP tables use the old ones. Feed rows therefore land on
old codes and match storms directly. `withOldCodes` in `lib/geo.ts` covers a blackout with no
county detail, which falls back on the metro's new codes.

`lib/locations.test.ts` checks that all of these files agree, since a broken link between them
would raise no error: an alert would just go to the wrong place or quietly fail to match.

Reading stories for statements needs `ANTHROPIC_API_KEY` in the environment. Without it that
step is skipped and everything else runs as normal.

To refresh the wind stations, run `node scripts/build_wind_stations.ts`. It writes
`data/wind-stations.json`, leaving out stations that are windy all the time and any the
live feed doesn't carry.

EAGLE-I isn't needed to run the site. The 2024 and 2025 files live in `datasets/eaglei/`,
which is left out of git and of Vercel uploads. Add other years there as
`eaglei_outages_<year>.csv`, then run `node scripts/backtest-eaglei.ts <years>`.

## Known data quirks

- **Texas delivery companies** (Oncor, CenterPoint, AEP Texas, TNMP) appear only in
  EIA's `Delivery_Companies` file, not `Sales_Ult_Cust`.
- **Connecticut** uses planning regions in Census metro files but legacy counties in
  EIA data and most feeds. `build_registry.py` holds a best-fit map between them.
- **Puerto Rico** was dropped on 2026-11-02, leaving the 50 states and DC. San Juan's grid
  fails on its own so often that its outages drowned out everywhere else's. `build_registry.py`
  and `build_geo.py` leave it out, and LUMA's feed is gone.
- **Independent cities** (Virginia, Baltimore, St. Louis) share names with counties.
  A bare name goes to the more populous place.
- **New York boroughs** are aliased to their counties in `build_geo.py`.
- **EAGLE-I** yearly files differ: 2024 has an extra column and is sorted by county. Its
  collection also drops out, so a national dip or an area reading zero for a while gets
  bridged in the replay. Otherwise each return looks like outages starting everywhere at
  once. It covers about 231 and 171 such national gaps in 2024 and 2025.
- **DOE-417 reports** are rough. Eleven August 2023 reports have no start date and can't
  be tested. Customer counts can be filler (50,000,000 in Meade County, South Dakota) or
  look like customers at risk rather than customers lost. A cause of "Unknown" can mean
  the filer left it open: one such report falls on the night Hurricane Helene hit
  Tallahassee.
