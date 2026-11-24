import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isEnrolled, loadEnrollment, parseUserIds, readConfigIds } from "../src/survey/enroll.js";
import { audience } from "../src/survey/deliver.js";

const ALICE = "111111111111111111";
const BEAU = "222222222222222222";

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-enroll-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("SURVEY_USER_IDS is a comma-separated list, cleaned up", () => {
  assert.deepEqual(parseUserIds(`${ALICE}, ${BEAU} ,, `), [ALICE, BEAU]);
  assert.deepEqual(parseUserIds(`${ALICE},${ALICE}`), [ALICE]);
  assert.deepEqual(parseUserIds(""), []);
  assert.deepEqual(parseUserIds(undefined), []);
  assert.deepEqual(parseUserIds("alice"), []);
});

test("the environment variable alone enrolls exactly its ids", async () => {
  const enrolled = await loadEnrollment({
    env: { SURVEY_USER_IDS: `${ALICE},${BEAU}` },
    configFile: join(tmpdir(), "bishop-missing-config.json"),
  });
  assert.deepEqual([...enrolled].sort(), [ALICE, BEAU]);
  assert.equal(isEnrolled(ALICE, enrolled), true);
  assert.equal(isEnrolled("999999999999999999", enrolled), false);
});

test("the config file enrolls ids too, and either source is enough", async (t) => {
  const dir = await workspace(t);
  const configFile = join(dir, "config.json");
  await writeFile(configFile, JSON.stringify({ user_ids: [BEAU] }), "utf8");
  assert.deepEqual(await readConfigIds(configFile), [BEAU]);

  const fromFileOnly = await loadEnrollment({ env: {}, configFile });
  assert.deepEqual([...fromFileOnly], [BEAU]);

  const fromBoth = await loadEnrollment({ env: { SURVEY_USER_IDS: ALICE }, configFile });
  assert.deepEqual([...fromBoth].sort(), [ALICE, BEAU]);
});

test("a missing or broken config file enrolls nobody, rather than everybody", async (t) => {
  const dir = await workspace(t);
  const missing = join(dir, "nope.json");
  assert.deepEqual(await readConfigIds(missing), []);
  const broken = join(dir, "broken.json");
  await writeFile(broken, "{not json", "utf8");
  assert.deepEqual(await readConfigIds(broken), []);
  assert.equal((await loadEnrollment({ env: {}, configFile: broken })).size, 0);
});

test("a non-enrolled user id is not answered and not in the audience", async () => {
  const enrolled = await loadEnrollment({
    env: { SURVEY_USER_IDS: ALICE },
    configFile: join(tmpdir(), "bishop-missing-config.json"),
  });
  const stranger = "333333333333333333";
  assert.equal(isEnrolled(stranger, enrolled), false);
  assert.deepEqual(audience(enrolled, []), [ALICE]);
  assert.equal(audience(enrolled, []).includes(stranger), false);
});

test("a paused user is enrolled but outside the audience", () => {
  assert.deepEqual(audience([ALICE, BEAU], [BEAU]), [ALICE]);
  assert.deepEqual(audience([ALICE], [ALICE]), []);
  assert.deepEqual(audience(new Set([ALICE, BEAU, ALICE]), []), [ALICE, BEAU]);
});
