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
import { type Draft, DraftStore } from "./drafts.js";
import { isEnrolled, loadEnrollment } from "./enroll.js";
import { buildEntry, type SurveyNotes, type SurveyEntry } from "./entry.js";
import { applyAnswer, fieldByKey, PAGE_COUNT } from "./fields.js";
import {
  buildSurveyMessage,
  confirmationRow,
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
  findEntry,
  hasEntry,
  isPaused,
  monthKey,
  patchUserState,
  saveEntry,
  userState,
} from "./storage.js";
import { isoDateInZone, parseAt, SURVEY_TIME_ZONE } from "./time.js";

/**
 * Half-finished check-ins, keyed `userId|date`, written through to
 * `data/survey/drafts.json` on every change and read back at startup. A restart
 * between two pages hands the next click the answers from the earlier pages; an
 * entry is still only written on Submit.
 */
export const drafts = new DraftStore();

/** Discord's callback window is three seconds; leave the network some room. */
const INTERACTION_DEADLINE_MS = 2_500;

const EXPIRED_COPY = "This check-in message has expired — ask for a fresh one.";

function notesModal(date: string, notes?: SurveyNotes): ModalBuilder {
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
  // Add notes after Submit opens on what was stored, so correcting a note is
  // editing it rather than typing it again.
  if (notes?.other) other.setValue(notes.other);
  if (notes?.red_flags_note) flags.setValue(notes.red_flags_note);
  return new ModalBuilder()
    .setCustomId(customIds.notesModal(date))
    .setTitle("Notes")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(other),
      new ActionRowBuilder<TextInputBuilder>().addComponents(flags),
    );
}

/**
 * The draft for an evening, rebuilt from the stored entry when memory has
 * nothing: Submit drops the draft, and the confirmation's buttons (or a stale
 * page click) then open the stored answers and notes as the draft. A resubmit
 * replaces that date's line, as storage already does. Works across a restart,
 * because the entry is on disk and not in this process.
 */
async function draftFor(userId: string, date: string): Promise<Draft> {
  const existing = drafts.get(userId, date);
  if (existing) return existing;
  const stored = await findEntry(userId, date);
  const draft = drafts.ensure(userId, date, stored?.started_at);
  if (!stored) return draft;
  draft.answers = { ...stored.answers };
  draft.notes = { ...stored.notes };
  await drafts.persist();
  return draft;
}

/** How long Discord gives before a click can no longer be answered at all. */
function isExpired(interaction: Interaction): boolean {
  const age = Date.now() - interaction.createdTimestamp;
  return Number.isFinite(age) && age > INTERACTION_DEADLINE_MS;
}

/**
 * Tells her the message is too old to answer. The reply itself may fail with the
 * same 10062 — an expired token rejects everything — so it is never allowed to
 * throw: the point is a sentence, not a stack trace.
 */
async function apologiseForExpiry(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  await interaction
    .reply({ content: EXPIRED_COPY, flags: MessageFlags.Ephemeral })
    .catch((err) => {
      console.warn(`survey: could not answer an expired interaction (${String(err)})`);
    });
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
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

  // A late event — a reconnect, a busy box — is past the three-second window
  // before this process sees it, and every callback would answer 10062. Say the
  // sentence instead, and do not run the work.
  if (isExpired(interaction)) {
    await apologiseForExpiry(interaction);
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

  // One read of drafts.json for the life of the process; a no-op after startup.
  await drafts.load();

  try {
    await dispatch(interaction, parsed);
  } catch (err) {
    console.error("survey: interaction failed", err);
    if (!interaction.isRepliable()) return;
    if (interaction.deferred) {
      // A deferred component update keeps the check-in message standing, so the
      // apology goes beside it rather than replacing it.
      await interaction
        .followUp({
          content: "Something went wrong saving that. Please try it again.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    } else if (!interaction.replied) {
      await interaction
        .reply({
          content: "Something went wrong saving that. Please try it again.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }
}

/**
 * The acknowledgement rule: every component is acknowledged first, with
 * `deferUpdate` when the message itself will be edited and `deferReply` when the
 * answer is a new ephemeral message. The notes button is the exception —
 * `showModal` is its acknowledgement. Nothing slow (a file write, an API call
 * for someone else) happens before the ack.
 */
export async function dispatch(interaction: Interaction, parsed: SurveyCustomId): Promise<void> {
  switch (parsed.kind) {
    case "field": {
      if (!interaction.isStringSelectMenu()) return;
      await interaction.deferUpdate();
      const draft = await draftFor(interaction.user.id, parsed.date);
      try {
        draft.answers = applyAnswer(draft.answers, parsed.field, interaction.values);
      } catch {
        await interaction.followUp({
          content: "That answer could not be read. Please pick it again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      draft.page = fieldByKey(parsed.field)?.page ?? draft.page;
      await drafts.persist();
      await interaction.editReply(buildSurveyMessage(draft.date, draft.answers, draft.page));
      return;
    }

    case "page": {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      const draft = await draftFor(interaction.user.id, parsed.date);
      draft.page = parsed.page;
      await drafts.persist();
      await interaction.editReply(buildSurveyMessage(draft.date, draft.answers, parsed.page));
      return;
    }

    case "notes": {
      if (!interaction.isButton()) return;
      // showModal is the acknowledgement, but the modal must be sent already
      // filled, so tonight's notes are resolved first. That is the draft when
      // one is open and the stored entry after Submit, both local reads; the
      // notes themselves come back on the modal, so no message edit is needed.
      const draft = await draftFor(interaction.user.id, parsed.date);
      await interaction.showModal(notesModal(parsed.date, draft.notes));
      return;
    }

    case "edit": {
      if (!interaction.isButton()) return;
      // Edit tonight reopens page one on tonight's entry; every page after it
      // shows those stored answers, so Submit replaces the one line.
      await interaction.deferUpdate();
      const draft = await draftFor(interaction.user.id, parsed.date);
      draft.page = 1;
      await drafts.persist();
      await interaction.editReply(buildSurveyMessage(draft.date, draft.answers, 1));
      return;
    }

    case "notes-modal": {
      if (!interaction.isModalSubmit()) return;
      const draft = drafts.ensure(interaction.user.id, parsed.date);
      draft.notes = {
        other: interaction.fields.getTextInputValue(NOTES_OTHER_INPUT).trim(),
        red_flags_note: interaction.fields.getTextInputValue(NOTES_FLAGS_INPUT).trim(),
      };
      draft.page = PAGE_COUNT;
      await drafts.persist();
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
      // Normally the draft is in memory (loaded at startup), so the blank check
      // costs no I/O and a missing answer is named before anything is deferred.
      // A Submit that follows a confirmation click has no draft: the answers
      // come from the stored entry, which is read after the acknowledgement.
      const cached = drafts.get(interaction.user.id, parsed.date);
      if (cached) {
        const missing = missingFieldsNotice(cached.answers);
        if (missing) {
          await interaction.reply({ content: missing, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      await interaction.deferUpdate();
      const draft = cached ?? (await draftFor(interaction.user.id, parsed.date));
      if (!cached) {
        const missing = missingFieldsNotice(draft.answers);
        if (missing) {
          await interaction.followUp({ content: missing, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      const entry = buildEntry({
        userId: interaction.user.id,
        date: draft.date,
        startedAt: draft.startedAt,
        answers: draft.answers,
        notes: draft.notes,
      });
      const { action, monthCount } = await saveEntry(entry);
      await drafts.drop(entry.user, entry.date);
      // Two ways back: the copy promises a resubmit corrects the line, so the
      // message keeps a buttons row that rebuilds tonight's draft from the entry.
      await interaction.editReply({
        content: confirmationCopy(entry, action, monthCount),
        components: [confirmationRow(entry.date)],
      });
      return;
    }

    case "pause": {
      if (!interaction.isButton()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await patchUserState(interaction.user.id, { paused_at: new Date().toISOString() });
      await interaction.editReply(resumeButton());
      return;
    }

    case "resume": {
      if (!interaction.isButton()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await patchUserState(interaction.user.id, { paused_at: null });
      await interaction.editReply({
        content: "Resumed. The next check-in arrives at the usual evening time.",
      });
      return;
    }

    case "delete": {
      if (!interaction.isButton()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(deletePrompt());
      return;
    }

    case "delete-confirm": {
      if (!interaction.isButton()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const removed = await deleteUserEntries(interaction.user.id);
      // A half-filled evening is her data too, and Delete my data says nothing
      // is left behind.
      await drafts.dropUser(interaction.user.id);
      // Cleared intro: if she comes back, the explanation comes first again.
      await patchUserState(interaction.user.id, {
        paused_at: new Date().toISOString(),
        intro_sent_at: undefined,
      });
      await interaction.editReply({
        content: [
          removed === 0
            ? "No entries were stored for this account, so there was nothing to delete."
            : `Deleted ${removed} ${removed === 1 ? "entry" : "entries"}. Nothing is left in bishop's files for this account.`,
          "The nightly check-in is paused. Press **Resume** to start again.",
        ].join("\n\n"),
        components: resumeButton().components,
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
    "**Edit tonight** changes an answer, and submitting again corrects this one line rather than adding a second. **Add notes** adds anything else.",
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
  await drafts.prune(date);

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
      // The blank draft records when the evening began; keep it across restarts.
      drafts.ensure(userId, promptDate, startedAt);
      await drafts.persist();
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
  // A restart resumes the evenings in progress; this is the only read. Pruning
  // stays with the evening's own run (sendDaily), so a restart just after
  // midnight cannot drop a draft from the evening that has only just ended.
  await drafts.load();

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
