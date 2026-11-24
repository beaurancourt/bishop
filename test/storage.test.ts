import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEntry } from "../src/survey/entry.js";
import type { Answers } from "../src/survey/fields.js";
import {
  deleteUserEntries,
  hasEntry,
  listMonths,
  monthFile,
  patchUserState,
  readMonth,
  saveEntry,
  userState,
} from "../src/survey/storage.js";

const answers = (pain: number): Answers => ({
  worst_pain: pain,
  bloating: 3,
  upper_gi: "mild",
  bowel_movements: 2,
  bristol: 4,
  urgency: "no",
  woke_at_night: "no",
  foods: ["dairy"],
  medications: ["PPI"],
  stress: 1,
  sleep: "7-8 h",
});

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-survey-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const entryFor = (date: string, pain: number, user = "111111111111111111", submittedAt?: Date) =>
  buildEntry({
    userId: user,
    date,
    startedAt: `${date}T01:00:00.000Z`,
    answers: answers(pain),
    notes: { other: "", red_flags_note: "" },
    submittedAt,
  });

test("an entry is one JSON line in the month's file", async (t) => {
  const dir = await workspace(t);
  const result = await saveEntry(entryFor("2026-11-02", 4), dir);
  assert.equal(result.action, "appended");
  assert.equal(result.monthCount, 1);

  const raw = await readFile(monthFile("2026-11", dir), "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 1);
  const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
  assert.equal(parsed.date, "2026-11-02");
  assert.equal(parsed.user, "111111111111111111");
  assert.ok(typeof parsed.started_at === "string");
  assert.ok(typeof parsed.submitted_at === "string");
  assert.deepEqual(parsed.red_flags, []);
  assert.equal((parsed.answers as Answers).worst_pain, 4);
});

test("entries land in the file of their own month", async (t) => {
  const dir = await workspace(t);
  await saveEntry(entryFor("2026-11-30", 2), dir);
  await saveEntry(entryFor("2026-12-01", 5), dir);
  assert.deepEqual(await listMonths(dir), ["2026-12", "2026-11"]);
  assert.equal((await readMonth("2026-11", dir)).length, 1);
  assert.equal((await readMonth("2026-12", dir)).length, 1);
});

test("a second submission for the same date updates the line instead of adding one", async (t) => {
  const dir = await workspace(t);
  const first = await saveEntry(
    entryFor("2026-11-05", 2, "111111111111111111", new Date("2026-11-05T01:05:00Z")),
    dir,
  );
  assert.equal(first.action, "appended");
  await saveEntry(entryFor("2026-11-06", 6), dir);

  const second = await saveEntry(
    entryFor("2026-11-05", 9, "111111111111111111", new Date("2026-11-05T02:30:00Z")),
    dir,
  );
  assert.equal(second.action, "updated");
  assert.equal(second.monthCount, 2);

  const entries = await readMonth("2026-11", dir);
  assert.equal(entries.length, 2);
  const corrected = entries.find((entry) => entry.date === "2026-11-05");
  assert.equal(corrected?.answers.worst_pain, 9);
  assert.equal(corrected?.submitted_at, "2026-11-05T02:30:00.000Z");
  const raw = await readFile(monthFile("2026-11", dir), "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 2);
});

test("two people on the same date are two lines, not one overwriting the other", async (t) => {
  const dir = await workspace(t);
  await saveEntry(entryFor("2026-11-05", 2, "111111111111111111"), dir);
  await saveEntry(entryFor("2026-11-05", 7, "222222222222222222"), dir);
  const entries = await readMonth("2026-11", dir);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.user).sort(),
    ["111111111111111111", "222222222222222222"],
  );
  assert.equal(await hasEntry("222222222222222222", "2026-11-05", dir), true);
  assert.equal(await hasEntry("222222222222222222", "2026-11-06", dir), false);
});

test("a skipped day leaves no line at all, not a zero", async (t) => {
  const dir = await workspace(t);
  await saveEntry(entryFor("2026-11-02", 4), dir);
  await saveEntry(entryFor("2026-11-04", 3), dir);
  const dates = (await readMonth("2026-11", dir)).map((entry) => entry.date);
  assert.deepEqual(dates, ["2026-11-02", "2026-11-04"]);
  assert.equal(dates.includes("2026-11-03"), false);
});

test("quotes, newlines, emoji and backslashes survive the round trip", async (t) => {
  const dir = await workspace(t);
  const notes = {
    other: 'said "cheese" then\nwoke at 3 \u2014 \ud83e\uddc0 with a \\ backslash',
    red_flags_note: "",
  };
  const entry = buildEntry({
    userId: "111111111111111111",
    date: "2026-11-07",
    startedAt: "2026-11-07T01:00:00.000Z",
    answers: answers(5),
    notes,
    submittedAt: new Date("2026-11-07T01:04:00Z"),
  });
  await saveEntry(entry, dir);
  const [stored] = await readMonth("2026-11", dir);
  assert.deepEqual(stored.notes, notes);
  const raw = await readFile(monthFile("2026-11", dir), "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 1, "the note's newline must be escaped, not a new line");
});

test("deleting a user removes their lines and nobody else's", async (t) => {
  const dir = await workspace(t);
  await saveEntry(entryFor("2026-11-02", 4, "111111111111111111"), dir);
  await saveEntry(entryFor("2026-11-03", 5, "111111111111111111"), dir);
  await saveEntry(entryFor("2026-11-03", 6, "222222222222222222"), dir);
  await saveEntry(entryFor("2026-12-01", 2, "111111111111111111"), dir);

  const removed = await deleteUserEntries("111111111111111111", dir);
  assert.equal(removed, 3);
  const remaining = await readMonth("2026-11", dir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].user, "222222222222222222");
  assert.deepEqual(await readMonth("2026-12", dir), []);
  const survivor = buildEntry({
    userId: "222222222222222222",
    date: "2026-11-04",
    startedAt: "2026-11-04T01:00:00.000Z",
    answers: answers(1),
    notes: { other: "", red_flags_note: "" },
  });
  await saveEntry(survivor, dir);
  assert.equal((await readMonth("2026-11", dir)).length, 2);
});

test("state remembers the intro and the pause across reads", async (t) => {
  const dir = await workspace(t);
  assert.deepEqual(await userState("111111111111111111", dir), {});
  await patchUserState("111111111111111111", { intro_sent_at: "2026-11-01T01:00:00.000Z" }, dir);
  await patchUserState("111111111111111111", { paused_at: "2026-11-09T01:00:00.000Z" }, dir);
  const state = await userState("111111111111111111", dir);
  assert.equal(state.intro_sent_at, "2026-11-01T01:00:00.000Z");
  assert.equal(state.paused_at, "2026-11-09T01:00:00.000Z");
  await patchUserState("111111111111111111", { paused_at: null }, dir);
  assert.equal((await userState("111111111111111111", dir)).paused_at, null);
});

test("concurrent appends do not lose an entry", async (t) => {
  const dir = await workspace(t);
  await Promise.all([
    saveEntry(entryFor("2026-11-10", 1), dir),
    saveEntry(entryFor("2026-11-11", 2), dir),
    saveEntry(entryFor("2026-11-12", 3), dir),
    saveEntry(entryFor("2026-11-13", 4), dir),
  ]);
  const entries = await readMonth("2026-11", dir);
  assert.equal(entries.length, 4);
});
