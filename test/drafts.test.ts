import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DraftStore, draftsFile } from "../src/survey/drafts.js";

const USER = "111111111111111111";
const OTHER = "222222222222222222";
const DATE = "2026-11-23";

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-drafts-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A half-filled evening, the way a click on page two leaves it. */
function fill(store: DraftStore, userId = USER, date = DATE) {
  const draft = store.ensure(userId, date, "2026-11-23T02:00:00.000Z");
  draft.answers = {
    worst_pain: 7,
    bloating: 3,
    upper_gi: "mild",
    bowel_movements: 2,
    bristol: "4",
    urgency: "no",
    woke_at_night: "no",
    foods: ["dairy"],
    medications: ["PPI"],
    stress: 1,
    sleep: "7-8 h",
  };
  draft.notes = { other: "cheese at lunch", red_flags_note: "" };
  draft.page = 2;
  return draft;
}

test("a half-filled check-in survives a restart", async (t) => {
  const dir = await workspace(t);
  const before = new DraftStore(dir);
  await before.load();
  const draft = fill(before);
  await before.persist();

  // The restart: a new process has no map, only the directory on disk.
  const after = new DraftStore(dir);
  assert.equal(after.get(USER, DATE), undefined);
  await after.load();

  const restored = after.get(USER, DATE);
  assert.deepEqual(restored, draft);
  assert.equal(restored?.startedAt, "2026-11-23T02:00:00.000Z");
  assert.equal(restored?.page, 2);
  assert.deepEqual(restored?.answers, draft.answers);
});

test("reload forgets whatever memory held and reads the file again", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  fill(store);
  await store.persist();

  // A click that was never written: memory only, so a restart must not see it.
  store.ensure(USER, DATE).page = 3;
  store.ensure(OTHER, DATE).answers.worst_pain = 2;

  await store.reload();
  assert.equal(store.get(USER, DATE)?.page, 2);
  assert.equal(store.get(OTHER, DATE), undefined, "an unpersisted draft does not survive");
});

test("one evening per user, and a second person does not overwrite the first", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  fill(store, USER);
  fill(store, OTHER);
  await store.persist();

  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, DATE)?.answers.worst_pain, 7);
  assert.equal(restarted.get(OTHER, DATE)?.answers.worst_pain, 7);
  assert.equal(restarted.get(OTHER, "2026-11-22"), undefined);
});

test("drafts from an earlier evening are pruned from the file, not just memory", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  fill(store, USER, "2026-11-22");
  fill(store, USER, DATE);
  await store.persist();

  const removed = await store.prune(DATE);
  assert.equal(removed, 1);

  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, "2026-11-22"), undefined);
  assert.equal(restarted.get(USER, DATE)?.page, 2);
});

test("a submitted evening is dropped from the file", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  fill(store);
  await store.persist();
  await store.drop(USER, DATE);

  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, DATE), undefined);
});

test("Delete my data takes the drafts with the entries", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  fill(store, USER);
  fill(store, OTHER);
  await store.persist();

  assert.equal(await store.dropUser(USER), 1);
  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, DATE), undefined);
  assert.equal(restarted.get(OTHER, DATE)?.page, 2);
});

test("a missing file is an empty evening", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  assert.equal(store.get(USER, DATE), undefined);
  // Creating one still writes cleanly into a directory that did not exist.
  fill(store);
  await store.persist();
  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, DATE)?.page, 2);
});

test("a corrupt file is ignored rather than fatal", async (t) => {
  const dir = await workspace(t);
  const store = new DraftStore(dir);
  await store.load();
  await store.persist();
  await writeFile(draftsFile(dir), "{ not json", "utf8");

  const restarted = new DraftStore(dir);
  await restarted.load();
  assert.equal(restarted.get(USER, DATE), undefined);

  fill(restarted);
  await restarted.persist();
  const third = new DraftStore(dir);
  await third.load();
  assert.equal(third.get(USER, DATE)?.page, 2);
});
