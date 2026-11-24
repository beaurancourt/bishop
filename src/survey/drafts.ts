/**
 * Half-finished check-ins, kept on disk so a restart cannot lose them.
 *
 * An entry is written only on Submit; until then a check-in lives here, one
 * object per user and evening, keyed `userId|date`. The in-memory map is the
 * read path and `data/survey/drafts.json` is the write-through copy, so a
 * restart between page one and the Next button hands the next click the answers
 * from page one. Drafts are dropped when their evening is no longer today, and a
 * submitted entry never appears in this file.
 *
 * One file for every user, replaced whole and atomically (temporary file, then
 * rename), with writes serialised: two people clicking at the same moment do
 * not overwrite each other. A missing or unreadable file is empty, never fatal.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SurveyNotes } from "./entry.js";
import type { Answers } from "./fields.js";
import { surveyDir } from "./storage.js";

export interface Draft {
  userId: string;
  date: string;
  startedAt: string;
  answers: Answers;
  notes: SurveyNotes;
  page: number;
}

export const DRAFTS_FILE = "drafts.json";

/** Where drafts live: beside the month files and the state file. */
export function draftsFile(dir?: string): string {
  return join(surveyDir(dir), DRAFTS_FILE);
}

export function draftKey(userId: string, date: string): string {
  return `${userId}|${date}`;
}

interface DraftFile {
  drafts?: Record<string, Draft>;
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Partial<Draft>;
  return (
    typeof draft.userId === "string" &&
    typeof draft.date === "string" &&
    typeof draft.startedAt === "string" &&
    typeof draft.page === "number" &&
    typeof draft.answers === "object" &&
    draft.answers !== null &&
    typeof draft.notes === "object" &&
    draft.notes !== null
  );
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
}

export class DraftStore {
  private readonly drafts = new Map<string, Draft>();
  private loading: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly dir?: string;

  /** `dir` falls back to `BISHOP_SURVEY_DIR`, then `data/survey`. */
  constructor(dir?: string) {
    this.dir = dir;
  }

  /** Reads the file once; every later call reuses the same promise. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  /** Forgets everything and reads the file again, as a fresh process would. */
  async reload(): Promise<void> {
    this.loading = null;
    this.drafts.clear();
    await this.load();
  }

  private async read(): Promise<void> {
    let body: string;
    try {
      body = await readFile(draftsFile(this.dir), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(`survey: drafts file unreadable, starting empty (${String(err)})`);
      return;
    }
    try {
      const parsed = JSON.parse(body) as DraftFile;
      for (const [key, draft] of Object.entries(parsed.drafts ?? {})) {
        if (!isDraft(draft)) {
          console.warn(`survey: skipping unreadable draft ${JSON.stringify(key)}`);
          continue;
        }
        if (key !== draftKey(draft.userId, draft.date)) continue;
        this.drafts.set(key, draft);
      }
    } catch (err) {
      console.warn(`survey: drafts file is not valid JSON, starting empty (${String(err)})`);
    }
  }

  get(userId: string, date: string): Draft | undefined {
    return this.drafts.get(draftKey(userId, date));
  }

  /** The draft for this evening, created blank when there is none. Memory only. */
  ensure(userId: string, date: string, startedAt?: string): Draft {
    const key = draftKey(userId, date);
    const existing = this.drafts.get(key);
    if (existing) return existing;
    const fresh: Draft = {
      userId,
      date,
      startedAt: startedAt ?? new Date().toISOString(),
      answers: {},
      notes: { other: "", red_flags_note: "" },
      page: 1,
    };
    this.drafts.set(key, fresh);
    return fresh;
  }

  /**
   * Writes the whole map. Calls are serialised and each snapshots the map at
   * call time, so the last write always reflects the last change.
   */
  persist(): Promise<void> {
    const body = `${JSON.stringify({ drafts: Object.fromEntries(this.drafts) }, null, 2)}\n`;
    const write = this.writes.then(async () => {
      await mkdir(surveyDir(this.dir), { recursive: true });
      await writeAtomic(draftsFile(this.dir), body);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** Drops one evening's draft after it has been saved, then writes the file. */
  async drop(userId: string, date: string): Promise<void> {
    if (this.drafts.delete(draftKey(userId, date))) await this.persist();
  }

  /** Drops every draft that is not `date`; returns how many went. */
  async prune(date: string): Promise<number> {
    let removed = 0;
    for (const [key, draft] of this.drafts) {
      if (draft.date === date) continue;
      this.drafts.delete(key);
      removed += 1;
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  /** Drops one person's drafts, for Delete my data. Returns how many went. */
  async dropUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, draft] of this.drafts) {
      if (draft.userId !== userId) continue;
      this.drafts.delete(key);
      removed += 1;
    }
    if (removed > 0) await this.persist();
    return removed;
  }
}
