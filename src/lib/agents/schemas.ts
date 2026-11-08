/** Every structured Nemotron output in one place. Nothing here holds a dollar figure. */
import * as z from "zod";

/**
 * What the estimator returns for ONE category. It picks a forecaster and says
 * why; the chosen model is then fitted and scored deterministically.
 */
export const ModelChoice = z.object({
  kind: z.enum(["naive", "drift", "linear", "seasonal"]),
  /** Only meaningful for "seasonal". 12 = annual, 3 = quarterly, 1 = monthly bill. */
  period: z.number().int().min(0).max(24),
  /** 0..1. Low confidence should route the category to the deep tier. */
  confidence: z.number().min(0).max(1),
  /** One sentence, in plain language, naming the pattern it saw. */
  // Generous on purpose: the prompt asks for two short sentences, but a long answer must not fail the call.
  rationale: z.string().min(1).max(1200),
  /**
   * Display only - never fed to the fitter. Kept permissive on purpose: an
   * earlier version capped this at 0-11 and the model answered with data
   * indices, which failed validation and silently dropped the whole call.
   * Never let a decorative field be able to fail a structured call.
   */
  peakMonths: z.array(z.number().int()).max(6).default([]),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

/** One agent's bid for a slice of a fixed monthly surplus. */
export const Proposal = z.object({
  agent: z.string().min(1).max(60),
  /** Share of the surplus this agent is asking for, 0..1. */
  share: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  /** The case for this bid, in the agent's own voice. Shown in the transcript. */
  argument: z.string().min(1).max(500),
});
export type Proposal = z.infer<typeof Proposal>;

/**
 * The arbiter's verdict. This is LLM-as-judge with an explicit rubric - it
 * scores and ranks proposals against the user's stated priority order. It does
 * NOT invent an allocation; the orchestrator normalises the shares downstream.
 */
export const Verdict = z.object({
  ranking: z
    .array(
      z.object({
        agent: z.string().min(1).max(60),
        /** 0..10 against the rubric. */
        score: z.number().min(0).max(10),
        /** Which priority rule decided it, quoted from the list it was given. */
        basis: z.string().min(1).max(200),
      }),
    )
    .min(1),
  /** Two sentences max: what it traded off and why. */
  reasoning: z.string().min(1).max(600),
});
export type Verdict = z.infer<typeof Verdict>;

/** Cause attribution for a forecast that missed. */
export const ResidualCause = z.object({
  cause: z.enum(["one_off_shock", "regime_change", "seasonality_miss", "data_error", "within_noise"]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1).max(300),
  /** True when the forecaster itself should be refitted rather than ignored. */
  refit: z.boolean(),
});
export type ResidualCause = z.infer<typeof ResidualCause>;

/** Cluster label for a batch of merchant strings. */
export const ClusterLabel = z.object({
  label: z.string().min(1).max(40),
  category: z.enum([
    "income", "housing", "essentials", "discretionary",
    "subscriptions", "savings", "retirement", "card", "unknown",
  ]),
  confidence: z.number().min(0).max(1),
});
export type ClusterLabel = z.infer<typeof ClusterLabel>;
