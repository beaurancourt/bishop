# bishop

A Discord bot that watches a server for newly created **scheduled events** and
posts add-to-calendar links so anyone can save the time, place, and name to
their own calendar.

When someone creates a scheduled event in a guild, bishop replies with:

- a **Google Calendar** link (prefilled),
- an **Outlook** link (prefilled),
- a downloadable **`.ics`** file for Apple Calendar and everything else.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications):
   - Under **Bot**, reset/copy the token.
   - No privileged intents are required — bishop only uses `Guilds` and
     `GuildScheduledEvents`, which are non-privileged.

3. Configure environment:

   ```sh
   cp .env.example .env
   # fill in DISCORD_TOKEN (and optionally DISCORD_ANNOUNCE_CHANNEL_ID)
   ```

4. Invite the bot to your server with the `bot` scope and permission to
   **View Channels** and **Send Messages** (plus **Attach Files** for the
   `.ics`). An invite URL looks like:

   ```
   https://discord.com/oauth2/authorize?client_id=DISCORD_CLIENT_ID&scope=bot&permissions=51200
   ```

   (`51200` = View Channels + Send Messages + Attach Files.)

## Running

```sh
npm run dev     # watch mode (tsx)
npm start       # one-off run
npm run typecheck
```

Create a scheduled event in your server and bishop will post the calendar
links in the configured channel (or the system channel by default).

## Layout

- `src/calendar.ts` — provider URLs and `.ics` generation (no Discord types).
- `src/event.ts` — maps a discord.js scheduled event to a calendar event.
- `src/index.ts` — gateway client, channel resolution, message posting.
