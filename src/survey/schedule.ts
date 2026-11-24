/**
 * The timer that wakes the bot at 21:00 local.
 *
 * A `setTimeout` of "24 hours" would drift by an hour twice a year and fire at
 * 22:00 or 20:00 for the rest of the season. Instead each firing recomputes the
 * next wall-clock 21:00 from the current date in the zone, so a DST change is
 * just a different gap between two firings (23 or 25 hours) with the local hour
 * unchanged.
 *
 * The timer is chained, not an interval: the next one is armed only after the
 * current run finished, so a slow send cannot overlap itself and the event loop
 * stays free (a DM send is awaited inside an async callback, never blocking).
 */
import { type DailyScheduleOptions, nextRun } from "./time.js";

/** Node's setTimeout limit; a longer delay fires immediately. */
const MAX_DELAY_MS = 2_147_483_647;

export class DailyTimer {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: DailyScheduleOptions,
    private readonly onDue: (due: Date) => Promise<void>,
  ) {}

  /** Arms the timer for the next occurrence. Safe to call once at startup. */
  start(): Date {
    return this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The instant the armed timer is aiming at. */
  nextDue(from: Date = new Date()): Date {
    return nextRun(from, this.options);
  }

  private arm(): Date {
    const now = Date.now();
    const due = nextRun(new Date(now), this.options);
    // +50ms so the firing is strictly after the boundary, not a hair before it.
    const delay = Math.min(Math.max(due.getTime() - now, 0) + 50, MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      void this.fire(due);
    }, delay);
    return due;
  }

  private async fire(due: Date): Promise<void> {
    if (Date.now() + 1_000 < due.getTime()) {
      // The clock jumped, or the delay was capped: wait out the remainder.
      this.arm();
      return;
    }
    try {
      await this.onDue(due);
    } catch (err) {
      console.error("survey: daily run failed", err);
    } finally {
      this.arm();
    }
  }
}
