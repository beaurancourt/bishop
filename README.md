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

A 21:00 DM diary for a GI clinic: twenty-four select menus, a **Notes** modal, and a
"Which other?" modal for a select answered with `other`; no typed commands and no
privileged intents. It is a separate feature from the calendar path and does not
read or write anything the calendar path uses.

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

The directory is created `0700` and every file `0600`, set with `chmod` after
each create rather than left to the umask, so no other account on the host can
read the health data. A file an earlier version left `0644` is tightened on its
next write; `data/` itself stays as it is, because the calendar bot keeps
`data/messages.json` there.

An entry is `{date, user, started_at, submitted_at, answers, notes, red_flags}`,
serialised with `JSON.stringify` (a note with quotes or newlines cannot break the
line). Submitting again for the same date rewrites that line instead of adding
one. A skipped day has no line at all, so it is never recorded as a zero. The
confirmation keeps **Add notes** and **Edit tonight**: both rebuild that date's
draft from the stored entry, so they still work after a restart, and a resubmit
corrects the one line.

`answers` has the twenty-four fields: `worst_pain`, `bloating`, `upper_gi`,
`pain_location` (none / upper middle / upper right / around the navel / lower
right / lower left / all over), `other_symptoms` (a list: nausea, vomiting, cold
sweats, cramping, fatigue, headache, dizziness, fever, mucus in stool), then
`bowel_movements` (4 means "4 or more"), `bristol` (1-7 or `"none"`), `urgency`,
`woke_at_night`, `foods_fodmap` (a list: dairy, wheat, onion/garlic, legumes,
apple/pear, stone fruit, honey/HFCS/sorbitol, mushroom, cauliflower/broccoli,
avocado, mango/watermelon, rye/barley, none), `foods_other` (a list: chocolate,
sweets/desserts, fried or fatty, lean or low-fat meals, carbonated, caffeine,
alcohol, spicy, artificial sweeteners, none), `medications`, `stress`, `sleep`,
`meals` (a list), `caffeine`, `alcohol`, `last_meal`, `fatigue`
(none/mild/moderate/severe/bed-bound), `anaemia_signs` (a list: pale, breathless
on exertion, palpitations, dizzy on standing, none), and the reflux side:
`reflux_triggers` (a list: mint, citrus, tomato, none — deliberately not
overlapping the food lists, so a trigger is tapped once), `lay_down_after_eating`
(yes/no), `portion_size` (small/medium/large), `spicy` (yes/no). Diet, pain
location, symptoms, the reflux fields and the anaemia pair arrived after the
first entries; a line without them exports a blank cell, not a zero.

The food question used to be one `foods` list. Entries from before the split keep
their `foods` values in the file: the export maps each value into the list that
holds it now (`apple/pear/stone fruit` lists under high-FODMAP, `fried/fatty`
under other) and leaves the other column blank, so an old month still adds up.

The `medications` select offers `other`, and a menu cannot record what that was.
Picking it stores the answer first, then opens a one-box modal; what she types
goes in `notes.other_meds`, never in `answers`, so the fixed value `other` is
what the CSV counts and the export's groups stay stable. The words are trimmed,
capped at 200 characters, shown on the medication page, and cleared when she
later picks a named medication instead. Dismissing the modal keeps the answer and
writes no note. A modal opened from a component keeps that component's message,
so its submit re-renders the prompt in one response; a modal that did not come
from one gets an ephemeral sentence instead. The same path covers a food list if
one ever offers `other` (`notes.other_foods`).

The twenty-four selects are split over six pages, at most four per page plus the
page's button row, which is Discord's five-row limit per message. Six pages is
the minimum at four selects a page, so the anaemia pair shares page five with
alcohol and the last meal, and spicy moved to the reflux page to keep both at
four.

Fatigue is a grade and the anaemia signs are a list, asked beside it because
tiredness alone is too vague to trend. If a day records two or more signs, the
confirmation adds one sentence saying repeated signs are worth a blood test. It
is copy, not a stored flag: `red_flags` is unchanged, and "known anaemia" stays
on the red-flag list, where a person reads it.

Red flags are detected from the notes box (the alarm list in the spec has no
yes/no field in the fast path). When one fires, the confirmation says to contact
the doctor today and to seek urgent care for vomiting blood, black stools,
fainting, severe chest pain, or cold sweats with chest or upper-abdominal pain.
It never reassures. The keys that fired are stored in `red_flags`.

### Export

```sh
python3 scripts/export.py --month 2026-11 --format csv
python3 scripts/export.py --month 2026-11 --format md --out ~/Desktop/gut.md
```

Reads `data/survey/2026-11.jsonl` and prints to stdout, or writes the path you
give. It refuses a path inside this repository — the CSV leaves the checkout by
hand. The CSV's notes columns are `notes_other`, `notes_other_meds`,
`notes_other_foods` and `notes_red_flags`; the Markdown mentions the two `other`
notes only on the days she typed something. The summary reports adherence,
severity medians, the Bristol distribution, the diet counts, and for each food
group the list it came from, the days eaten with the mean next-day pain, and that
mean's denominator (`n`). It also states the derived reflux trigger-day count
with its formula, so the number recomputes from the CSV: a day counts when
`reflux_triggers` has mint, citrus or tomato, or `foods_other` has chocolate,
caffeine, alcohol, carbonated or fried or fatty, or `last_meal` is `within 2 h`,
or `lay_down_after_eating` is `yes`.

### Scheduling and safety notes

- The timer is a chained `setTimeout`, re-armed after each run from the next
  wall-clock 21:00 in `America/New_York`, so a DST change moves the UTC instant,
  not the local hour. It never blocks the event loop: DM sends are awaited inside
  async callbacks, and one blocked DM does not stop the others.
- Every component click is acknowledged before any file or Discord work, so a
  slow write cannot push the answer past Discord's three-second window. A click
  that reaches the bot more than 2.5 seconds after it was made is answered with
  "This check-in message has expired — ask for a fresh one" and changes nothing.
  The one exception is a select answered with `other`: Discord takes one response
  per interaction and that response is the modal, so the draft is written before
  the modal opens rather than after an acknowledgement. A restart in the seconds
  while she types therefore keeps the answer.
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

