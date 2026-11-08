/**
 * The estimator: Nemotron reads a category's history PLUS deterministic
 * statistics about it, and chooses which forecaster to use. It never produces
 * a forecast and never sees a dollar it can change.
 *
 * Design note, learned the hard way. The first version handed the model raw
 * numbers and asked it to spot cycles. Measured on held-out months it picked
 * "seasonal" far too often and made two categories WORSE than carry-forward.
 * So the statistics are now computed first - trend, noise, autocorrelation at
 * lag 12, how many full cycles the history covers - and the model interprets
 * them instead of eyeballing a column of figures.
 *
 * That split is also the honest answer to "why not just use a stats test?":
 * the test produces the number, the model decides whether the number means a
 * real cycle or an artefact, names the cause in plain language, and can apply
 * world knowledge a test cannot (rent has no cycle; heating bills do).
 */

import { callTier, type CallRecord } from "../nemotron/client";
import { ModelChoice } from "./schemas";
import { evidence, type FitSpec } from "../finance/forecast";

const SYSTEM = `You are a time-series model-selection agent in a personal
finance system. You are given one category, its monthly history, and
statistics already computed from that history. Choose the forecaster:

  naive    - no reliable trend; last value carried forward
  drift    - steady compounding growth or decay, no cycle
  linear   - steady additive trend, no cycle
  seasonal - additive trend PLUS a repeating annual cycle

How to read the statistics you are given:
- seasonalStrength is the autocorrelation of the detrended series at lag 12.
  Below 0.25 there is NO usable annual cycle, whatever the raw numbers look
  like. Choose seasonal ONLY when it is 0.25 or higher AND seasonalEstimable
  is true. Choosing seasonal without that evidence makes forecasts worse.
- seasonalEstimable is false when the history covers under two full cycles.
  When it is false, seasonal is not available to you at all.
- trendPerMonth near zero (|value| < 0.002) with high noiseRatio means naive.
- A steady trend with low noise means linear, or drift if growth looks
  proportional (balances, debts and investments usually compound; bills and
  rent usually step up additively).

Set confidence to reflect the evidence, not your enthusiasm. Weak or
conflicting statistics mean confidence below 0.5.
Never output a forecast or a dollar amount. Pick the model only.
Keep "rationale" to at most two short sentences, and make sure it describes the
model you actually chose.`;

export async function chooseModel(input: {
  label: string;
  kind: string;
  months: string[];
  values: number[];
}): Promise<{ spec: FitSpec; choice: ModelChoice; record: CallRecord }> {
  const ev = evidence(input.values, 12);
  const rows = input.values.map((v, i) => `${input.months[i]}: ${v.toFixed(2)}`).join("\n");

  const { data, record } = await callTier({
    label: `estimate:${input.label}`,
    // An ambiguous series earns the deep tier; a clear one does not.
    tier: Math.abs(ev.seasonalStrength) > 0.2 && ev.seasonalStrength < 0.4 ? "deep" : "fast",
    system: SYSTEM,
    schema: ModelChoice,
    user:
      `Category: ${input.label} (${input.kind})\n\n` +
      `Computed statistics:\n` +
      `  months of history : ${ev.n}\n` +
      `  trendPerMonth     : ${ev.trendPerMonth.toFixed(5)}\n` +
      `  noiseRatio        : ${ev.noiseRatio.toFixed(4)}\n` +
      `  seasonalStrength  : ${ev.seasonalStrength.toFixed(3)}  (lag 12)\n` +
      `  cycles covered    : ${ev.cycles.toFixed(2)}\n` +
      `  seasonalEstimable : ${ev.seasonalEstimable}\n\n` +
      `History:\n${rows}`,
  });

  // Hard guard. The model does not get to override the estimability rule, and
  // it does not get to pick seasonal on a series with no measured cycle.
  const seasonalAllowed = ev.seasonalEstimable && ev.seasonalStrength >= 0.25;
  const spec: FitSpec =
    data.kind === "seasonal" && !seasonalAllowed
      ? { kind: "linear" }
      : data.kind === "seasonal"
        ? { kind: "seasonal", period: data.period >= 2 ? data.period : 12 }
        : { kind: data.kind };

  return { spec, choice: data, record };
}
