import {
  GuildScheduledEvent,
  GuildScheduledEventEntityType,
  type PartialGuildScheduledEvent,
} from "discord.js";
import type { CalendarEvent } from "./calendar.js";

/** A scheduled event as delivered by create/update (full) or delete (partial). */
type AnyScheduledEvent = GuildScheduledEvent | PartialGuildScheduledEvent;

/** One hour, used as the default duration when the source has no end time. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** Human-readable location string for a scheduled event, if determinable. */
function resolveLocation(event: AnyScheduledEvent): string | undefined {
  if (event.entityType === GuildScheduledEventEntityType.External) {
    return event.entityMetadata?.location ?? undefined;
  }
  // Voice / Stage events live in a channel.
  if (event.channel) return `#${event.channel.name} (Discord)`;
  return undefined;
}

/**
 * Maps a discord.js scheduled event into the gateway-agnostic CalendarEvent.
 * Returns null when the event has no start time (should not happen for a
 * created event, but the type allows it).
 */
export function toCalendarEvent(event: AnyScheduledEvent): CalendarEvent | null {
  const start = event.scheduledStartAt;
  if (!start || !event.name) return null;

  const end =
    event.scheduledEndAt ?? new Date(start.getTime() + DEFAULT_DURATION_MS);

  const descriptionParts: string[] = [];
  if (event.description) descriptionParts.push(event.description);
  descriptionParts.push(`Discord event: ${event.url}`);

  return {
    title: event.name,
    description: descriptionParts.join("\n\n"),
    location: resolveLocation(event),
    start,
    end,
    uid: `${event.id}@bishop.discord`,
    stamp: event.createdAt ?? start,
  };
}
