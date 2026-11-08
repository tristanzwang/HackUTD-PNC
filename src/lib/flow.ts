// A small incompressible 2D fluid solver drives Lagrangian logo particles.
// Semi-Lagrangian advection + Jacobi pressure projection, no dependencies.
export class Fluid {
  readonly n: number;
  u: Float32Array;
  v: Float32Array;
  nextU: Float32Array;
  nextV: Float32Array;
  pressure: Float32Array;
  nextP: Float32Array;
  div: Float32Array;
  constructor(n = 64) {
    this.n = n;
    this.u = new Float32Array(n * n);
    this.v = new Float32Array(n * n);
    this.nextU = new Float32Array(n * n);
    this.nextV = new Float32Array(n * n);
    this.pressure = new Float32Array(n * n);
    this.nextP = new Float32Array(n * n);
    this.div = new Float32Array(n * n);
  }
  sample(a: Float32Array, x: number, y: number): number {
    const n = this.n;
    x = Math.max(0, Math.min(n - 1.001, x)); y = Math.max(0, Math.min(n - 1.001, y));
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * n + ix;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + n] * (1 - fx) + a[i + n + 1] * fx) * fy;
  }
  vortex(x: number, y: number, strength: number, radius = 8): void {
    const n = this.n;
    for (let j = Math.max(1, Math.floor(y - radius * 2)); j < Math.min(n - 1, y + radius * 2); j++) {
      for (let i = Math.max(1, Math.floor(x - radius * 2)); i < Math.min(n - 1, x + radius * 2); i++) {
        const dx = i - x, dy = j - y, f = Math.exp(-(dx * dx + dy * dy) / (radius * radius)) * strength;
        this.u[j * n + i] -= dy * f; this.v[j * n + i] += dx * f;
      }
    }
  }
  step(dt: number): void {
    const n = this.n;
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x, px = x - this.u[i] * dt, py = y - this.v[i] * dt;
      this.nextU[i] = this.sample(this.u, px, py) * .993;
      this.nextV[i] = this.sample(this.v, px, py) * .993;
    }
    [this.u, this.nextU] = [this.nextU, this.u]; [this.v, this.nextV] = [this.nextV, this.v];
    this.pressure.fill(0);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      this.div[i] = -.5 * (this.u[i + 1] - this.u[i - 1] + this.v[i + n] - this.v[i - n]);
    }
    for (let k = 0; k < 18; k++) {
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const i = y * n + x, p = this.pressure;
        this.nextP[i] = (this.div[i] + p[i - 1] + p[i + 1] + p[i - n] + p[i + n]) * .25;
      }
      [this.pressure, this.nextP] = [this.nextP, this.pressure];
    }
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      this.u[i] -= .5 * (this.pressure[i + 1] - this.pressure[i - 1]);
      this.v[i] -= .5 * (this.pressure[i + n] - this.pressure[i - n]);
    }
    for (let j = 0; j < n; j++) {
      this.u[j * n] = this.u[j * n + n - 1] = 0;
      this.v[j] = this.v[(n - 1) * n + j] = 0;
    }
  }
}

