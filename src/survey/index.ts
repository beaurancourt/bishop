/**
 * The check-in's gateway glue: component ids in, JSONL out, one DM at 21:00.
 *
 * No message-content intent and no typed commands: every interaction is a select
 * menu, a button or a modal, all of which arrive on the non-privileged `Guilds`
 * intent. The only text she types is inside the two modal boxes.
 */
import {
  ActionRowBuilder,
  type Client,
  Events,
  type Interaction,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { deliverDaily } from "./deliver.js";
import { isEnrolled, loadEnrollment } from "./enroll.js";
import { buildEntry, type SurveyEntry, type SurveyNotes } from "./entry.js";
import { type Answers, applyAnswer, fieldByKey, PAGE_COUNT } from "./fields.js";
import {
  buildSurveyMessage,
  customIds,
  deletePrompt,
  formatDateLabel,
  introMessage,
  missingFieldsNotice,
  NOTES_FLAGS_INPUT,
  NOTES_OTHER_INPUT,
  parseCustomId,
  resumeButton,
  type SurveyCustomId,
  submitRow,
} from "./prompt.js";
import { detectRedFlags, redFlagMessage } from "./redflags.js";
import { DailyTimer } from "./schedule.js";
import {
  deleteUserEntries,
  hasEntry,
  isPaused,
  monthKey,
  patchUserState,
  saveEntry,
  userState,
} from "./storage.js";
import { isoDateInZone, parseAt, SURVEY_TIME_ZONE } from "./time.js";

interface Draft {
  userId: string;
  date: string;
  startedAt: string;
  answers: Answers;
  notes: SurveyNotes;
  page: number;
}

/**
 * In-memory drafts, keyed `userId|date`. A restart loses half-finished pages,
 * not saved entries: the entry is written on Submit, and an interaction after a
 * restart recreates the draft from that click onward.
 */
const drafts = new Map<string, Draft>();

const draftKey = (userId: string, date: string): string => `${userId}|${date}`;

function draftFor(userId: string, date: string, startedAt?: string): Draft {
  const key = draftKey(userId, date);
  const existing = drafts.get(key);
  if (existing) return existing;
  const fresh: Draft = {
    userId,
    date,
    startedAt: startedAt ?? new Date().toISOString(),
    answers: {},
    notes: { other: "", red_flags_note: "" },
    page: 1,
  };
  drafts.set(key, fresh);
  return fresh;
}

/** Drops yesterday's half-finished pages when a new evening starts. */
function pruneDrafts(date: string): void {
  for (const [key, draft] of drafts) {
    if (draft.date !== date) drafts.delete(key);
  }
}

function notesModal(date: string): ModalBuilder {
  const other = new TextInputBuilder()
    .setCustomId(NOTES_OTHER_INPUT)
    .setLabel("Anything else (foods, timing, colour)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);
  const flags = new TextInputBuilder()
    .setCustomId(NOTES_FLAGS_INPUT)
    .setLabel("Anything from the red-flag list today")
    .setPlaceholder("Leave blank if none")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);
  return new ModalBuilder()
    .setCustomId(customIds.notesModal(date))
    .setTitle("Notes")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(other),
      new ActionRowBuilder<TextInputBuilder>().addComponents(flags),
    );
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  const customId = "customId" in interaction ? interaction.customId : undefined;
  if (!customId) return;
  const parsed = parseCustomId(customId);
  if (!parsed) return;

  if (interaction.inGuild()) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "The gut check-in only works in a direct message.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const enrolled = await loadEnrollment();
  if (!isEnrolled(interaction.user.id, enrolled)) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "The gut check-in is not enabled for this account.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  try {
    await dispatch(interaction, parsed);
  } catch (err) {
    console.error("survey: interaction failed", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "Something went wrong saving that. Please try it again.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }
}

async function dispatch(interaction: Interaction, parsed: SurveyCustomId): Promise<void> {
  switch (parsed.kind) {
    case "field": {
      if (!interaction.isStringSelectMenu()) return;
      const draft = draftFor(interaction.user.id, parsed.date);
      try {
        draft.answers = applyAnswer(draft.answers, parsed.field, interaction.values);
      } catch {
        await interaction.reply({
          content: "That answer could not be read. Please pick it again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      draft.page = fieldByKey(parsed.field)?.page ?? draft.page;
      await interaction.update(buildSurveyMessage(draft.date, draft.answers, draft.page));
      return;
    }

    case "page": {
      if (!interaction.isButton()) return;
      const draft = draftFor(interaction.user.id, parsed.date);
      draft.page = parsed.page;
      await interaction.update(buildSurveyMessage(draft.date, draft.answers, parsed.page));
      return;
    }

    case "notes": {
      if (!interaction.isButton()) return;
      await interaction.showModal(notesModal(parsed.date));
      return;
    }

    case "notes-modal": {
      if (!interaction.isModalSubmit()) return;
      const draft = draftFor(interaction.user.id, parsed.date);
      draft.notes = {
        other: interaction.fields.getTextInputValue(NOTES_OTHER_INPUT).trim(),
        red_flags_note: interaction.fields.getTextInputValue(NOTES_FLAGS_INPUT).trim(),
      };
      draft.page = PAGE_COUNT;
      const fired = redFlagMessage(detectRedFlags(draft.notes.red_flags_note));
      await interaction.reply({
        content: ["Notes saved.", fired, "Press **Submit** to write tonight's entry."]
          .filter((line): line is string => Boolean(line))
          .join("\n\n"),
        components: [submitRow(parsed.date)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case "submit": {
      if (!interaction.isButton()) return;
      const draft = draftFor(interaction.user.id, parsed.date);
      const missing = missingFieldsNotice(draft.answers);
      if (missing) {
        await interaction.reply({ content: missing, flags: MessageFlags.Ephemeral });
        return;
      }
      const entry = buildEntry({
        userId: interaction.user.id,
        date: draft.date,
        startedAt: draft.startedAt,
        answers: draft.answers,
        notes: draft.notes,
      });
      const { action, monthCount } = await saveEntry(entry);
      drafts.delete(draftKey(entry.user, entry.date));
      await interaction.update({
        content: confirmationCopy(entry, action, monthCount),
        components: [],
      });
      return;
    }

    case "pause": {
      if (!interaction.isButton()) return;
      await patchUserState(interaction.user.id, { paused_at: new Date().toISOString() });
      await interaction.reply({ ...resumeButton(), flags: MessageFlags.Ephemeral });
      return;
    }

    case "resume": {
      if (!interaction.isButton()) return;
      await patchUserState(interaction.user.id, { paused_at: null });
      await interaction.reply({
        content: "Resumed. The next check-in arrives at the usual evening time.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case "delete": {
      if (!interaction.isButton()) return;
      await interaction.reply({ ...deletePrompt(), flags: MessageFlags.Ephemeral });
      return;
    }

    case "delete-confirm": {
      if (!interaction.isButton()) return;
      const removed = await deleteUserEntries(interaction.user.id);
      // Cleared intro: if she comes back, the explanation comes first again.
      await patchUserState(interaction.user.id, {
        paused_at: new Date().toISOString(),
        intro_sent_at: undefined,
      });
      await interaction.reply({
        content: [
          removed === 0
            ? "No entries were stored for this account, so there was nothing to delete."
            : `Deleted ${removed} ${removed === 1 ? "entry" : "entries"}. Nothing is left in bishop's files for this account.`,
          "The nightly check-in is paused. Press **Resume** to start again.",
        ].join("\n\n"),
        components: resumeButton().components,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
}

function confirmationCopy(
  entry: SurveyEntry,
  action: "appended" | "updated",
  monthCount: number,
): string {
  const when = action === "updated" ? "Replaced tonight's earlier answer" : "Saved";
  const lines = [
    `✅ ${when} for ${formatDateLabel(entry.date)}.`,
    `That is ${monthCount} ${monthCount === 1 ? "entry" : "entries"} in ${monthKey(entry.date)}.`,
    "Submitting again tonight corrects it rather than adding a second one.",
  ];
  const flags = redFlagMessage(entry.red_flags);
  if (flags) lines.push(flags);
  return lines.join("\n\n");
}

async function openDm(client: Client, userId: string) {
  const user = await client.users.fetch(userId);
  return user.createDM();
}

async function sendDaily(client: Client, options: { startedAt?: Date } = {}): Promise<void> {
  const timeZone = process.env.SURVEY_TIME_ZONE ?? SURVEY_TIME_ZONE;
  const now = options.startedAt ?? new Date();
  const date = isoDateInZone(now, timeZone);
  const enrolled = [...(await loadEnrollment())];
  pruneDrafts(date);

  const report = await deliverDaily({
    enrolled,
    date,
    startedAt: now.toISOString(),
    isPaused: (userId) => isPaused(userId),
    hasEntryToday: (userId) => hasEntry(userId, date),
    introSent: async (userId) => (await userState(userId)).intro_sent_at != null,
    sendIntro: async (userId) => {
      const dm = await openDm(client, userId);
      await dm.send(introMessage());
      await patchUserState(userId, { intro_sent_at: new Date().toISOString() });
    },
    sendPrompt: async (userId, promptDate, startedAt) => {
      draftFor(userId, promptDate, startedAt);
      const dm = await openDm(client, userId);
      await dm.send(buildSurveyMessage(promptDate, {}, 1));
    },
  });

  console.log(
    `survey: ${date} — sent ${report.sent.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`,
  );
  for (const skip of report.skipped) {
    console.log(`survey: skipped ${skip.userId} (${skip.reason})`);
  }
  for (const failure of report.failed) {
    console.warn(`survey: could not DM ${failure.userId}: ${failure.error}`);
  }
}

async function startScheduler(client: Client): Promise<void> {
  const timeZone = process.env.SURVEY_TIME_ZONE ?? SURVEY_TIME_ZONE;
  let at: { hour: number; minute: number };
  try {
    at = parseAt(process.env.SURVEY_AT ?? "21:00");
  } catch (err) {
    console.error(`survey: ${(err as Error).message}; the daily check-in is off`);
    return;
  }

  const enrolled = await loadEnrollment();
  if (enrolled.size === 0) {
    console.warn(
      "survey: no enrolled user ids (SURVEY_USER_IDS or the config file); the daily check-in is idle",
    );
    return;
  }

  const timer = new DailyTimer({ timeZone, hour: at.hour, minute: at.minute }, () =>
    sendDaily(client),
  );
  const due = timer.start();
  console.log(
    `survey: ${enrolled.size} enrolled; next check-in ${due.toISOString()} (${at.hour}:${String(at.minute).padStart(2, "0")} ${timeZone})`,
  );

  if (process.env.SURVEY_SEND_ON_START === "1") {
    console.log("survey: SURVEY_SEND_ON_START=1, sending a check-in now");
    await sendDaily(client);
  }
}

/**
 * The single wiring point. `src/index.ts` calls this once after it builds the
 * client; nothing in the calendar/event path changes.
 */
export function installSurvey(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((err) => {
      console.error("survey: interaction failed", err);
    });
  });
  client.once(Events.ClientReady, () => {
    void startScheduler(client).catch((err) => {
      console.error("survey: scheduler failed to start", err);
    });
  });
}
