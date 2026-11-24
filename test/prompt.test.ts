import assert from "node:assert/strict";
import test from "node:test";
import {
  type Answers,
  FIELDS,
  FIELD_KEYS,
  PAGE_COUNT,
  applyAnswer,
  fieldsOnPage,
  missingFields,
  selectedValues,
} from "../src/survey/fields.js";
import {
  NOTES_FLAGS_INPUT,
  NOTES_OTHER_INPUT,
  buildSurveyMessage,
  confirmationRow,
  customIds,
  formatDateLabel,
  introMessage,
  missingFieldsNotice,
  parseCustomId,
} from "../src/survey/prompt.js";

const DATE = "2026-11-23";

interface RawComponent {
  type: number;
  custom_id?: string;
  label?: string;
  options?: { label: string; value: string; default?: boolean }[];
  max_values?: number;
  components?: RawComponent[];
}

function componentsOf(message: ReturnType<typeof buildSurveyMessage>): RawComponent[] {
  return (message.components as unknown as RawComponent[]).flatMap(
    (row) => row.components ?? [],
  );
}

const rowsOf = (message: ReturnType<typeof buildSurveyMessage>) =>
  message.components as unknown as RawComponent[];

test("the sixteen fast-path fields are all present and none is repeated", () => {
  assert.equal(FIELDS.length, 16);
  assert.equal(new Set(FIELD_KEYS).size, 16);
  assert.deepEqual(
    [...FIELD_KEYS].sort(),
    [
      "alcohol",
      "bloating",
      "bowel_movements",
      "bristol",
      "caffeine",
      "foods",
      "last_meal",
      "meals",
      "medications",
      "sleep",
      "spicy",
      "stress",
      "upper_gi",
      "urgency",
      "woke_at_night",
      "worst_pain",
    ],
  );
});

test("every page fits Discord's five action rows and five components per row", () => {
  assert.equal(PAGE_COUNT, 4);
  const seen = new Set<string>();
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const message = buildSurveyMessage(DATE, {}, page);
    const rows = rowsOf(message);
    const fields = fieldsOnPage(page);
    // One row per select, plus the single button row this page adds.
    assert.equal(rows.length, fields.length + 1, `page ${page} rows`);
    assert.ok(rows.length <= 5, `page ${page} has ${rows.length} rows`);
    assert.ok(fields.length <= 4, `page ${page} has ${fields.length} selects`);
    for (const row of rows) {
      assert.equal(row.type, 1);
      assert.ok((row.components ?? []).length >= 1);
      assert.ok((row.components ?? []).length <= 5);
    }
    for (const field of fields) seen.add(field.key);
  }
  assert.equal(seen.size, 16);
});

test("each select's custom id carries the date and the field, and parses back", () => {
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const message = buildSurveyMessage(DATE, {}, page);
    for (const field of fieldsOnPage(page)) {
      const component = componentsOf(message).find(
        (candidate) => candidate.custom_id === customIds.field(DATE, field.key),
      );
      assert.ok(component, `no select for ${field.key}`);
      assert.equal(component?.type, 3);
      assert.deepEqual(parseCustomId(component!.custom_id!), {
        kind: "field",
        date: DATE,
        field: field.key,
      });
    }
    for (const component of componentsOf(message)) {
      if (component.type !== 3) continue;
      assert.match(component.custom_id ?? "", /^survey:\d{4}-\d{2}-\d{2}:field:/);
    }
  }
});

test("a re-rendered page shows the answers already given", () => {
  const answers = applyAnswer(
    applyAnswer({}, "worst_pain", ["7"]),
    "foods",
    ["dairy", "wheat"],
  );
  const first = buildSurveyMessage(DATE, answers, 1);
  const pain = componentsOf(first).find((c) => c.custom_id === customIds.field(DATE, "worst_pain"));
  const defaults = (pain?.options ?? []).filter((option) => option.default).map((o) => o.value);
  assert.deepEqual(defaults, ["7"]);

  const third = buildSurveyMessage(DATE, answers, 3);
  const foods = componentsOf(third).find((c) => c.custom_id === customIds.field(DATE, "foods"));
  assert.deepEqual(
    (foods?.options ?? []).filter((o) => o.default).map((o) => o.value),
    ["dairy", "wheat"],
  );
  assert.equal(foods?.max_values, 11);
});

test("the last page has Notes and Submit, both tied to the date", () => {
  const last = buildSurveyMessage(DATE, {}, PAGE_COUNT);
  const buttons = componentsOf(last).filter((component) => component.type === 2);
  const notes = buttons.find((button) => button.label === "Notes");
  const submit = buttons.find((button) => button.label === "Submit");
  assert.equal(notes?.custom_id, customIds.notes(DATE));
  assert.equal(submit?.custom_id, customIds.submit(DATE));
  assert.deepEqual(parseCustomId(submit!.custom_id!), { kind: "submit", date: DATE });
  assert.deepEqual(parseCustomId(notes!.custom_id!), { kind: "notes", date: DATE });
});

test("the last page's copy sends her to Notes before Submit", () => {
  const last = buildSurveyMessage(DATE, {}, PAGE_COUNT);
  assert.match(last.content, /\*\*Notes\*\*/);
  assert.match(last.content, /then press \*\*Submit\*\*/);
  // Pages before the last do not carry the Submit instruction yet.
  assert.doesNotMatch(buildSurveyMessage(DATE, {}, 1).content, /then press \*\*Submit\*\*/);
});

test("the confirmation row offers Add notes and Edit tonight for that date", () => {
  const row = confirmationRow(DATE);
  const buttons = (row as unknown as { components: RawComponent[] }).components;
  assert.deepEqual(
    buttons.map((button) => button.label),
    ["Add notes", "Edit tonight"],
  );
  assert.deepEqual(buttons.map((button) => button.custom_id), [
    customIds.notes(DATE),
    customIds.edit(DATE),
  ]);
  assert.deepEqual(parseCustomId(customIds.edit(DATE)), { kind: "edit", date: DATE });
  assert.deepEqual(parseCustomId("survey:2026-11-22:edit"), {
    kind: "edit",
    date: "2026-11-22",
  });
});

test("paging buttons point at the neighbouring pages", () => {
  const first = componentsOf(buildSurveyMessage(DATE, {}, 1)).find(
    (component) => component.type === 2 && component.label === "Next",
  );
  assert.equal(first?.custom_id, customIds.page(DATE, 2));
  assert.deepEqual(parseCustomId(first!.custom_id!), { kind: "page", date: DATE, page: 2 });
  const second = componentsOf(buildSurveyMessage(DATE, {}, 2)).filter(
    (component) => component.type === 2,
  );
  assert.deepEqual(
    second.map((button) => button.label),
    ["Back", "Next"],
  );
});

test("custom ids from other features, and malformed dates, are not ours", () => {
  assert.equal(parseCustomId("calendar:something"), null);
  assert.equal(parseCustomId("survey:2026-11-23:nonsense"), null);
  assert.equal(parseCustomId("survey:23-11-2026:submit"), null);
  assert.equal(parseCustomId("survey:2026-11-23:page:9"), null);
  assert.equal(parseCustomId("survey:2026-11-23:field:"), null);
  assert.deepEqual(parseCustomId(customIds.pause()), { kind: "pause" });
  assert.deepEqual(parseCustomId(customIds.deleteConfirm()), { kind: "delete-confirm" });
});

test("none never coexists with a real item in a multi-select", () => {
  let answers = applyAnswer({}, "foods", ["none", "dairy"]);
  assert.deepEqual(answers.foods, ["dairy"]);
  answers = applyAnswer(answers, "foods", ["none"]);
  assert.deepEqual(answers.foods, ["none"]);
  answers = applyAnswer(answers, "foods", ["dairy", "caffeine"]);
  assert.deepEqual(answers.foods, ["dairy", "caffeine"]);
  assert.deepEqual(selectedValues(FIELDS[8], answers.foods), ["dairy", "caffeine"]);
});

test("a value outside the menu is refused rather than stored", () => {
  assert.throws(() => applyAnswer({}, "worst_pain", ["11"]));
  assert.throws(() => applyAnswer({}, "upper_gi", ["catastrophic"]));
  assert.throws(() => applyAnswer({}, "not_a_field", ["1"]));
});

test("bristol keeps none apart from the 1-7 scale", () => {
  assert.equal(applyAnswer({}, "bristol", ["4"]).bristol, 4);
  assert.equal(applyAnswer({}, "bristol", ["none"]).bristol, "none");
});

test("the diet questions store exactly the spec's answer values", () => {
  const values = (key: string) =>
    FIELDS.find((field) => field.key === key)?.options.map((option) => option.value);
  assert.deepEqual(values("meals"), ["breakfast", "lunch", "dinner", "snacks"]);
  assert.deepEqual(values("caffeine"), ["0", "1", "2", "3+"]);
  assert.deepEqual(values("alcohol"), ["0", "1", "2", "3+"]);
  assert.deepEqual(values("last_meal"), ["more than 3 h", "2–3 h", "within 2 h", "did not eat"]);
  assert.deepEqual(values("spicy"), ["yes", "no"]);

  let answers = applyAnswer({}, "meals", ["breakfast", "dinner"]);
  assert.deepEqual(answers.meals, ["breakfast", "dinner"]);
  answers = applyAnswer(answers, "caffeine", ["3+"]);
  answers = applyAnswer(answers, "alcohol", ["0"]);
  answers = applyAnswer(answers, "last_meal", ["2–3 h"]);
  answers = applyAnswer(answers, "spicy", ["yes"]);
  assert.equal(answers.caffeine, "3+");
  assert.equal(answers.alcohol, "0");
  assert.equal(answers.last_meal, "2–3 h");
  assert.equal(answers.spicy, "yes");

  // They are spread over pages three and four, inside the row budget.
  assert.equal(FIELDS.find((field) => field.key === "meals")?.page, 3);
  for (const key of ["caffeine", "alcohol", "last_meal", "spicy"]) {
    assert.equal(FIELDS.find((field) => field.key === key)?.page, 4);
  }
  // The counter copy reports the new total, not the old eleven.
  assert.match(buildSurveyMessage(DATE, {}, 1).content, /answered 0 of 16/);
});

test("a submission missing fields is named, not written", () => {
  const answers = applyAnswer({}, "worst_pain", ["3"]);
  assert.equal(missingFields(answers).length, 15);
  const notice = missingFieldsNotice(answers);
  assert.ok(notice?.includes("Bloating"));
  assert.ok(!notice?.includes("Worst abdominal pain"));
  const full = FIELDS.reduce<Answers>(
    (acc, field) => applyAnswer(acc, field.key, [field.options[0].value]),
    {},
  );
  assert.equal(missingFieldsNotice(full), null);
});

test("the date label is the calendar date that was prompted", () => {
  assert.equal(formatDateLabel("2026-11-23"), "Mon 23 Nov 2026");
  assert.equal(formatDateLabel("2026-03-08"), "Sun 8 Mar 2026");
});

test("the intro says what is recorded, that it is not advice, and offers both controls", () => {
  const intro = introMessage();
  assert.match(intro.content, /not medical advice/i);
  assert.match(intro.content, /21:00/);
  assert.match(intro.content, /Delete my data/);
  const buttons = componentsOf(intro);
  assert.deepEqual(
    buttons.map((button) => button.label),
    ["Pause", "Delete my data"],
  );
  assert.equal(buttons[0].custom_id, customIds.pause());
  assert.equal(buttons[1].custom_id, customIds.delete());
});

test("the notes modal ids are distinct from the survey ids", () => {
  assert.notEqual(NOTES_OTHER_INPUT, NOTES_FLAGS_INPUT);
  assert.equal(parseCustomId(NOTES_OTHER_INPUT), null);
});
