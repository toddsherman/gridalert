import type { CountReading } from '../types.ts';

/** NWS products that can explain a large outage on their own. */
export const EXPLAINING_EVENTS: ReadonlySet<string> = new Set([
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Extreme Wind Warning',
  'High Wind Warning',
  'Hurricane Warning',
  'Tropical Storm Warning',
  'Storm Surge Warning',
  'Ice Storm Warning',
  'Winter Storm Warning',
  'Blizzard Warning',
]);

/**
 * Products worth showing, but too common or too mild to settle the cause. Wind
 * Advisory is the close call: counting it alone caught more storms in the backtest, but
 * doubled chance matches, which is how a real attack would get explained away. With a
 * measured gust behind it, it does settle the cause.
 */
export const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  'Wind Advisory',
  'Flash Flood Warning',
  'Flood Warning',
  'Winter Weather Advisory',
  'Lake Effect Snow Warning',
  'Extreme Heat Warning',
  'Excessive Heat Warning',
  'Extreme Cold Warning',
  'Red Flag Warning',
  'Dust Storm Warning',
  'Tornado Watch',
  'Severe Thunderstorm Watch',
  'Hurricane Watch',
  'Tropical Storm Watch',
  'High Wind Watch',
  'Winter Storm Watch',
]);

const HOUR = 3_600_000;

/**
 * A storm warning counts if in force from this long before the start until this
 * long after. Set from the DOE backtest, where wider windows caught more storms and
 * no more non-weather reports (docs/CAUSE_CHECKS.md).
 */
export const WEATHER_BEFORE_MS = 3 * HOUR;
export const WEATHER_AFTER_MS = 2 * HOUR;
/** A measured gust this strong backs up a Wind Advisory (docs/CAUSE_CHECKS.md). */
export const WIND_GUST_MPH = 45;
/** Wildfires discovered longer ago than this are background, not a trigger. */
export const FIRE_MAX_AGE_MS = 7 * 24 * HOUR;
export const FIRE_MIN_ACRES = 1_000;
/** How long before and after the start a severe geomagnetic storm is worth noting. */
export const SPACE_BEFORE_MS = 6 * HOUR;
export const SPACE_AFTER_MS = 3 * HOUR;
/** Kp 8 is a G4 storm, the level grid operators start to worry about. */
export const SEVERE_KP = 8;

/**
 * How old a blackout must be before "nothing found" counts. It is short because in the
 * DOE backtest no more storms had a warning at 30 minutes than at the start, so waiting
 * longer only delays the alert. It mainly stops a one-poll feed glitch from counting.
 */
export const SETTLE_MS = 10 * 60_000;
/**
 * How long a blackout waits for storm warnings that can't be read. A failure at NWS would
 * otherwise silence high-priority alerts for as long as it lasted. Costs about one false
 * alert per 5 days of NWS outage, and each says weather couldn't be checked.
 */
export const STORM_WAIT_MS = 30 * 60_000;
/** A check only counts as done if it read its source this recently. */
export const CHECK_FRESH_MS = 30 * 60_000;
/** Storm reports lag the storm, so a closed blackout stays checkable for a while. */
export const RECHECK_AFTER_CLOSE_MS = 3 * HOUR;

/** The 2015 Ukraine attack hit three utilities within 30 minutes of each other. */
export const SIMULTANEOUS_WINDOW_MS = HOUR / 2;

/** A jump this size inside an open blackout counts as a fresh start. The alert level is 4,000. */
export const SURGE_CUSTOMERS = 4_000;

/** DOE's reporting line for loss of service, used as the bar for a large blackout. */
export const LARGE_CUSTOMERS = 50_000;

/**
 * How quickly customers have to go for it to count as a jump. A storm builds for hours, while
 * failures and anyone opening breakers take them out at once (docs/CAUSE_CHECKS.md).
 */
export const JUMP_WINDOW_MS = HOUR / 2;
/** A blackout this many times the level alerts at any speed, as cover for an attack staged over hours. */
const ANY_SPEED_FACTOR = 3;

/**
 * The level a blackout has reached for the high-priority alert, or 0 if it hasn't: a jump of the
 * level within the window, or several times the level however slowly it came. A level of 0 is off.
 */
export function alertBar(b: { peakCustomers: number; jumpCustomers?: number }, level: number): number {
  if (level <= 0) return 0;
  if ((b.jumpCustomers ?? 0) >= level) return level;
  const anySpeed = level * ANY_SPEED_FACTOR;
  return b.peakCustomers >= anySpeed ? anySpeed : 0;
}

/** A county needs this share of an area's customers out to count as affected. */
export const MIN_COUNTY_SHARE = 0.1;

/**
 * A live count ticks as outages come and go, while most false readings sit on one number
 * (docs/CAUSE_CHECKS.md). It has to move by more than this share to count as moving.
 */
export const READING_MOVE_SHARE = 0.0005;
/** A fall this steep isn't movement. A flipping feed does it and returns to the same number. */
export const READING_DROP_SHARE = 0.2;
/** How long a count that isn't moving can hold back a high-priority alert. */
export const READING_HOLD_MS = HOUR;

/** Whether any major part of an area has moved from an earlier reading. */
export function readingMoved(from: Record<string, number>, to: Record<string, number>, total: number): boolean {
  return Object.entries(to).some(([part, now]) => {
    const was = from[part] ?? 0;
    return now >= total * MIN_COUNTY_SHARE && now >= was * READING_DROP_SHARE && Math.abs(now - was) > was * READING_MOVE_SHARE;
  });
}

/** Whether a count has sat on one reading ever since it reached this level. */
export const readingSteady = (reading: CountReading | undefined, level: number): reading is CountReading => !!reading && reading.before < level;

/** Whether a high-priority alert at this level should wait for the count to move. */
export function heldBack(reading: CountReading | undefined, level: number, now: number): boolean {
  return readingSteady(reading, level) && now - Date.parse(reading.at) < READING_HOLD_MS;
}

/** Distance within which a quake of this size could plausibly trip local equipment. */
export function quakeReachKm(magnitude: number): number {
  if (magnitude >= 7) return 600;
  if (magnitude >= 6) return 300;
  if (magnitude >= 5) return 100;
  return 0;
}
