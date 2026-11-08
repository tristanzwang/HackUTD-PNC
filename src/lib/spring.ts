/**
 * A critically damped spring, in Apple's two-knob terms: `response` is how
 * quickly it reaches the target (seconds), and there is no overshoot. Because the
 * motion is a spring rather than a timed curve, changing `target` mid-flight is
 * always smooth: the new motion starts from the live value *and* live velocity.
 *
 * Solved analytically, so it is stable at any time step (a stalled frame can't
 * blow it up). Pure math — no three.js, no DOM.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  /** Seconds for the spring to (mostly) arrive. Lower = snappier. */
  response: number;
  private readonly precision: number;

  constructor(value = 0, response = 0.35, precision = 1e-4) {
    this.value = value;
    this.target = value;
    this.response = response;
    this.precision = precision;
  }

  /** Head for a new target from wherever (and however fast) we are right now. */
  to(target: number) {
    this.target = target;
  }

  /** Jump there with no motion at all. */
  snap(value: number) {
    this.value = this.target = value;
    this.velocity = 0;
  }

  /** Keep the target (and any overshoot) inside [lo, hi]. */
  clamp(lo: number, hi: number) {
    this.target = Math.min(Math.max(this.target, lo), hi);
  }

  get settled() {
    return (
      Math.abs(this.value - this.target) < this.precision &&
      Math.abs(this.velocity) < this.precision * 10
    );
  }

  /** Step forward `dt` seconds and return the new value. */
  advance(dt: number) {
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
      return this.value;
    }
    const w = (2 * Math.PI) / this.response;
    const d = this.value - this.target;
    const c = this.velocity + w * d;
    const e = Math.exp(-w * dt);
    this.value = this.target + (d + c * dt) * e;
    this.velocity = (c - w * (d + c * dt)) * e;
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/** UIScrollView's normal deceleration: velocity keeps this fraction per millisecond. */
const GLIDE_PER_MS = 0.998;
export const GLIDE_PER_SECOND = Math.pow(GLIDE_PER_MS, 1000);

/** A release velocity coasting to a stop: returns the new velocity after `dt` seconds. */
export const glide = (velocity: number, dt: number) => velocity * Math.pow(GLIDE_PER_SECOND, dt);
