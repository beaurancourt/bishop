import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageFlags, type Interaction } from "discord.js";
import { drafts, dispatch, handleInteraction } from "../src/survey/index.js";
import { draftsFile } from "../src/survey/drafts.js";
import type { Answers } from "../src/survey/fields.js";
import { NOTES_FLAGS_INPUT, NOTES_OTHER_INPUT } from "../src/survey/prompt.js";
import { monthFile } from "../src/survey/storage.js";

const USER = "111111111111111111";
const DATE = "2026-11-23";
const STARTED_AT = "2026-11-23T02:00:00.000Z";

/** Tonight's answers, the way a completed check-in leaves them. */
function fullAnswers(): Answers {
  return {
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
}

interface RawButton {
  label?: string;
  custom_id?: string;
}

/** The buttons of an edited message, flattened out of its action rows. */
function buttonsOf(payload: { components?: unknown } | undefined): RawButton[] {
  const rows = (payload?.components ?? []) as { components?: RawButton[] }[];
  return rows.flatMap((row) => row.components ?? []);
}

/** The month file's lines for a workspace. */
async function monthLines(dir: string): Promise<string[]> {
  return (await readFile(monthFile("2026-11", dir), "utf8")).trim().split("\n");
}

interface FakeOptions {
  customId: string;
  isButton?: boolean;
  isSelect?: boolean;
  isModal?: boolean;
  values?: string[];
  /** Text boxes of a modal submit, by input id. */
  modalFields?: Record<string, string>;
  /** How long ago Discord says the click happened. */
  ageMs?: number;
  onDeferUpdate?: () => void;
  rejectReply?: boolean;
}

interface Fake {
  interaction: Interaction;
  events: string[];
  replies: { content?: string; flags?: number }[];
  edits: { content?: string; components?: unknown }[];
  modals: { toJSON: () => unknown }[];
}

/**
 * Enough of an interaction to run the handler: the methods dispatch and
 * handleInteraction call, a recording log, and a clock the test controls.
 */
function fakeInteraction(options: FakeOptions): Fake {
  const events: string[] = [];
  const replies: { content?: string; flags?: number }[] = [];
  const edits: { content?: string; components?: unknown }[] = [];
  const modals: { toJSON: () => unknown }[] = [];
  const state = { replied: false, deferred: false };

  const interaction = {
    customId: options.customId,
    createdTimestamp: Date.now() - (options.ageMs ?? 0),
    user: { id: USER },
    values: options.values ?? [],
    fields: {
      getTextInputValue: (id: string) => options.modalFields?.[id] ?? "",
    },
    inGuild: () => false,
    isRepliable: () => true,
    isButton: () => options.isButton ?? false,
    isStringSelectMenu: () => options.isSelect ?? false,
    isModalSubmit: () => options.isModal ?? false,
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    showModal: async (modal: { toJSON: () => unknown }) => {
      events.push("showModal");
      modals.push(modal);
    },
    deferUpdate: async () => {
      events.push("deferUpdate");
      state.deferred = true;
      options.onDeferUpdate?.();
    },
    deferReply: async () => {
      events.push("deferReply");
      state.deferred = true;
    },
    update: async (payload: { content?: string; components?: unknown }) => {
      events.push("update");
      edits.push(payload);
      state.replied = true;
    },
    editReply: async (payload: { content?: string; components?: unknown }) => {
      events.push("editReply");
      edits.push(payload);
      state.replied = true;
    },
    reply: async (payload: { content?: string; flags?: number }) => {
      events.push("reply");
      if (options.rejectReply) {
        // What Discord answers to a token that has already expired.
        throw Object.assign(new Error("Unknown interaction"), { code: 10062 });
      }
      replies.push(payload);
      state.replied = true;
    },
    followUp: async () => {
      events.push("followUp");
    },
  };

  return { interaction: interaction as unknown as Interaction, events, replies, edits, modals };
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bishop-interaction-"));
  process.env.BISHOP_SURVEY_DIR = dir;
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await drafts.reload();
  return dir;
}

test("the Next button is acknowledged before the draft file is written", async (t) => {
  const dir = await workspace(t);
  let fileAtAck: boolean | null = null;
  const click = fakeInteraction({
    customId: `survey:${DATE}:page:2`,
    isButton: true,
    onDeferUpdate: () => {
      fileAtAck = existsSync(draftsFile());
    },
  });

  await dispatch(click.interaction, { kind: "page", date: DATE, page: 2 });

  assert.deepEqual(click.events, ["deferUpdate", "editReply"], "ack, then edit; never a bare update");
  assert.equal(fileAtAck, false, "no file work may happen before the acknowledgement");
  assert.equal(existsSync(draftsFile()), true, "the page change is on disk");
  assert.match(String(click.edits.at(-1)?.content), /Page 2 of 3/);
});

test("an expired click gets a sentence instead of a 10062", async (t) => {
  await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const click = fakeInteraction({
    customId: `survey:${DATE}:page:2`,
    isButton: true,
    ageMs: 10_000,
  });

  await handleInteraction(click.interaction);

  assert.deepEqual(click.events, ["reply"]);
  assert.equal(click.replies.length, 1);
  assert.match(String(click.replies[0].content), /expired/);
  assert.equal(click.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(existsSync(draftsFile()), false, "an expired click does no work");
});

test("an expired click whose reply also expires does not throw", async (t) => {
  await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const click = fakeInteraction({
    customId: `survey:${DATE}:page:2`,
    isButton: true,
    ageMs: 10_000,
    rejectReply: true,
  });

  await assert.doesNotReject(handleInteraction(click.interaction));
});

test("a fresh click goes straight through, still acknowledged first", async (t) => {
  await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const click = fakeInteraction({
    customId: `survey:${DATE}:page:2`,
    isButton: true,
  });

  await handleInteraction(click.interaction);

  assert.deepEqual(click.events, ["deferUpdate", "editReply"]);
  assert.equal(click.replies.length, 0);
});

test("Submit acknowledges before the entry is written, then forgets the draft", async (t) => {
  const dir = await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const draft = drafts.ensure(USER, DATE, "2026-11-23T02:00:00.000Z");
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
  await drafts.persist();

  let entryAtAck: boolean | null = null;
  const click = fakeInteraction({
    customId: `survey:${DATE}:submit`,
    isButton: true,
    onDeferUpdate: () => {
      entryAtAck = existsSync(monthFile("2026-11", dir));
    },
  });

  await handleInteraction(click.interaction);

  assert.deepEqual(click.events, ["deferUpdate", "editReply"]);
  assert.equal(entryAtAck, false, "the JSONL write comes after the acknowledgement");
  const stored = (await readFile(monthFile("2026-11", dir), "utf8")).trim().split("\n");
  assert.equal(stored.length, 1);
  const entry = JSON.parse(stored[0]) as { answers: { medications: string[] } };
  assert.deepEqual(entry.answers.medications, ["PPI"], "the stored value is unchanged");
  assert.equal(drafts.get(USER, DATE), undefined);
  assert.equal(existsSync(draftsFile()), true);
  const onDisk = await readFile(draftsFile(), "utf8");
  assert.equal(onDisk.includes(USER), false, "a submitted evening is not a draft");
});

test("a restart between the prompt and Next keeps the earlier answers", async (t) => {
  await workspace(t);
  process.env.SURVEY_USER_IDS = USER;

  // She answers page one.
  const answer = fakeInteraction({
    customId: `survey:${DATE}:field:worst_pain`,
    isSelect: true,
    values: ["7"],
  });
  await handleInteraction(answer.interaction);

  // The service restarts before she presses Next: module memory is gone.
  await drafts.reload();
  assert.equal(drafts.get(USER, DATE)?.answers.worst_pain, 7);

  const next = fakeInteraction({ customId: `survey:${DATE}:page:2`, isButton: true });
  await handleInteraction(next.interaction);

  assert.deepEqual(next.events, ["deferUpdate", "editReply"]);
  assert.match(String(next.edits.at(-1)?.content), /answered 1 of 11/);
});

test("a select menu answer is acknowledged before it is stored", async (t) => {
  const dir = await workspace(t);
  let fileAtAck: boolean | null = null;
  const click = fakeInteraction({
    customId: `survey:${DATE}:field:worst_pain`,
    isSelect: true,
    values: ["7"],
    onDeferUpdate: () => {
      fileAtAck = existsSync(draftsFile());
    },
  });

  await dispatch(click.interaction, { kind: "field", date: DATE, field: "worst_pain" });

  assert.deepEqual(click.events, ["deferUpdate", "editReply"]);
  assert.equal(fileAtAck, false);
  assert.match(String(click.edits.at(-1)?.content), /answered 1 of 11/);
  assert.equal(drafts.get(USER, DATE)?.answers.worst_pain, 7);
  assert.equal(existsSync(join(dir, "drafts.json")), true);
});

test("the confirmation keeps Add notes and Edit tonight, and a resubmit replaces the line", async (t) => {
  const dir = await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const draft = drafts.ensure(USER, DATE, STARTED_AT);
  draft.answers = fullAnswers();
  await drafts.persist();

  const first = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(first.interaction);

  const confirmation = first.edits.at(-1);
  assert.match(String(confirmation?.content), /Edit tonight/);
  assert.deepEqual(
    buttonsOf(confirmation).map((button) => button.label),
    ["Add notes", "Edit tonight"],
    "the message keeps a way back after Submit",
  );
  assert.deepEqual(
    buttonsOf(confirmation).map((button) => button.custom_id),
    [`survey:${DATE}:notes`, `survey:${DATE}:edit`],
  );

  // Edit tonight reopens page one on the entry that was just stored.
  const edit = fakeInteraction({ customId: `survey:${DATE}:edit`, isButton: true });
  await handleInteraction(edit.interaction);
  assert.match(String(edit.edits.at(-1)?.content), /Page 1 of 3/);
  assert.match(String(edit.edits.at(-1)?.content), /answered 11 of 11/);
  assert.equal(drafts.get(USER, DATE)?.answers.worst_pain, 7, "the stored answers came back");

  // One answer changes, then Submit again.
  const change = fakeInteraction({
    customId: `survey:${DATE}:field:worst_pain`,
    isSelect: true,
    values: ["9"],
  });
  await handleInteraction(change.interaction);
  assert.equal(drafts.get(USER, DATE)?.answers.worst_pain, 9);

  const again = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(again.interaction);
  assert.match(String(again.edits.at(-1)?.content), /Replaced tonight's earlier answer/);

  const stored = await monthLines(dir);
  assert.equal(stored.length, 1, "a corrected evening is one line, not two");
  const entry = JSON.parse(stored[0]) as { answers: { worst_pain: number } };
  assert.equal(entry.answers.worst_pain, 9, "the line carries the new value");
});

test("Add notes after Submit opens on the stored notes and keeps one entry", async (t) => {
  const dir = await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const draft = drafts.ensure(USER, DATE, STARTED_AT);
  draft.answers = fullAnswers();
  draft.notes = { other: "cheese at lunch", red_flags_note: "" };
  await drafts.persist();

  const first = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(first.interaction);

  // The add-notes button: the modal comes back filled with what was stored.
  const addNotes = fakeInteraction({ customId: `survey:${DATE}:notes`, isButton: true });
  await handleInteraction(addNotes.interaction);
  assert.deepEqual(addNotes.events, ["showModal"]);
  assert.match(
    JSON.stringify(addNotes.modals[0]?.toJSON() ?? {}),
    /cheese at lunch/,
    "the notes box is prefilled with the stored note",
  );

  const modal = fakeInteraction({
    customId: `survey:${DATE}:notes-modal`,
    isModal: true,
    modalFields: {
      [NOTES_OTHER_INPUT]: "cheese at lunch, then tea",
      [NOTES_FLAGS_INPUT]: "blood in stool",
    },
  });
  await handleInteraction(modal.interaction);
  assert.match(String(modal.replies.at(-1)?.content), /Notes saved/);
  assert.deepEqual(
    buttonsOf(modal.replies.at(-1)).map((button) => button.label),
    ["Submit"],
    "the notes reply still offers Submit",
  );

  const again = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(again.interaction);

  const stored = await monthLines(dir);
  assert.equal(stored.length, 1, "adding notes does not add a second line");
  const entry = JSON.parse(stored[0]) as {
    notes: { other: string; red_flags_note: string };
    red_flags: string[];
  };
  assert.equal(entry.notes.other, "cheese at lunch, then tea");
  assert.equal(entry.notes.red_flags_note, "blood in stool");
  assert.ok(entry.red_flags.includes("gi_bleeding"), "the flag is still derived from the notes");
});

test("a restart between Submit and the confirmation buttons does not break them", async (t) => {
  const dir = await workspace(t);
  process.env.SURVEY_USER_IDS = USER;
  const draft = drafts.ensure(USER, DATE, STARTED_AT);
  draft.answers = fullAnswers();
  draft.notes = { other: "bread at breakfast", red_flags_note: "" };
  await drafts.persist();

  const first = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(first.interaction);
  assert.equal(drafts.get(USER, DATE), undefined, "Submit drops the draft");

  // The service restarts: nothing is in memory and drafts.json is empty.
  await drafts.reload();

  const addNotes = fakeInteraction({ customId: `survey:${DATE}:notes`, isButton: true });
  await handleInteraction(addNotes.interaction);
  assert.deepEqual(addNotes.events, ["showModal"], "Add notes works with no draft in memory");
  assert.match(JSON.stringify(addNotes.modals[0]?.toJSON() ?? {}), /bread at breakfast/);

  // And a second restart before Edit tonight: still rebuilt from the entry.
  await drafts.reload();

  const edit = fakeInteraction({ customId: `survey:${DATE}:edit`, isButton: true });
  await handleInteraction(edit.interaction);
  assert.match(String(edit.edits.at(-1)?.content), /Page 1 of 3/);
  assert.match(String(edit.edits.at(-1)?.content), /answered 11 of 11/);
  assert.equal(drafts.get(USER, DATE)?.answers.bloating, 3);

  const again = fakeInteraction({ customId: `survey:${DATE}:submit`, isButton: true });
  await handleInteraction(again.interaction);
  assert.equal((await monthLines(dir)).length, 1, "the resubmit still replaces the line");
});
