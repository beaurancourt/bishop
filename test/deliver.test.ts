import assert from "node:assert/strict";
import test from "node:test";
import { deliverDaily, type DeliveryDeps } from "../src/survey/deliver.js";

interface Recorder {
  intros: string[];
  prompts: { userId: string; date: string }[];
}

function makeDeps(overrides: Partial<DeliveryDeps> = {}): { deps: DeliveryDeps; log: Recorder } {
  const log: Recorder = { intros: [], prompts: [] };
  const deps: DeliveryDeps = {
    enrolled: [],
    date: "2026-11-23",
    startedAt: "2026-11-23T02:00:00.000Z",
    isPaused: async () => false,
    hasEntryToday: async () => false,
    introSent: async () => true,
    sendIntro: async (userId) => {
      log.intros.push(userId);
    },
    sendPrompt: async (userId, date) => {
      log.prompts.push({ userId, date });
    },
    ...overrides,
  };
  return { deps, log };
}

const ALICE = "111111111111111111";
const BEAU = "222222222222222222";
const STRANGER = "333333333333333333";

test("only enrolled ids are messaged", async () => {
  const { deps, log } = makeDeps({ enrolled: [ALICE] });
  // The stranger is not in the audience even if something upstream asked.
  const report = await deliverDaily({ ...deps, enrolled: [ALICE] });
  assert.deepEqual(report.sent, [ALICE]);
  assert.deepEqual(log.prompts, [{ userId: ALICE, date: "2026-11-23" }]);
  assert.equal(log.prompts.some((prompt) => prompt.userId === STRANGER), false);
});

test("a paused user gets nothing", async () => {
  const { deps, log } = makeDeps({
    enrolled: [ALICE, BEAU],
    isPaused: async (userId) => userId === BEAU,
  });
  const report = await deliverDaily(deps);
  assert.deepEqual(report.sent, [ALICE]);
  assert.deepEqual(report.skipped, [{ userId: BEAU, reason: "paused" }]);
  assert.deepEqual(log.prompts.map((prompt) => prompt.userId), [ALICE]);
});

test("an evening already submitted is not asked again", async () => {
  const { deps, log } = makeDeps({
    enrolled: [ALICE, BEAU],
    hasEntryToday: async (userId) => userId === ALICE,
  });
  const report = await deliverDaily(deps);
  assert.deepEqual(report.sent, [BEAU]);
  assert.deepEqual(report.skipped, [{ userId: ALICE, reason: "already-submitted" }]);
  assert.deepEqual(log.prompts.map((prompt) => prompt.userId), [BEAU]);
});

test("the intro goes before the first prompt, and only once", async () => {
  const seen = new Set<string>();
  const { deps, log } = makeDeps({
    enrolled: [ALICE],
    introSent: async (userId) => seen.has(userId),
    sendIntro: async (userId) => {
      log.intros.push(userId);
      seen.add(userId);
    },
  });
  await deliverDaily(deps);
  assert.deepEqual(log.intros, [ALICE]);
  assert.equal(log.prompts.length, 1);

  // Tomorrow: no second intro.
  await deliverDaily({ ...deps, date: "2026-11-24" });
  assert.deepEqual(log.intros, [ALICE]);
  assert.equal(log.prompts.length, 2);
});

test("one blocked DM does not stop the rest of the audience", async () => {
  const { deps, log } = makeDeps({
    enrolled: [ALICE, BEAU],
    sendPrompt: async (userId) => {
      if (userId === ALICE) throw new Error("Cannot send messages to this user");
      log.prompts.push({ userId, date: "2026-11-23" });
    },
  });
  const report = await deliverDaily(deps);
  assert.deepEqual(report.sent, [BEAU]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].userId, ALICE);
  assert.match(report.failed[0].error, /Cannot send messages/);
});

test("a repeated id in enrollment is messaged once", async () => {
  const { deps, log } = makeDeps({ enrolled: [ALICE, ALICE] });
  const report = await deliverDaily(deps);
  assert.deepEqual(report.sent, [ALICE]);
  assert.equal(log.prompts.length, 1);
});
