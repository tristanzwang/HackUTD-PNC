/**
 * Deterministic forecasters. No LLM in this file, ever.
 *
 * Nemotron's job is to pick WHICH of these fits a category and to supply the
 * seasonal period when it spots one. That choice is then measured against a
 * naive baseline on held-out months (backtest.ts). That measurement is what
 * separates "we used AI to predict your finances" from a defensible claim.
 */

export type ModelKind = "naive" | "drift" | "linear" | "seasonal";

export type FitSpec = {
  kind: ModelKind;
  /** Seasonal period in months. Only read when kind === "seasonal". */
  period?: number;
};

export type Fit = {
  spec: FitSpec;
  predict: (stepsAhead: number) => number;
  /** Residual std dev on the training window - drives the confidence cone. */
  sigma: number;
  /** Recovered parameters, for display next to Nemotron's estimates. */
  params: Record<string, number>;
};

/** Last observed value, carried forward. The baseline everything must beat. */
function fitNaive(y: number[]): Fit {
  const last = y[y.length - 1];
  const resid = y.slice(1).map((v, i) => v - y[i]);
  return {
    spec: { kind: "naive" },
    predict: () => last,
    sigma: std(resid),
    params: { last },
  };
}

/** Geometric drift: average month-over-month ratio, compounded forward. */
function fitDrift(y: number[]): Fit {
  const ratios: number[] = [];
  for (let i = 1; i < y.length; i++) if (y[i - 1] > 0) ratios.push(y[i] / y[i - 1]);
  const g = ratios.length ? mean(ratios) : 1;
  const last = y[y.length - 1];
  const resid = y.slice(1).map((v, i) => v - y[i] * g);
  return {
    spec: { kind: "drift" },
    predict: (k) => last * Math.pow(g, k),
    sigma: std(resid),
    params: { monthlyGrowth: g - 1, last },
  };
}

/** Ordinary least squares on t. */
function fitLinear(y: number[]): Fit {
  const n = y.length;
  const { a, b } = ols(y);
  const resid = y.map((v, t) => v - (a + b * t));
  return {
    spec: { kind: "linear" },
    predict: (k) => a + b * (n - 1 + k),
    sigma: std(resid),
    params: { intercept: a, slopePerMonth: b },
  };
}

/**
 * Linear trend plus an additive period-of-year effect, estimated as the mean
 * residual in each phase after detrending. Falls back to linear when there is
 * less than two full cycles of history.
 */
function fitSeasonal(y: number[], period: number): Fit {
  const n = y.length;
  if (!Number.isFinite(period) || period < 2 || n < period * 2) return fitLinear(y);
  const p = Math.round(period);
  const { a, b } = ols(y);
  const detrended = y.map((v, t) => v - (a + b * t));
  const eff = new Array(p).fill(0);
  const cnt = new Array(p).fill(0);
  for (let t = 0; t < n; t++) {
    eff[t % p] += detrended[t];
    cnt[t % p]++;
  }
  for (let i = 0; i < p; i++) eff[i] = cnt[i] ? eff[i] / cnt[i] : 0;
  const resid = y.map((v, t) => v - (a + b * t + eff[t % p]));
  return {
    spec: { kind: "seasonal", period: p },
    predict: (k) => {
      const t = n - 1 + k;
      return a + b * t + eff[((t % p) + p) % p];
    },
    sigma: std(resid),
    params: { intercept: a, slopePerMonth: b, period: p, amplitude: (Math.max(...eff) - Math.min(...eff)) / 2 },
  };
}

export function fit(y: number[], spec: FitSpec): Fit {
  switch (spec.kind) {
    case "naive": return fitNaive(y);
    case "drift": return fitDrift(y);
    case "linear": return fitLinear(y);
    case "seasonal": return fitSeasonal(y, spec.period ?? 12);
  }
}

export const ALL_SPECS: FitSpec[] = [
  { kind: "naive" },
  { kind: "drift" },
  { kind: "linear" },
  { kind: "seasonal", period: 12 },
];

/** Forward path with a confidence cone that widens as sqrt(horizon). */
export function project(f: Fit, horizon: number) {
  const out: { step: number; value: number; lo: number; hi: number }[] = [];
  for (let k = 1; k <= horizon; k++) {
    const v = f.predict(k);
    const band = 1.28 * f.sigma * Math.sqrt(k); // ~80% interval
    out.push({ step: k, value: v, lo: Math.max(0, v - band), hi: v + band });
  }
  return out;
}

function mean(x: number[]) { return x.length ? x.reduce((a, v) => a + v, 0) / x.length : 0; }
function std(x: number[]) {
  if (x.length < 2) return 0;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1));
}
function ols(y: number[]) {
  const n = y.length;
  const tBar = (n - 1) / 2;
  const yBar = mean(y);
  let num = 0, den = 0;
  for (let t = 0; t < n; t++) { num += (t - tBar) * (y[t] - yBar); den += (t - tBar) ** 2; }
  const b = den === 0 ? 0 : num / den;
  return { a: yBar - b * tBar, b };
}

/**
 * Deterministic evidence about a series, computed before any model is called.
 *
 * The estimator was choosing "seasonal" on vibes and hurting accuracy on
 * categories with no cycle. Handing it these numbers turns the call from a
 * guess into an interpretation: the statistics say what the shape is, the
 * model says what it MEANS and whether it is a real cycle or an artefact.
 */
export type SeriesEvidence = {
  n: number;
  /** Fractional change per month implied by OLS, relative to the mean. */
  trendPerMonth: number;
  /** Residual noise after detrending, relative to the mean. */
  noiseRatio: number;
  /**
   * Autocorrelation of the detrended series at lag `period`, in -1..1.
   * Above ~0.3 with two or more full cycles is a real annual cycle.
   */
  seasonalStrength: number;
  /** Full cycles of `period` the history actually covers. */
  cycles: number;
  /** True when the series is long enough for a seasonal fit to be estimable. */
  seasonalEstimable: boolean;
};

export function evidence(y: number[], period = 12): SeriesEvidence {
  const n = y.length;
  const m = y.reduce((a, v) => a + v, 0) / (n || 1) || 1;
  const { a, b } = ols(y);
  const det = y.map((v, t) => v - (a + b * t));
  const dm = det.reduce((x, v) => x + v, 0) / (n || 1);
  let num = 0, den = 0;
  for (let t = period; t < n; t++) num += (det[t] - dm) * (det[t - period] - dm);
  for (let t = 0; t < n; t++) den += (det[t] - dm) ** 2;
  const cycles = n / period;
  return {
    n,
    trendPerMonth: b / m,
    noiseRatio: std(det) / m,
    seasonalStrength: den > 0 ? num / den : 0,
    cycles,
    seasonalEstimable: cycles >= 2,
  };
}
