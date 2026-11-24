/**
 * Who may be messaged, and whose components bishop will answer.
 *
 * Enrollment is deliberate, not opt-in through the bot: the ids come from
 * `SURVEY_USER_IDS` (comma-separated) or from a small JSON config file, and
 * everyone else is ignored — no reply, no entry, no DM. Both sources are read on
 * each use so an operator can add an id without a restart.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { surveyDir } from "./storage.js";

const ID_PATTERN = /^\d{5,25}$/;

/** Splits `SURVEY_USER_IDS`, dropping blanks, duplicates and junk. */
export function parseUserIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(",")) {
    const id = token.trim();
    if (!id) continue;
    if (!ID_PATTERN.test(id)) {
      console.warn(`survey: ignoring SURVEY_USER_IDS entry ${JSON.stringify(id)} (not a user id)`);
      continue;
    }
    seen.add(id);
  }
  return [...seen];
}

export interface SurveyConfig {
  /** Discord user ids to message. Same meaning as SURVEY_USER_IDS. */
  user_ids?: string[];
  /** Also accepted, for hands that type camelCase. */
  userIds?: string[];
}

export function configPath(override?: string): string {
  return override ?? process.env.SURVEY_CONFIG_PATH ?? join(surveyDir(), "config.json");
}

/** Reads the config file, or `[]` when it is absent or unreadable. */
export async function readConfigIds(path?: string): Promise<string[]> {
  const file = configPath(path);
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn(`survey: config ${file} unreadable (${String(err)})`);
    return [];
  }
  try {
    const parsed = JSON.parse(body) as SurveyConfig;
    return [ ...(parsed.user_ids ?? []), ...(parsed.userIds ?? []) ].filter(
      (id): id is string => typeof id === "string" && ID_PATTERN.test(id),
    );
  } catch (err) {
    console.warn(`survey: config ${file} is not valid JSON (${String(err)})`);
    return [];
  }
}

/**
 * The union of the environment variable and the config file. Nobody else is
 * enrolled, so an unlisted id gets no message and no handler runs for it.
 */
export async function loadEnrollment(options: { env?: NodeJS.ProcessEnv; configFile?: string } = {}): Promise<Set<string>> {
  const env = options.env ?? process.env;
  const ids = new Set<string>(parseUserIds(env.SURVEY_USER_IDS));
  for (const id of await readConfigIds(options.configFile)) ids.add(id);
  return ids;
}

export function isEnrolled(userId: string, enrolled: Iterable<string>): boolean {
  if (enrolled instanceof Set) return enrolled.has(userId);
  for (const id of enrolled) if (id === userId) return true;
  return false;
}
