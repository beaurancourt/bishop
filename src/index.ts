import "dotenv/config";
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEvent,
  GuildScheduledEventStatus,
  type Message,
  MessageFlags,
  type SendableChannels,
  TimestampStyles,
  time,
} from "discord.js";
import {
  buildIcs,
  type CalendarEvent,
  googleCalendarUrl,
  icsFilename,
  outlookCalendarUrl,
} from "./calendar.js";
import { toCalendarEvent } from "./event.js";
import { startHttpServer } from "./http.js";
import { forgetMessage, getMessage, rememberMessage } from "./store.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const announceChannelId = process.env.DISCORD_ANNOUNCE_CHANNEL_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
});

/**
 * Picks the channel to post calendar links in: an explicitly configured
 * channel if set, otherwise the guild's system channel, otherwise the first
 * text channel the bot can send messages in.
 */
async function resolveAnnounceChannel(
  event: GuildScheduledEvent,
): Promise<SendableChannels | null> {
  const guild = event.guild;
  if (!guild) return null;

  if (announceChannelId) {
    const channel = await guild.channels.fetch(announceChannelId).catch(() => null);
    if (channel?.isSendable()) return channel;
    console.warn(
      `Configured DISCORD_ANNOUNCE_CHANNEL_ID ${announceChannelId} is not a sendable channel in ${guild.name}.`,
    );
  }

  if (guild.systemChannel?.isSendable()) return guild.systemChannel;

  const fallback = guild.channels.cache.find((c) => c.isSendable());
  return fallback?.isSendable() ? fallback : null;
}

/** Fresh .ics attachment for the current state of an event. */
function icsAttachment(calEvent: CalendarEvent): AttachmentBuilder {
  return new AttachmentBuilder(Buffer.from(buildIcs(calEvent), "utf8"), {
    name: icsFilename(calEvent),
    description: `Calendar file for ${calEvent.title}`,
  });
}

/** Message body for an upcoming/active event, with calendar links. */
function renderActiveEvent(calEvent: CalendarEvent): string {
  // Title links to the event in Discord. Embeds are suppressed on the message
  // (see postEvent), so this stays a plain clickable link rather than unfurling
  // into Discord's event card + a generic site preview.
  const title = calEvent.url ? `[${calEvent.title}](${calEvent.url})` : calEvent.title;
  const lines = [
    `📅 **${title}** is on the calendar.`,
    `🕒 ${time(calEvent.start, TimestampStyles.LongDateTime)} (${time(calEvent.start, TimestampStyles.RelativeTime)})`,
  ];
  if (calEvent.location) lines.push(`📍 ${calEvent.location}`);
  lines.push(
    "",
    "Add it to your calendar:",
    `• [Google Calendar](${googleCalendarUrl(calEvent)})`,
    `• [Outlook](${outlookCalendarUrl(calEvent)})`,
    "• Apple / other: download the attached `.ics` file",
  );
  return lines.join("\n");
}

/** Message body once an event is cancelled/deleted; links are removed. */
function renderCancelledEvent(calEvent: CalendarEvent | null): string {
  if (!calEvent) return "❌ This event was cancelled.";
  return [
    `❌ ~~**${calEvent.title}**~~ was cancelled.`,
    `🕒 was ${time(calEvent.start, TimestampStyles.LongDateTime)}`,
  ].join("\n");
}

/** Resolves the message bishop previously posted for an event, if it still exists. */
async function fetchPostedMessage(eventId: string): Promise<Message | null> {
  const stored = await getMessage(eventId);
  if (!stored) return null;
  const channel = await client.channels.fetch(stored.channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(stored.messageId).catch(() => null);
}

/** Posts a new calendar message and records it for later edits/deletes. */
async function postEvent(event: GuildScheduledEvent, calEvent: CalendarEvent): Promise<void> {
  const channel = await resolveAnnounceChannel(event);
  if (!channel) {
    console.warn(`No sendable channel found in ${event.guild?.name ?? "unknown guild"}.`);
    return;
  }
  const message = await channel.send({
    content: renderActiveEvent(calEvent),
    files: [icsAttachment(calEvent)],
    flags: MessageFlags.SuppressEmbeds,
  });
  await rememberMessage(event.id, {
    guildId: event.guildId,
    channelId: channel.id,
    messageId: message.id,
  });
  const channelName = "name" in channel ? `#${channel.name}` : "a DM channel";
  console.log(`Posted calendar links for "${calEvent.title}" in ${channelName}.`);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Bishop is online as ${c.user.tag}`);
  // Local HTTP endpoint so on-box tools (e.g. the digest job) can ask bishop to
  // DM a user. No-op unless BISHOP_HTTP_TOKEN is set.
  startHttpServer(client);
});

client.on(Events.GuildScheduledEventCreate, async (event) => {
  const calEvent = toCalendarEvent(event);
  if (!calEvent) {
    console.warn(`Scheduled event ${event.id} has no start time; skipping.`);
    return;
  }
  await postEvent(event, calEvent);
});

client.on(Events.GuildScheduledEventUpdate, async (_oldEvent, event) => {
  const calEvent = toCalendarEvent(event);
  if (!calEvent) return;

  // A completed event keeps its message as-is — nothing useful to change.
  if (event.status === GuildScheduledEventStatus.Completed) return;

  const message = await fetchPostedMessage(event.id);

  if (event.status === GuildScheduledEventStatus.Canceled) {
    if (message) {
      await message.edit({ content: renderCancelledEvent(calEvent), files: [], attachments: [] });
      await forgetMessage(event.id);
      console.log(`Marked "${calEvent.title}" cancelled.`);
    }
    return;
  }

  // Scheduled/active: re-render with the latest details and a fresh .ics.
  if (!message) {
    await postEvent(event, calEvent);
    return;
  }
  await message.edit({
    content: renderActiveEvent(calEvent),
    files: [icsAttachment(calEvent)],
    attachments: [],
    flags: MessageFlags.SuppressEmbeds,
  });
  console.log(`Updated calendar links for "${calEvent.title}".`);
});

client.on(Events.GuildScheduledEventDelete, async (event) => {
  const calEvent = toCalendarEvent(event);
  const message = await fetchPostedMessage(event.id);
  if (message) {
    await message.edit({ content: renderCancelledEvent(calEvent), files: [], attachments: [] });
    console.log(`Marked deleted event ${event.id} cancelled.`);
  }
  await forgetMessage(event.id);
});

client.login(token);
