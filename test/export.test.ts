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
    foods: ["none"],
    medications: ["PPI"],
    stress: 1,
    sleep: "7-8 h",
    meals: ["breakfast", "dinner"],
    caffeine: "2",
    alcohol: "0",
    last_meal: "2–3 h",
    spicy: "yes",
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
    entry("2026-11-01", { worst_pain: 5, foods: ["dairy"] }, {
      notes: { other: "cheese at lunch, pain after", red_flags_note: "" },
    }),
    entry("2026-11-02", { worst_pain: 7, foods: ["none"] }, {
      red_flags: ["gi_bleeding"],
      notes: { other: "", red_flags_note: "blood in stool" },
    }),
    entry("2026-11-03", { worst_pain: 3, foods: ["dairy", "caffeine"], bristol: "none" }),
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
    "foods",
    "medications",
    "stress",
    "sleep",
    "meals",
    "caffeine",
    "alcohol",
    "last_meal",
    "spicy",
    "notes_other",
    "notes_red_flags",
    "red_flags",
  ].join(","));
  assert.equal(lines.length, 4, "header plus three entries");
  assert.match(lines[1], /cheese at lunch, pain after/);
  assert.match(lines[1], /"cheese at lunch, pain after"/, "a comma in a note must be quoted");
  assert.match(lines[2], /vomiting blood, black or tarry stools, or blood in stool/);
  assert.match(lines[3], /dairy; caffeine/);
  assert.match(lines[3], /,none,/, "bristol none survives as its own value");
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
  assert.match(stdout, /\| dairy \| 2 \| 1 \| 7\.0 \|/, "eaten twice, one next-day pain");
  assert.match(stdout, /\| caffeine \| 1 \| 0 \| — \|/, "last day of the file has no next day");
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
  for (const key of ["meals", "caffeine", "alcohol", "last_meal", "spicy"]) {
    assert.equal(cells[columns.indexOf(key)], "", `${key} is blank when it was never asked`);
  }

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
