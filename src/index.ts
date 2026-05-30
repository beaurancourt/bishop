import "dotenv/config";
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEvent,
  type SendableChannels,
  TimestampStyles,
  time,
} from "discord.js";
import {
  buildIcs,
  googleCalendarUrl,
  icsFilename,
  outlookCalendarUrl,
} from "./calendar.js";
import { toCalendarEvent } from "./event.js";

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

client.once(Events.ClientReady, (c) => {
  console.log(`Bishop is online as ${c.user.tag}`);
});

client.on(Events.GuildScheduledEventCreate, async (event) => {
  const calEvent = toCalendarEvent(event);
  if (!calEvent) {
    console.warn(`Scheduled event ${event.id} has no start time; skipping.`);
    return;
  }

  const channel = await resolveAnnounceChannel(event);
  if (!channel) {
    console.warn(`No sendable channel found in ${event.guild?.name ?? "unknown guild"}.`);
    return;
  }

  const ics = new AttachmentBuilder(Buffer.from(buildIcs(calEvent), "utf8"), {
    name: icsFilename(calEvent),
    description: `Calendar file for ${calEvent.title}`,
  });

  const whenLine = time(calEvent.start, TimestampStyles.LongDateTime);
  const lines = [
    `📅 **${calEvent.title}** was just scheduled.`,
    `🕒 ${whenLine} (${time(calEvent.start, TimestampStyles.RelativeTime)})`,
  ];
  if (calEvent.location) lines.push(`📍 ${calEvent.location}`);
  lines.push(
    "",
    "Add it to your calendar:",
    `• [Google Calendar](${googleCalendarUrl(calEvent)})`,
    `• [Outlook](${outlookCalendarUrl(calEvent)})`,
    "• Apple / other: download the attached `.ics` file",
  );

  await channel.send({ content: lines.join("\n"), files: [ics] });
  const channelName = "name" in channel ? `#${channel.name}` : "a DM channel";
  console.log(`Posted calendar links for "${calEvent.title}" in ${channelName}.`);
});

client.login(token);
