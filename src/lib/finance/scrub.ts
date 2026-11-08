/**
 * The scrubbed point in time, in months from today (0 = now, fractional is fine).
 *
 * It lives outside React on purpose: the sim reads it every frame to size the
 * planets, and while it is playing it changes 60 times a second. Only the few
 * components that display it subscribe, so the 3D scene never re-renders.
 */
export class Scrub {
  k = 0;
  private listeners = new Set<() => void>();

  set = (k: number) => {
    if (k === this.k) return;
    this.k = k;
    this.listeners.forEach((l) => l());
  };

  get = () => this.k;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
