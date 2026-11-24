import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(REPO, "scripts", "export.py");

async function pythonWorks(): Promise<boolean> {
  try {
    await run("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const entry = (date: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  date,
  user: "111111111111111111",
  started_at: `${date}T01:00:00.000Z`,
  submitted_at: `${date}T01:05:00.000Z`,
  answers: {
    worst_pain: 4,
    bloating: 3,
    upper_gi: "mild",
    bowel_movements: 2,
    bristol: 4,
    urgency: "no",
    woke_at_night: "no",
    foods_fodmap: ["none"],
    foods_other: ["none"],
    medications: ["PPI"],
    stress: 1,
    sleep: "7-8 h",
    meals: ["breakfast", "dinner"],
    caffeine: "2",
    alcohol: "0",
    last_meal: "2–3 h",
    spicy: "yes",
    pain_location: "upper right",
    other_symptoms: ["nausea", "cold sweats"],
    reflux_triggers: ["none"],
    lay_down_after_eating: "no",
    portion_size: "medium",
    fatigue: "moderate",
    anaemia_signs: ["pale", "palpitations"],
    ...answers,
  },
  notes: { other: "", red_flags_note: "" },
  red_flags: [],
  ...extra,
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-export-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const entries = [
    entry("2026-11-01", { worst_pain: 5, foods_fodmap: ["dairy"] }, {
      notes: { other: "cheese at lunch, pain after", red_flags_note: "" },
    }),
    entry("2026-11-02", { worst_pain: 7, foods_fodmap: ["none"] }, {
      red_flags: ["gi_bleeding"],
      notes: { other: "", red_flags_note: "blood in stool" },
    }),
    entry(
      "2026-11-03",
      { worst_pain: 3, foods_fodmap: ["dairy"], foods_other: ["caffeine"], bristol: "none" },
    ),
  ];
  await writeFile(
    join(dir, "2026-11.jsonl"),
    entries.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );
  return dir;
}

const skipUnlessPython = (await pythonWorks()) ? test : test.skip;

skipUnlessPython("the CSV has one column per field plus notes and flags", async (t) => {
  const dir = await fixture(t);
  const { stdout } = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "csv",
    "--data-dir",
    dir,
  ]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines[0], [
    "date",
    "user",
    "submitted_at",
    "worst_pain",
    "bloating",
    "upper_gi",
    "bowel_movements",
    "bristol",
    "urgency",
    "woke_at_night",
    "foods_fodmap",
    "foods_other",
    "medications",
    "stress",
    "sleep",
    "meals",
    "caffeine",
    "alcohol",
    "last_meal",
    "spicy",
    "pain_location",
    "other_symptoms",
    "reflux_triggers",
    "lay_down_after_eating",
    "portion_size",
    "fatigue",
    "anaemia_signs",
    "notes_other",
    "notes_other_meds",
    "notes_other_foods",
    "notes_red_flags",
    "red_flags",
  ].join(","));
  assert.equal(lines.length, 4, "header plus three entries");
  assert.match(lines[1], /cheese at lunch, pain after/);
  assert.match(lines[1], /"cheese at lunch, pain after"/, "a comma in a note must be quoted");
  assert.match(lines[2], /vomiting blood, black or tarry stools, or blood in stool/);
  assert.match(lines[3], /,dairy,caffeine,/, "the two food lists are separate columns");
  assert.match(lines[3], /,none,/, "bristol none survives as its own value");
  assert.match(lines[1], /upper right/, "the pain location is its own column");
  assert.match(lines[1], /nausea; cold sweats/, "a symptom list is joined like the other lists");
  assert.match(lines[1], /,moderate,pale; palpitations,/, "fatigue then the anaemia sign list");
});

skipUnlessPython("the Markdown summary carries adherence, medians, Bristol and food denominators", async (t) => {
  const dir = await fixture(t);
  const { stdout } = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
  ]);
  assert.match(stdout, /^# Gut check-in — November 2026/m);
  assert.match(stdout, /3 entries from 3 days/);
  assert.match(stdout, /## Adherence/);
  assert.match(stdout, /Days recorded: 3 of \d+/);
  assert.match(stdout, /## Severity/);
  assert.match(stdout, /Worst pain \(0-10\): median 5, mean 5\.0 \(n=3\)/);
  assert.match(stdout, /Bristol distribution: 1: 0, 2: 0, 3: 0, 4: 2, none: 1|Bristol distribution: 4: 2, none: 1/);
  assert.match(stdout, /## Foods, and the pain the next day/);
  assert.match(
    stdout,
    /\| high-FODMAP \| dairy \| 2 \| 1 \| 7\.0 \|/,
    "eaten twice, one next-day pain, and the list each row came from",
  );
  assert.match(
    stdout,
    /\| other \| caffeine \| 1 \| 0 \| — \|/,
    "the other list, and the last day of the file has no next day",
  );
  assert.match(stdout, /## Red flags/);
  assert.match(stdout, /2026-11-02: vomiting blood/);
  assert.match(stdout, /1 entry reported an alarm symptom/);
  assert.match(stdout, /## Diet/);
  assert.match(stdout, /- Meals eaten: breakfast 3, lunch 0, dinner 3, snacks 0/);
  assert.match(stdout, /- Caffeine servings: 2 on 3 days/);
  assert.match(stdout, /\| caffeine \(1\+\) \| 3 \| 5\.0 \(n=3\) \|/);
  assert.match(stdout, /\| last meal within 2 h \| 0 \| — \|/, "2-3 h is not within 2 h");
});

skipUnlessPython("an entry from before the diet fields exports blanks, not zeros or a crash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bishop-export-old-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // November's first two days were recorded before the diet questions existed.
  const older = (date: string, pain: number) => ({
    date,
    user: "111111111111111111",
    started_at: `${date}T01:00:00.000Z`,
    submitted_at: `${date}T01:05:00.000Z`,
    answers: {
      worst_pain: pain,
      bloating: 2,
      upper_gi: "none",
      bowel_movements: 1,
      bristol: 3,
      urgency: "no",
      woke_at_night: "no",
      foods: ["none"],
      medications: ["none"],
      stress: 0,
      sleep: "7-8 h",
    },
    notes: { other: "", red_flags_note: "" },
    red_flags: [],
  });
  await writeFile(
    join(dir, "2026-11.jsonl"),
    [older("2026-11-01", 5), older("2026-11-02", 7)].map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const csv = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "csv",
    "--data-dir",
    dir,
  ]);
  const [header, first] = csv.stdout.trim().split("\n");
  const columns = header.split(",");
  const cells = first.split(",");
  for (const key of [
    "meals",
    "caffeine",
    "alcohol",
    "last_meal",
    "spicy",
    "pain_location",
    "other_symptoms",
    "reflux_triggers",
    "lay_down_after_eating",
    "portion_size",
    "fatigue",
    "anaemia_signs",
  ]) {
    assert.equal(cells[columns.indexOf(key)], "", `${key} is blank when it was never asked`);
  }
  // These lines predate the split but did answer the old `foods` question with
  // "none", which answers both new lists; neither column is a blank.
  assert.equal(cells[columns.indexOf("foods_fodmap")], "none");
  assert.equal(cells[columns.indexOf("foods_other")], "none");

  const md = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
  ]);
  assert.match(md.stdout, /## Diet/);
  assert.match(md.stdout, /- Meals eaten: none recorded/);
  assert.match(md.stdout, /- Caffeine servings: none recorded/);
  assert.match(md.stdout, /\| caffeine \(1\+\) \| 0 \| — \|/);
  assert.match(md.stdout, /\| last meal within 2 h \| 0 \| — \|/);
  assert.doesNotMatch(md.stdout, /NaN|Traceback/, "no mean is divided by a zero denominator");
});

skipUnlessPython("an entry from before the food split maps its foods into the two lists", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bishop-export-foods-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // November's first two days answered the single `foods` list. Day two uses the
  // two values that changed wording in the split.
  const { foods_fodmap: _fodmap, foods_other: _other, ...beforeSplit } = entry(
    "2026-11-01",
    {},
  ).answers as Record<string, unknown>;
  void _fodmap;
  void _other;
  const legacy = (day: string, pain: number, foods: string[]) =>
    entry(day, {}, { answers: { ...beforeSplit, worst_pain: pain, foods } });
  const lines = [
    legacy("2026-11-01", 5, ["dairy", "caffeine"]),
    legacy("2026-11-02", 6, ["apple/pear/stone fruit", "fried/fatty"]),
    legacy("2026-11-03", 4, ["none"]),
    entry("2026-11-04", {
      worst_pain: 2,
      foods_fodmap: ["mushroom"],
      foods_other: ["chocolate", "lean or low-fat meals"],
    }),
  ];
  await writeFile(
    join(dir, "2026-11.jsonl"),
    lines.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const csv = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "csv",
    "--data-dir",
    dir,
  ]);
  const [header, ...body] = csv.stdout.trim().split("\n");
  const columns = header.split(",");
  const foodCell = (line: string, key: string) => {
    // Every fixture cell is unquoted; the notes are the only quoted field and
    // they come after the food columns, so splitting is safe here.
    return line.split(",")[columns.indexOf(key)];
  };
  assert.equal(foodCell(body[0], "foods_fodmap"), "dairy");
  assert.equal(foodCell(body[0], "foods_other"), "caffeine");
  assert.equal(
    foodCell(body[1], "foods_fodmap"),
    "apple/pear/stone fruit",
    "an old value keeps its wording, in the list that holds it",
  );
  assert.equal(foodCell(body[1], "foods_other"), "fried/fatty");
  assert.equal(foodCell(body[2], "foods_fodmap"), "none", "an old none answered both lists");
  assert.equal(foodCell(body[2], "foods_other"), "none");
  assert.equal(foodCell(body[3], "foods_fodmap"), "mushroom");
  assert.equal(foodCell(body[3], "foods_other"), "chocolate; lean or low-fat meals");

  const md = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
  ]);
  assert.doesNotMatch(md.stdout, /Traceback|KeyError/, "an old foods line does not crash the summary");
  assert.match(md.stdout, /\| high-FODMAP \| dairy \| 1 \| 1 \| 6\.0 \|/);
  assert.match(md.stdout, /\| other \| caffeine \| 1 \| 1 \| 6\.0 \|/);
  assert.match(
    md.stdout,
    /\| high-FODMAP \| apple\/pear\/stone fruit \(before the split\) \| 1 \|/,
    "a renamed old group is marked, not dropped",
  );
  assert.match(md.stdout, /\| other \| fried\/fatty \(before the split\) \| 1 \|/);
  assert.match(md.stdout, /\| high-FODMAP \| mushroom \| 1 \| 0 \| — \|/);
  assert.match(md.stdout, /\| other \| chocolate \| 1 \| 0 \| — \|/);
});

skipUnlessPython("the reflux fields round-trip, and the trigger day is their union", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bishop-export-reflux-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // Four hand-built days: one trigger from each clause the new fields touch,
  // then one clean day. The clean day keeps a large portion, which is a value
  // of its own and not a trigger, to show the count uses only the formula.
  const clean = {
    reflux_triggers: ["none"],
    foods_other: ["none"],
    last_meal: "2–3 h",
    lay_down_after_eating: "no",
    portion_size: "large",
  };
  const lines = [
    entry("2026-11-01", { ...clean, reflux_triggers: ["mint"] }),
    entry("2026-11-02", { ...clean, foods_other: ["chocolate"] }),
    entry("2026-11-03", { ...clean, last_meal: "within 2 h" }),
    entry("2026-11-04", clean),
  ];
  await writeFile(
    join(dir, "2026-11.jsonl"),
    lines.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const csv = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "csv",
    "--data-dir",
    dir,
  ]);
  const [header, ...body] = csv.stdout.trim().split("\n");
  const columns = header.split(",");
  // The notes are empty in this fixture, so no cell is quoted and splitting on
  // commas is safe, as in the food-split test above.
  const cell = (line: string, key: string) => line.split(",")[columns.indexOf(key)];
  assert.equal(cell(body[0], "reflux_triggers"), "mint");
  assert.equal(cell(body[1], "reflux_triggers"), "none");
  assert.equal(cell(body[1], "lay_down_after_eating"), "no");
  assert.equal(cell(body[2], "portion_size"), "large");

  const md = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
  ]);
  assert.match(md.stdout, /## Reflux/);
  assert.match(md.stdout, /- Trigger days: 3 of 4\./);
  assert.match(
    md.stdout,
    /A day counts when `reflux_triggers` has mint, citrus or tomato; or `foods_other` has chocolate, caffeine, alcohol, carbonated or fried or fatty; or `last_meal` is `within 2 h`; or `lay_down_after_eating` is `yes`\./,
    "the formula travels beside the number, so the CSV recomputes it",
  );
  assert.match(md.stdout, /reflux_triggers mint\/citrus\/tomato 1/);
  assert.match(md.stdout, /foods_other chocolate\/caffeine\/alcohol\/carbonated\/fried or fatty 1/);
  assert.match(md.stdout, /last meal within 2 h 1/);
  assert.match(md.stdout, /lay down after eating 0/);
  assert.match(md.stdout, /- Reflux triggers: mint 1 \(of 4 days with an answer\)/);
  assert.match(md.stdout, /- Portion size: large on 4 days/);
});

skipUnlessPython("the script refuses to write inside the repository", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(
    run("python3", [
      SCRIPT,
      "--month",
      "2026-11",
      "--out",
      join(REPO, "data", "survey", "leak.csv"),
      "--data-dir",
      dir,
    ]),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /inside the repository/);
      return true;
    },
  );
});

skipUnlessPython("--out outside the repository writes a file and prints nothing", async (t) => {
  const dir = await fixture(t);
  const target = join(dir, "summary.md");
  const { stdout } = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
    "--out",
    target,
  ]);
  assert.equal(stdout, "");
  const written = await readFile(target, "utf8");
  assert.match(written, /# Gut check-in — November 2026/);
});

skipUnlessPython("a month with no file is an error, not an empty summary", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(
    run("python3", [SCRIPT, "--month", "2020-01", "--data-dir", dir]),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 3);
      assert.match(err.stderr, /no entries for 2020-01/);
      return true;
    },
  );
});

skipUnlessPython("the words behind other are their own columns, and only when non-empty", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bishop-export-other-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // The first day answered medication with `other` and typed what it was; the
  // second day answered it normally, so nothing is invented for it.
  const typed = entry("2026-11-01", { medications: ["other"] }, {
    notes: { other: "", other_meds: "ibuprofen, codeine", red_flags_note: "" },
  });
  const plain = entry("2026-11-02", { medications: ["PPI"] });
  await writeFile(
    join(dir, "2026-11.jsonl"),
    [typed, plain].map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const csv = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "csv",
    "--data-dir",
    dir,
  ]);
  const [header, ...body] = csv.stdout.trim().split("\n");
  const columns = header.split(",");
  assert.ok(columns.includes("notes_other_meds"));
  assert.ok(columns.includes("notes_other_foods"));
  assert.match(body[0], /"ibuprofen, codeine"/, "a comma in the words is quoted, like any note");
  // The answer column keeps the fixed value the export counts.
  assert.match(body[0], /,other,/, "medications still exports as other");
  assert.equal(body[1].split(",")[columns.indexOf("notes_other_meds")], "");

  const md = await run("python3", [
    SCRIPT,
    "--month",
    "2026-11",
    "--format",
    "md",
    "--data-dir",
    dir,
  ]);
  assert.match(md.stdout, /2026-11-01 — other medication: ibuprofen, codeine/);
  assert.doesNotMatch(md.stdout, /other food/, "a food note is only mentioned when there is one");
  assert.doesNotMatch(md.stdout, /2026-11-02 — /, "a day with no notes keeps no notes line");
});
