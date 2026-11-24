/**
 * The red-flag list from the spec, turned into detection over what she typed in
 * the notes box, plus the one piece of copy the bot must never soften.
 *
 * The fast path is a fixed set of selects, so there is no yes/no field for each
 * alarm symptom: the notes modal asks "anything from the red-flag list today"
 * and this module reads that answer. Any positive mention fires the flag; the
 * flag keys are what gets written to JSONL, the labels are what a person reads.
 */

export interface RedFlagDef {
  key: string;
  label: string;
  patterns: RegExp[];
  /**
   * A clause that matches one of these is not evidence of this flag: "blood
   * test was normal" is not a bleed, however alarming the word looks.
   */
  unless?: RegExp[];
}

export const RED_FLAGS: RedFlagDef[] = [
  {
    key: "unintentional_weight_loss",
    label: "unintentional weight loss",
    patterns: [
      /\bweight loss\b/i,
      /\blosing weight\b/i,
      /\blost weight\b/i,
      /\blost \d+ ?(lb|lbs|pound|pounds|kg|kilos?|kilograms?|stone)\b/i,
      /\bdropped \d+ ?(lb|lbs|pound|pounds|kg|kilos?)\b/i,
    ],
  },
  {
    key: "dysphagia",
    label: "difficulty or pain swallowing",
    patterns: [/\bswallow/i, /\bdysphagi/i, /\bodynophagi/i],
    unless: [/\bswallow(ing)? (test|study|exercises?)\b/i],
  },
  {
    key: "gi_bleeding",
    label: "vomiting blood, black or tarry stools, or blood in stool",
    patterns: [
      /\bblood\b/i,
      /\bblack (stool|stools|poo|poop)\b/i,
      /\btarry\b/i,
      /\bmelaena\b/i,
      /\bhematemesis\b/i,
    ],
    unless: [/\bblood (test|tests|work|pressure|sugar|panel|draw|results?)\b/i],
  },
  {
    key: "persistent_vomiting",
    label: "persistent vomiting",
    patterns: [/\bvomit/i, /\bthrowing up\b/i, /\bthrew up\b/i, /\bpuking\b/i],
  },
  {
    key: "anaemia",
    label: "anaemia or known iron deficiency",
    patterns: [
      /\banemi/i,
      /\biron (deficiency|deficient|low|levels?)\b/i,
      /\biron (levels? )?(is |are )?low\b/i,
      /\blow iron\b/i,
      /\bferritin\b/i,
    ],
  },
  {
    key: "fever_with_pain",
    label: "fever with abdominal pain",
    patterns: [/\bfever\b/i, /\bhigh temperature\b/i, /\bchills\b/i],
  },
  {
    key: "new_symptoms_age_55",
    label: "new or worsening symptoms at 55 or older",
    patterns: [/\bnew symptoms?\b/i, /\bsymptoms? (are |is )?new\b/i, /\b(over|past|aged?|age) 55\b/i],
  },
  {
    key: "night_symptoms",
    label: "waking at night with symptoms, or symptoms that stop eating",
    patterns: [
      /\bwoke me\b/i,
      /\bwaking (me )?(up )?(at|during the) night\b/i,
      /\bwake (me )?(up )?(at|during the) night\b/i,
      /\bwoken me\b/i,
      /\bnight sweats?\b/i,
      /\b(can'?t|cannot|unable to) eat\b/i,
      /\b(stopped|stop) eating\b/i,
      /\bnot eating\b/i,
    ],
  },
];

const NEGATION = /^(no|none|not|nothing|nope|nil|negative|denies?|never|zero)$/i;

/** Splits free text into the smallest clauses a negation could apply to. */
function clauses(text: string): string[] {
  return text
    .split(/[,.;!?\n]+|\bbut\b|\bexcept\b|\bthough\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isNegated(clause: string): boolean {
  const lead = clause.split(/\s+/).slice(0, 5);
  return lead.some((word) => NEGATION.test(word.replace(/[^a-z']/gi, "")));
}

/**
 * Flag keys present in a free-text red-flag answer, in the order of the list.
 *
 * Empty text, "none", "no", and "no blood, no black stools" all return `[]`;
 * "blood test was normal" returns `[]`; "vomited blood last night" returns
 * `["gi_bleeding"]`.
 */
export function detectRedFlags(text: string | null | undefined): string[] {
  if (!text || text.trim().length === 0) return [];
  const fired = new Set<string>();
  for (const clause of clauses(text)) {
    if (isNegated(clause)) continue;
    const clauseFlags: string[] = [];
    for (const flag of RED_FLAGS) {
      if (flag.unless?.some((pattern) => pattern.test(clause))) continue;
      if (flag.patterns.some((pattern) => pattern.test(clause))) clauseFlags.push(flag.key);
    }
    // "vomited blood" names the bleed; the same clause need not also say
    // "persistent vomiting". A separate clause still can.
    for (const key of clauseFlags) {
      if (key === "persistent_vomiting" && clauseFlags.includes("gi_bleeding")) continue;
      fired.add(key);
    }
  }
  return RED_FLAGS.filter((flag) => fired.has(flag.key)).map((flag) => flag.key);
}

export function redFlagLabel(key: string): string {
  return RED_FLAGS.find((flag) => flag.key === key)?.label ?? key;
}

/**
 * What the bot says after an entry with flags. It states the instruction, names
 * what she reported, and names the emergencies. It never reassures: no "probably
 * fine", no "don't worry", no interpretation.
 */
export function redFlagMessage(flagKeys: string[]): string | null {
  if (flagKeys.length === 0) return null;
  const labels = flagKeys.map(redFlagLabel);
  return [
    "⚠️ **Please contact your doctor today.**",
    `You reported: ${labels.join("; ")}. That is on the list that needs a person, not a diary.`,
    "If you have vomited blood, have black or tarry stools, have fainted, have severe chest pain, or have cold sweats with chest or upper-abdominal pain, **seek urgent care now** — call 911 or go to an emergency department. Do not wait for the morning.",
    "This is a diary, not medical advice. bishop cannot tell you what is wrong, and writing it down does not replace being seen.",
  ].join("\n\n");
}
