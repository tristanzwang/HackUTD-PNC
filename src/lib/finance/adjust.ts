/**
 * Apply the user's own plans to the forecast. Deterministic: given the baseline
 * forecast and a list of plans, the result is fixed. The model never touches a number.
 *
 * Two kinds of category behave differently:
 *   - flows (income, rent, essentials, discretionary, subscriptions) are monthly
 *     amounts. A plan changes that month's flow, and what it changes is carried
 *     into checking: earning $300 more a month leaves checking $300 higher each
 *     month, cumulatively.
 *   - balances and debt (checking, savings, retirement, card) are stocks. A plan is a
 *     step (one_off) or a running contribution (recurring) that stays in the balance.
 *
 * Not modelled (and said so to the user): moving money between accounts, interest on
 * the extra, and taxes. A plan touches one category, plus checking for flows.
 */

import type { ForecastAdjustment } from "../chat/types";
import type { CategoryKey } from "./synth";

export const FLOW_CATEGORIES: readonly CategoryKey[] = [
  "income",
  "housing",
  "essentials",
  "discretionary",
  "subscriptions",
];
export const isFlow = (k: CategoryKey) => FLOW_CATEGORIES.includes(k);

/**
 * Dollar change to each forecast month (index 0 = next month) from one plan.
 * `baseline` is the unadjusted forecast, used by "set" plans.
 */
export function adjustmentDeltas(a: ForecastAdjustment, baseline: number[]): number[] {
  const horizon = baseline.length;
  const d = new Array<number>(horizon).fill(0);
  const sign = a.direction === "increase" ? 1 : -1;
  const flow = isFlow(a.category);
  const s = a.startOffset - 1;
  if (s < 0 || s >= horizon) return d;

  if (a.kind === "level_shift" && a.mode === "set") {
    for (let i = s; i < horizon; i++) d[i] = a.amount - baseline[i];
    return d;
  }
  if (a.kind === "one_off") {
    if (flow) d[s] = sign * a.amount; // one month's flow
    else for (let i = s; i < horizon; i++) d[i] = sign * a.amount; // a step in the balance
    return d;
  }
  // recurring, or a level shift
  const every = a.kind === "recurring" ? Math.max(a.everyMonths, 1) : 1;
  if (flow) {
    if (a.kind === "level_shift") for (let i = s; i < horizon; i++) d[i] = sign * a.amount;
    else for (let i = s; i < horizon; i += every) d[i] = sign * a.amount;
  } else {
    // a running contribution to a balance: it accumulates
    let total = 0;
    for (let i = s; i < horizon; i++) {
      if ((i - s) % every === 0) total += sign * a.amount;
      d[i] = total;
    }
  }
  return d;
}

/**
 * Per-category dollar changes for a set of plans, including the effect of income
 * and spending plans on checking. Plans for unknown categories are ignored.
 */
export function combineDeltas(
  plans: ForecastAdjustment[],
  baselines: Partial<Record<CategoryKey, number[]>>,
  horizon: number,
): Partial<Record<CategoryKey, number[]>> {
  const out: Partial<Record<CategoryKey, number[]>> = {};
  const add = (key: CategoryKey, d: number[]) => {
    const cur = out[key] ?? new Array<number>(horizon).fill(0);
    out[key] = cur.map((v, i) => v + d[i]);
  };
  for (const p of plans) {
    const base = baselines[p.category];
    if (!base) continue;
    const d = adjustmentDeltas(p, base);
    add(p.category, d);
    if (isFlow(p.category) && baselines.checking) {
      // extra income raises checking; extra spending lowers it; the effect builds up month by month
      const s = p.category === "income" ? 1 : -1;
      let run = 0;
      add("checking", d.map((v) => (run += s * v)));
    }
  }
  return out;
}
