/**
 * Pure logic for the user's profile: validating what the models claim against what
 * the user actually said, and merging it in. No network, no LLM, safe for the client.
 *
 * The rule that holds this together: a model may *propose* anything, but nothing
 * reaches the profile or the forecast unless the user's own words back it up.
 */

import type { CategoryKey } from "../finance/synth";
import type {
  ChatMessage,
  ForecastAdjustment,
  Observation,
  Profile,
  ProfileFact,
} from "./types";

export const MAX_FACTS = 40;
export const MAX_ASKED = 24;

export const emptyProfile = (): Profile => ({
  facts: [],
  priorities: [],
  adjustments: [],
  summary: "",
  asked: [],
  updatedAt: null,
});

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Lowercase letters and digits only, single-spaced: "I’ll pay $1,500!" -> "i ll pay 1 500". */
function squash(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `quote` appears in one of the user's own messages (ignoring punctuation and case). */
export function quoteIn(quote: string, userTexts: string[]) {
  const q = squash(quote);
  if (q.length < 3) return false;
  return userTexts.some((t) => squash(t).includes(q));
}

/** Every dollar-looking number in a string: "$1,500" -> 1500, "2k" -> 2000, "1.5k" -> 1500. */
export function parseAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(m[2] ? n * 1000 : n);
  }
  return out;
}

/** The amount must literally be in the quote: the model cannot make a figure up. */
export function quoteSupportsAmount(evidence: string, amount: number) {
  return parseAmounts(evidence).some((v) => Math.abs(v - amount) <= Math.max(0.01 * amount, 0.5));
}

/** What a model proposed, before it has been checked. `startMonth` is a label like "Mar 2027". */
export type AdjustmentDraft = {
  category: CategoryKey;
  kind: ForecastAdjustment["kind"];
  startMonth: string;
  everyMonths: number;
  amount: number;
  direction: ForecastAdjustment["direction"];
  mode: ForecastAdjustment["mode"];
  note: string;
  evidence: string;
};

/**
 * Accept a proposed adjustment only if: its category is real, its month is in the
 * forecast window, its quote is the user's own words, and the dollar amount is in
 * that quote. Anything else is rejected with a reason (shown to the user).
 */
export function validateAdjustment(
  draft: AdjustmentDraft,
  userTexts: string[],
  /** Forecast month labels, index 0 = next month. */
  futureMonths: string[],
  knownCategories: readonly string[],
): { ok: true; adjustment: ForecastAdjustment } | { ok: false; reason: string } {
  if (!knownCategories.includes(draft.category)) return { ok: false, reason: "unknown category" };
  const idx = futureMonths.indexOf(draft.startMonth);
  if (idx < 0) return { ok: false, reason: `month "${draft.startMonth}" is outside the forecast` };
  if (!(draft.amount > 0) || !Number.isFinite(draft.amount)) return { ok: false, reason: "no valid amount" };
  if (!quoteIn(draft.evidence, userTexts)) return { ok: false, reason: "the quote isn’t something you said" };
  if (!quoteSupportsAmount(draft.evidence, draft.amount))
    return { ok: false, reason: `$${draft.amount} isn’t in your quote` };
  return {
    ok: true,
    adjustment: {
      id: newId("plan"),
      category: draft.category,
      kind: draft.kind,
      startOffset: idx + 1,
      everyMonths: draft.kind === "recurring" ? Math.min(Math.max(Math.round(draft.everyMonths), 1), 12) : 1,
      amount: draft.amount,
      direction: draft.direction,
      mode: draft.kind === "level_shift" ? draft.mode : "add",
      note: draft.note.trim(),
      evidence: draft.evidence.trim(),
    },
  };
}

/** Keep only observations whose quote really is the user's words. */
export function verifyObservations(obs: Observation[], userTexts: string[]) {
  return obs.filter((o) => o.statement.trim() && quoteIn(o.evidence, userTexts));
}

export type ProfileUpdate = {
  summary?: string;
  priorities?: string[];
  retireFactIds?: string[];
  newFacts?: Observation[];
  adjustments?: ForecastAdjustment[];
  dropAdjustmentIds?: string[];
  asked?: string;
};

/** Merge an update into a profile (returns a new one). Caps sizes and drops duplicates. */
export function mergeProfile(profile: Profile, u: ProfileUpdate, now = new Date()): Profile {
  const retire = new Set(u.retireFactIds ?? []);
  let facts = profile.facts.filter((f) => !retire.has(f.id));

  const seen = new Set(facts.map((f) => squash(f.statement)));
  for (const o of u.newFacts ?? []) {
    const key = squash(o.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fact: ProfileFact = { ...o, id: newId("fact"), at: now.toISOString() };
    facts.push(fact);
  }
  if (facts.length > MAX_FACTS) {
    // keep the most confident, breaking ties toward the newest
    facts = [...facts]
      .sort((a, b) => b.confidence - a.confidence || b.at.localeCompare(a.at))
      .slice(0, MAX_FACTS)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  const drop = new Set(u.dropAdjustmentIds ?? []);
  const adjustments = [...profile.adjustments.filter((a) => !drop.has(a.id)), ...(u.adjustments ?? [])];

  const asked = u.asked && !profile.asked.includes(u.asked) ? [...profile.asked, u.asked] : profile.asked;

  return {
    facts,
    priorities: u.priorities ? u.priorities.slice(0, 6) : profile.priorities,
    adjustments,
    summary: u.summary !== undefined ? u.summary.slice(0, 800) : profile.summary,
    asked: asked.slice(-MAX_ASKED),
    updatedAt: now.toISOString(),
  };
}

/** The profile as compact text for a prompt. */
export function profileForPrompt(p: Profile): string {
  const lines: string[] = [];
  lines.push(`Portrait: ${p.summary || "(nothing known yet)"}`);
  if (p.priorities.length) lines.push(`What they care about, in order: ${p.priorities.map((x, i) => `${i + 1}. ${x}`).join("; ")}`);
  if (p.facts.length) {
    lines.push("Things they have told us:");
    for (const f of p.facts) lines.push(`  [${f.id}] (${f.kind}) ${f.statement}`);
  }
  if (p.adjustments.length) {
    lines.push("Plans already applied to their forecast:");
    for (const a of p.adjustments) lines.push(`  [${a.id}] ${a.note}`);
  }
  return lines.join("\n");
}

export const userTextsOf = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => m.content);
