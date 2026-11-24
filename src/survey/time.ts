/**
 * Wall-clock arithmetic in one IANA time zone.
 *
 * The daily check-in must fire at 21:00 *local* every day, including the two
 * days a year when "local" stops being UTC-5. So every computation starts from
 * the calendar date in the zone and converts that date's wall clock back to an
 * instant, rather than adding 24 hours to the previous instant.
 */

export const SURVEY_TIME_ZONE = "America/New_York";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall clock of `date` as read in `timeZone`. */
export function zonedParts(date: Date, timeZone = SURVEY_TIME_ZONE): ZonedParts {
  const fields: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== "literal") fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `YYYY-MM-DD` for the calendar date `date` falls on in `timeZone`. */
export function isoDateInZone(date: Date, timeZone = SURVEY_TIME_ZONE): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The instant at which the wall clock reads `hour:minute` on the given local
 * date.
 *
 * The zone offset is not known until the instant is known, so this starts from
 * a UTC guess and corrects it until the round trip agrees. Two iterations are
 * enough for every real zone, including one inside a DST transition day.
 */
export function localTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = SURVEY_TIME_ZONE,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = target;
  for (let i = 0; i < 4; i += 1) {
    const p = zonedParts(new Date(instant), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const drift = target - asUtc;
    if (drift === 0) break;
    instant += drift;
  }
  return new Date(instant);
}

/** Adds calendar days to a `YYYY-MM-DD` date without involving any zone. */
export function addIsoDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export interface DailyScheduleOptions {
  /** IANA zone the wall clock belongs to. */
  timeZone?: string;
  /** Local hour, 0-23. */
  hour?: number;
  /** Local minute, 0-59. */
  minute?: number;
}

/**
 * The next instant strictly after `now` at which the local clock reads
 * `hour:minute`.
 *
 * Strictly after, so a timer that fires a few milliseconds early does not
 * immediately schedule itself again for the same second, and a run at exactly
 * 21:00:00.000 targets tomorrow.
 */
export function nextRun(now: Date, options: DailyScheduleOptions = {}): Date {
  const timeZone = options.timeZone ?? SURVEY_TIME_ZONE;
  const hour = options.hour ?? 21;
  const minute = options.minute ?? 0;

  const today = isoDateInZone(now, timeZone);
  let date = today;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [y, m, d] = date.split("-").map(Number);
    const candidate = localTimeToInstant(y, m, d, hour, minute, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate;
    date = addIsoDays(date, 1);
  }
  // Unreachable for any real zone: tomorrow's 21:00 is always in the future.
  throw new Error(`nextRun could not find a future ${hour}:${minute} in ${timeZone}`);
}

/** Parses `HH:MM` from configuration. Throws on anything else. */
export function parseAt(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`SURVEY_AT must be HH:MM (got ${JSON.stringify(value)})`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`SURVEY_AT must be a valid time of day (got ${JSON.stringify(value)})`);
  }
  return { hour, minute };
}
