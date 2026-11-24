import assert from "node:assert/strict";
import test from "node:test";
import { DailyTimer } from "../src/survey/schedule.js";
import {
  addIsoDays,
  isoDateInZone,
  localTimeToInstant,
  nextRun,
  parseAt,
  zonedParts,
} from "../src/survey/time.js";

const TZ = "America/New_York";
const at2130 = (now: string, options = {}) =>
  nextRun(new Date(now), { timeZone: TZ, hour: 21, minute: 0, ...options });

test("before 21:00 the next run is tonight", () => {
  // 2026-11-23 08:00 EST
  const due = at2130("2026-11-23T13:00:00Z");
  assert.equal(due.toISOString(), "2026-11-24T02:00:00.000Z");
  assert.deepEqual(zonedParts(due, TZ), {
    year: 2026,
    month: 11,
    day: 23,
    hour: 21,
    minute: 0,
    second: 0,
  });
});

test("after 21:00 the next run is tomorrow", () => {
  // 2026-11-23 22:15 EST
  const due = at2130("2026-11-24T03:15:00Z");
  assert.equal(due.toISOString(), "2026-11-25T02:00:00.000Z");
  assert.equal(zonedParts(due, TZ).day, 24);
  assert.equal(zonedParts(due, TZ).hour, 21);
});

test("exactly at the boundary the next run is tomorrow, not a second run now", () => {
  const boundary = new Date("2026-11-24T02:00:00.000Z"); // 21:00 EST
  const due = nextRun(boundary, { timeZone: TZ, hour: 21, minute: 0 });
  assert.equal(due.toISOString(), "2026-11-25T02:00:00.000Z");
});

test("spring forward: 21:00 stays 21:00 across the lost hour", () => {
  // DST starts 2026-03-08 at 02:00 EST. The evening of the 7th is still EST:
  // 21:00 EST is 2026-03-08T02:00Z.
  const before = new Date("2026-03-08T01:30:00Z"); // 2026-03-07 20:30 EST
  assert.equal(before.toISOString(), "2026-03-08T01:30:00.000Z");
  const tonight = at2130(before.toISOString());
  assert.equal(tonight.toISOString(), "2026-03-08T02:00:00.000Z");

  // The following evening is EDT: 21:00 EDT is 2026-03-09T01:00Z, one hour
  // earlier in UTC than a 21:00 EST would be — a 23-hour gap.
  const previousEvening = localTimeToInstant(2026, 3, 7, 21, 0, TZ);
  const due = nextRun(new Date("2026-03-08T02:30:00Z"), { timeZone: TZ, hour: 21, minute: 0 });
  assert.equal(due.toISOString(), "2026-03-09T01:00:00.000Z");
  assert.equal(due.getTime() - previousEvening.getTime(), 23 * 60 * 60 * 1000);
  assert.equal(zonedParts(due, TZ).hour, 21);
});

test("fall back: 21:00 stays 21:00 across the repeated hour", () => {
  // DST ends 2026-11-01 at 02:00 EDT.
  const previousEvening = localTimeToInstant(2026, 10, 31, 21, 0, TZ);
  assert.equal(previousEvening.toISOString(), "2026-11-01T01:00:00.000Z");

  const due = nextRun(new Date("2026-11-01T02:30:00Z"), { timeZone: TZ, hour: 21, minute: 0 });
  assert.equal(due.toISOString(), "2026-11-02T02:00:00.000Z");
  assert.equal(due.getTime() - previousEvening.getTime(), 25 * 60 * 60 * 1000);
  assert.equal(zonedParts(due, TZ).hour, 21);
});

test("a week of 21:00s crosses DST with only the gap changing", () => {
  let now = new Date("2026-03-05T12:00:00Z");
  const fired: Date[] = [];
  for (let i = 0; i < 7; i += 1) {
    const due = nextRun(now, { timeZone: TZ, hour: 21, minute: 0 });
    fired.push(due);
    assert.equal(zonedParts(due, TZ).hour, 21, `run ${i} is not at 21:00 local`);
    assert.equal(zonedParts(due, TZ).minute, 0);
    now = due;
  }
  const gaps = fired
    .slice(1)
    .map((due, index) => (due.getTime() - fired[index].getTime()) / 3_600_000);
  assert.deepEqual(gaps, [24, 24, 23, 24, 24, 24]);
});

test("a month of runs never repeats a date", () => {
  let now = new Date("2026-10-25T12:00:00Z");
  const dates = new Set<string>();
  for (let i = 0; i < 31; i += 1) {
    const due = nextRun(now, { timeZone: TZ, hour: 21, minute: 0 });
    const parts = zonedParts(due, TZ);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    assert.equal(dates.has(key), false, `duplicate run for ${key}`);
    dates.add(key);
    now = due;
  }
  assert.equal(dates.size, 31);
});

test("the survey zone is the one the spec asks for", () => {
  assert.equal(isoDateInZone(new Date("2026-11-24T01:00:00Z"), TZ), "2026-11-23");
  assert.equal(isoDateInZone(new Date("2026-11-24T03:00:00Z"), TZ), "2026-11-23");
  assert.equal(isoDateInZone(new Date("2026-11-24T05:30:00Z"), TZ), "2026-11-24");
});

test("calendar days add without a zone", () => {
  assert.equal(addIsoDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addIsoDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addIsoDays("2026-01-01", -1), "2025-12-31");
});

test("SURVEY_AT is parsed strictly", () => {
  assert.deepEqual(parseAt("21:00"), { hour: 21, minute: 0 });
  assert.deepEqual(parseAt(" 7:05 "), { hour: 7, minute: 5 });
  assert.throws(() => parseAt("9pm"));
  assert.throws(() => parseAt("24:00"));
  assert.throws(() => parseAt("21:60"));
});

test("the timer aims at the same instant the pure function computes", () => {
  const timer = new DailyTimer({ timeZone: TZ, hour: 21, minute: 0 }, async () => undefined);
  const from = new Date("2026-11-23T13:00:00Z");
  assert.equal(timer.nextDue(from).toISOString(), at2130(from.toISOString()).toISOString());
  timer.stop();
});
