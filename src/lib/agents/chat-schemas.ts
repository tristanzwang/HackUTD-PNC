/** Structured outputs for the chatbot and the overseer. Nothing here is trusted until code checks it. */
import * as z from "zod";

export const CATEGORY_KEYS = [
  "income",
  "housing",
  "essentials",
  "discretionary",
  "subscriptions",
  "checking",
  "savings",
  "retirement",
  "card",
] as const;

const FactKind = z.enum(["character", "habit", "priority", "goal", "constraint", "event", "preference"]);

/** Something the user said about themselves. `evidence` is checked against their actual words. */
export const ObservationSchema = z.object({
  kind: FactKind,
  statement: z.string().min(1).max(600),
  evidence: z.string().min(1).max(800),
  confidence: z.number().min(0).max(1),
});

/** One chatbot turn: what it says, and what it learned from the user's last message. */
export const ChatTurn = z.object({
  reply: z.string().min(1).max(1500),
  // Limits on model output are generous on purpose, and code trims to the real caps:
  // a verbose answer must never be able to fail a whole call (it did, twice, in testing).
  observations: z.array(ObservationSchema).max(12).default([]),
  /** A few words naming the topic of the question just asked, or "". */
  askedAbout: z.string().max(120).default(""),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

/** What the overseer wants the chatbot to bring up (or leave alone). */
export const BriefSchema = z.object({
  topics: z
    .array(z.object({ topic: z.string().min(1).max(400), why: z.string().min(1).max(800) }))
    .min(1)
    .max(12),
  mentionFactIds: z.array(z.string().max(60)).max(12).default([]),
  avoid: z.array(z.string().max(500)).max(12).default([]),
  tone: z.string().max(600).default(""),
});
export type BriefOut = z.infer<typeof BriefSchema>;

/**
 * The overseer's update after a chat turn. Built per call because the allowed start
 * months are the actual forecast months, so the model cannot name a month we do not have.
 */
export function makeIntegrateSchema(futureMonths: string[]) {
  const months = z.enum(futureMonths as [string, ...string[]]);
  return z.object({
    summary: z.string().max(2000),
    priorities: z.array(z.string().min(1).max(400)).max(12).default([]),
    retireFactIds: z.array(z.string().max(60)).max(30).default([]),
    adjustments: z
      .array(
        z.object({
          category: z.enum(CATEGORY_KEYS),
          kind: z.enum(["level_shift", "one_off", "recurring"]),
          startMonth: months,
          everyMonths: z.number().int().min(1).max(12).default(1),
          amount: z.number().positive().max(10_000_000),
          direction: z.enum(["increase", "decrease"]),
          mode: z.enum(["add", "set"]).default("add"),
          note: z.string().min(1).max(400),
          evidence: z.string().min(1).max(800),
        }),
      )
      .max(12)
      .default([]),
    dropAdjustmentIds: z.array(z.string().max(60)).max(30).default([]),
    brief: BriefSchema,
  });
}

// ---------------------------------------------------------------------------
// Request shapes. The client keeps the profile (the server is stateless), so
// everything arriving from it is validated and size-capped before it goes near a prompt.
// ---------------------------------------------------------------------------

export const StoredAdjustment = z.object({
  id: z.string().max(40),
  category: z.enum(CATEGORY_KEYS),
  kind: z.enum(["level_shift", "one_off", "recurring"]),
  startOffset: z.number().int().min(1).max(24),
  everyMonths: z.number().int().min(1).max(12),
  amount: z.number().positive().max(10_000_000),
  direction: z.enum(["increase", "decrease"]),
  mode: z.enum(["add", "set"]),
  note: z.string().max(200),
  evidence: z.string().max(500),
});

export const StoredProfile = z.object({
  facts: z
    .array(
      ObservationSchema.extend({
        id: z.string().max(40),
        at: z.string().max(40),
      }),
    )
    .max(60),
  priorities: z.array(z.string().max(160)).max(8),
  adjustments: z.array(StoredAdjustment).max(24),
  summary: z.string().max(900),
  asked: z.array(z.string().max(120)).max(30),
  updatedAt: z.string().max(40).nullable(),
});

export const StoredBrief = z.object({
  topics: z
    .array(z.object({ topic: z.string().min(1).max(160), why: z.string().min(1).max(300) }))
    .max(4),
  mentionFactIds: z.array(z.string().max(60)).max(3),
  avoid: z.array(z.string().max(240)).max(5),
  tone: z.string().max(300),
  createdAt: z.string().max(40),
});

export const MessagesSchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) }))
  .max(60);
