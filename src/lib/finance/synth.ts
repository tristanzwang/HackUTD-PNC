/**
 * Synthetic personas. No LLM, no network, seeded and reproducible.
 *
 * This is the honest foundation of the whole project: we have no bank data and
 * will not pretend to. Each persona is generated from KNOWN ground-truth
 * parameters (level, monthly drift, seasonal amplitude, noise). Because the
 * truth is known, every downstream claim about estimation or forecasting is
 * measurable rather than asserted - see backtest.ts.
 */

export type CategoryKey =
  | "income"
  | "checking"
  | "savings"
  | "housing"
  | "essentials"
  | "discretionary"
  | "subscriptions"
  | "retirement"
  | "card";

export type CategorySpec = {
  key: CategoryKey;
  label: string;
  /** Sign convention: inflow positive, outflow negative, balance positive. */
  kind: "inflow" | "outflow" | "balance" | "debt";
  /** Ground truth used to generate the series - the thing estimators must recover. */
  truth: {
    level: number;
    /** Fractional change per month (0.004 = +0.4%/mo). */
    drift: number;
    /** Amplitude of a 12-month sinusoid, as a fraction of level. */
    seasonAmp: number;
    /** Month index (0-11) of the seasonal peak. */
    seasonPeak: number;
    /** Std dev of multiplicative noise, as a fraction of level. */
    noise: number;
  };
};

export type Persona = {
  id: string;
  label: string;
  /** Oldest month first. */
  months: string[];
  categories: CategorySpec[];
  /** series[categoryKey][monthIndex] - the generated history. */
  series: Record<CategoryKey, number[]>;
};

/** mulberry32: tiny seeded PRNG so a persona is byte-identical every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so noise is actually gaussian rather than uniform-and-hoping. */
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthKeys(nMonths: number, endYear: number, endMonth: number): string[] {
  const out: string[] = [];
  for (let i = nMonths - 1; i >= 0; i--) {
    const m = ((endMonth - i) % 12 + 12) % 12;
    const y = endYear + Math.floor((endMonth - i) / 12);
    out.push(`${MONTH_LABELS[m]} ${y}`);
  }
  return out;
}

/**
 * The college-student persona: the one the pitch is about. Thin margins, rent
 * dominating, a card that creeps, textbook spikes in Jan and Aug.
 */
export const COLLEGE_STUDENT: CategorySpec[] = [
  { key: "income",        label: "Income",        kind: "inflow",  truth: { level: 2150, drift: 0.0035, seasonAmp: 0.08, seasonPeak: 5,  noise: 0.06 } },
  { key: "housing",       label: "Rent",          kind: "outflow", truth: { level: 1080, drift: 0.0048, seasonAmp: 0.0,  seasonPeak: 0,  noise: 0.004 } },
  { key: "essentials",    label: "Essentials",    kind: "outflow", truth: { level: 430,  drift: 0.0031, seasonAmp: 0.11, seasonPeak: 0,  noise: 0.09 } },
  { key: "discretionary", label: "Discretionary", kind: "outflow", truth: { level: 295,  drift: 0.0012, seasonAmp: 0.34, seasonPeak: 11, noise: 0.22 } },
  { key: "subscriptions", label: "Subscriptions", kind: "outflow", truth: { level: 68,   drift: 0.0090, seasonAmp: 0.0,  seasonPeak: 0,  noise: 0.02 } },
  { key: "checking",      label: "Checking",      kind: "balance", truth: { level: 1240, drift: 0.0020, seasonAmp: 0.18, seasonPeak: 7,  noise: 0.14 } },
  { key: "savings",       label: "Savings",       kind: "balance", truth: { level: 2600, drift: 0.0105, seasonAmp: 0.0,  seasonPeak: 0,  noise: 0.05 } },
  { key: "retirement",    label: "Retirement",    kind: "balance", truth: { level: 3100, drift: 0.0130, seasonAmp: 0.0,  seasonPeak: 0,  noise: 0.08 } },
  { key: "card",          label: "Credit card",   kind: "debt",    truth: { level: 1850, drift: 0.0115, seasonAmp: 0.14, seasonPeak: 11, noise: 0.07 } },
];

export function makePersona(opts: {
  id: string;
  label: string;
  categories?: CategorySpec[];
  nMonths?: number;
  seed?: number;
  endYear?: number;
  endMonth?: number;
}): Persona {
  const categories = opts.categories ?? COLLEGE_STUDENT;
  const nMonths = opts.nMonths ?? 24;
  const r = rng(opts.seed ?? 20261108);
  const series = {} as Record<CategoryKey, number[]>;

  for (const c of categories) {
    const { level, drift, seasonAmp, seasonPeak, noise } = c.truth;
    const vals: number[] = [];
    for (let t = 0; t < nMonths; t++) {
      const trend = level * Math.pow(1 + drift, t);
      const season = 1 + seasonAmp * Math.cos((2 * Math.PI * (t - seasonPeak)) / 12);
      const shock = 1 + noise * gauss(r);
      vals.push(Math.max(0, Math.round(trend * season * shock * 100) / 100));
    }
    series[c.key] = vals;
  }

  return {
    id: opts.id,
    label: opts.label,
    months: monthKeys(nMonths, opts.endYear ?? 2026, opts.endMonth ?? 10),
    categories,
    series,
  };
}
