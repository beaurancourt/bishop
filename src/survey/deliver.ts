/**
 * The nightly fan-out, with Discord kept behind function parameters.
 *
 * Nothing here imports discord.js: the caller supplies the send functions, so a
 * test can prove that only enrolled ids are messaged, that a paused user is
 * skipped, that an evening already submitted is not asked twice, and that one
 * blocked DM does not stop the rest.
 */

export interface DeliveryDeps {
  /** Ids allowed to be messaged. This list is the whole audience. */
  enrolled: string[];
  /** `YYYY-MM-DD` the prompt is for. */
  date: string;
  /** ISO instant the prompt was first shown for that date. */
  startedAt: string;
  isPaused: (userId: string) => Promise<boolean>;
  hasEntryToday: (userId: string) => Promise<boolean>;
  introSent: (userId: string) => Promise<boolean>;
  sendIntro: (userId: string) => Promise<void>;
  sendPrompt: (userId: string, date: string, startedAt: string) => Promise<void>;
}

export interface DeliveryReport {
  date: string;
  sent: string[];
  skipped: { userId: string; reason: "paused" | "already-submitted" }[];
  failed: { userId: string; error: string }[];
}

/** The audience for tonight: enrolled, minus the paused. */
export function audience(enrolled: Iterable<string>, paused: Iterable<string>): string[] {
  const pausedSet = new Set(paused);
  return [...new Set(enrolled)].filter((id) => !pausedSet.has(id));
}

export async function deliverDaily(deps: DeliveryDeps): Promise<DeliveryReport> {
  const report: DeliveryReport = { date: deps.date, sent: [], skipped: [], failed: [] };

  for (const userId of [...new Set(deps.enrolled)]) {
    try {
      if (await deps.isPaused(userId)) {
        report.skipped.push({ userId, reason: "paused" });
        continue;
      }
      if (await deps.hasEntryToday(userId)) {
        report.skipped.push({ userId, reason: "already-submitted" });
        continue;
      }
      if (!(await deps.introSent(userId))) {
        await deps.sendIntro(userId);
      }
      await deps.sendPrompt(userId, deps.date, deps.startedAt);
      report.sent.push(userId);
    } catch (err) {
      report.failed.push({ userId, error: String((err as Error)?.message ?? err) });
    }
  }

  return report;
}
