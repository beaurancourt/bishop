/**
 * Append-only JSONL storage for the check-in, plus the small state file that
 * remembers who has seen the intro and who is paused.
 *
 * Layout under the bot's data directory (outside git, on pop):
 *
 *   data/survey/2026-11.jsonl   one entry per line, one file per month
 *   data/survey/state.json      intro sent, paused, nothing clinical
 *
 * A second submission for the same date and user rewrites that one line, so a
 * corrected evening does not appear twice. Everything is written through
 * `JSON.stringify`, so a note containing quotes, newlines or emoji cannot break
 * the file. Writes go to a temporary file and are renamed into place, and
 * concurrent writers are serialised per directory.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SurveyEntry } from "./entry.js";

export const DEFAULT_SURVEY_DIR = "data/survey";

/** Where entries and state live. `BISHOP_SURVEY_DIR` moves it (tests, dev). */
export function surveyDir(dir?: string): string {
  return dir ?? process.env.BISHOP_SURVEY_DIR ?? DEFAULT_SURVEY_DIR;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthFile(month: string, dir?: string): string {
  if (!MONTH_PATTERN.test(month)) throw new Error(`bad month ${JSON.stringify(month)}`);
  return join(surveyDir(dir), `${month}.jsonl`);
}

/**
 * Runs `fn` after every earlier call for the same key finished. Without this,
 * two simultaneous submissions read the same file and the second overwrites the
 * first.
 */
const queues = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
}

async function readLines(file: string): Promise<string[]> {
  try {
    const body = await readFile(file, "utf8");
    return body.split("\n").filter((line) => line.trim().length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Every entry in a month, in file order. Unreadable lines are skipped. */
export async function readMonth(month: string, dir?: string): Promise<SurveyEntry[]> {
  const lines = await readLines(monthFile(month, dir));
  const entries: SurveyEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SurveyEntry);
    } catch {
      console.warn(`survey: skipping unreadable line in ${monthFile(month, dir)}`);
    }
  }
  return entries;
}

export interface SaveResult {
  action: "appended" | "updated";
  /** Entries for this user in this month after the write. */
  monthCount: number;
}

/**
 * Writes one entry. If the month already holds a line for the same date and
 * user, that line is replaced in place (`submitted_at` moves forward, the rest
 * is the new answer); otherwise the line is appended.
 */
export function saveEntry(entry: SurveyEntry, dir?: string): Promise<SaveResult> {
  const month = monthKey(entry.date);
  const file = monthFile(month, dir);
  return withLock(file, async () => {
    const lines = await readLines(file);
    let replaced = false;
    const output = lines.map((line) => {
      let parsed: SurveyEntry | undefined;
      try {
        parsed = JSON.parse(line) as SurveyEntry;
      } catch {
        return line;
      }
      if (!replaced && parsed.date === entry.date && parsed.user === entry.user) {
        replaced = true;
        return JSON.stringify(entry);
      }
      return line;
    });
    if (!replaced) output.push(JSON.stringify(entry));
    await mkdir(surveyDir(dir), { recursive: true });
    await writeAtomic(file, `${output.join("\n")}\n`);
    const monthCount = output.filter((line) => {
      try {
        const parsed = JSON.parse(line) as SurveyEntry;
        return parsed.user === entry.user;
      } catch {
        return false;
      }
    }).length;
    return { action: replaced ? "updated" : "appended", monthCount };
  });
}

/** Whether this user already has an entry for `date`. */
export async function hasEntry(userId: string, date: string, dir?: string): Promise<boolean> {
  const entries = await readMonth(monthKey(date), dir);
  return entries.some((entry) => entry.user === userId && entry.date === date);
}

/** Every month file currently on disk, newest first. */
export async function listMonths(dir?: string): Promise<string[]> {
  try {
    const names = await readdir(surveyDir(dir));
    return names
      .filter((name) => name.endsWith(".jsonl") && MONTH_PATTERN.test(name.slice(0, -6)))
      .map((name) => name.slice(0, -6))
      .sort()
      .reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Removes every line this user wrote, in every month. Returns lines removed. */
export function deleteUserEntries(userId: string, dir?: string): Promise<number> {
  const key = join(surveyDir(dir), "*");
  return withLock(key, async () => {
    let removed = 0;
    for (const month of await listMonths(dir)) {
      const file = monthFile(month, dir);
      const lines = await readLines(file);
      const kept = lines.filter((line) => {
        try {
          return (JSON.parse(line) as SurveyEntry).user !== userId;
        } catch {
          return true;
        }
      });
      removed += lines.length - kept.length;
      if (kept.length === lines.length) continue;
      if (kept.length === 0) {
        await writeAtomic(file, "");
      } else {
        await writeAtomic(file, `${kept.join("\n")}\n`);
      }
    }
    return removed;
  });
}

export interface UserState {
  /** When the one-time intro was delivered. */
  intro_sent_at?: string;
  /** Set while the user has asked bishop to stop. */
  paused_at?: string | null;
}

export interface SurveyState {
  users: Record<string, UserState>;
}

const EMPTY_STATE: SurveyState = { users: {} };

function stateFile(dir?: string): string {
  return join(surveyDir(dir), "state.json");
}

export async function readState(dir?: string): Promise<SurveyState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(dir), "utf8")) as Partial<SurveyState>;
    return { users: parsed.users ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { users: { ...EMPTY_STATE.users } };
    console.warn(`survey: state file unreadable, starting from empty (${String(err)})`);
    return { users: {} };
  }
}

async function writeState(state: SurveyState, dir?: string): Promise<void> {
  await mkdir(surveyDir(dir), { recursive: true });
  await writeAtomic(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`);
}

/** Applies a patch to one user's state under the directory lock. */
export function patchUserState(
  userId: string,
  patch: Partial<UserState>,
  dir?: string,
): Promise<UserState> {
  return withLock(stateFile(dir), async () => {
    const state = await readState(dir);
    const current = state.users[userId] ?? {};
    const next = { ...current, ...patch };
    state.users[userId] = next;
    await writeState(state, dir);
    return next;
  });
}

export async function userState(userId: string, dir?: string): Promise<UserState> {
  const state = await readState(dir);
  return state.users[userId] ?? {};
}

export async function isPaused(userId: string, dir?: string): Promise<boolean> {
  return (await userState(userId, dir)).paused_at != null;
}
