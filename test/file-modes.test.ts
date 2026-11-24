/**
 * The survey holds health data, so a write must leave nothing readable by
 * another account: the directory 0700 and every file 0600, whatever the umask
 * of the process that runs bishop.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DraftStore } from "../src/survey/drafts.js";
import { buildEntry } from "../src/survey/entry.js";
import type { Answers } from "../src/survey/fields.js";
import { DIR_MODE, FILE_MODE, monthFile, patchUserState, saveEntry } from "../src/survey/storage.js";

const USER = "111111111111111111";
const DATE = "2026-11-23";

const answers: Answers = {
  worst_pain: 4,
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
};

const entry = buildEntry({
  userId: USER,
  date: DATE,
  startedAt: `${DATE}T01:00:00.000Z`,
  answers,
  notes: { other: "", red_flags_note: "" },
});

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-modes-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const mode = (path: string) => stat(path).then((info) => info.mode & 0o777);

test("every file and the directory are private after a write under umask 022", async (t) => {
  const root = await workspace(t);
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));

  const dir = join(root, "survey");
  await saveEntry(entry, dir);
  await patchUserState(USER, { intro_sent_at: `${DATE}T01:00:00.000Z` }, dir);
  const drafts = new DraftStore(dir);
  await drafts.load();
  drafts.ensure(USER, DATE, `${DATE}T02:00:00.000Z`);
  await drafts.persist();

  assert.equal(await mode(dir), DIR_MODE, "the survey directory is 0700");
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ["2026-11.jsonl", "drafts.json", "state.json"]);
  for (const name of names) {
    assert.equal(await mode(join(dir, name)), FILE_MODE, `${name} is 0600`);
  }
});

test("a wider mode left by an earlier version is tightened on the next write", async (t) => {
  const root = await workspace(t);
  const dir = join(root, "survey");
  const file = monthFile("2026-11", dir);
  const state = join(dir, "state.json");
  const draftsFile = join(dir, "drafts.json");

  await mkdir(dir, { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  for (const path of [file, state, draftsFile]) {
    await writeFile(path, "{}\n", { encoding: "utf8", mode: 0o644 });
    await chmod(path, 0o644);
  }
  assert.equal(await mode(dir), 0o755, "the old directory really starts wide");

  await saveEntry(entry, dir);
  await patchUserState(USER, { paused_at: `${DATE}T03:00:00.000Z` }, dir);
  const drafts = new DraftStore(dir);
  await drafts.load();
  drafts.ensure(USER, DATE, `${DATE}T02:00:00.000Z`);
  await drafts.persist();

  assert.equal(await mode(dir), DIR_MODE);
  assert.equal(await mode(file), FILE_MODE);
  assert.equal(await mode(state), FILE_MODE);
  assert.equal(await mode(draftsFile), FILE_MODE);
});
