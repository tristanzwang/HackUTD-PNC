/**
 * Layout and choreography for the solar-system view: where each fluid's planet
 * orbits, how fast it goes round, and how the tank dissolves into it.
 * Pure math — no three.js, no DOM.
 */

/** Radius of the central sun. */
export const SUN_RADIUS = 0.8;

const INNER = 1.9; // radius of the first orbit
const GAP = 1.3; // radial distance between orbits

/** Orbit radius for the fluid in slot `index` (0-based). */
export function orbitRadius(index: number) {
  return INNER + index * GAP;
}

/** Radius of the outermost of `n` orbits, for framing the camera. */
export function systemRadius(n: number) {
  return orbitRadius(Math.max(n - 1, 0));
}

/**
 * Inner planets sweep round faster, the way real ones do. The falloff is gentler
 * than Kepler's 1.5 so the outermost orbit still visibly moves.
 */
export function orbitSpeed(index: number) {
  return 0.5 * Math.pow(INNER / orbitRadius(index), 0.9);
}

/** A little inclination per orbit, so the system reads as 3D rather than flat. */
export function orbitTilt(index: number) {
  return Math.sin(index * 1.7) * 0.13;
}

/** Starting angles spread by the golden angle, so planets never all line up. */
export function orbitPhase(index: number) {
  return index * 2.399963;
}

/** Where the planet in slot `index` is at time `t` seconds. */
export function orbitPosition(
  index: number,
  t: number,
  out: [number, number, number],
): [number, number, number] {
  const r = orbitRadius(index);
  const a = orbitPhase(index) + orbitSpeed(index) * t;
  const tilt = orbitTilt(index);
  const z = r * Math.sin(a);
  out[0] = r * Math.cos(a);
  out[1] = -z * Math.sin(tilt);
  out[2] = z * Math.cos(tilt);
  return out;
}

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Splits the 0..1 view transition (0 = tank, 1 = solar system) into two
 * overlapping stages, so the water balls up before it flies out to its orbit —
 * and, running backwards, comes home before it melts back into the tank.
 *
 * - `gather` drives the fluid's gravity: 0 = tank floor, 1 = a gravity point.
 * - `launch` drives how far that gravity point has travelled out to its orbit.
 */
export function transitionStages(p: number) {
  return {
    gather: easeInOutCubic(clamp01(p / 0.55)),
    launch: easeInOutCubic(clamp01((p - 0.25) / 0.75)),
  };
}

/** Evenly spread points on a sphere, for drawing the sun as a ball of dots. */
export function fibonacciSphere(n: number, radius: number): Float32Array {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(1 - y * y, 0));
    const a = golden * i;
    out[i * 3] = Math.cos(a) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(a) * r * radius;
  }
  return out;
}

/**
 * Drives the tank <-> solar-system transition. It lives outside React so the
 * render loop can advance it every frame without re-rendering anything, and so
 * both views can read the same progress value.
 */
export class ViewTransition {
  /** 0 = tank, 1 = solar system; anything between is mid-flight. */
  p = 0;
  /** Orbital clock, in seconds. */
  t = 0;
  private target = 0;
  private homes = new Map<number, [number, number, number]>();

  /** Head for the tank (0) or the solar system (1). */
  setTarget(v: number) {
    this.target = v;
  }

  /** Which view the camera and pointer should be treated as belonging to. */
  get headingToSolar() {
    return this.target > 0.5;
  }

  /** Step the transition forward and return this frame's two stages. */
  advance(dt: number, seconds: number) {
    if (this.p !== this.target) {
      const step = dt / seconds;
      this.p =
        this.target > this.p
          ? Math.min(this.p + step, this.target)
          : Math.max(this.p - step, this.target);
    }
    this.t += dt;
    return transitionStages(this.p);
  }

  /**
   * Where a fluid's ball forms before it sets off for its orbit. `make` runs
   * once per outward trip; `fresh` says whether this call was that first one.
   */
  home(id: number, make: () => [number, number, number]) {
    const existing = this.homes.get(id);
    if (existing) return { home: existing, fresh: false };
    const home = make();
    this.homes.set(id, home);
    return { home, fresh: true };
  }

  /** Drop remembered homes — all of them, or just those of fluids that are gone. */
  forget(aliveIds?: Set<number>) {
    if (!aliveIds) {
      this.homes.clear();
      return;
    }
    for (const id of this.homes.keys()) if (!aliveIds.has(id)) this.homes.delete(id);
  }
}
