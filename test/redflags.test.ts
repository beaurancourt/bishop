import assert from "node:assert/strict";
import test from "node:test";
import { buildEntry } from "../src/survey/entry.js";
import { RED_FLAGS, detectRedFlags, redFlagLabel, redFlagMessage } from "../src/survey/redflags.js";

test("a positive mention fires the matching flag", () => {
  assert.deepEqual(detectRedFlags("vomited blood last night"), ["gi_bleeding"]);
  assert.deepEqual(detectRedFlags("black tarry stools in the morning"), ["gi_bleeding"]);
  assert.deepEqual(detectRedFlags("lost 5 lb without trying"), ["unintentional_weight_loss"]);
  assert.deepEqual(detectRedFlags("pain when I swallow"), ["dysphagia"]);
  assert.deepEqual(detectRedFlags("threw up three times, then could not keep water down"), [
    "persistent_vomiting",
  ]);
  assert.deepEqual(detectRedFlags("my iron is low again"), ["anaemia"]);
  assert.deepEqual(detectRedFlags("fever of 38.4 with the pain"), ["fever_with_pain"]);
  assert.deepEqual(detectRedFlags("these are new symptoms since October"), ["new_symptoms_age_55"]);
  assert.deepEqual(detectRedFlags("it woke me at 03:00"), ["night_symptoms"]);
});

test("a blank answer, or an explicit no, fires nothing", () => {
  assert.deepEqual(detectRedFlags(""), []);
  assert.deepEqual(detectRedFlags("   "), []);
  assert.deepEqual(detectRedFlags(undefined), []);
  assert.deepEqual(detectRedFlags(null), []);
  assert.deepEqual(detectRedFlags("none"), []);
  assert.deepEqual(detectRedFlags("no"), []);
  assert.deepEqual(detectRedFlags("Nothing today"), []);
  assert.deepEqual(detectRedFlags("No red flags"), []);
});

test("a negated clause is not a flag, and does not hide a later one", () => {
  assert.deepEqual(detectRedFlags("no blood, no black stools"), []);
  assert.deepEqual(detectRedFlags("I have not had any vomiting"), []);
  assert.deepEqual(detectRedFlags("no blood, but the pain woke me"), ["night_symptoms"]);
  assert.deepEqual(
    detectRedFlags("no weight loss; vomited blood on Tuesday"),
    ["gi_bleeding"],
  );
});

test("a test result is not a symptom", () => {
  assert.deepEqual(detectRedFlags("blood test was normal"), []);
  assert.deepEqual(detectRedFlags("swallowing study booked for Friday"), []);
});

test("several flags can fire at once, in the order of the list", () => {
  const fired = detectRedFlags("fever, low iron, and blood in stool");
  assert.deepEqual(fired, ["gi_bleeding", "anaemia", "fever_with_pain"]);
  assert.deepEqual(
    fired,
    fired.slice().sort((a, b) => RED_FLAGS.findIndex((f) => f.key === a) - RED_FLAGS.findIndex((f) => f.key === b)),
  );
});

test("the confirmation tells her to call today and never reassures", () => {
  const message = redFlagMessage(["gi_bleeding"]);
  assert.ok(message);
  assert.match(message!, /contact your doctor today/i);
  assert.match(message!, /urgent care/i);
  assert.match(message!, /vomited blood/i);
  assert.match(message!, /black or tarry stools/i);
  assert.match(message!, /fainted/i);
  assert.match(message!, /severe chest pain/i);
  assert.match(message!, /not medical advice/i);
  assert.match(message!, new RegExp(redFlagLabel("gi_bleeding").slice(0, 20)));
  for (const reassurance of [
    /don'?t worry/i,
    /probably fine/i,
    /nothing to worry/i,
    /should be fine/i,
    /try not to/i,
    /it'?s likely/i,
  ]) {
    assert.doesNotMatch(message!, reassurance);
  }
  assert.equal(redFlagMessage([]), null);
});

test("the stored entry records exactly the flags the notes imply", () => {
  const entry = buildEntry({
    userId: "111111111111111111",
    date: "2026-11-04",
    startedAt: "2026-11-04T01:00:00.000Z",
    answers: { worst_pain: 6 },
    notes: { other: "worse after cheese", red_flags_note: "blood in stool, no fever" },
    submittedAt: new Date("2026-11-04T01:06:00Z"),
  });
  assert.deepEqual(entry.red_flags, ["gi_bleeding"]);
});

test("a plain evening records no flags", () => {
  const entry = buildEntry({
    userId: "111111111111111111",
    date: "2026-11-06",
    startedAt: "2026-11-06T01:00:00.000Z",
    answers: { worst_pain: 2 },
    notes: { other: "fine, a bit bloated", red_flags_note: "none" },
  });
  assert.deepEqual(entry.red_flags, []);
});
