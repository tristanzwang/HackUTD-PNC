import { Spring } from "./spring";

/**
 * Layout and choreography for the solar-system view: where each fluid's planet
 * orbits, how fast it goes round, and how the tank dissolves into it.
 * Pure math — no three.js, no DOM.
 */

/** Radius of the central sun: a small, very bright body. */
export const SUN_RADIUS = 0.3;

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

/**
 * Each planet turns on its own slightly tilted axis, at its own rate and in its
 * own direction, so no two look alike. This is a rigid turn of the dots only —
 * see FluidSim.spin — so it never deforms the ball.
 */
export function spinAxis(index: number): [number, number, number] {
  const tilt = 0.18 + ((index * 0.37) % 0.3);
  const yaw = index * 1.31;
  return [Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw)];
}

/** Radians per second, alternating direction down the orbits. */
export function spinRate(index: number) {
  return (index % 2 === 0 ? 1 : -1) * (0.22 + ((index * 0.29) % 0.2));
}

/** How quickly the tank <-> system transition arrives (see Spring), in seconds. */
export const VIEW_RESPONSE = 1.8;
export const VIEW_RESPONSE_REDUCED = 0.15;

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Splits the 0..1 view transition (0 = tank, 1 = solar system) into two
 * overlapping stages. They are linear on purpose: the transition itself is a
 * spring, which already supplies the easing, so easing again would stack curves.
 * The water the water balls up before it flies out to its orbit —
 * and, running backwards, comes home before it melts back into the tank.
 *
 * - `gather` drives the fluid's gravity: 0 = tank floor, 1 = a gravity point.
 * - `launch` drives how far that gravity point has travelled out to its orbit.
 */
export function transitionStages(p: number) {
  return {
    gather: clamp01(p / 0.55),
    launch: clamp01((p - 0.25) / 0.75),
  };
}

/**
 * Drives the tank <-> solar-system transition. It lives outside React so the
 * render loop can advance it every frame without re-rendering anything, and so
 * both views can read the same progress value.
 *
 * Progress is a critically damped spring, so flipping the tab mid-flight turns
 * the motion around smoothly (it keeps its velocity) instead of snapping back.
 */
export class ViewTransition {
  /** Orbital clock, in seconds. */
  t = 0;
  private spring = new Spring(0, VIEW_RESPONSE);
  private homes = new Map<number, [number, number, number]>();

  /** 0 = tank, 1 = solar system; anything between is mid-flight. */
  get p() {
    return clamp01(this.spring.value);
  }

  /** Head for the tank (0) or the solar system (1). */
  setTarget(v: number) {
    this.spring.to(v);
  }

  /** Reduced motion: arrive almost at once, as a short cross-dissolve. */
  setReducedMotion(reduced: boolean) {
    this.spring.response = reduced ? VIEW_RESPONSE_REDUCED : VIEW_RESPONSE;
  }

  /** Which view the camera and pointer should be treated as belonging to. */
  get headingToSolar() {
    return this.spring.target > 0.5;
  }

  /** Step the transition forward and return this frame's two stages. */
  advance(dt: number) {
    this.spring.advance(dt);
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
