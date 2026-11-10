# How the cause checks work and how well they do

A blackout's status starts at `Checking` and moves to `Explained` or `Cause unknown`.
`Cause unknown` is the signal that matters, so these checks exist to make it mean
something: most large outages have an ordinary cause, and finding it is what leaves the
real mysteries standing out.

## The unexplained blackout alert

A blackout with no known cause sends a separate high-priority alert, once, if 50,000
customers go out within 30 minutes, or if it reaches 150,000 at any speed. It fires as soon
as the blackout is 10 minutes old, or the moment it meets the bar if that's later, and only
while at least 25,000 are still out, so one bad reading from a feed can't trigger it. It also waits for the count to
move, for up to an hour, as described under [Feed quality](#feed-quality). If a cause turns
up later, a follow-up stands the alert down. On ntfy it arrives at high priority with its own tag, and
in a browser it stays on screen until dismissed. Set the jump at `/settings`, and the
any-speed level follows at three times it; 0 turns it off. It's judged per metro, so an attack
spread thinly across many metros won't trigger it.

GridAlert covers the 50 states and DC. San Juan was dropped on 2026-11-02: its grid fails on
its own so often that at 50,000 customers it sent about half of all unexplained alerts, and
still 2 a year at a level of 250,000 set just for it. Results below that were measured on the
labeled alerts before then include its 4, and say so.

### Why speed, and not size or percentage

50,000 on its own was borrowed from DOE's reporting line, which says nothing about attacks.
The EAGLE-I replay shows speed separates causes far better than either size or share of the
metro. Storms took a median 5.6 hours to reach 90% of their peak, equipment failures 1 hour, and
unexplained blackouts 15 minutes. An attack by someone opening breakers should look like the
second two: Ukraine's 2015 attack hit three utilities within 30 minutes.

Percentage fared worst. A rule of 5% of a metro would send 162 alerts a year, and 10% still 58, because small metros get there easily, while a 164,933-customer blackout in Los
Angeles was only 3.3% of its metro. EAGLE-I's county customer counts also have errors.

Replayed through the production rule, 2024 and 2025:

| | Old rule, 50,000+ | Jump of 50,000 in 30 minutes, or 150,000+ |
|---|---|---|
| Alerts a year | 17 | 11 |
| Storms the checks missed, of 12 | 12 | 4 |
| Equipment failures, of 4 | 4 | 4 |
| Unknown, of 3 | 3 | 3 |
| Operator-ordered cuts, of 3 | 3 | 1 |
| False or distorted readings, of 12 | 12 | 10 |

The wait for the count to move then stops 5 of those 10 false readings, warns on 2 more, and
loses none of the 12 real alerts, for about 8 or 9 a year. The
gust rule would take off a little more.

- **What it costs:** two operator cuts no longer send the high-priority alert, because they were
  staged over hours, so a slow attack under 150,000 would only show on the site.
- **False readings still look sudden.** That's why the wait for the count to move stays.
- **Smaller attacks are missed either way.** Tacoma in 2022 was under 20,000 customers, and Moore
  County in 2022 was about 45,000 and outside the 196 metros.
- **Tuned on what it was tested on.** There's no holdout, and no US cyberattack to test against,
  so these figures are optimistic. Review them with live data.
- **A failed feed can't fake a jump.** The count history holds while an area's data is incomplete,
  so a feed coming back doesn't read as customers going out.
- **Simultaneous alerts don't change.** Three unrelated areas at once happens about once in two
  years with or without a speed test. Two areas happens about 6 times a year even when both are
  sudden, and those look like coincidence.
- **Small cities:** a route for a quarter of a metro going out at once would add about 4.5 alerts
  a year. It was left out because the aim is large-scale attacks.

GridAlert does not estimate how likely an attack is. No public US blackout is confirmed
as a cyberattack, so there is nothing to calibrate a probability against.

## The simultaneous outage alert

Three or more unrelated areas, each reaching 10,000 customers, that all start within 30
minutes with nothing ordinary found in any of them send a high-priority alert. This is the
pattern of the 2015 Ukraine attack, where three utilities went down within 30 minutes. It
catches what the single-area alert can't: three areas of 15,000 customers each fire this
but not the 50,000 level.

- **Unrelated** means different areas with different lead utilities, so one operator's
  trouble counts once.
- **Nothing ordinary** is stricter here than for `Explained`: even a Wind Advisory or a
  severe geomagnetic storm rules an area out, since a windy front can start several at once.
- **Stand-down:** if explanations leave too few areas, it sends one follow-up. Later
  starters inside the window join the group without a new alert.
- **Shared vendors:** if every area reaches GridAlert through Kubra or ODIN, the alert says
  so, because a fault at that vendor would look the same. It still fires.
- **Latency:** about 10 minutes after the last of the areas starts, since each has to settle.
- **Stuck counts:** an area joins only once its count has moved, or after an hour.
- **Already-open alerts:** a sudden jump of 10,000+ customers inside an open blackout counts
  as a fresh start. Without this, a metro that happened to have an ordinary alert open
  couldn't take part, which is about 1 metro in 15 at any moment.

Both levels are at `/settings`, and setting the area count to 0 turns it off.

Blackouts below the alert level aren't tracked, so an attack spread thinly enough to stay
under 10,000 customers everywhere won't trigger this.

## Calibration against EAGLE-I

`scripts/backtest-eaglei.ts` replays EAGLE-I, the federal record of outages by county every
15 minutes, for 2024 and 2025 through the real alert engine and cause checks, with weather
history from the same days. Evidence is limited to what was known when each alert would
have fired. EAGLE-I also covers Duke and the other gaps in `docs/COVERAGE.md`, so this
describes a slightly fuller view than production has.

| | 2024 | 2025 |
|---|---|---|
| Ordinary outages at 10,000 people, shown on the site but not sent | 11.0 a day | 10.6 a day |
| Blackouts of 50,000+ customers | 113 | 81 |
| Already explained by a warning, so no alert | 97 | 63 |
| Unexplained alerts at 50,000 on size alone | 16 (1.3 a month) | 18 (1.5 a month) |
| **Unexplained alerts as built**, before the wait for the count to move | **8** (0.7 a month) | **14** (1.2 a month) |
| **Simultaneous alerts sent** | **1** | **1** |
| Of those, stood down by a storm | 1 | 0 |

**Unexplained alert.** As built it sends 11 a year before the wait for the count to move,
and about 8 or 9 after it. San Juan, dropped on 2026-11-02, would have added 34 more over
the two years at 50,000, and 4 even at a level of 250,000 set just for it. The cost of
dropping it is that nothing in Puerto Rico is watched, so an attack there would go unseen.

Size alone, applied to every metro, for comparison:

| Level, customers | Alerts a year |
|---|---|
| 50,000 | 17 |
| 75,000 | 8.5 |
| 100,000 | 6 |
| 150,000 | 2.5 |
| 250,000 | 0 |

The list includes the real thing: San Francisco on 2025-12-20 (a substation fire, dated by
the replay to 1:15 pm Pacific, five minutes after it began). Some entries are probably
EAGLE-I glitches, such as two near-identical Chicago readings of about 102,000 that last a
single sample.

**Simultaneous alert.** The levels hold up. Alerts sent over the two years:

| Customers per area | 2 areas | 3 areas | 4 areas |
|---|---|---|---|
| 5,000 | 503 | 64 | 7 |
| 7,500 | 128 | 10 | 2 |
| **10,000** | 57 | **2** | 0 |
| 15,000 | 13 | 1 | 0 |
| 25,000 | 5 | 0 | 0 |

Lowering either level costs far more false alarms than it buys. EAGLE-I has no utility
names, so "unrelated" here means different metros only. One of the two alerts pairs
Riverside and Los Angeles, which share a utility, so production would probably have
dropped it.

**How much would it miss?** Synthetic attacks at 2,000 random moments in each year, on
population-weighted metros:

| Metros hit | Caught, as built | If only strong evidence ruled an area out |
|---|---|---|
| 3 | 69 to 77% | 93 to 94% |
| 4 | 90 to 94% | 99% |
| 5 | 97 to 98% | 100% |

The strict rule costs about 1 three-metro attack in 5, because mild weather in any one of
them rules it out. It stays because the looser rule would send about 10 alerts a year
instead of 1, and because the miss is narrower than it looks: at 50,000+ customers per
metro the unexplained alert catches each one anyway, whatever the weather elsewhere.

`node scripts/backtest-simultaneous.ts` replays GridAlert's own archive the same way, and
will become the better test as the archive grows, since it includes utility names.

## What really caused the alerts

The replay's unexplained alerts were researched one by one through utility statements, local
news, regulator filings and DOE reports, with each alert's raw EAGLE-I curve alongside. The
labels and sources are in `data/unexplained-alerts.json`, which is the test set for any new
check. San Juan's 4, all equipment failures, left with it, leaving 34.

| What happened | Alerts | Rose to peak within 60 min |
|---|---|---|
| Weather the checks didn't count as enough | 12 | 1 |
| No public record at all, probably false readings | 9 | 8 |
| Equipment failure or accident | 4 | 3 |
| Deliberate power cuts by a utility or grid operator | 3 | 1 |
| Real outage, but a bad feed distorted the count | 3 | 3 |
| Real outage with no clear public cause | 3 | 3 |
| Physical or cyberattack | 0 | |

- **Weather:** all 9 alerts with a Wind Advisory and nothing stronger turned out to be real
  storms. Nine of the 12 weather alerts have a measured gust of 46 to 61 mph in the area.
  The next section tests that as a rule.
- **No public record:** four are NIPSCO readings in Northwest Indiana, two with identical
  county figures a week apart. None of the 9 has a DOE report, against 15 of the 29 real
  outages, but outages under an hour don't need one. Silence is evidence, not proof, and
  these may be faults in EAGLE-I's own collection that production wouldn't see.
- **Deliberate cuts:** San Diego's shutoff was announced in advance, and MISO declared its
  emergency 28 minutes before New Orleans lost power. Stockton's cut was unannounced.
- **Bad feeds:** Rhode Island Energy said its own map was unreliable on 2025-07-04, and the
  50,359 it showed matches the flat 50,361 in the data. Riverside's 99,256 includes only
  about 17,000 reported customers, from a locomotive hitting equipment.
- **No clear cause:** Los Angeles on 2025-11-08 is the clearest case. More than 100,000
  LADWP customers lost power for about 2 hours and no cause was found publicly. Chattanooga
  on 2025-06-13 may be covered by EPB's maintenance explanation. Seattle on 2024-09-11
  rests on one risk-alert snippet, so it may be a false reading.
- **Statements are slow:** 25 of the 38 had a publicly stated cause, usually 2 to 6 hours
  after the start, and many of those times are upper limits. The alert fires at 10 minutes,
  so a statement can only stand it down.
- **Speed of rise:** only 1 of 12 weather alerts reached its peak within an hour, against 20
  of the 38 overall. It isn't safe as a filter, because San Francisco and both of Puerto
  Rico's island-wide failures took over 2 hours in this data.

The research hit a search limit near the end, and the Miami Herald, Commercial Appeal and
Leaf-Chronicle couldn't be searched, which limits the Miami, Memphis and Clarksville labels.

## Measured wind gusts

A Wind Advisory alone adds too many chance matches to explain a blackout, yet all 9 alerts
with one were real storms. `scripts/backtest-gusts.ts` tests whether a measured gust makes
it safe to count, using Iowa State's record of 996 airport stations in metro counties for
2024 and 2025. The chance figure is the share of 40,000 random metros and hours that a rule
would newly explain, on top of the 2.2% the storm checks already match.

| Rule | Storm alerts stopped before sending, of 12 | Explained by the end | Added by chance |
|---|---|---|---|
| Wind Advisory alone | 9 | 9 | 1.8% |
| A gust of 45+ mph anywhere in the metro | 8 | 11 | 1.3% |
| Wind Advisory and 45+ mph anywhere in the metro | 8 | 9 | 0.4% |
| **The same, ignoring the 67 windiest stations** | **8** | **9** | **0.3%** |

The live rule is the last one: a Wind Advisory in an affected county, and a 45+ mph reading
at a station anywhere in the metro, from 3 hours before the start to 2 hours after the
latest peak. A gust with no Wind Advisory is shown as context. The script also replays
everything through the production code and station list, which gives the same result.

- **Effect:** the 38 alerts over two years fall to 30, about 15 a year, and one more stands
  down later. The calibration tables above are from before this rule. The simultaneous
  alert doesn't change, since a Wind Advisory already rules an area out there.
- **A station has to really be there.** Iowa State files each station under its nearest
  county, which put oil platforms in the Gulf in New Orleans, Houston and Lafayette, up to 345
  km out. A gust at sea plus a Wind Advisory on land would have explained a real blackout. A
  station must now fall inside its metro's county shapes, within 5 km for simplified borders,
  and within 140 km of the middle of the metro's other stations, since a Wind Advisory says
  little in a county the size of San Bernardino's. The live feed's coordinates decide that:
  the archive's T89 is Castroville, but the live KT89 is at Lajitas, 430 km away. This took
  out 23 stations and changed none of the results here.
- **Windy stations:** coincidences lean on stations that are windy all the time. Sandberg
  is in the mountains of Los Angeles County, and that metro matched 6.1% of random hours
  until stations with over 40 days of 45+ mph were ignored, then 1.5%. Each metro has only
  about 200 samples, so treat those two as rough. Picking the stations from one year and
  scoring the other kept every storm, at 0.2 to 0.4%.
- **Peak wind:** the remark at the end of a report matters. Using only the main gust field
  explains 7 storms rather than 9, because a peak often falls between reports.
- **Live feed:** aviationweather.gov serves these reports without a key, and its raw text
  carries the peak-wind remark. It silently stops at 400 reports, newest first, and allows
  about 100 requests a minute, so stations are requested 25 at a time. A first read can take
  several seconds, so this check gets 25 seconds where the others get 10. If any request
  fails the check counts as not run for that poll, and the next one covers the same 6 hours.
- **DOE reports:** the rule without the station filter, by county, adds 6 of the 22 storm
  reports the warnings missed, and matches none of the 21 non-weather reports.
- **Still missed:** Detroit on 2024-01-12 and Seattle on 2024-06-03 had gusts of 53 and 49
  mph but no Wind Advisory. New York's heat wave had no wind to find.
- **A weak test:** none of the 22 non-weather alerts had a Wind Advisory, so that they all
  pass shows little. The chance figure is what protects against explaining away an attack.
- **Coverage:** `data/wind-stations.json` holds 913 stations across 188 of the 196 metros.
  The rule can't act in the other 8, so a blackout there stays `Cause unknown`, which is
  the safe direction. In places like Buffalo and Amarillo the only airport is too windy to
  count. Connecticut's stations were added
  after the backtest, so their metros weren't part of it.

## Feed quality

A bad reading looks exactly like a sudden blackout, and 12 of the 38 alerts above were
false or distorted. Speed of rise can't separate them, but the numbers can. A live count
ticks as outages come and go, while most of these sat on one number: Providence showed
exactly 21,067, 15,691 and 10,623 in its three counties for nearly four hours, on the day
Rhode Island Energy said its map was unreliable. Northwest Indiana read 66,462 and 34,199
one Saturday night and the same two figures a week later.

### Waiting for the count to move

Both high-priority alerts wait until the count has moved since reaching their level. After
an hour they go out anyway, saying the count hasn't moved and may be false. The ordinary
alert never waits, so nothing is hidden. `scripts/backtest-feed-quality.ts` replays EAGLE-I
through the production code:

| | Alerts | At once, or one sample later | Later | At the hour, with a warning | Never sent |
|---|---|---|---|---|---|
| False or distorted readings | 12 | 2 | 3 | 2 | **5** |
| Real, from the 38 | 26 | 24 | 1 | 1 | **0** |
| Real, explained by storms | 161 | 159 | 1 | 1 | 0 |

- **Effect:** the alerts over two years fall from 38 to 33, or from 30 to 25 with the gust
  rule, about 12 a year. Two simultaneous alerts of the three would not have been sent,
  because Knoxville read 10,910 twice and then 0, and Los Angeles read 35,712 twice and then
  95. Those two weren't researched, so calling them false rests on the curves alone.
- **Cost:** one sample here is 15 minutes, which overstates the delay. On GridAlert's own
  polls the count moved within 10 minutes in 46 of 93 rises of 1,000+ customers, within 15
  in 62 and within 30 in 70. The alert already waits 10 minutes, so most would lose 0 to 5
  minutes. A single fault can leave a count flat much longer, and those rises were small.
  Smaller blackouts stick more often: of 2,075 areas reaching 10,000 customers, 77% could
  join a simultaneous group within one sample and 88% within an hour, and 7% vanished first.
- **What moving means:** any county holding 10% of the area changes by more than 0.05%, up
  or down. Exactly equal would be too strict: Bakersfield went from 79,327 to 79,326 and
  Memphis from 73,352 to 73,343, and neither has any public record. Those two depend on that
  figure, and it was set on these same alerts. Real alerts did no worse at 0.05% than at
  exact equality.
- **Flipping:** a fall to under 20% of the reading doesn't count as moving, because a
  failing feed flips between a number and zero. That catches 66,462, 0, 66,462.
- **Why an hour:** attackers who wipe systems might freeze the count too, so a stuck number
  can't hold an alert back for long. Two hours would also stop Omaha, at the cost of an hour
  more delay in exactly that case.
- **Wrongly warned:** San Diego's announced shutoff of 2024-12-09 climbed in slow steps and
  reached the hour unmoved, so it would carry the warning.
- **Still sent:** five of the 12 keep moving and still go out. Miami on 2025-05-19 and
  Clarksville on 2025-05-28 move the way a real sudden outage does, Asheville and Riverside
  have a real outage underneath, and Chicago on 2024-09-01 stepped down about 2% once.
- **Limits:** EAGLE-I's 15-minute samples hide anything shorter, and these faults may
  partly belong to EAGLE-I's own collection. Only Providence is a confirmed utility fault.
  Nothing this large has happened on GridAlert's own feeds since this was added.

### Frozen feeds

A feed that fails is noticed at once. One that answers normally while repeating itself is
harder, and it matters: the attackers in Ukraine in 2015 also wiped systems, and a real
blackout behind a frozen map would look like nothing at all. A feed now shows as `Frozen` on
`/coverage` when:

- **Its own clock stops for 2 hours.** 95 of the 228 feeds publish one, covering 53% of
  monitored customers. On a live check they ran up to 25 minutes behind, apart from
  Brownsville PUB at 275, which has since caught up, so it may flag now and then.
- **Or its reading stays identical for 12 hours** with 100+ customers out, counting every
  area it lists. Nothing is safe to conclude from a quiet total alone: Seattle City Light's
  sat unchanged for over 6 hours on a normal day, and a day's longest at 100+ out was 5.5
  hours. The 12 hours are about twice that, from one day of data.

A frozen feed counts as not live, so it lowers coverage and can trigger the low-coverage
notice. If it carries 10% or more of an area, an open alert there can't resolve. One frozen
feed sends no alert, because a small feed can stall for ordinary reasons. A feed reading zero
with no clock can't be judged, and ODIN has no clock.

### Several large feeds stopping together

Three or more feeds serving 100,000+ customers that stop updating at once send a
high-priority alert, because a real blackout could be hidden behind them and attackers who
wipe systems could cause exactly this. A feed counts once its clock has stopped for 45
minutes or it has stopped answering for 45 minutes. That's far sooner than the 2 hours for
one feed, since several stopping together is much less likely by chance. If every feed
reaches GridAlert through Kubra, the alert says a fault there is possible, and it stays open
until fewer than two are stuck, so it can't flap.

These limits are cautious guesses from a few hours of live clocks, which ran up to 25
minutes behind. Feeds with no clock of their own count only if they stop answering. It hasn't
fired on anything real, so the 30-day review should check how often it does.

## Grid operator notices

For blackouts of 10,000+ customers, GridAlert reads the public notices of the grid operator
serving the lead utilities. `data/operators.json` maps each utility to its operator by state,
using EIA-861: 356 utilities serving 86 million of the 150.6 million customers in major
metros. Elsewhere, and in ERCOT's part of Texas, no notice is read and the check isn't
claimed. A blackout's notices are read on every poll, and an hourly job reads all six so a feed
that stops answering shows in the logs before it's needed.

| Operator | Where it's read | Notes |
|---|---|---|
| MISO | Public JSON behind its notifications page | Names regions. Keeps 30 days |
| PJM | Emergency Procedures postings page | Names zones |
| Southwest Power Pool | Headline status on its grid conditions page | No times, so it counts from the poll that sees it |
| California ISO | The JSON behind its emergency notifications page | Empty while the grid is normal |
| New York ISO | Daily real-time events CSV | |
| ISO New England | Yearly power system status page | Its CSV download refuses server requests |

ERCOT is missing because its grid status comes from an API that refuses server requests,
which isn't worked around here.

- **A cut explains a blackout:** a notice saying the operator ordered power off, in the
  blackout's own region. That means PJM's `Load Shed Directive` or `Manual Load Dump Action`,
  ISO New England's OP-7, wording about shed load or rotating outages, or a MISO EEA 3 notice
  that says load is being shed. A cut says who turned the power off, not why, and the
  stand-down says so, because an attack that took out generation could force a real one.
- **An emergency is context:** EEA levels, Max Gen Events, transmission emergencies and OP-4
  actions appear under "Also noted" and explain nothing. Unlike a Wind Advisory, an
  emergency doesn't keep an area out of a simultaneous alert, since an attack could cause one.
- **Everything else is ignored:** MISO alone posted 40 real-time notices in 30 days, mostly
  load pocket and capacity advisories.
- **Failures:** if an operator can't be read, the check isn't claimed for that blackout.

**What the test shows.** Real notices went through the production readers: 156 MISO notices
from the 2024 and 2025 captures on the Internet Archive and today's feed, and ISO New
England's full 2024 and 2025 record. MISO gave 1 emergency, a Max Gen Step 1b on 2025-06-23.
ISO New England gave 10 rows from 4 events. Neither gave a cut. None of the emergencies
overlapped any of the 38 alerts, so **this check changes none of the alert counts above.**

**Limits.**

- **The 3 deliberate cuts:** none is proven to be caught. MISO's feed doesn't reach back to
  New Orleans on 2025-05-25, and that was a transmission emergency, so it may never have been
  posted there. San Diego's shutoff came from the utility, so operator notices can't see it.
  No operator notice was found for Stockton.
- **Wording:** no operator's cut notice has been seen, so the rules rest on PJM's published
  list of message types and on descriptions of the rest. If a real order is worded
  differently, the blackout stays `Cause unknown`, the safe direction.
- **Unseen formats:** PJM rows and California events have only been seen empty, so those
  two readers are built from the page's columns and script, and are untested on a live row.
- **MISO's steps:** Hoosier Energy reports that MISO cut Max Gen from five steps to three, so
  step numbers aren't relied on. Its wording in 2026 is `Maximum Generation Event Step 1 (EEA 1)`.
- **SPP:** the headline status has to be in force at a poll to count.

## Statements and news

Blackouts of 10,000+ customers collect a timeline of what's being said, from an hour before
the start until 24 hours after the end. It's shown on the Blackouts tab. **Nothing on it changes a
blackout's cause status.**

| Source | What it gives | Why this one |
|---|---|---|
| GDELT's 15-minute file | Stories tagged as power outages, with a headline and places | Free for any use with a citation, no key and no rate limit |
| CISA news and alerts | Statements that mention the grid. The FBI's feed refuses requests from cloud servers, so it's left out | Official and quiet: CISA had no grid match in recent months |

Left out: Google News and Bing limit their feeds to personal, non-commercial use, Reddit and
Bluesky refuse server requests, and GDELT's search API rate-limited 2 of 3 careful requests,
which is why the bulk file is used. Department of Energy's feed is stale.

The files are read from GDELT's public storage bucket, not `data.gdeltproject.org`. That
address sits behind a CDN that caches a 404 for an hour, and files go up about 12 minutes
before their named time, so one early request from anyone can hide a file that exists.

A story counts when its headline is about a power cut and either GDELT places it within 50 km
of an affected county, or the headline names the area with a place in the same state, or it
names the utility. GDELT's places can be wrong: it once put Greenacres, Florida in Delaware.

`scripts/backtest-news.ts` read the files around all 38 alerts and two real attacks:

| Alerts with data | Alerts | Any news in 12 hours | Within 6 hours |
|---|---|---|---|
| Real outages | 27 | 23 | 18 |
| Suspected false readings | 9 | 0 | 0 |

- **Timing:** the first story came at a median of 4.3 hours, so news can't stop an alert. It
  arrives after the fact, to confirm or question one.
- **Silence:** an unknown blackout with no coverage after 12 hours says so on the page. The
  0 of 9 is partly circular, because those 9 were labelled by finding no reports. The honest
  evidence is the real outages: 4 of 27 had no coverage, so silence is unusual, not proof.
  These counts include San Juan's 4 alerts, from before it was dropped, and one of its 4 is
  among those with no coverage.
- **Chance:** 7,056 windows of 12 hours in other metros held any outage story 7.6% of the time.
- **Gaps:** GDELT has no data around Stockton and New York in June 2025, so they're left out.

### Reports of a deliberate cause

A headline with words like `intentional`, `vandalism`, `sabotage`, `attacked`, `criminal` or
`cyberattack` is marked on the timeline. It sends a high-priority alert, unconfirmed and with
the status unchanged, once one of these reports it: a federal agency naming the area, an outlet
with editors (`TRUSTED_OUTLETS` in `lib/causes/news.ts`), or two different outlets. A lone
unknown site can't, because anyone can publish a headline. An agency speaking later still gets
its own alert, even if a news report has already sent one.

| Test | Result |
|---|---|
| Moore County, NC, 2022, gunfire at two substations | Flagged 6.3 hours in, alert at 7.3 hours |
| Tacoma, WA, 2022, three substations vandalized | Flagged 7.5 hours in, alert at 7.8 hours |
| The 38 alerts, none an attack | No flags |
| 7,056 windows in other metros | No flags |

- **Only two real cases,** both physical. No US cyberattack has blacked out customers, so the
  wording has never been tested on one.
- **Fitted by hand:** the wording was adjusted after reading these headlines, so the zero is
  optimistic. Foreign wars are left out by naming Ukraine, Gaza, Israel and Lebanon, but not
  Russia, Iran or China, since a real attack here might name them.
- **Waiting for a second source costs time:** 1 hour on Moore County and 18 minutes on Tacoma,
  against what a single headline would have done. Copies of one headline count once, but a
  shutoff described as `intentional` by two outlets could still trigger it. It didn't in this
  test.
- **Not built:** a `Deliberate` status, or a statement changing a cause. Headlines can't show
  who is speaking, and a wrong status would do more harm than a missing one.

## Do the locations line up?

Every check here depends on places matching across sources that name them differently. A
mismatch raises no error, so each link was tested against something independent, in November
2026. `lib/locations.test.ts` keeps the data files honest from here on.

| Link | Tested against | Result |
|---|---|---|
| Feed rows to county | ODIN's own county codes for the same utilities | 98.9% of customers agree (4,299 of 4,345) |
| Feed rows to county | EIA's list of every county each utility serves | 95.5% of rows inside it. Of the customers outside, nearly all are gaps in EIA's list |
| Customers per county | County population | Only vacation counties stand out, such as Cape May, which has more meters than residents |
| NWS warnings | County list | All 500 alerts carry county codes, and all 110 distinct codes parsed are real |
| SPC storm reports | County list | 99.1% of 3,215 reports resolve. The rest are over water or malformed |
| NIFC wildfires | County list | All 73 are real counties in the right state |
| News places | 14 sampled matches read by hand | All plausible |
| Feed to utility | Feed names against EIA names | No wrong pairing |

- **Not tested live:** the grid operators' region rules. No operator has posted a cut notice yet.
- **Utility names rarely match headlines.** Feeds are named like `Pacific Gas & Electric`, where
  headlines say `PG&E`, so news matches by place. Short names would add stories from elsewhere
  on the same utility's system, so they were left out.
- **No wind stations** in Buffalo, Harrisburg, Waterbury, Canton, Lubbock, Lincoln, Roanoke
  or Amarillo, which are too windy or off the live feed. The
  gust check isn't claimed there, so a windy day can send an unexplained alert.

## Stated causes and % explained

Most feeds report causes for their whole system, so each row is now read with its county, and
only rows in the blackout's counties count. Before this, a utility in several metros could
blame an outage in Los Angeles on one in Kern County. A multi-metro feed that can't say where
an outage is doesn't count, and a one-metro feed can only mean that metro. Kubra's come from the
map around the blackout.

**% explained** on the Blackouts tab is how much of a blackout has a known cause. Something
outside the utility, like a storm warning, a wildfire or an operator's order, counts for 100%.
A utility counts only for the customers it names, out of the most ever out. Each named cause
stays at the most customers it reached, so it stays known after that outage is fixed. Labels
such as `Analyzing Problem` name nothing, and context like a Wind Advisory alone doesn't count.

## Keeping watch on GridAlert itself

Everything above fails silently if GridAlert stops, so two things watch it.

- **Dead-man's switch:** every 15 minutes a finished poll pushes back a message scheduled on
  ntfy's own servers. If polling stops for any reason, including a Vercel outage, ntfy sends
  "GridAlert has stopped" by itself about 40 minutes after the last check-in, and a message
  follows when polling returns. A poll that dies partway doesn't check in, so a crash counts.
  It needs the webhook to be ntfy, and it doesn't cover ntfy itself failing.
- **Hourly check:** `/api/cron/probes` (`lib/probes.ts`) reads every outside service whether or
  not anything is wrong, since most only run during a blackout. Results are on `/coverage`. It
  can't see an empty Claude credit balance, only a bad key. If it stops running, a poll says so.

ntfy is the only working alert channel today: browser alerts are built but nobody has
subscribed, and email is off. If ntfy fails, alerts stop.

### When something outside breaks

A broken source must never look the same as a quiet day. Every reader checks that a document
is the one it knows, so a redesign or a maintenance page fails rather than reading as nothing
found. `ShapeError` marks those apart from a site being down, since they need a code fix.

| What broke | What happens |
|---|---|
| Storm warnings can't be read for 3 polls | High-priority notice |
| A blackout has waited 30 minutes for storm warnings | It alerts anyway, saying a storm isn't ruled out. About one false alert per 5 days of NWS outage |
| Blackout checks fail for 3 polls | High-priority notice, because high-priority alerts can't fire. Outages still show on the site |
| 60% of a platform's large feeds read exactly 0 or fail for 3 polls | High-priority notice. The most seen on a calm day was 33%. Clears under 40% |
| 3+ large feeds stop together | High-priority notice |
| Alert can't be sent | A high-priority one retries for 24 hours, a follow-up or notice for 30 minutes, then a notice says what was dropped |
| ODIN can't be read for 3 polls | Normal notice, and areas that depend on it count as incomplete |
| A document changes shape for 2 hourly checks | One normal notice, and another when it's fixed |
| The hourly check stops running for 3 hours | Normal notice |
| Any other check unreadable for 6 hours | Daily digest |
| A feed of 250,000+ customers down or frozen for 6 hours | Daily digest |
| A feed reads 0 while ODIN shows 100+ out for 3 polls | Daily digest |
| A feed stays at exactly 0 too long | Daily digest, after 24 hours at 1M+ customers, 72 hours at 250,000+ or 7 days at 100,000+ |

The digest goes out once a day at 12:00 UTC and stays silent if nothing has changed, with one
line a week to show it's alive. Feeds under 100,000 customers stay on `/coverage`.
`/api/health` returns 503 for anything in the first group, as well as if polling stops.

### When a feed fails during a blackout

- **The last trusted count stays.** Failed feeds lower a count without anyone being restored,
  so only complete data can bring an alert's count down, and a high-priority alert can't be
  cancelled by the feed dying with the power.
- **It doesn't wait for the count to move.** A blind area sends its high-priority alert without
  the hour's hold, since a dead feed can't move, and says the data stopped.
- **After 12 hours with no complete reading** an alert closes as `Closed with no reading`, so a
  dead feed can't hold one open and hide the next outage. It never says restored.
- **A new jump past the alert level reopens an explained blackout,** so an old storm can't hide
  a new blackout in the same place. Checks then look from the jump onward.

## Internet reachability, tested

When power fails, local networks go dark too, independently of any utility map. IODA, at
Georgia Tech, measures this every 10 minutes and is live within about 10 minutes, but only by
state: its county data is empty. `scripts/backtest-internet.ts` looked for a dip in reachable
network blocks in the hour after each alert started.

| | Clear dip, 4+ times normal noise |
|---|---|
| Real alerts | 4 of 22 |
| Suspected false readings | 1 of 9 |
| Random quiet hours | 7 of 293, or 2.4% |

Most outages are too small for their state. Los Angeles's 165,000 customers barely register
against California's 127,000 blocks. It's far better than hourly demand, but not good enough
for every alert. It only looks useful when a blackout is large for its state, about 9+
customers per reachable block:

| Blackout | What it really was | Customers per block | Dip |
|---|---|---|---|
| Anchorage, 2024-08-13 | Real, sudden | 41 | 13.1 |
| New Orleans, 2025-05-25 | Real, sudden | 11 | 6.4 |
| Providence, 2025-07-04 | Stale map, no new outage | 15 | None |
| Omaha, 2025-10-21 | Suspected false reading | 10 | None |

All four went the right way, and an attack large enough to matter would qualify in most
states. But four cases prove little, and it can't run alone: random hours held several huge
dips with nothing behind them, so it could only confirm or question a blackout already found.
It isn't in the service. IODA's terms for its data couldn't be found, so they need checking before any use.

## Grid demand, tested and left out

The idea was to confirm a blackout from something utilities don't publish: if the lights
really went out, regional demand should fall. EIA's hourly grid data covers most of the
country for free, so `scripts/backtest-demand.ts` tested it against 2024 and 2025, using the
most local demand series for each area. **It isn't used, because it doesn't work.**

| Test | Result |
|---|---|
| Real alerts with a clear drop, 3+ times normal noise | 3 of 20 |
| Random quiet hours with the same drop | 8.8% |
| Sustained falls of 15%+ across all large series | 338 a year |
| Sustained falls of 30%+ | 40 a year |
| Hurricane Milton, about 2 million customers | 5% fall |
| Hurricane Beryl, about 2.3 million customers | 25% fall |

- **Alert-sized blackouts don't show.** 130,000 customers is about 200 MW in a region of
  thousands, inside normal hourly swings. Weather moves demand far more than an outage does.
- **The large falls aren't blackouts.** The deepest are data errors: FPL jumps to 32,218 MW
  for one hour, Nevada reads 0. A fall of 30% happens about 40 times a year with nothing behind
  it, so a real one can't be told apart.
- **Real disasters barely register.** Milton's 5% is smaller than 10,000 false falls a year.
- **Five-minute data didn't save it.** California's public 5-minute demand shows no step for
  San Francisco on 2025-12-20: normal steps that day ran up to 211 MW at the 95th percentile.
  That's the whole state, and a request for finer areas failed, so that remains untested.

### Who said what

Headlines can't show who is speaking, and they rarely name a real cause: for the 7 equipment
or accident alerts with news, none named the specific cause. So after a blackout sends an
unexplained or deliberate alert, Claude reads up to 8 of its new stories, up to 6 times per
blackout, and records who said what about the cause. It runs after alerts have gone out and
is off without `ANTHROPIC_API_KEY`.

- **Fixed form:** speaker, type of speaker, cause, one sentence and a quote. Article text is
  treated as untrusted and is never stored.
- **Quote check:** code rejects any quote not found word for word in its article.
- **Display only:** statements appear on the Blackouts tab and can't change a cause.

`scripts/backtest-statements.ts` ran this on every alert with stories still online, plus the
two attacks, for $1.10. That's 23 of 40 events, about 5 cents a read: the rest had no stories
or none that could still be fetched.

| Test | Result |
|---|---|
| Real attacks called deliberate by police or the utility | 2 of 2 |
| Other events called deliberate by anyone | 0 of 21 |
| Alerts with a known cause, stated correctly by a named source | 11 of 22 |
| Stated, but not matching the final cause | 1 of 22 |
| No named source stated a cause | 10 of 22 |
| Quotes rejected, requests refused | 0, 0 |

- **The one miss was the source's:** Chugach Electric's spokesperson guessed at load shedding
  in Anchorage before the real fault was known, and the reader recorded that fairly. Early
  statements can be wrong, which is a reason to show who said it rather than treat it as fact.
- **Cases that matter:** it found the substation fire in San Francisco, the failed line in
  Puerto Rico, MISO's order in New Orleans, SDG&E's shutoff and the train in San Bernardino.
  Those are 5 of the 8 non-storm alerts it could read. This test ran before San Juan was
  dropped, so its alerts are in these counts.
- **Quiet on speculation:** a local activist blaming God in Moore County was kept as `public`,
  and "reporter" and "public" statements never count as a named source.
- **Limits:** two attacks is a small test, and neither was a cyberattack. The quote check
  never fired, so it's untested on a real invented quote. Articles from 2022 to 2025 may
  differ from what was online in the first hours, so the live result could be worse.

## What is checked

Checks run on every poll while a blackout is open, and for three hours after it closes
because storm reports lag the storm. A check that fails is never reported as ruled out.

| Check | Source | Explains a blackout when |
|---|---|---|
| Storm warnings | National Weather Service alerts, by county | A listed severe product was in force in an affected county, from 3 hours before the start to 2 hours after the latest peak |
| Storm reports | NOAA Storm Prediction Center | Tornado or damaging wind reported in an affected county in the same window |
| Wind gusts | Airport stations, from NOAA's Aviation Weather Center | A 45+ mph gust anywhere in the metro during a Wind Advisory in an affected county, in the same window |
| Wildfires | National Interagency Fire Center | Fire of 1,000+ acres in an affected county, found in the last 7 days |
| Earthquakes | US Geological Survey | Magnitude 5+ within 100 km, 6+ within 300 km, 7+ within 600 km |
| Space weather | NOAA Space Weather Prediction Center | Never. A Kp 8+ storm is noted as context only |
| Grid operators | Notices from six regional operators, for blackouts of 10,000+ customers | The operator says it ordered power cut in that region. An emergency is context only |
| Utility maps | Kubra incident tiles and 21 feeds with a cause field | One named cause covers at least half the customers listed, and the map covers at least 30% of the blackout |

An affected county holds at least 10% of an area's customers out, so a stray outage in a
far county can't let a storm there explain the blackout. "Pending" and crew-status labels
count as no information. On a blackout of 50,000+ customers, equipment, accident, wildlife
and tree labels are shown but don't explain it, because those labels are often filled in
automatically and an operator might not see past them in an attack.

The rules are in `lib/causes/rules.ts`.

## Backtest

`scripts/backtest-causes.ts` replays every DOE-417 report of 50,000+ customers from 2019
to 2025 through the production matching code, using warnings from Iowa State's archive and
historical storm reports. It covers warnings and storm reports only. Wildfires,
earthquakes and utility maps have no usable archive, so they can only add to these numbers.

| Reports with a county named | Reports | Matched |
|---|---|---|
| DOE said weather | 113 | 79% |
| DOE said something else | 22 | 14% |

Two of those three "something else" matches were real storms where the filer left the
cause open, including Hurricane Helene at Tallahassee. The third is Harris County, Texas
on 2022-10-25, which DOE lists as system operations with damaging wind reported nearby.

The other 456 reports name only a state. They are in the script's output but aren't a fair
test, because a whole state nearly always has a warning somewhere: non-weather reports
matched 50% of the time on that basis. Production always matches by county.

**Control.** 250 random metro county groups at random hours from the same years, where a
match can only be coincidence: **2% matched** (5 of 250). This is the number that estimates
how often a real attack would be wrongly marked `Explained`, and with 250 samples it could
be off by a point or two either way.

## Choices the backtest made

- **Calling a cause unknown after 10 minutes.** At the start of an outage 72% of storm
  reports already had a warning, and the figure was still 72% at 30 minutes, reaching 75%
  at 60. So a longer wait only delays the alert. The 10 minutes mainly rules out glitches.
- **Looking across the whole climb.** A storm can arrive hours after a small first rise, as
  in Houston on 2024-05-28, so the window runs to the latest peak, not just the start. In
  the EAGLE-I replay this cut unexplained alerts from about 5 a month to about 3.
- **Window of 3 hours before and 2 hours after.** Widening from 1 hour to 2 caught 6 more
  points of storms with no extra non-weather matches up to 6 hours. DOE times are rough,
  so production, which dates a start to about 5 minutes, may need less.
- **Wind Advisory stays as context.** Counting it would match 86% of storms instead of
  79%, but would double chance matches to 4%. That trades a few extra unknowns a year for
  half the risk of explaining away a real attack, so it stays out.

## Limits

- Only 135 reports name a county and 22 of those aren't weather, so these percentages are
  rough.
- DOE start times are approximate and assumed to be local.
- Nothing here has been tested on a real cyberattack. The checks find blackouts nothing
  explains; they can't say why.
- A storm and an attack can coincide. Evidence of a storm marks a blackout `Explained`
  even if something else also happened.
- Duke, Avangrid and other gaps in `docs/COVERAGE.md` aren't seen at all.

## Rerunning

The path from a poll to a delivered alert is tested end to end in `lib/run.test.ts`, which
runs real polls against fake storage and feeds.

```bash
node scripts/backtest-causes.ts   # about 10 minutes the first time; downloads are cached in .cache/
node scripts/check-causes.ts      # run the checks on live state without writing anything
```
