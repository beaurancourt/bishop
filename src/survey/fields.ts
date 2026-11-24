/**
 * The eleven fast-path fields of the daily gut check-in, and the one place that
 * knows how a select-menu value becomes a stored answer.
 *
 * The shape here is the storage shape: `answers` is keyed by `FieldKey`, and a
 * value is either a number, a string, or (for the two multi-selects) a string
 * array. Nothing in this module touches Discord or the filesystem.
 */

/** Multi-select sentinel: "none" means the list is empty for that day. */
export const NONE = "none";

export type FieldKey =
  | "worst_pain"
  | "bloating"
  | "upper_gi"
  | "bowel_movements"
  | "bristol"
  | "urgency"
  | "woke_at_night"
  | "foods"
  | "medications"
  | "stress"
  | "sleep";

export type FieldKind = "scale" | "enum" | "bristol" | "multi";

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldDef {
  key: FieldKey;
  /** Question text shown in the prompt above the menu. */
  prompt: string;
  /** Placeholder, which is what the menu shows before a value is picked. */
  placeholder: string;
  kind: FieldKind;
  /** Which page of the DM this field is on. Pages hold at most four menus. */
  page: number;
  options: FieldOption[];
}

/** Answer value for one field, as written to JSONL. */
export type AnswerValue = number | string | string[];

export type Answers = Partial<Record<FieldKey, AnswerValue>>;

const scale = (from: number, to: number, suffix = ""): FieldOption[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    label: `${from + i}${suffix}`,
    value: String(from + i),
  }));

const enumOptions = (...values: string[]): FieldOption[] =>
  values.map((value) => ({ label: value, value }));

/**
 * Bristol values are the published 1-7 scale, in its own words, plus "none"
 * for a day without a bowel movement. Clinicians read these without a legend.
 */
export const BRISTOL_OPTIONS: FieldOption[] = [
  { label: "1 — separate hard lumps", value: "1" },
  { label: "2 — lumpy sausage", value: "2" },
  { label: "3 — like a sausage, cracked", value: "3" },
  { label: "4 — smooth snake", value: "4" },
  { label: "5 — soft blobs", value: "5" },
  { label: "6 — mushy, ragged", value: "6" },
  { label: "7 — entirely liquid", value: "7" },
  { label: "none", value: NONE },
];

/** Food groups between which the low-FODMAP trial separates a trigger. */
export const FOOD_OPTIONS: FieldOption[] = [
  { label: "dairy", value: "dairy" },
  { label: "wheat", value: "wheat" },
  { label: "onion/garlic", value: "onion/garlic" },
  { label: "legumes", value: "legumes" },
  { label: "apple/pear/stone fruit", value: "apple/pear/stone fruit" },
  { label: "honey/HFCS/sorbitol", value: "honey/HFCS/sorbitol" },
  { label: "caffeine", value: "caffeine" },
  { label: "alcohol", value: "alcohol" },
  { label: "fried/fatty", value: "fried/fatty" },
  { label: "carbonated", value: "carbonated" },
  { label: "none", value: NONE },
];

export const MEDICATION_OPTIONS: FieldOption[] = [
  { label: "PPI", value: "PPI" },
  { label: "antacid", value: "antacid" },
  { label: "laxative", value: "laxative" },
  { label: "probiotic", value: "probiotic" },
  { label: "other", value: "other" },
  { label: "none", value: NONE },
];

/**
 * Page 1: pain and the two "how much" numbers.
 * Page 2: gut behaviour and the two modifiers of stress.
 * Page 3: the two multi-selects and sleep.
 *
 * Discord allows five action rows per message and one component per row for a
 * select menu, so a page carries at most four menus plus its button row.
 */
export const FIELDS: FieldDef[] = [
  {
    key: "worst_pain",
    prompt: "Worst abdominal pain today",
    placeholder: "worst pain (0 = none, 10 = worst)",
    kind: "scale",
    page: 1,
    options: scale(0, 10),
  },
  {
    key: "bloating",
    prompt: "Bloating or distension",
    placeholder: "bloating (0 = none, 10 = worst)",
    kind: "scale",
    page: 1,
    options: scale(0, 10),
  },
  {
    key: "upper_gi",
    prompt: "Upper GI: heartburn, regurgitation, nausea",
    placeholder: "upper GI symptoms",
    kind: "enum",
    page: 1,
    options: enumOptions("none", "mild", "moderate", "severe"),
  },
  {
    key: "bowel_movements",
    prompt: "Bowel movements today",
    placeholder: "bowel movements",
    kind: "scale",
    page: 1,
    options: [
      { label: "0", value: "0" },
      { label: "1", value: "1" },
      { label: "2", value: "2" },
      { label: "3", value: "3" },
      { label: "4+", value: "4" },
    ],
  },
  {
    key: "bristol",
    prompt: "Stool form (Bristol scale)",
    placeholder: "Bristol stool form",
    kind: "bristol",
    page: 2,
    options: BRISTOL_OPTIONS,
  },
  {
    key: "urgency",
    prompt: "Urgency or an accident",
    placeholder: "urgency or accident",
    kind: "enum",
    page: 2,
    options: enumOptions("yes", "no"),
  },
  {
    key: "woke_at_night",
    prompt: "Did symptoms wake you?",
    placeholder: "symptoms woke you",
    kind: "enum",
    page: 2,
    options: enumOptions("yes", "no"),
  },
  {
    key: "stress",
    prompt: "Stress today",
    placeholder: "stress (0 = none, 4 = extreme)",
    kind: "scale",
    page: 2,
    options: scale(0, 4),
  },
  {
    key: "foods",
    prompt: "Foods of note today (choose any)",
    placeholder: "foods of note",
    kind: "multi",
    page: 3,
    options: FOOD_OPTIONS,
  },
  {
    key: "medications",
    prompt: "Medication today (choose any)",
    placeholder: "medication today",
    kind: "multi",
    page: 3,
    options: MEDICATION_OPTIONS,
  },
  {
    key: "sleep",
    prompt: "Sleep last night",
    placeholder: "hours slept",
    kind: "enum",
    page: 3,
    options: enumOptions("<5 h", "5-6 h", "6-7 h", "7-8 h", "8+ h"),
  },
];

export const FIELD_KEYS: FieldKey[] = FIELDS.map((field) => field.key);

export const PAGE_COUNT = Math.max(...FIELDS.map((field) => field.page));

export function fieldByKey(key: string): FieldDef | undefined {
  return FIELDS.find((field) => field.key === key);
}

export function fieldsOnPage(page: number): FieldDef[] {
  return FIELDS.filter((field) => field.page === page);
}

export class AnswerError extends Error {}

/**
 * Turns the values a select menu delivered into the stored answer.
 *
 * `bristol` keeps `none` as a string so a day without a bowel movement is not
 * read as Bristol 0; `bowel_movements` stores 4 for "4 or more", documented in
 * the CSV header rather than as a new value type.
 */
export function decodeValues(field: FieldDef, values: string[]): AnswerValue {
  const allowed = new Set(field.options.map((option) => option.value));
  const valid = values.filter((value) => allowed.has(value));
  if (valid.length === 0) {
    throw new AnswerError(`no valid value for ${field.key}: ${JSON.stringify(values)}`);
  }
  if (field.kind === "multi") return valid;
  const value = valid[0];
  if (field.kind === "scale") return Number(value);
  if (field.kind === "bristol") return value === NONE ? NONE : Number(value);
  return value;
}

/**
 * Applies one select-menu interaction to the answers collected so far.
 *
 * "none" in a multi-select clears the rest, and picking a real item clears
 * "none": the stored list never says both. An interaction that carries no
 * valid value leaves the draft untouched.
 */
export function applyAnswer(answers: Answers, key: string, values: string[]): Answers {
  const field = fieldByKey(key);
  if (!field) throw new AnswerError(`unknown field ${JSON.stringify(key)}`);
  if (field.kind === "multi") {
    const allowed = new Set(field.options.map((option) => option.value));
    const valid = values.filter((value) => allowed.has(value));
    if (valid.length === 0) return answers;
    const real = valid.filter((value) => value !== NONE);
    const stored = real.length === 0 ? [NONE] : real;
    return { ...answers, [field.key]: stored };
  }
  return { ...answers, [field.key]: decodeValues(field, values) };
}

/** Fields with no answer yet, in prompt order. */
export function missingFields(answers: Answers): FieldDef[] {
  return FIELDS.filter((field) => {
    const value = answers[field.key];
    if (value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
}

export function answeredCount(answers: Answers): number {
  return FIELDS.length - missingFields(answers).length;
}

/** A stored answer rendered back as the option label the user picked. */
export function displayValue(field: FieldDef, value: AnswerValue | undefined): string {
  if (value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value
      .map((item) => field.options.find((option) => option.value === item)?.label ?? item)
      .join(", ");
  }
  if (field.key === "bowel_movements" && value === 4) return "4+";
  return field.options.find((option) => option.value === String(value))?.label ?? String(value);
}

/** The option values that should render as selected for a stored answer. */
export function selectedValues(field: FieldDef, value: AnswerValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}
