/**
 * The projection: one object that carries everything the frontend needs to draw
 * a user's financial future. Pure functions, no network, no LLM, safe to import
 * from client code.
 *
 * Division of labour (the same rule the rest of the finance layer follows):
 *   - Nemotron decides WHICH forecaster fits each category and says why.
 *   - Everything numeric (fits, forecasts, ranges, net worth, insights) is
 *     computed here, deterministically. The model never writes a dollar figure,
 *     so a hallucinated number can never reach the user.
 */

import type { CallRecord } from "../nemotron/client";
import { evidence, fit, project, type FitSpec } from "./forecast";
import type { CategoryKey, CategorySpec, Persona } from "./synth";

export type ChoiceSource = "nemotron" | "heuristic";

/** How a category's forecaster was picked, and by whom. */
export type ModelInfo = {
  kind: FitSpec["kind"];
  period?: number;
  confidence: number;
  /** One plain-language sentence naming the pattern that was seen. */
  rationale: string;
  source: ChoiceSource;
  /** Telemetry from the model call, when there was one. */
  call?: Pick<CallRecord, "model" | "tier" | "thinking" | "ms" | "repairs">;
};

export type CategoryProjection = {
  key: CategoryKey;
  label: string;
  kind: CategorySpec["kind"];
  /** Monthly history, oldest first. Magnitudes: outflows and debts are positive. */
  history: number[];
  /** `horizon` months after the last history month, with an ~80% range. */
  forecast: { value: number; lo: number; hi: number }[];
  /** The same horizon under plain carry-forward (naive), so the UI can show what the model changed. */
  baseline: { value: number; lo: number; hi: number }[];
  model: ModelInfo;
  /** Plain-language reading of where this is heading, built from the numbers. */
  insight: string;
};

export type Summary = {
  /** Index 0 = today (the last history month), then one entry per forecast month. */
  netWorth: number[];
  /** Monthly income minus monthly spending. */
  surplus: number[];
  /** Assets and debts at each step, for explaining the net worth line. */
  assets: number[];
  debt: number[];
};

export type Projection = {
  /** Changes only when the underlying history changes. Clients use it to skip no-op refreshes. */
  version: string;
  generatedAt: string;
  persona: string;
  months: string[];
  futureMonths: string[];
  horizon: number;
  categories: CategoryProjection[];
  summary: Summary;
  /** `summary` recomputed from the carry-forward baselines, for a before/after comparison. */
  baselineSummary: Summary;
  agent: {
    /** True when Nemotron picked at least one model; false = every pick was the local heuristic. */
    live: boolean;
    note?: string;
  };
  /**
   * True when this came from the pre-built snapshot rather than a live run in
   * this process (a cold serverless start serves the snapshot before the first
   * Nemotron call completes). A freshly built projection is always `false`.
   */
  stale: boolean;
};

/** A model's pick for one category, however it was made. */
export type Choice = {
  spec: FitSpec;
  confidence: number;
  rationale: string;
  source: ChoiceSource;
  call?: ModelInfo["call"];
};

// ---------------------------------------------------------------------------
// the local fallback: the estimator's own rules, written as code
// ---------------------------------------------------------------------------

/**
 * Pick a forecaster from the same statistics the agent is shown, using the rules
 * in its prompt. This is what runs when there is no API key or a call fails, so
 * the app always has a projection, and it is labelled as such.
 */
export function heuristicChoice(y: number[], kind: CategorySpec["kind"]): Choice {
  const ev = evidence(y, 12);
  if (ev.seasonalEstimable && ev.seasonalStrength >= 0.25) {
    return {
      spec: { kind: "seasonal", period: 12 },
      confidence: Math.min(0.9, 0.5 + ev.seasonalStrength),
      rationale: "A repeating yearly cycle shows up on top of the trend.",
      source: "heuristic",
    };
  }
  if (Math.abs(ev.trendPerMonth) < 0.002) {
    return {
      spec: { kind: "naive" },
      confidence: 0.6,
      rationale: "No clear trend or cycle, so the latest value is carried forward.",
      source: "heuristic",
    };
  }
  if (kind === "balance" || kind === "debt") {
    return {
      spec: { kind: "drift" },
      confidence: ev.noiseRatio < 0.1 ? 0.7 : 0.5,
      rationale: "A steady trend that compounds, as balances and debts usually do.",
      source: "heuristic",
    };
  }
  return {
    spec: { kind: "linear" },
    confidence: ev.noiseRatio < 0.1 ? 0.7 : 0.5,
    rationale: "A steady step up or down each month, with no yearly cycle.",
    source: "heuristic",
  };
}

// ---------------------------------------------------------------------------
// plain-language insights, from the computed numbers only
// ---------------------------------------------------------------------------

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const pct = (n: number, digits = 0) => `${Math.abs(n * 100).toFixed(digits)}%`;

function insightFor(
  c: { label: string; kind: CategorySpec["kind"] },
  now: number,
  end: number,
  lo: number,
  hi: number,
  months: number,
  income: number,
): string {
  const change = now > 0 ? (end - now) / now : 0;
  const flat = Math.abs(change) < 0.03;
  const range = `Likely range ${usd(lo)}–${usd(hi)}.`;
  switch (c.kind) {
    case "debt":
      return flat
        ? `Your ${c.label.toLowerCase()} balance stays near ${usd(now)} if recent habits continue. ${range} Paying only the minimum mostly covers interest.`
        : `If recent habits continue, your ${c.label.toLowerCase()} balance moves from ${usd(now)} to about ${usd(end)} in ${months} months (${change > 0 ? "+" : "−"}${pct(change)}). ${range} Paying more than the interest each month is what brings a balance down.`;
    case "balance":
      return flat
        ? `Your ${c.label.toLowerCase()} stays near ${usd(now)}. ${range}`
        : `If recent habits continue, your ${c.label.toLowerCase()} goes from ${usd(now)} to about ${usd(end)} in ${months} months (${change > 0 ? "+" : "−"}${pct(change)}). ${range}`;
    case "outflow": {
      const share = income > 0 ? end / income : 0;
      return `${c.label} runs about ${usd(now)} a month now and heads toward ${usd(end)} (${flat ? "roughly flat" : `${change > 0 ? "+" : "−"}${pct(change)}`}), around ${pct(share)} of your income by then. ${range}`;
    }
    case "inflow":
      return `Income runs about ${usd(now)} a month now and heads toward ${usd(end)} (${flat ? "roughly flat" : `${change > 0 ? "+" : "−"}${pct(change)}`}). ${range}`;
  }
}

// ---------------------------------------------------------------------------
// building the projection
// ---------------------------------------------------------------------------

const ASSETS: CategoryKey[] = ["checking", "savings", "retirement"];
const SPENDING: CategoryKey[] = ["housing", "essentials", "discretionary", "subscriptions"];

/**
 * Net worth, surplus, assets and debt for k = 0 (today) .. horizon, read from the
 * categories' `forecast` (or `baseline`). Exported so a scenario overlay can
 * recompute it from edited forecasts without duplicating the accounting rules.
 */
export function summaryOf(
  categories: CategoryProjection[],
  horizon: number,
  which: "forecast" | "baseline" = "forecast",
): Summary {
  const at = (key: CategoryKey, k: number) => {
    const c = categories.find((x) => x.key === key);
    if (!c) return 0;
    return k === 0 ? c.history[c.history.length - 1] : c[which][k - 1].value;
  };
  const s: Summary = { netWorth: [], surplus: [], assets: [], debt: [] };
  for (let k = 0; k <= horizon; k++) {
    const assets = ASSETS.reduce((a, key) => a + at(key, k), 0);
    const debt = at("card", k);
    s.assets.push(assets);
    s.debt.push(debt);
    s.netWorth.push(assets - debt);
    s.surplus.push(at("income", k) - SPENDING.reduce((a, key) => a + at(key, k), 0));
  }
  return s;
}

function futureMonthLabels(last: string, horizon: number): string[] {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [mon, yr] = last.split(" ");
  let m = names.indexOf(mon);
  let y = Number(yr);
  const out: string[] = [];
  for (let i = 0; i < horizon; i++) {
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
    out.push(`${names[m]} ${y}`);
  }
  return out;
}

export function buildProjection(
  persona: Persona,
  horizon: number,
  choices: Partial<Record<CategoryKey, Choice>>,
  meta: { version: string; generatedAt: string; note?: string },
): Projection {
  const incomeNow = persona.series.income?.[persona.series.income.length - 1] ?? 0;

  const categories: CategoryProjection[] = persona.categories.map((spec) => {
    const y = persona.series[spec.key];
    const choice = choices[spec.key] ?? heuristicChoice(y, spec.kind);
    const f = fit(y, choice.spec);
    const forecast = project(f, horizon).map(({ value, lo, hi }) => ({
      value: Math.max(0, value),
      lo,
      hi,
    }));
    // the same horizon under plain carry-forward, as a "what did the model change?" reference
    const baseline = project(fit(y, { kind: "naive" }), horizon).map(({ value, lo, hi }) => ({
      value: Math.max(0, value),
      lo,
      hi,
    }));
    const now = y[y.length - 1];
    const last = forecast[forecast.length - 1];
    return {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      history: y,
      forecast,
      baseline,
      model: {
        kind: choice.spec.kind,
        period: choice.spec.period,
        confidence: choice.confidence,
        rationale: choice.rationale,
        source: choice.source,
        call: choice.call,
      },
      insight: insightFor(spec, now, last.value, last.lo, last.hi, horizon, incomeNow),
    };
  });

  const summary = summaryOf(categories, horizon, "forecast");
  const baselineSummary = summaryOf(categories, horizon, "baseline");

  const live = categories.some((c) => c.model.source === "nemotron");
  return {
    version: meta.version,
    generatedAt: meta.generatedAt,
    persona: persona.label,
    months: persona.months,
    futureMonths: futureMonthLabels(persona.months[persona.months.length - 1], horizon),
    horizon,
    categories,
    summary,
    baselineSummary,
    agent: { live, note: meta.note },
    stale: false,
  };
}
