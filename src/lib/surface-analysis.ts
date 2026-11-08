import type { SurfaceFn } from "./expression";
import { AXIS_MAX, MAX_SURFACE_UNITS } from "./units";

const CLIP_LABEL = String(Math.round(MAX_SURFACE_UNITS));

/** Height range of a grid-unit graph, and how many wiggles it has (to warn about shapes the fluid can't show). */
export function analyzeSurface(fn: SurfaceFn) {
  const N = 25;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < N; i++)
    for (let k = 0; k < N; k++) {
      const v = fn((i * AXIS_MAX) / (N - 1), (k * AXIS_MAX) / (N - 1));
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  // count local extrema along the middle lines and the diagonal; lots of them = very fine detail
  const eps = 1e-3 * Math.max(1, max - min);
  const lines: ((t: number) => [number, number])[] = [(t) => [t, 50], (t) => [50, t], (t) => [t, t]];
  let extrema = 0;
  for (const at of lines) {
    let count = 0;
    let prevSign = 0;
    let prev = fn(...at(0));
    for (let t = 1; t <= AXIS_MAX; t++) {
      const v = fn(...at(t));
      const d = v - prev;
      if (Number.isFinite(d) && Math.abs(d) > eps) {
        const sign = Math.sign(d);
        if (prevSign !== 0 && sign !== prevSign) count++;
        prevSign = sign;
      }
      prev = v;
    }
    extrema = Math.max(extrema, count);
  }
  return { min, max, extrema };
}

/** The most useful hint for why a graph might not look like what was typed. */
export function adviceFor(stats: ReturnType<typeof analyzeSurface>): string | null {
  if (stats.max < 1.5)
    return "Height near 0: almost no fluid. The number of points follows the volume under the graph.";
  if (stats.extrema > 10)
    return "Very fine detail: ripples shorter than about 15 units are too small for the fluid to follow. Divide x and z, e.g. sin(x/15).";
  if (stats.max > MAX_SURFACE_UNITS)
    return `Heights above ${CLIP_LABEL} are clipped to the top of the tank.`;
  if (stats.min < 0) return "Heights below 0 are treated as 0 (no fluid there).";
  return null;
}
