import { FluidSim } from "./fluid-sim";

export const MAX_FLUIDS = 8;

/** A new fluid is a flat pool this high on the 0-100 y axis. */
export const DEFAULT_EXPR = "40";

/** Default fluid colours (amber is left out: it marks stuck points). */
export const FLUID_COLORS = [
  "#1b5fd1", // blue
  "#e5484d", // red
  "#30a46c", // green
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#9aa4c7", // lavender grey
];

/**
 * Particle budget per fluid slot: `capacity` is the most nodes the fluid may use
 * (node count follows the volume under its graph), `spacing` is the point
 * spacing it uses until it hits that cap and has to space out. The first fluid
 * gets the most points; later ones are drastically thinner so 8 stay smooth.
 */
const SPECS = [
  { capacity: 2400, spacing: 0.097 },
  { capacity: 1500, spacing: 0.11 },
  { capacity: 1000, spacing: 0.12 },
];
const LATE_SPEC = { capacity: 500, spacing: 0.135 };

export type FluidEntry = {
  id: number;
  sim: FluidSim;
  color: string;
  /** Applied surface expression (in grid units), shown in the panel. */
  expr: string;
};

/** Create the fluid that goes in slot `index` (0-based). */
export function createFluid(id: number, index: number, color: string): FluidEntry {
  const spec = SPECS[index] ?? LATE_SPEC;
  return { id, sim: new FluidSim(spec.capacity, spec.spacing), color, expr: DEFAULT_EXPR };
}
