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
- `src/survey/` — the daily gut check-in (below).
- `scripts/export.py` — CSV / Markdown export of a month of check-ins.

## Daily gut check-in

A 21:00 DM diary for a GI clinic: eleven select menus, one **Notes** modal, no
typed commands and no privileged intents. It is a separate feature from the
calendar path and does not read or write anything the calendar path uses.

Enable it by naming who may be messaged:

```sh
SURVEY_USER_IDS=123456789012345678          # comma-separated
# or data/survey/config.json: {"user_ids": ["123456789012345678"]}
```

Anyone not listed is ignored: no DM, and a component they click is not answered
with an entry. The first message each person receives explains what is recorded,
says plainly that it is not medical advice, and offers **Pause** and **Delete my
data**.

What it writes, under `BISHOP_SURVEY_DIR` (default `data/survey`, which git
ignores):

```
data/survey/2026-11.jsonl   one entry per line, one file per month
data/survey/state.json      who has seen the intro, who is paused
data/survey/drafts.json     half-finished check-ins, one per user and evening
```

An entry is `{date, user, started_at, submitted_at, answers, notes, red_flags}`,
serialised with `JSON.stringify` (a note with quotes or newlines cannot break the
line). Submitting again for the same date rewrites that line instead of adding
one. A skipped day has no line at all, so it is never recorded as a zero.

`answers` has the eleven fields: `worst_pain`, `bloating`, `upper_gi`,
`bowel_movements` (4 means "4 or more"), `bristol` (1-7 or `"none"`), `urgency`,
`woke_at_night`, `foods`, `medications`, `stress`, `sleep`.

Red flags are detected from the notes box (the alarm list in the spec has no
yes/no field in the fast path). When one fires, the confirmation says to contact
the doctor today and to seek urgent care for vomiting blood, black stools,
fainting or severe chest pain. It never reassures. The keys that fired are
stored in `red_flags`.

### Export

```sh
python3 scripts/export.py --month 2026-11 --format csv
python3 scripts/export.py --month 2026-11 --format md --out ~/Desktop/gut.md
```

Reads `data/survey/2026-11.jsonl` and prints to stdout, or writes the path you
give. It refuses a path inside this repository — the CSV leaves the checkout by
hand. The Markdown summary reports adherence, severity medians, the Bristol
distribution, and for each food group the days eaten with the mean next-day pain
and that mean's denominator (`n`).

### Scheduling and safety notes

- The timer is a chained `setTimeout`, re-armed after each run from the next
  wall-clock 21:00 in `America/New_York`, so a DST change moves the UTC instant,
  not the local hour. It never blocks the event loop: DM sends are awaited inside
  async callbacks, and one blocked DM does not stop the others.
- Every component click is acknowledged before any file or Discord work, so a
  slow write cannot push the answer past Discord's three-second window. A click
  that reaches the bot more than 2.5 seconds after it was made is answered with
  "This check-in message has expired — ask for a fresh one" and changes nothing.
- Half-finished pages are kept in `data/survey/drafts.json` and loaded at
  startup, so a restart mid-evening hands the next click the answers from the
  earlier pages. Drafts are pruned when their evening is no longer today, and
  Submit removes the draft. Delete my data removes it too.
- `SURVEY_SEND_ON_START=1` sends one check-in at startup without waiting for
  21:00, for a deployment smoke test.

## Tests

```sh
npm test        # node --test through tsx, no Discord connection
npm run typecheck
```

`node:test` is built into Node 20+, so the runner is not a dependency. `tsx` is
already in the project for `npm start`, and it lets the runner import the
TypeScript sources directly, so tests exercise the same code the bot runs.
Vitest would add a dependency for no extra capability here.

