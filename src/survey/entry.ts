/**
 * One stored check-in, and the only place its shape is assembled.
 *
 * The object is exactly what the spec fixes: `{date, user, started_at,
 * submitted_at, answers, notes, red_flags}`. Red flags are derived from the
 * notes at build time, so what the confirmation says and what the file records
 * can never disagree. Serialisation is `JSON.stringify` in storage.ts; nothing
 * escapes anything by hand.
 */
import type { Answers } from "./fields.js";
import { detectRedFlags } from "./redflags.js";

export interface SurveyNotes {
  /** "anything else (foods, timing, stool colour, mucus)" */
  other: string;
  /** "anything from the red-flag list today" */
  red_flags_note: string;
}

export interface SurveyEntry {
  /** Calendar date the entry is about, `YYYY-MM-DD`, in the survey zone. */
  date: string;
  /** Discord user id. */
  user: string;
  /** When the prompt was first shown for that date. */
  started_at: string;
  /** When Submit was pressed. */
  submitted_at: string;
  answers: Answers;
  notes: SurveyNotes;
  /** Red-flag keys that fired, in list order. Empty on a normal day. */
  red_flags: string[];
}

export interface BuildEntryInput {
  userId: string;
  date: string;
  startedAt: string;
  answers: Answers;
  notes: SurveyNotes;
  submittedAt?: Date;
}

/** Assembles a complete entry, including the red flags its notes imply. */
export function buildEntry(input: BuildEntryInput): SurveyEntry {
  const notes: SurveyNotes = {
    other: (input.notes.other ?? "").trim(),
    red_flags_note: (input.notes.red_flags_note ?? "").trim(),
  };
  return {
    date: input.date,
    user: input.userId,
    started_at: input.startedAt,
    submitted_at: (input.submittedAt ?? new Date()).toISOString(),
    answers: input.answers,
    notes,
    red_flags: detectRedFlags(notes.red_flags_note),
  };
}
