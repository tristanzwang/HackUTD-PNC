/**
 * "What if" scenarios. A Scenario is a set of plain deltas to named categories;
 * applyScenario folds them into a NEW Projection, deterministically and with no
 * model call. The real projection is never touched, so the overlay can always be
 * discarded to return to reality.
 *
 * Same division of labour as the rest of the finance layer: Nemotron only turns a
 * sentence into the Scenario below (category, amount, cadence, duration, label).
 * Every dollar figure here is computed, never generated.
 */

import { summaryOf, type CategoryProjection, type Projection } from "./projection";
import type { CategoryKey } from "./synth";

export type ScenarioDelta = {
  category: CategoryKey;
  /** Dollars per occurrence. Negative reduces the category. */
  amount: number;
  cadence: "daily" | "weekly" | "monthly" | "once";
  /** Months the delta runs for, from now. */
  months: number;
};

export type Scenario = {
  label: string; // "Gamble $100/day for 10 years"
  deltas: ScenarioDelta[];
};

/** Occurrences per month for each cadence (a month is 30.44 days / 4.345 weeks). */
const PER_MONTH: Record<ScenarioDelta["cadence"], number> = {
  daily: 30.44,
  weekly: 4.345,
  monthly: 1,
  once: 1,
};

/**
 * Apply `s` to `base` and return a new Projection. Flows (income, spending)
 * change by the monthly figure for the run; stocks (balances, debt) accumulate
 * that flow month over month and then hold. Balances clamp at 0; debt grows
 * without bound. Pure and deterministic.
 */
export function applyScenario(base: Projection, s: Scenario): Projection {
  const horizon = base.horizon;

  // The scenario is the user's own hypothetical, not a model's reading, so it lands on
  // BOTH the interpreted forecast and the raw carry-forward baseline. Otherwise the
  // Raw/Interpreted switch would make a what-if vanish.
  const edit = (rows: { value: number; lo: number; hi: number }[], cat: CategoryProjection) => {
    const out = rows.map((p) => ({ ...p }));
    for (const d of s.deltas) {
      if (d.category !== cat.key) continue;
      const isStock = cat.kind === "balance" || cat.kind === "debt";
      const run = Math.max(0, Math.min(Math.round(d.months), horizon));
      const monthly = d.cadence === "once" ? d.amount : d.amount * PER_MONTH[d.cadence];

      for (let k = 0; k < horizon; k++) {
        // out[k] is month k + 1 from now
        let add: number;
        if (d.cadence === "once") {
          // a one-off step persists on a stock; on a flow it bumps a single month
          add = isStock ? d.amount : k === 0 ? d.amount : 0;
        } else if (isStock) {
          // the recurring flow accumulates into the stock while it runs, then holds
          add = monthly * Math.min(k + 1, run);
        } else {
          // the flow level shifts for the duration of the run
          add = k < run ? monthly : 0;
        }
        const f = out[k];
        // can't hold a negative balance or spend a negative amount; debt has no cap
        f.value = Math.max(0, f.value + add);
        f.lo = Math.max(0, f.lo + add);
        f.hi = Math.max(0, f.hi + add);
      }
    }
    return out;
  };

  // copy the rows we edit; everything else is shared with `base`
  const categories = base.categories.map((c) => ({
    ...c,
    forecast: edit(c.forecast, c),
    baseline: edit(c.baseline, c),
  }));

  return {
    ...base,
    // a distinct version so the scene/fluids re-read this instead of the real one
    version: `${base.version}~${scenarioKey(s)}`,
    categories,
    summary: summaryOf(categories, horizon, "forecast"),
    baselineSummary: summaryOf(categories, horizon, "baseline"),
  };
}

/** The month index at which to read a scenario's effect: the end of its longest run. */
export function runLength(base: Projection, s: Scenario): number {
  const longest = s.deltas.reduce((m, d) => Math.max(m, Math.round(d.months)), 0);
  return Math.max(1, Math.min(longest, base.horizon));
}

/** A short hash of a scenario, so its overlay gets its own version string. */
function scenarioKey(s: Scenario): string {
  const str = s.label + JSON.stringify(s.deltas);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
