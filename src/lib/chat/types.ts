/**
 * Shared types for the companion: the chatbot that talks to the user and the
 * overseer that keeps what it learns. Types only, so client code can import them
 * without pulling in zod or the model client.
 */

import type { CategoryKey } from "../finance/synth";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type FactKind =
  | "character"
  | "habit"
  | "priority"
  | "goal"
  | "constraint"
  | "event"
  | "preference";

/** Something the user said about themselves, with their own words as evidence. */
export type Observation = {
  kind: FactKind;
  statement: string;
  /** A verbatim quote from the user's messages. Checked in code, never trusted. */
  evidence: string;
  confidence: number;
};

export type ProfileFact = Observation & { id: string; at: string };

/**
 * A change to the forecast that the user told us about ("rent goes to $1,500 in
 * March"). The dollar amount must come from their own words; the overseer never
 * invents one (see validateAdjustment).
 *
 * Flow categories (income, spending): the change applies to the monthly flow, and
 * what is left over carries into checking. Balance and debt categories: the change
 * is a step (one_off) or a running contribution (recurring), and persists.
 */
export type ForecastAdjustment = {
  id: string;
  category: CategoryKey;
  kind: "level_shift" | "one_off" | "recurring";
  /** Months from today (1 = next month), 1..24. */
  startOffset: number;
  /** For recurring: every this many months. */
  everyMonths: number;
  /** Dollars, positive. Always a figure the user stated. */
  amount: number;
  direction: "increase" | "decrease";
  /** "set" replaces the forecast with `amount` from startOffset (level_shift only). */
  mode: "add" | "set";
  /** One plain line, shown to the user. */
  note: string;
  /** The user's own words. */
  evidence: string;
};

export type Profile = {
  facts: ProfileFact[];
  /** Ordered, most important first: only what the user has said they care about. */
  priorities: string[];
  adjustments: ForecastAdjustment[];
  /** A short portrait of who this person is, kept by the overseer. */
  summary: string;
  /** Topics already asked about, so the chatbot does not repeat itself. */
  asked: string[];
  updatedAt: string | null;
};

export type BriefTopic = { topic: string; why: string };

/** What the overseer tells the chatbot to bring up (or leave alone) right now. */
export type ChatBrief = {
  topics: BriefTopic[];
  /** Ids of computed finance facts the chatbot may mention. */
  mentionFactIds: string[];
  /** Things to avoid: declined topics, pushy angles. */
  avoid: string[];
  tone: string;
  createdAt: string;
};

/** A computed fact about the user's finances, in words. Numbers come from code. */
export type FinanceFact = { id: string; text: string };
