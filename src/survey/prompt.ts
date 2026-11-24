/**
 * Everything the check-in says in Discord: the twenty-four selects, the page buttons,
 * the notes modal, the intro, and the control acks. Plain data only, so the
 * builder can be unit-tested without a client or a gateway.
 *
 * Custom ids carry the entry date, because a component can be clicked days
 * after the message was sent and the answer still belongs to that evening.
 */
import type { APIActionRowComponent, APIComponentInMessageActionRow } from "discord.js";
import type { SurveyNotes } from "./entry.js";
import {
  type Answers,
  type FieldDef,
  type OtherNoteKey,
  PAGE_COUNT,
  answeredCount,
  displayValue,
  FIELDS,
  fieldsOnPage,
  fieldByKey,
  missingFields,
  otherNoteKey,
  selectedValues,
} from "./fields.js";

export const CUSTOM_ID_PREFIX = "survey";

/** Text inputs in the notes modal. */
export const NOTES_OTHER_INPUT = "survey-notes-other";
export const NOTES_FLAGS_INPUT = "survey-notes-flags";

/** Discord's own limit on a short text input; the survey's words fit inside it. */
export const OTHER_INPUT_MAX = 200;

/** The one text box of the "which other?" modal, named for its select. */
export function otherInputId(field: string): string {
  return `survey-other-${field}`;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type SurveyCustomId =
  | { kind: "field"; date: string; field: string }
  | { kind: "page"; date: string; page: number }
  | { kind: "notes"; date: string }
  | { kind: "edit"; date: string }
  | { kind: "submit"; date: string }
  | { kind: "notes-modal"; date: string }
  | { kind: "other-modal"; date: string; field: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "delete" }
  | { kind: "delete-confirm" };

export const customIds = {
  field: (date: string, field: string) => `${CUSTOM_ID_PREFIX}:${date}:field:${field}`,
  page: (date: string, page: number) => `${CUSTOM_ID_PREFIX}:${date}:page:${page}`,
  notes: (date: string) => `${CUSTOM_ID_PREFIX}:${date}:notes`,
  edit: (date: string) => `${CUSTOM_ID_PREFIX}:${date}:edit`,
  submit: (date: string) => `${CUSTOM_ID_PREFIX}:${date}:submit`,
  notesModal: (date: string) => `${CUSTOM_ID_PREFIX}:${date}:notes-modal`,
  otherModal: (date: string, field: string) => `${CUSTOM_ID_PREFIX}:${date}:other-modal:${field}`,
  pause: () => `${CUSTOM_ID_PREFIX}:pause`,
  resume: () => `${CUSTOM_ID_PREFIX}:resume`,
  delete: () => `${CUSTOM_ID_PREFIX}:delete`,
  deleteConfirm: () => `${CUSTOM_ID_PREFIX}:delete-confirm`,
};

/** Reads a custom id back, or null when it belongs to another feature. */
export function parseCustomId(raw: string): SurveyCustomId | null {
  const parts = raw.split(":");
  if (parts[0] !== CUSTOM_ID_PREFIX) return null;
  if (parts.length === 2) {
    switch (parts[1]) {
      case "pause":
        return { kind: "pause" };
      case "resume":
        return { kind: "resume" };
      case "delete":
        return { kind: "delete" };
      case "delete-confirm":
        return { kind: "delete-confirm" };
      default:
        return null;
    }
  }
  const date = parts[1];
  if (!date || !DATE_PATTERN.test(date)) return null;
  switch (parts[2]) {
    case "field": {
      const field = parts[3];
      return field ? { kind: "field", date, field } : null;
    }
    case "page": {
      const page = Number(parts[3]);
      if (!Number.isInteger(page) || page < 1 || page > PAGE_COUNT) return null;
      return { kind: "page", date, page };
    }
    case "notes":
      return { kind: "notes", date };
    case "edit":
      return { kind: "edit", date };
    case "submit":
      return { kind: "submit", date };
    case "notes-modal":
      return { kind: "notes-modal", date };
    case "other-modal": {
      const field = parts[3];
      if (!field || !fieldByKey(field)) return null;
      return { kind: "other-modal", date, field };
    }
    default:
      return null;
  }
}

export interface SurveyMessage {
  content: string;
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Mon 23 Nov 2026" from a calendar date, with no locale or zone involved. */
export function formatDateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTHS[m - 1]} ${y}`;
}

function selectRow(field: FieldDef, date: string, answers: Answers): APIActionRowComponent<APIComponentInMessageActionRow> {
  const selected = new Set(selectedValues(field, answers[field.key]));
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customIds.field(date, field.key),
        placeholder: field.placeholder,
        min_values: 1,
        max_values: field.kind === "multi" ? field.options.length : 1,
        options: field.options.map((option) => ({
          label: option.label,
          value: option.value,
          default: selected.has(option.value),
        })),
      },
    ],
  };
}

function buttonRow(
  date: string,
  page: number,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  const buttons: APIComponentInMessageActionRow[] = [];
  if (page > 1) {
    buttons.push({
      type: 2,
      style: 2,
      label: "Back",
      custom_id: customIds.page(date, page - 1),
    });
  }
  if (page < PAGE_COUNT) {
    buttons.push({
      type: 2,
      style: 2,
      label: "Next",
      custom_id: customIds.page(date, page + 1),
    });
  } else {
    buttons.push({
      type: 2,
      style: 2,
      label: "Notes",
      custom_id: customIds.notes(date),
    });
    buttons.push({
      type: 2,
      style: 3,
      label: "Submit",
      custom_id: customIds.submit(date),
    });
  }
  return { type: 1, components: buttons };
}

/** What a notes key is called when the prompt echoes back what she typed. */
export function otherLabel(key: OtherNoteKey): string {
  return key === "other_meds" ? "Other medication" : "Other food";
}

/** The page a notes key belongs to: the select whose `other` answer filled it. */
function otherNotePage(key: OtherNoteKey): number {
  const field = FIELDS.find((candidate) => otherNoteKey(candidate) === key);
  return field?.page ?? 1;
}

/**
 * One page of the check-in. `answers` drives the selected options, so a page
 * re-rendered after a click shows what has already been answered. `notes` adds
 * the words a select's `other` answer collected, beside the menu that asked.
 */
export function buildSurveyMessage(
  date: string,
  answers: Answers,
  page = 1,
  notes?: SurveyNotes,
): SurveyMessage {
  const fields = fieldsOnPage(page);
  const content: string[] = [`🩺 **Gut check-in · ${formatDateLabel(date)}**`, ""];

  if (page === 1) {
    content.push(
      `${FIELDS.length} taps, then **Notes** if you want to add anything. This is a diary for your clinic, not medical advice.`,
      "",
    );
  }
  content.push(
    `Page ${page} of ${PAGE_COUNT} · answered ${answeredCount(answers)} of ${FIELDS.length}.`,
  );
  for (const key of ["other_meds", "other_foods"] as const) {
    const text = notes?.[key];
    if (text && otherNotePage(key) === page) content.push(`${otherLabel(key)}: ${text}`);
  }
  if (page === PAGE_COUNT) {
    content.push(`When all ${FIELDS.length} are in, put anything else in **Notes**, then press **Submit**.`);
  }

  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = fields.map((field) =>
    selectRow(field, date, answers),
  );
  components.push(buttonRow(date, page));
  return { content: content.join("\n"), components };
}

/** Which fields are still blank, phrased for a reminder reply. */
export function missingFieldsNotice(answers: Answers): string | null {
  const missing = missingFields(answers);
  if (missing.length === 0) return null;
  return [
    "Almost — these are still blank:",
    ...missing.map((field) => `• ${field.prompt}`),
  ].join("\n");
}

/** One-line echo of a page's answers, used in the saved-entry confirmation. */
export function summarise(answers: Answers): string {
  return FIELDS.map((field) => `${field.prompt}: ${displayValue(field, answers[field.key])}`).join(
    "\n",
  );
}

export const INTRO_COPY = [
  "👋 **A month of gut check-ins.**",
  "",
  `From tonight I will send a short check-in at 21:00 each day: ${FIELDS.length} taps about today, then a **Notes** button for anything else — food, timing, stool colour, mucus, or anything from the red-flag list.`,
  "",
  "Each entry is one line in a file on pop. Nobody else reads it; you hand the export to your clinic when you are ready. Recording a day is optional — a skipped day is recorded as skipped, never as zero.",
  "",
  "This is **not medical advice**. It cannot diagnose anything, and it will never tell you a symptom is fine. If you report a red flag, it will tell you to contact your doctor today, and to seek urgent care for vomiting blood, black stools, fainting, severe chest pain, or cold sweats with chest or upper-abdominal pain.",
  "",
  "**Pause** stops the nightly check-in. **Delete my data** removes every entry bishop holds for you.",
].join("\n");

export function introMessage(): SurveyMessage {
  return {
    content: INTRO_COPY,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "Pause", custom_id: customIds.pause() },
          { type: 2, style: 4, label: "Delete my data", custom_id: customIds.delete() },
        ],
      },
    ],
  };
}

export const PAUSED_COPY =
  "Paused. No check-in will arrive until you press **Resume**. Your existing entries are untouched.";

export function resumeButton(): SurveyMessage {
  return {
    content: PAUSED_COPY,
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 1, label: "Resume", custom_id: customIds.resume() }],
      },
    ],
  };
}

export const DELETE_PROMPT_COPY =
  "This removes every gut check-in entry bishop holds for you, for every month. It cannot be undone.\n\nPress the button only if you mean it.";

/** The Submit button on its own, for the reply that follows the notes modal. */
export function submitRow(date: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  return {
    type: 1,
    components: [{ type: 2, style: 3, label: "Submit", custom_id: customIds.submit(date) }],
  };
}

/**
 * What the confirmation offers after Submit. Both buttons carry the entry's
 * date, so a click days later still edits that evening rather than today's
 * blank draft: Add notes reopens the notes modal on the stored notes, and Edit
 * tonight reopens page one on the stored answers, ready for a resubmit.
 */
export function confirmationRow(
  date: string,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: "Add notes", custom_id: customIds.notes(date) },
      { type: 2, style: 2, label: "Edit tonight", custom_id: customIds.edit(date) },
    ],
  };
}


export function deletePrompt(): SurveyMessage {
  return {
    content: DELETE_PROMPT_COPY,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "Yes, delete my data", custom_id: customIds.deleteConfirm() },
        ],
      },
    ],
  };
}
