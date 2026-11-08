/**
 * Held-out evaluation. Fit on the first `train` months, predict the rest,
 * score against months the fitter never saw.
 *
 * This is the number you put on a slide. It is a claim about recovering
 * structure in a known generated series, NOT a claim about real-world
 * financial accuracy - say so out loud.
 */

import { ALL_SPECS, fit, type FitSpec, type ModelKind } from "./forecast";

export type Score = {
  spec: FitSpec;
  /** Mean absolute error over the held-out window. */
  mae: number;
  /** MAE as a fraction of the mean held-out value. */
  mape: number;
};

export function scoreSpec(y: number[], train: number, spec: FitSpec): Score {
  const f = fit(y.slice(0, train), spec);
  const held = y.slice(train);
  let err = 0;
  for (let k = 0; k < held.length; k++) err += Math.abs(f.predict(k + 1) - held[k]);
  const mae = held.length ? err / held.length : 0;
  const avg = held.length ? held.reduce((a, v) => a + v, 0) / held.length : 1;
  return { spec, mae, mape: avg === 0 ? 0 : mae / avg };
}

/** Score every candidate; returns them best-first. */
export function rankSpecs(y: number[], train: number): Score[] {
  return ALL_SPECS.map((s) => scoreSpec(y, train, s)).sort((a, b) => a.mae - b.mae);
}

export type Verdict = {
  category: string;
  chosen: ModelKind;
  chosenMae: number;
  baselineMae: number;
  /** >0 means the choice beat carry-forward. This is the headline figure. */
  improvementPct: number;
  oracle: ModelKind;
  /** True when the choice matched the best available model. */
  optimal: boolean;
};

/** Judge one chosen spec against the naive baseline and against the oracle. */
export function judge(category: string, y: number[], train: number, chosen: FitSpec): Verdict {
  const ranked = rankSpecs(y, train);
  const baseline = ranked.find((r) => r.spec.kind === "naive")!;
  const chosenScore = scoreSpec(y, train, chosen);
  const oracle = ranked[0];
  return {
    category,
    chosen: chosen.kind,
    chosenMae: chosenScore.mae,
    baselineMae: baseline.mae,
    improvementPct: baseline.mae === 0 ? 0 : ((baseline.mae - chosenScore.mae) / baseline.mae) * 100,
    oracle: oracle.spec.kind,
    optimal: oracle.spec.kind === chosen.kind,
  };
}
