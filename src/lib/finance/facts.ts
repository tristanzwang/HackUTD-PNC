/**
 * Facts about the user's finances, written in words from the computed projection.
 *
 * The chatbot is only ever allowed to quote a number that appears here. The overseer
 * picks WHICH facts to surface (by id); it never writes a figure itself. That keeps
 * every dollar the user hears traceable to the forecasting code.
 */

import type { FinanceFact } from "../chat/types";
import type { CategoryProjection, Projection } from "./projection";
import { formatUSD } from "./scene-bridge";

const cat = (p: Projection, key: string): CategoryProjection | undefined =>
  p.categories.find((c) => c.key === key);
const now = (c: CategoryProjection) => c.history[c.history.length - 1];
const end = (c: CategoryProjection) => c.forecast[c.forecast.length - 1].value;
const pct = (x: number) => `${Math.abs(x * 100).toFixed(0)}%`;

export function buildFacts(p: Projection): FinanceFact[] {
  const facts: FinanceFact[] = [];
  const months = p.horizon;

  const nw0 = p.summary.netWorth[0];
  const nwEnd = p.summary.netWorth[p.summary.netWorth.length - 1];
  facts.push({
    id: "net_worth",
    text: `Net worth (assets minus the credit card) is about ${formatUSD(nw0)} today and about ${formatUSD(nwEnd)} in ${months} months if recent patterns hold.`,
  });

  const s0 = p.summary.surplus[0];
  facts.push({
    id: "surplus",
    text:
      s0 < 0
        ? `Spending runs about ${formatUSD(-s0)} a month more than income right now, so there is no monthly surplus yet.`
        : `Income runs about ${formatUSD(s0)} a month above spending right now.`,
  });

  const card = cat(p, "card");
  if (card && now(card) > 0) {
    const ch = (end(card) - now(card)) / now(card);
    facts.push({
      id: "card",
      text: `The credit card balance is about ${formatUSD(now(card))} and is ${Math.abs(ch) < 0.03 ? "holding roughly steady" : `${ch > 0 ? "growing" : "shrinking"} about ${pct(ch)} over ${months} months`}.`,
    });
  }

  const income = cat(p, "income");
  const rent = cat(p, "housing");
  if (income && rent && now(income) > 0) {
    facts.push({
      id: "rent_share",
      text: `Rent is about ${pct(now(rent) / now(income))} of monthly income.`,
    });
  }

  const savings = cat(p, "savings");
  if (savings) {
    facts.push({
      id: "savings",
      text: `Savings are about ${formatUSD(now(savings))} today and heading toward ${formatUSD(end(savings))} in ${months} months.`,
    });
  }

  // a yearly cycle, if one was found: name its highest forecast month
  for (const c of p.categories) {
    if (c.model.kind !== "seasonal") continue;
    const first12 = c.forecast.slice(0, 12);
    const peak = first12.reduce((best, f, i) => (f.value > first12[best].value ? i : best), 0);
    facts.push({
      id: `cycle_${c.key}`,
      text: `${c.label} follows a yearly cycle, and its highest month in the coming year is ${p.futureMonths[peak]}.`,
    });
    break; // one cycle fact is plenty
  }

  const disc = cat(p, "discretionary");
  if (disc) {
    const last = disc.forecast[disc.forecast.length - 1];
    facts.push({
      id: "discretionary_range",
      text: `Discretionary spending is about ${formatUSD(now(disc))} a month, and it is the least predictable category (likely range ${formatUSD(last.lo)}–${formatUSD(last.hi)} in ${months} months).`,
    });
  }
  return facts;
}
