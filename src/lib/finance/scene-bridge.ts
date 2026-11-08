/**
 * The join between dollars and the 3D scene. This is the ONLY file that knows
 * about both, and it is the contract between the finance work and the fluid
 * work - neither side needs to read the other's code.
 *
 * Three jobs:
 *   1. Say which category occupies which fluid slot and which orbit, and why
 *      those are different things.
 *   2. Turn a dollar amount into the tank surface height that produces a
 *      planet of the right size (used once, at load).
 *   3. Turn a CHANGED dollar amount into a packing factor, so a planet can
 *      grow or shrink smoothly without a refill (used every frame of a scrub).
 */

import type { CategoryKey } from "./synth";

/** Where a category sits in the scene, and what it is worth. */
export type SceneCategory = {
  key: CategoryKey;
  label: string;
  /** Dollars. Balances and debts are magnitudes; flows are per month. */
  amount: number;
  /**
   * Fluid slot, 0-7. This decides the NODE BUDGET only (slot 0 gets 2400
   * points, then 1500, 1000, 500...), so it is ordered by dollar magnitude:
   * the biggest body deserves the most dots.
   */
  slot: number;
  /**
   * Orbit index, 0-7. This decides orbit RADIUS and speed, so it is ordered by
   * liquidity and time horizon: checking is innermost and fast, retirement is
   * outermost and slow. Deliberately NOT the same as `slot` - coupling them
   * would force the biggest category to also be the innermost planet, which
   * is wrong (retirement is huge and should be far out).
   */
  orbit: number;
  color: string;
  /** Debt renders as a dark body that pulls dots off its neighbours. */
  isDebt: boolean;
};

/** Ordering for orbit radius: liquid and near-term first, locked-away last. */
const BY_HORIZON: CategoryKey[] = [
  "checking", "essentials", "discretionary", "subscriptions",
  "housing", "card", "savings", "retirement",
];

const META: Record<string, { label: string; color: string; isDebt: boolean }> = {
  checking:      { label: "Checking",      color: "#06b6d4", isDebt: false },
  essentials:    { label: "Essentials",    color: "#30a46c", isDebt: false },
  discretionary: { label: "Discretionary", color: "#a855f7", isDebt: false },
  subscriptions: { label: "Subscriptions", color: "#84cc16", isDebt: false },
  housing:       { label: "Rent",          color: "#ec4899", isDebt: false },
  card:          { label: "Credit card",   color: "#e5484d", isDebt: true  },
  savings:       { label: "Savings",       color: "#1b5fd1", isDebt: false },
  retirement:    { label: "Retirement",    color: "#9aa4c7", isDebt: false },
};

/**
 * Build the scene layout from this month's amounts. Slots go by size, orbits
 * by horizon, so the two orderings are independent.
 */
export function layout(amounts: Partial<Record<CategoryKey, number>>): SceneCategory[] {
  const present = BY_HORIZON.filter((k) => (amounts[k] ?? 0) > 0);
  const bySize = [...present].sort((a, b) => (amounts[b] ?? 0) - (amounts[a] ?? 0));
  return present.map((key, orbit) => ({
    key,
    label: META[key].label,
    amount: amounts[key] ?? 0,
    slot: bySize.indexOf(key),
    orbit,
    color: META[key].color,
    isDebt: META[key].isDebt,
  }));
}

/** Tallest flat pool the tank accepts, on the 0-100 axis. */
const MAX_UNITS = 92;
/** Shortest pool that still reads as a planet rather than a speck. */
const MIN_UNITS = 8;

/**
 * Dollars -> the flat surface height to hand FluidSim.setSurface at load.
 *
 * A flat pool's volume is proportional to its height, and node count follows
 * volume, so height maps linearly to dollars. Scaled against the largest
 * category so the system fills the tank whatever the absolute amounts are.
 * Returns a height in grid units (0-100) - pass it through
 * gridToWorldSurface() exactly as the surface panel does.
 */
export function heightForAmount(amount: number, largestAmount: number): number {
  if (largestAmount <= 0) return MIN_UNITS;
  const t = Math.max(0, amount) / largestAmount;
  return MIN_UNITS + t * (MAX_UNITS - MIN_UNITS);
}

/**
 * THE SCRUBBER FUNCTION. Dollars now vs dollars at load -> packing factor.
 *
 * FluidSim.ballRadius is cbrt(count * spacing^3 * k), so at fixed count the
 * radius is directly proportional to spacing, and setPacking(k) sets spacing
 * to tankSpacing * k. Volume scales as radius cubed, so the cube root of the
 * dollar ratio is exactly the packing factor that gives the right size.
 *
 * Call it every frame with the scrubbed amount. The ball condenses or expands
 * smoothly because setPacking leaves the fluid off-density and lets gravity
 * resolve it - no refill, no teleport.
 *
 *   sim.setPacking(packingFor(amountNow, amountAtLoad, orbitPacking))
 *
 * `orbitPacking` is the existing ORBIT_PACKING constant in FluidScene (0.65),
 * which is what makes a planet denser than its pool. Pass the blended value
 * during the tank->solar transition, exactly as line 261 does today.
 */
export function packingFor(amountNow: number, amountAtLoad: number, orbitPacking = 0.65): number {
  if (amountAtLoad <= 0) return orbitPacking;
  const ratio = Math.max(amountNow, 0) / amountAtLoad;
  // clamp so a category going to zero does not collapse to a singularity and
  // a 10x spike does not swallow its neighbours' orbits
  return orbitPacking * Math.cbrt(Math.min(Math.max(ratio, 0.05), 8));
}

/** Share of total, for the legend. Use THIS, not sim.count - count no longer moves. */
export function shares(cats: SceneCategory[]): Record<string, number> {
  const total = cats.filter((c) => !c.isDebt).reduce((a, c) => a + c.amount, 0) || 1;
  return Object.fromEntries(cats.map((c) => [c.key, c.amount / total]));
}

export function formatUSD(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
