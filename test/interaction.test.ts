import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageFlags, type Interaction } from "discord.js";
import { drafts, dispatch, handleInteraction } from "../src/survey/index.js";
import { draftsFile } from "../src/survey/drafts.js";
import { monthFile } from "../src/survey/storage.js";

const USER = "111111111111111111";
const DATE = "2026-11-23";

interface FakeOptions {
  customId: string;
  isButton?: boolean;
  isSelect?: boolean;
  values?: string[];
  /** How long ago Discord says the click happened. */
  ageMs?: number;
  onDeferUpdate?: () => void;
  rejectReply?: boolean;
}

interface Fake {
  interaction: Interaction;
  events: string[];
  replies: { content?: string; flags?: number }[];
  edits: { content?: string }[];
}

/**
 * Enough of an interaction to run the handler: the methods dispatch and
 * handleInteraction call, a recording log, and a clock the test controls.
 */
function fakeInteraction(options: FakeOptions): Fake {
  const events: string[] = [];
  const replies: { content?: string; flags?: number }[] = [];
  const edits: { content?: string }[] = [];
  const state = { replied: false, deferred: false };

  const interaction = {
    customId: options.customId,
    createdTimestamp: Date.now() - (options.ageMs ?? 0),
    user: { id: USER },
    values: options.values ?? [],
    inGuild: () => false,
    isRepliable: () => true,
    isButton: () => options.isButton ?? false,
    isStringSelectMenu: () => options.isSelect ?? false,
    isModalSubmit: () => false,
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    showModal: async () => {
      events.push("showModal");
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
    update: async (payload: { content?: string }) => {
      events.push("update");
      edits.push(payload);
      state.replied = true;
    },
    editReply: async (payload: { content?: string }) => {
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

  return { interaction: interaction as unknown as Interaction, events, replies, edits };
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
