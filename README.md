# GridAlert

Monitors power outages across every metro of 250,000 people or more in the 50 states and DC. Its purpose is
to flag, quickly and with few false alarms, a large blackout with no ordinary explanation,
which is what a major cyberattack on the grid would look like at first. It does not claim
to detect attacks: it records when each blackout started and whether anything explains
it. Live at https://www.todd.sh/gridalert

The app builds with `/gridalert` as its base path (`lib/site.ts`), so every path in this README
sits under it. todd.sh's own Next config proxies `/gridalert` to this Vercel project, as it does
for its other apps. Old links to the Vercel host's root redirect into the base path.

## How it works

Every 5 minutes, Vercel Cron calls `/gridalert/api/cron/collect`, which:

1. Polls every utility feed in `data/sources.json`, plus DOE's ODIN feed.
2. Maps each reading to a county, then to a metro.
3. Runs the alert engine.
4. Updates the blackout list and checks open blackouts for an ordinary cause.
5. Sends notifications and writes state to a private Vercel Blob store.

| Path | Purpose |
|---|---|
| `lib/sources/` | Feed adapters: `kubra`, `kubra-legacy`, `arcgis`, `json`, `regex`, ODIN |
| `lib/collector.ts` | Turns raw readings into a snapshot and alert candidates |
| `lib/alerts/engine.ts` | The alert state machine. Pure, and fully unit tested |
| `lib/alerts/notify.ts` | The owner's delivery: webhook (Slack, Discord, ntfy), email |
| `lib/alerts/push.ts` | The public's browser alerts, from the sign-up on the home page |
| `lib/blackouts.ts` | The blackout list: one record per alert, with its cause status |
| `lib/simultaneous.ts` | Spots unrelated blackouts that began together |
| `lib/causes/` | Ordinary-cause checks: `feeds.ts` reads them, `assess.ts` matches them, `rules.ts` holds the rules |
| `lib/run.ts` | One poll, end to end |
| `data/sources/*.json` | Feed configs by region, merged into `data/sources.json` |

## How alerts decide

Estimated people = customers out × 2.5. An alert covers one metro, or one utility when
its feed has no county detail and it serves several metros.

- **Opens** after 2 polls over the level, or at once at 5 times the level.
- **Logs again** each time the outage doubles.
- **Resolves** after 6 polls under half the level.
- **Isn't sent.** About 12 outages a day reach the level, so these only appear on the site and
  in the alert history. Only the high-priority alerts below, their follow-ups and notices
  about GridAlert itself are sent.
- **Never reports restored on blind data.** If feeds for 10% or more of an area's customers are
  failing, a low number isn't trusted, so the alert stays open. After 12 hours with no complete
  reading it closes as unknown, so a dead feed can't hide the next outage.

Change all of this at `/settings`. To see how noisy a level would be before you set it,
replay real history:

```bash
node scripts/backtest.ts 10000 25000 50000 100000
```

## How blackouts are recorded

Every alert also becomes a blackout record, dated from the first poll showing the
rise rather than from when the alert fired. Each one is checked for storm warnings, storm
reports, measured wind gusts, wildfires, earthquakes, grid operator notices and what utility maps say, and shows as
`Checking`, `Cause unknown` or `Explained`, along with what was ruled out. Blackouts of
10,000+ customers also collect what's being said in the news and by federal agencies.
Notifications carry the same finding. Speculation never changes a status, and no probability of attack is
given.

A jump of 50,000+ customers within 30 minutes with no known cause, or 150,000+ at any speed, sends a separate high-priority alert
about 10 minutes after it starts, once its count has moved, a follow-up if a cause turns up, and another when it ends. So do three or more unrelated areas of
10,000+ customers that start within 30 minutes with nothing ordinary found in any of them.
Both levels are at `/settings`.

The site is one page: a sign-up for browser alerts, the alerts of the last two days when there
are any, and how it works. Anyone can sign up, with no account, and on iPhone once the site is on the Home Screen.
Subscribers get the high-priority alerts and their follow-ups and nothing else; GridAlert's
notices about itself go only to the owner's channels. Each alert links to the page, where every
area links a search of the latest posts on X and Threads for a person to read. GridAlert doesn't
read either.

`docs/CAUSE_CHECKS.md` has the rules and how they tested against seven years of DOE reports.

## Storage

State lives in Vercel Blob rather than a database because polling every 5 minutes would
keep a free Neon database awake around the clock, past its monthly compute allowance.
Each poll also keeps a small sample under `archive/`, which is what the backtest reads.

## Common tasks

```bash
npm test                                          # run tests
node scripts/verify-sources.ts data/sources/west.json   # run feeds through the real adapters
node scripts/merge-sources.ts                     # rebuild data/sources.json and coverage reports
node scripts/run-once.ts                          # one real poll against production storage
node scripts/check-causes.ts                      # run cause checks on live state, writing nothing
node scripts/backtest-causes.ts                   # test the checks against DOE history
node scripts/backtest-simultaneous.ts             # see how often areas coincide by chance
node scripts/backtest-eaglei.ts 2024 2025         # calibrate alerts against federal outage history
node scripts/backtest-feed-quality.ts             # test the wait for a moving count against the same history
node scripts/check-operators.ts                   # read every grid operator's notices now, writing nothing
node scripts/backtest-news.ts                     # test the news matching against the same alerts
node scripts/backtest-demand.ts                   # why grid demand isn't used as a check
node scripts/backtest-internet.ts                 # test internet reachability against the same alerts
node scripts/backtest-statements.ts               # test who-said-what reading, which spends API credits
node scripts/backtest-reports.ts                  # test the news backstop for metros no feed can see
node scripts/backfill-blackouts.ts --write        # add records for alerts the list missed
zsh scripts/deploy.sh                             # types, lint and tests, then deploy, then check the live site
node scripts/smoke.ts                             # check the live site on its own
```

**Adding a utility:** add an entry to the right file in `data/sources/`, run the verifier
until it prints `ok`, run the merge, then deploy. `docs/COVERAGE.md` lists what's missing.

**If a feed breaks:** `/coverage` shows each feed's status. A failed feed keeps its last value
for 30 minutes, then falls back to ODIN if that utility reports there. Its error is in
`state/latest.json` and the Vercel logs.

**If an outside site changes:** a reader fails rather than reporting nothing, and after two
hourly checks GridAlert sends a notice. Fix the reader, then refresh its sample with
`node scripts/save-fixtures.ts` and run `npm test`, which tests every reader on those samples.

## Monitoring GridAlert itself

Point an uptime monitor at `/api/health`, which returns 503 if no poll has landed in 15
minutes, or if something stands between a blackout and a high-priority alert. GridAlert also
sends an alert if under 60% of customers have a live feed. `/api/cron/probes` reads every
outside service hourly, and `/coverage` shows the results. `docs/CAUSE_CHECKS.md` lists what
happens when each one breaks.

On the 1st of each month, at noon or 1pm Eastern, the poll runs a drill (`lib/drill.ts`). It puts
a made-up blackout through the real alert rules, then sends the owner the result through the real
outbox at a real alert's priority, titled "Drill passed" or "Drill FAILED". Nothing is stored or
shown as an outage, and browser subscribers never get it. A month with no drill message means
delivery is broken.

## Security

- **Feeds are untrusted.** Responses stop at 16 MB, however they're compressed. A count can't
  exceed 1.25 times the utility's registered customers, a feed can't place customers in a
  metro it doesn't serve, and on a large blackout a utility map can't settle the cause alone.
  Two small co-ops, Rutherford EMC and United Cooperative Services, have no HTTPS, so these
  limits are what bound them.
- **News is untrusted.** Links must be public web addresses, every redirect is checked, and
  Claude's quotes are checked against the article. That shows the article said it, not that
  it's true, so the page marks them as reported and unconfirmed.
- **Sign-ups** take only push endpoints at the browsers' own push services, one per browser,
  up to 10,000, stored privately. Dead ones are dropped when an alert finds them gone.
- **Secrets** stay in environment variables and out of responses. Pages show fixed wording
  rather than raw feed errors. `/settings` needs `ADMIN_TOKEN`, and sessions last 90 days,
  enforced on the server.

Two limits are set outside the code. Set a monthly spend limit on the Anthropic key, and add a
Vercel Firewall rate limit if traffic ever becomes a problem.

## Environment

| Variable | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | State storage, set by the Blob integration |
| `CRON_SECRET` | Authorizes the collector route |
| `NTFY_TOKEN` | Optional. An access token from a free ntfy account. Without one ntfy counts its limits by sender address, which Vercel shares, and can refuse GridAlert |
| `ADMIN_TOKEN` | Signs in to `/settings` |
| `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Browser push |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | Optional email alerts |

Source data and rebuild steps are in `docs/DATA.md`.

## License

The code is under the [MIT License](LICENSE). The outage data belongs to the utilities and agencies that publish it; `docs/DATA.md` lists each source.
