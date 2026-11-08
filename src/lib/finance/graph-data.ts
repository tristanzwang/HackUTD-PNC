/**
 * Turns a Projection into what the 3D scene needs: one surface graph per category,
 * the size each planet should have at any scrubbed month, and the axis labels.
 * Pure functions, safe for the client.
 *
 * Each category's graph is a ribbon, h(x, z):
 *   x  time, from `HISTORY_WINDOW` months back through the whole forecast
 *   z  the likely range: the bottom edge is the low end, the top edge the high end
 *   h  dollars (see heightForAmount)
 * Over the history the range collapses to the actual value, so the ribbon is flat
 * across z there, then fans out into the forecast. The fan IS the uncertainty.
 */

import type { SurfaceFn } from "../expression";
import type { CategoryProjection, Projection, Summary } from "./projection";
import {
  amountForHeight,
  compactUSD,
  heightForAmount,
  layout,
  type SceneCategory,
} from "./scene-bridge";

/**
 * Planet radii, in world units. The biggest body in the forecast is `PLANET_MAX`;
 * every other planet's VOLUME is in proportion to its dollars, i.e. radius goes
 * as the cube root. `PLANET_MIN` keeps a tiny category (a $90 subscription)
 * visible as a speck rather than vanishing.
 */
export const PLANET_MAX = 0.6;
export const PLANET_MIN = 0.14;

/** Months of history drawn to the left of "today". */
export const HISTORY_WINDOW = 24;

export type ForecastMode = "interpreted" | "raw";

export type FinanceGraph = SceneCategory & {
  cat: CategoryProjection;
  /** The ribbon, in grid units (0-100 on x and z, height on the y axis). */
  surface: SurfaceFn;
  /** Mean height of the ribbon: what the sim's point count (and so the planet) starts from. */
  meanHeight: number;
  /** Dollars at `k` months from today (fractional k is interpolated). */
  amountAt: (k: number) => number;
  /** The ~80% range at `k` months from today. */
  rangeAt: (k: number) => { lo: number; hi: number };
  /** The radius this planet should have at `k` months from today (see PLANET_MAX). */
  radiusAt: (k: number) => number;
};

export type FinanceScene = {
  version: string;
  horizon: number;
  graphs: FinanceGraph[];
  /** Where "today" sits along the time axis, 0-1. */
  todayFraction: number;
  /** Axis tick labels, one per grid tick (0, 20, ... 100); "" = no label. */
  labels: { x: string[]; y: string[]; z: string[] };
  /** "Nov 2026" for k = 0, then the forecast months. */
  monthAt: (k: number) => string;
  /** Net worth, surplus, assets and debt for k = 0 (today) .. horizon. */
  summary: Summary;
  /** "interpreted" = per-category model picks; "raw" = carry-forward. Drives radiusAt. */
  mode: ForecastMode;
  setMode: (m: ForecastMode) => void;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Linear interpolation into an array at a fractional index. */
function sample(a: number[], i: number) {
  const c = Math.min(Math.max(i, 0), a.length - 1);
  const i0 = Math.floor(c);
  const i1 = Math.min(i0 + 1, a.length - 1);
  return lerp(a[i0], a[i1], c - i0);
}

/** "Nov 2026" -> "Nov ’26" */
const shortMonth = (m: string) => m.replace(/ \d\d(\d\d)$/, " ’$1");

/**
 * The height/size normalisation: the tallest range (`largest`) and the biggest
 * body today-or-later (`biggest`). Drawn from `scaleRef` so a "what if" overlay
 * can be sized against the REAL projection — otherwise one runaway category (a
 * decade of gambling debt) collapses every other planet to a speck.
 */
function sceneScale(scaleRef: Projection, hist: number, today: number) {
  let largest = 0;
  let biggest = 0;
  for (const c of scaleRef.categories) {
    const h = c.history.slice(-hist);
    const hi = [...h, ...c.forecast.map((f) => f.hi)];
    for (const v of hi) largest = Math.max(largest, v);
    const mid = [...h, ...c.forecast.map((f) => f.value)];
    for (const v of mid.slice(today)) biggest = Math.max(biggest, v);
  }
  return { largest: largest || 1, biggest: biggest || 1 };
}

export function buildFinanceScene(p: Projection, scaleRef: Projection = p): FinanceScene {
  const hist = Math.min(HISTORY_WINDOW, p.months.length);
  const N = hist + p.horizon;
  const today = hist - 1; // index of the last history month along the time axis

  // flipped by the Raw/Interpreted control; radiusAt below reads it live each frame
  let mode: ForecastMode = "interpreted";

  // dollars along the whole time axis, per category
  const series = new Map<string, { mid: number[]; lo: number[]; hi: number[]; base: number[] }>();
  for (const c of p.categories) {
    const h = c.history.slice(-hist);
    series.set(c.key, {
      mid: [...h, ...c.forecast.map((f) => f.value)],
      lo: [...h, ...c.forecast.map((f) => f.lo)],
      hi: [...h, ...c.forecast.map((f) => f.hi)],
      base: [...h, ...c.baseline.map((f) => f.value)],
    });
  }

  // sizes are shared across graphs and (for an overlay) against the real scene,
  // so a scenario shows its one category ballooning without shrinking the rest
  const { largest, biggest } = sceneScale(scaleRef, hist, today);

  const latest: Record<string, number> = {};
  for (const c of p.categories) latest[c.key] = c.history[c.history.length - 1];
  const placed = layout(latest);

  const graphs: FinanceGraph[] = [];
  for (const sc of [...placed].sort((a, b) => a.orbit - b.orbit)) {
    const cat = p.categories.find((c) => c.key === sc.key)!;
    const s = series.get(sc.key)!;
    const hLo = s.lo.map((v) => heightForAmount(v, largest));
    const hHi = s.hi.map((v) => heightForAmount(v, largest));
    // everything from today onward, so index k = months from now
    const midNow = s.mid.slice(today);
    const baseNow = s.base.slice(today);
    const loNow = s.lo.slice(today);
    const hiNow = s.hi.slice(today);

    const surface: SurfaceFn = (x, z) => {
      const u = (Math.min(Math.max(x, 0), 100) / 100) * (N - 1);
      const t = Math.min(Math.max(z, 0), 100) / 100;
      return lerp(sample(hLo, u), sample(hHi, u), t);
    };

    // the volume the sim starts from: the ribbon's mean height
    let sum = 0;
    const SAMPLES = 400;
    for (let i = 0; i < SAMPLES; i++) {
      const u = (i / (SAMPLES - 1)) * (N - 1);
      sum += (sample(hLo, u) + sample(hHi, u)) / 2;
    }
    const meanHeight = sum / SAMPLES;

    graphs.push({
      ...sc,
      cat,
      surface,
      meanHeight,
      amountAt: (k) => sample(midNow, k),
      rangeAt: (k) => ({ lo: sample(loNow, k), hi: sample(hiNow, k) }),
      radiusAt: (k) => {
        const pick = mode === "raw" ? baseNow : midNow;
        const r = PLANET_MAX * Math.cbrt(Math.max(sample(pick, k), 0) / biggest);
        return Math.min(Math.max(r, PLANET_MIN), PLANET_MAX);
      },
    });
  }

  // tick labels: time along x, the range along z, dollars up y
  const allMonths = [...p.months.slice(-hist), ...p.futureMonths];
  const x = [0, 1, 2, 3, 4, 5].map((i) => shortMonth(allMonths[Math.round((i / 5) * (N - 1))]));
  const z = ["low", "", "", "", "", "high"];
  const y = [0, 1, 2, 3, 4, 5].map((i) => (i === 0 ? "" : compactUSD(amountForHeight(i * 20, largest))));

  return {
    version: p.version,
    horizon: p.horizon,
    graphs,
    todayFraction: today / (N - 1),
    labels: { x, y, z },
    summary: p.summary,
    get mode() {
      return mode;
    },
    setMode: (m) => {
      mode = m;
    },
    monthAt: (k) => {
      const i = Math.round(k);
      return i <= 0 ? p.months[p.months.length - 1] : p.futureMonths[Math.min(i, p.horizon) - 1];
    },
  };
}
