/**
 * Builds "add to calendar" artifacts (provider links + an .ics file) from a
 * normalized event. Kept free of discord.js types so it can be unit-tested and
 * reused independently of the gateway layer.
 */

export interface CalendarEvent {
  title: string;
  description?: string;
  location?: string;
  /** Absolute event start. */
  start: Date;
  /** Absolute event end. Defaults to start + 1h when the source has none. */
  end: Date;
  /** Stable identifier used as the iCalendar UID. */
  uid: string;
  /** When the source event was created/last modified, for DTSTAMP. */
  stamp?: Date;
  /** Link back to the event in Discord (where members can RSVP). */
  url?: string;
}

/** YYYYMMDDTHHMMSSZ in UTC, the form Google Calendar and iCalendar expect. */
function toCompactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Google Calendar prefilled-event template URL. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${toCompactUtc(event.start)}/${toCompactUtc(event.end)}`,
  });
  if (event.description) params.set("details", event.description);
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook.com prefilled-event compose URL. */
export function outlookCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: event.start.toISOString(),
    enddt: event.end.toISOString(),
  });
  if (event.description) params.set("body", event.description);
  if (event.location) params.set("location", event.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Escapes a value for an iCalendar text field per RFC 5545 §3.3.11. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Folds a content line to <=75 octets per RFC 5545 §3.1. We approximate by
 * character count, which is correct for ASCII and safe for short event text.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    chunks.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) chunks.push(" " + rest);
  return chunks.join("\r\n");
}

/** A self-contained VCALENDAR document with a single VEVENT. */
export function buildIcs(event: CalendarEvent): string {
  const stamp = event.stamp ?? event.start;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bishop//discord-event-calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${toCompactUtc(stamp)}`,
    `DTSTART:${toCompactUtc(event.start)}`,
    `DTEND:${toCompactUtc(event.end)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** A filesystem-safe .ics filename derived from the event title. */
export function icsFilename(event: CalendarEvent): string {
  const slug = event.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "event"}.ics`;
}
