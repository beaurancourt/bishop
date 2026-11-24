#!/usr/bin/env python3
"""Export a month of gut check-ins as CSV or a one-page summary.

    scripts/export.py --month 2026-11 --format csv
    scripts/export.py --month 2026-11 --format md --out ~/Desktop/summary.md

Reads data/survey/YYYY-MM.jsonl (override with --data-dir or BISHOP_SURVEY_DIR)
and writes only to stdout, or to a path you name. It refuses to write inside the
repository: exported data leaves the bot's checkout, by hand.

The summary reports associations as counts with denominators. It never calls a
food a cause: a diary shows what came next, not why.
"""

from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Storage key -> CSV header. One column per fast-path field, then the notes.
FIELD_COLUMNS: list[tuple[str, str]] = [
    ("worst_pain", "worst_pain"),
    ("bloating", "bloating"),
    ("upper_gi", "upper_gi"),
    ("bowel_movements", "bowel_movements"),  # 4 means "4 or more"
    ("bristol", "bristol"),
    ("urgency", "urgency"),
    ("woke_at_night", "woke_at_night"),
    ("foods", "foods"),
    ("medications", "medications"),
    ("stress", "stress"),
    ("sleep", "sleep"),
    # Added after the first month of entries; an older line has no answer here
    # and exports a blank cell, which is what "not asked" looks like.
    ("meals", "meals"),
    ("caffeine", "caffeine"),
    ("alcohol", "alcohol"),
    ("last_meal", "last_meal"),
    ("spicy", "spicy"),
]
LIST_FIELDS = {"foods", "medications", "meals"}

# The daily set's own order, used to lay out the diet counters.
MEAL_ORDER = ["breakfast", "lunch", "dinner", "snacks"]
SERVING_ORDER = ["0", "1", "2", "3+"]
LAST_MEAL_ORDER = ["more than 3 h", "2–3 h", "within 2 h", "did not eat"]

# Display order and labels for the rows of the food table.
FOOD_GROUPS = [
    "dairy",
    "wheat",
    "onion/garlic",
    "legumes",
    "apple/pear/stone fruit",
    "honey/HFCS/sorbitol",
    "caffeine",
    "alcohol",
    "fried/fatty",
    "carbonated",
]

# Mirrors src/survey/redflags.ts: keys are stored, these are read by a person.
RED_FLAG_LABELS = {
    "unintentional_weight_loss": "unintentional weight loss",
    "dysphagia": "difficulty or pain swallowing",
    "gi_bleeding": "vomiting blood, black or tarry stools, or blood in stool",
    "persistent_vomiting": "persistent vomiting",
    "anaemia": "anaemia or known iron deficiency",
    "fever_with_pain": "fever with abdominal pain",
    "new_symptoms_age_55": "new or worsening symptoms at 55 or older",
    "night_symptoms": "waking at night with symptoms, or symptoms that stop eating",
}

MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]


def fail(message: str, code: int = 2):
    print(f"export: {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_month(value: str) -> date:
    try:
        year, month = value.split("-")
        return date(int(year), int(month), 1)
    except (ValueError, TypeError):
        fail(f"--month must be YYYY-MM (got {value!r})")


def month_bounds(first: date) -> tuple[date, date]:
    last_day = calendar.monthrange(first.year, first.month)[1]
    return first, date(first.year, first.month, last_day)


def default_data_dir() -> Path:
    return Path(os.environ.get("BISHOP_SURVEY_DIR", REPO_ROOT / "data" / "survey"))


def load_entries(month: date, data_dir: Path) -> list[dict]:
    path = data_dir / f"{month.strftime('%Y-%m')}.jsonl"
    if not path.exists():
        fail(f"no entries for {month.strftime('%Y-%m')} ({path} does not exist)", 3)
    entries: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as err:
                print(f"export: skipping unreadable line {number} ({err})", file=sys.stderr)
                continue
            if not isinstance(item, dict) or "date" not in item:
                print(f"export: skipping line {number} (not an entry)", file=sys.stderr)
                continue
            entries.append(item)
    entries.sort(key=lambda entry: (entry.get("date", ""), entry.get("user", "")))
    return entries


def cell(entry: dict, key: str) -> str:
    if key in LIST_FIELDS:
        value = entry.get("answers", {}).get(key) or []
        return "; ".join(str(item) for item in value)
    value = entry.get("answers", {}).get(key)
    return "" if value is None else str(value)


def flag_labels(entry: dict) -> list[str]:
    return [RED_FLAG_LABELS.get(key, key) for key in entry.get("red_flags") or []]


def write_csv(entries: list[dict], stream) -> None:
    writer = csv.writer(stream, lineterminator="\n")
    header = ["date", "user", "submitted_at"]
    header += [name for _, name in FIELD_COLUMNS]
    header += ["notes_other", "notes_red_flags", "red_flags"]
    writer.writerow(header)
    for entry in entries:
        row = [entry.get("date", ""), entry.get("user", ""), entry.get("submitted_at", "")]
        row += [cell(entry, key) for key, _ in FIELD_COLUMNS]
        notes = entry.get("notes") or {}
        row += [
            notes.get("other", ""),
            notes.get("red_flags_note", ""),
            "; ".join(flag_labels(entry)),
        ]
        writer.writerow(row)


def numeric(values) -> list[float]:
    out = []
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out.append(float(value))
    return out


def describe(values: list[float]) -> str:
    if not values:
        return "no data"
    return f"median {statistics.median(values):g}, mean {statistics.mean(values):.1f} (n={len(values)})"


def value_counter(entries: list[dict], key: str) -> Counter:
    """Counts the days each stored value appeared for one single-select field."""
    return Counter(
        str(value)
        for value in (entry.get("answers", {}).get(key) for entry in entries)
        if value is not None
    )


def list_counter(entries: list[dict], key: str) -> tuple[Counter, int]:
    """Counts list answers by item, and how many days answered at all."""
    counts: Counter = Counter()
    answered = 0
    for entry in entries:
        values = entry.get("answers", {}).get(key)
        if not isinstance(values, list):
            continue
        answered += 1
        for item in values:
            if item != "none":
                counts[str(item)] += 1
    return counts, answered


def bucket_days(counts: Counter, order: list[str]) -> str:
    """`0 on 5 days, 1 on 8 days`: a category and the days it appeared."""
    if not counts:
        return "none recorded"
    keys = [key for key in order if key in counts]
    keys += sorted(key for key in counts if key not in order)
    return ", ".join(
        f"{key} on {counts[key]} {'day' if counts[key] == 1 else 'days'}" for key in keys
    )


def elapsed_days(first: date, last: date, today: date) -> int:
    if today < first:
        return 0
    return min(today, last).day


def write_markdown(entries: list[dict], month: date, stream) -> None:
    first, last = month_bounds(month)
    users = sorted({entry.get("user", "") for entry in entries})
    dates = sorted({entry.get("date", "") for entry in entries if entry.get("date")})
    today = date.today()
    elapsed = elapsed_days(first, last, today)
    days_in_month = last.day
    span = elapsed if elapsed else days_in_month
    title = f"{MONTH_NAMES[month.month - 1]} {month.year}"

    write = stream.write
    write(f"# Gut check-in — {title}\n\n")
    write(
        f"{len(entries)} entries from {len(dates)} "
        f"{'day' if len(dates) == 1 else 'days'}"
        f" · {len(users)} {'person' if len(users) == 1 else 'people'}\n\n"
    )
    write(
        "A diary, not a diagnosis. Counts and denominators only: this shows what "
        "came next, not what caused it.\n\n"
    )

    # --- adherence -----------------------------------------------------------
    recorded = set(dates)
    missing = [
        (first + timedelta(days=offset)).isoformat()
        for offset in range(span)
        if (first + timedelta(days=offset)).isoformat() not in recorded
    ]
    pct = (len(recorded) / span * 100) if span else 0.0
    write("## Adherence\n\n")
    write(f"- Days in month: {days_in_month}" + (f" ({span} elapsed)" if span != days_in_month else "") + "\n")
    write(f"- Days recorded: {len(recorded)} of {span} ({pct:.0f}%)\n")
    if missing:
        shown = ", ".join(missing[:10]) + (" …" if len(missing) > 10 else "")
        write(f"- Missed: {len(missing)} ({shown})\n")
    if len(users) > 1:
        per_user = Counter(entry.get("user", "") for entry in entries)
        write("- Per user: " + ", ".join(f"`{user}` {count}" for user, count in sorted(per_user.items())) + "\n")
    write("\n")

    # --- severity ------------------------------------------------------------
    def field_values(key: str):
        return [entry.get("answers", {}).get(key) for entry in entries]

    pain_values = numeric(field_values("worst_pain"))
    bloating_values = numeric(field_values("bloating"))
    stress_values = numeric(field_values("stress"))
    bm_values = numeric(field_values("bowel_movements"))

    write("## Severity\n\n")
    write(f"- Worst pain (0-10): {describe(pain_values)}\n")
    write(f"- Bloating (0-10): {describe(bloating_values)}\n")
    write(f"- Stress (0-4): {describe(stress_values)}\n")
    if bm_values:
        write(f"- Bowel movements per day: median {statistics.median(bm_values):g} (n={len(bm_values)})\n")
    write("\n")

    # --- stool and upper GI --------------------------------------------------
    bristol = Counter(str(value) for value in field_values("bristol") if value is not None)
    upper = Counter(str(value) for value in field_values("upper_gi") if value is not None)
    urgency = sum(1 for entry in entries if entry.get("answers", {}).get("urgency") == "yes")
    night = sum(1 for entry in entries if entry.get("answers", {}).get("woke_at_night") == "yes")
    sleep = Counter(str(value) for value in field_values("sleep") if value is not None)

    write("## Stool and upper GI\n\n")
    if bristol:
        order = [str(n) for n in range(1, 8)] + ["none"]
        parts = [f"{key}: {bristol[key]}" for key in order if key in bristol]
        write(f"- Bristol distribution: {', '.join(parts)} (n={sum(bristol.values())})\n")
    write(f"- Urgency or an accident: {urgency} of {len(entries)} days\n")
    write(f"- Symptoms woke her: {night} of {len(entries)} days\n")
    if upper:
        write("- Upper GI: " + ", ".join(f"{key} {count}" for key, count in sorted(upper.items())) + "\n")
    if sleep:
        write("- Sleep: " + ", ".join(f"{key} {count}" for key, count in sleep.most_common()) + "\n")
    write("\n")

    # --- diet ----------------------------------------------------------------
    # The diet fields arrived after the first entries, so every count here has
    # to tolerate a month of lines that never answered them: no key is not a
    # zero, and a mean with no denominator is a dash.
    meals, meal_days = list_counter(entries, "meals")
    caffeine = value_counter(entries, "caffeine")
    alcohol = value_counter(entries, "alcohol")
    last_meal = value_counter(entries, "last_meal")
    spicy = value_counter(entries, "spicy")

    def exposed(key: str, values: set[str]) -> list[dict]:
        return [
            entry
            for entry in entries
            if str(entry.get("answers", {}).get(key)) in values
        ]

    def exposure_row(label: str, selected: list[dict]) -> str:
        pains = numeric(entry.get("answers", {}).get("worst_pain") for entry in selected)
        mean = f"{statistics.mean(pains):.1f} (n={len(pains)})" if pains else "—"
        return f"| {label} | {len(selected)} | {mean} |\n"

    write("## Diet\n\n")
    if meal_days:
        write(
            "- Meals eaten: "
            + ", ".join(f"{meal} {meals[meal]}" for meal in MEAL_ORDER)
            + f" (of {meal_days} {'day' if meal_days == 1 else 'days'} with an answer)\n"
        )
    else:
        write("- Meals eaten: none recorded\n")
    write(f"- Caffeine servings: {bucket_days(caffeine, SERVING_ORDER)}\n")
    write(f"- Alcohol drinks: {bucket_days(alcohol, SERVING_ORDER)}\n")
    write(f"- Last meal before bed: {bucket_days(last_meal, LAST_MEAL_ORDER)}\n")
    write(f"- Spicy or acidic: {bucket_days(spicy, ['yes', 'no'])}\n")
    write(
        "\nDays each exposure occurred, and the mean worst pain on those days. "
        "A field a day did not answer is left out, never counted as zero.\n\n"
    )
    write("| exposure | days | mean worst pain |\n")
    write("| --- | --- | --- |\n")
    write(exposure_row("caffeine (1+)", exposed("caffeine", {"1", "2", "3+"})))
    write(exposure_row("alcohol (1+)", exposed("alcohol", {"1", "2", "3+"})))
    write(exposure_row("spicy or acidic", exposed("spicy", {"yes"})))
    write(exposure_row("last meal within 2 h", exposed("last_meal", {"within 2 h"})))
    write("\n")

    # --- red flags -----------------------------------------------------------
    flagged = [entry for entry in entries if entry.get("red_flags")]
    write("## Red flags\n\n")
    if not flagged:
        write("- None reported this month.\n\n")
    else:
        write(f"- {len(flagged)} {'entry' if len(flagged) == 1 else 'entries'} reported an alarm symptom:\n")
        for entry in flagged:
            labels = "; ".join(flag_labels(entry))
            write(f"  - {entry.get('date', '?')}: {labels}\n")
        write(
            "\nThese are the questions the clinic asks, recorded verbatim. They are not "
            "scored, and the app that collected them told her to contact her doctor; this "
            "summary repeats that.\n\n"
        )

    # --- foods and next-day pain --------------------------------------------
    by_user_date: dict[str, dict[str, dict]] = defaultdict(dict)
    for entry in entries:
        if entry.get("date"):
            by_user_date[entry.get("user", "")][entry.get("date")] = entry

    stats: dict[str, dict[str, float]] = {
        group: {"eaten": 0.0, "next_days": 0.0, "pain_sum": 0.0} for group in FOOD_GROUPS
    }
    for entry in entries:
        day = entry.get("date")
        if not day:
            continue
        try:
            following = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
        except ValueError:
            continue
        eaten = entry.get("answers", {}).get("foods") or []
        if not isinstance(eaten, list):
            continue
        next_entry = by_user_date.get(entry.get("user", ""), {}).get(following)
        next_pain = None
        if next_entry is not None:
            raw = next_entry.get("answers", {}).get("worst_pain")
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                next_pain = float(raw)
        for group in FOOD_GROUPS:
            if group not in eaten:
                continue
            bucket = stats[group]
            bucket["eaten"] += 1
            if next_pain is not None:
                bucket["next_days"] += 1
                bucket["pain_sum"] += next_pain

    write("## Foods, and the pain the next day\n\n")
    write(
        "For each food group: days it was eaten, and the mean worst pain the following day. "
        "The denominator is days where a next-day entry exists, so it is smaller than the "
        "number of times eaten.\n\n"
    )
    write("| food group | days eaten | next-day pain (n) | mean next-day pain |\n")
    write("| --- | --- | --- | --- |\n")
    for group in FOOD_GROUPS:
        bucket = stats[group]
        eaten = int(bucket["eaten"])
        n = int(bucket["next_days"])
        mean = f"{bucket['pain_sum'] / n:.1f}" if n else "—"
        write(f"| {group} | {eaten} | {n} | {mean} |\n")

    medications = Counter()
    for entry in entries:
        for item in entry.get("answers", {}).get("medications") or []:
            if item != "none":
                medications[str(item)] += 1
    if medications:
        write("\nMedication days: " + ", ".join(f"{key} {count}" for key, count in sorted(medications.items())) + "\n")

    # --- notes --------------------------------------------------------------
    notes = [
        entry
        for entry in entries
        if (entry.get("notes") or {}).get("other") or (entry.get("notes") or {}).get("red_flags_note")
    ]
    write("\n## Notes\n\n")
    if not notes:
        write("- None written this month.\n")
    for entry in notes:
        note = entry.get("notes") or {}
        parts = []
        if note.get("other"):
            parts.append(f"other: {note['other']}")
        if note.get("red_flags_note"):
            parts.append(f"red flags: {note['red_flags_note']}")
        write(f"- {entry.get('date', '?')} — " + " · ".join(parts) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export a month of gut check-ins. Writes to stdout unless --out is given.",
    )
    parser.add_argument("--month", required=True, help="YYYY-MM")
    parser.add_argument("--format", choices=("csv", "md"), default="md")
    parser.add_argument("--data-dir", type=Path, default=None, help="where YYYY-MM.jsonl lives")
    parser.add_argument("--out", type=Path, default=None, help="write here instead of stdout")
    args = parser.parse_args(argv)

    month = parse_month(args.month)
    data_dir = args.data_dir or default_data_dir()

    if args.out is not None:
        target = args.out.expanduser().resolve()
        if target == REPO_ROOT or REPO_ROOT in target.parents:
            fail(
                f"refusing to write inside the repository ({target}). "
                "Pass a path outside it, or drop --out to print."
            )
        args.out = target

    entries = load_entries(month, data_dir)

    if args.out is None:
        stream = sys.stdout
        close = False
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        stream = args.out.open("w", encoding="utf-8", newline="")
        close = True

    try:
        if args.format == "csv":
            write_csv(entries, stream)
        else:
            write_markdown(entries, month, stream)
    finally:
        if close:
            stream.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
