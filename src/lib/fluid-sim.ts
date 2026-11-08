/**
 * 3D particle fluid using "double density relaxation" (Clavet et al. 2005),
 * a position-based SPH variant that stays stable at real-time step sizes.
 * Pure TypeScript, no DOM/three dependencies.
 */

import type { SurfaceFn } from "./expression";

export const TANK = {
  minX: -0.8,
  maxX: 0.8,
  minZ: -0.8,
  maxZ: 0.8,
  minY: 0,
  maxY: 1.4,
};

const MAX_NEIGHBORS = 80;

/** Surface-shape grid: resolution over the tank footprint, height clip and slope clip. */
const SURF_N = 49;
export const MAX_SURFACE_HEIGHT = 0.5;
const MAX_SLOPE = 1.2;

/** Default fluid block: particles per axis and rest spacing. */
export const BLOCK = { nx: 18, ny: 8, nz: 18, spacing: 0.082 };

export class FluidSim {
  readonly count: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** 1 = particle is stuck in place (no longer fluid) until unpinned. */
  readonly pinned: Uint8Array;
  private spacing: number;
  /** Surface-shape height & slope grids (see setSurface). */
  private surfH = new Float32Array(SURF_N * SURF_N);
  private surfGX = new Float32Array(SURF_N * SURF_N);
  private surfGZ = new Float32Array(SURF_N * SURF_N);
  private hasSurface = false;
  private held: number[] = [];
  private heldOff: number[] = [];
  private heldMin = [0, 0, 0];
  private heldMax = [0, 0, 0];
  private prev: Float32Array;

  /** Smoothing radius, kept at ~2.3x the particle spacing. */
  readonly h: number;
  private rho0 = 1;
  gravity = 7;
  stiffness = 30;
  stiffnessNear = 60;
  viscosity = 0.15;
  maxSpeed = 7;

  // spatial hash
  private cellSize: number;
  private gx: number;
  private gy: number;
  private gz: number;
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private cellOf: Int32Array;
  private nbrs: Int32Array;
  private nbrCount: Int32Array;

  constructor(nx = BLOCK.nx, ny = BLOCK.ny, nz = BLOCK.nz, spacing = BLOCK.spacing) {
    this.spacing = spacing;
    this.h = spacing * 2.3;
    this.count = nx * ny * nz;
    const n = this.count;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.prev = new Float32Array(n * 3);

    this.cellSize = this.h;
    this.gx = Math.ceil((TANK.maxX - TANK.minX) / this.cellSize) + 1;
    this.gy = Math.ceil((TANK.maxY - TANK.minY) / this.cellSize) + 1;
    this.gz = Math.ceil((TANK.maxZ - TANK.minZ) / this.cellSize) + 1;
    const cells = this.gx * this.gy * this.gz;
    this.cellStart = new Int32Array(cells + 1);
    this.cellItems = new Int32Array(n);
    this.cellOf = new Int32Array(n);
    this.nbrs = new Int32Array(n * MAX_NEIGHBORS);
    this.nbrCount = new Int32Array(n);

    this.reset();
    this.calibrate();
  }

  /**
   * Fill the tank with fluid that falls and sloshes into place. The fluid
   * volume is filled up to a level surface shaped like the current surface
   * graph h(x, z), so it starts out close to its resting shape.
   */
  reset() {
    const s = this.spacing;
    const m = 0.04;
    const cols = Math.floor((TANK.maxX - TANK.minX - 2 * m) / s) + 1;
    const levels = Math.floor((TANK.maxY - TANK.minY - 2 * m) / s) + 1;
    const x0 = -(cols - 1) * s * 0.5;

    // lattice candidates, lowest "height above the shaped surface" first
    const cand: { x: number; y: number; z: number; key: number }[] = [];
    for (let k = 0; k < levels; k++)
      for (let j = 0; j < cols; j++)
        for (let i = 0; i < cols; i++) {
          const x = x0 + i * s, z = x0 + j * s, y = TANK.minY + m + k * s;
          cand.push({ x, y, z, key: y - this.surfaceHeight(x, z) + Math.random() * 1e-3 });
        }
    cand.sort((a, b) => a.key - b.key);

    const n = Math.min(this.count, cand.length);
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, cand[i].y);
    const lift = Math.max(0, Math.min(0.25, TANK.maxY - m - top)); // drop in from slightly above
    for (let i = 0; i < n; i++) {
      const c = cand[i], j = i * 3;
      // tiny jitter breaks lattice symmetry
      this.pos[j] = c.x + (Math.random() - 0.5) * 0.004;
      this.pos[j + 1] = c.y + lift + (Math.random() - 0.5) * 0.004;
      this.pos[j + 2] = c.z + (Math.random() - 0.5) * 0.004;
    }
    this.vel.fill(0);
    this.unpinAll();
  }

  /**
   * Set the natural shape of the fluid surface: its resting surface becomes
   * y = h(x, z) + level, where the level comes from the fluid volume.
   * Done with a body force a = g * (h_x, -1, h_z), i.e. gravity perpendicular
   * to the shaped surface, so fluid pools toward high parts of h.
   * Pass null for a flat surface. Heights are clipped to ±MAX_SURFACE_HEIGHT.
   */
  setSurface(fn: SurfaceFn | null) {
    const N = SURF_N;
    const w = TANK.maxX - TANK.minX, d = TANK.maxZ - TANK.minZ;
    const dx = w / (N - 1), dz = d / (N - 1);
    const H = this.surfH;
    for (let k = 0; k < N; k++)
      for (let i = 0; i < N; i++) {
        const v = fn ? fn(TANK.minX + i * dx, TANK.minZ + k * dz) : 0;
        H[k * N + i] = Number.isFinite(v)
          ? Math.max(-MAX_SURFACE_HEIGHT, Math.min(MAX_SURFACE_HEIGHT, v))
          : 0;
      }
    for (let k = 0; k < N; k++)
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, N - 1);
        const k0 = Math.max(k - 1, 0), k1 = Math.min(k + 1, N - 1);
        let gx = (H[k * N + i1] - H[k * N + i0]) / ((i1 - i0) * dx);
        let gz = (H[k1 * N + i] - H[k0 * N + i]) / ((k1 - k0) * dz);
        const sl = Math.hypot(gx, gz);
        if (sl > MAX_SLOPE) {
          gx *= MAX_SLOPE / sl;
          gz *= MAX_SLOPE / sl;
        }
        this.surfGX[k * N + i] = gx;
        this.surfGZ[k * N + i] = gz;
      }
    this.hasSurface = fn !== null;
  }

  /** Bilinear lookup in one of the surface grids. */
  private sampleSurface(grid: Float32Array, x: number, z: number) {
    const N = SURF_N;
    let u = ((x - TANK.minX) / (TANK.maxX - TANK.minX)) * (N - 1);
    let v = ((z - TANK.minZ) / (TANK.maxZ - TANK.minZ)) * (N - 1);
    u = u < 0 ? 0 : u > N - 1.001 ? N - 1.001 : u;
    v = v < 0 ? 0 : v > N - 1.001 ? N - 1.001 : v;
    const i = Math.floor(u), k = Math.floor(v);
    const fu = u - i, fv = v - k;
    const a = grid[k * N + i], b = grid[k * N + i + 1];
    const c = grid[(k + 1) * N + i], e = grid[(k + 1) * N + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
  }

  /** Height offset h(x, z) of the shaped surface (0 when flat). */
  surfaceHeight(x: number, z: number) {
    return this.hasSurface ? this.sampleSurface(this.surfH, x, z) : 0;
  }

  /** Rest density = density of a particle in the interior of the initial lattice. */
  private calibrate() {
    this.buildNeighbors();
    const h = this.h;
    let best = 0;
    for (let i = 0; i < this.count; i++) {
      let rho = 0;
      for (let k = 0; k < this.nbrCount[i]; k++) {
        const j = this.nbrs[i * MAX_NEIGHBORS + k];
        const r = this.dist(i, j);
        const q = 1 - r / h;
        rho += q * q;
      }
      if (rho > best) best = rho;
    }
    this.rho0 = best;
  }

  private dist(i: number, j: number) {
    const p = this.pos;
    const dx = p[j * 3] - p[i * 3];
    const dy = p[j * 3 + 1] - p[i * 3 + 1];
    const dz = p[j * 3 + 2] - p[i * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private cellIndex(x: number, y: number, z: number) {
    let cx = Math.floor((x - TANK.minX) / this.cellSize);
    let cy = Math.floor((y - TANK.minY) / this.cellSize);
    let cz = Math.floor((z - TANK.minZ) / this.cellSize);
    cx = cx < 0 ? 0 : cx >= this.gx ? this.gx - 1 : cx;
    cy = cy < 0 ? 0 : cy >= this.gy ? this.gy - 1 : cy;
    cz = cz < 0 ? 0 : cz >= this.gz ? this.gz - 1 : cz;
    return (cy * this.gz + cz) * this.gx + cx;
  }

  private buildNeighbors() {
    const { count: n, pos, cellStart, cellItems, cellOf, gx, gy, gz, h } = this;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cellStart.length - 1; c++) cellStart[c + 1] += cellStart[c];
    const fill = new Int32Array(cellStart.subarray(0, cellStart.length - 1));
    for (let i = 0; i < n; i++) cellItems[fill[cellOf[i]]++] = i;

    const h2 = h * h;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const cx = c % gx;
      const cz = Math.floor(c / gx) % gz;
      const cy = Math.floor(c / (gx * gz));
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      let cnt = 0;
      const base = i * MAX_NEIGHBORS;
      for (let oy = Math.max(cy - 1, 0); oy <= Math.min(cy + 1, gy - 1); oy++)
        for (let oz = Math.max(cz - 1, 0); oz <= Math.min(cz + 1, gz - 1); oz++)
          for (let ox = Math.max(cx - 1, 0); ox <= Math.min(cx + 1, gx - 1); ox++) {
            const cc = (oy * gz + oz) * gx + ox;
            for (let s = cellStart[cc]; s < cellStart[cc + 1]; s++) {
              const j = cellItems[s];
              if (j === i) continue;
              const dx = pos[j * 3] - px;
              const dy = pos[j * 3 + 1] - py;
              const dz = pos[j * 3 + 2] - pz;
              if (dx * dx + dy * dy + dz * dz < h2 && cnt < MAX_NEIGHBORS) {
                this.nbrs[base + cnt++] = j;
              }
            }
          }
      this.nbrCount[i] = cnt;
    }
  }

  step(dt: number) {
    const { count: n, pos, vel, prev, h, nbrs, nbrCount } = this;

    // gravity
    const pinned = this.pinned;
    const g = this.gravity * dt;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      vel[i * 3 + 1] -= g;
      if (this.hasSurface) {
        // tilt gravity to be perpendicular to the shaped surface
        const px = pos[i * 3], pz = pos[i * 3 + 2];
        vel[i * 3] += g * this.sampleSurface(this.surfGX, px, pz);
        vel[i * 3 + 2] += g * this.sampleSurface(this.surfGZ, px, pz);
      }
    }

    // viscosity (pairwise impulses on approaching particles)
    this.buildNeighbors();
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < nbrCount[i]; k++) {
        const j = nbrs[i * MAX_NEIGHBORS + k];
        if (j < i) continue;
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < 1e-6) continue;
        const nx = dx / r, ny = dy / r, nz = dz / r;
        const u =
          (vel[i * 3] - vel[j * 3]) * nx +
          (vel[i * 3 + 1] - vel[j * 3 + 1]) * ny +
          (vel[i * 3 + 2] - vel[j * 3 + 2]) * nz;
        if (u > 0) {
          const q = 1 - r / h;
          const I = 0.5 * q * this.viscosity * u;
          vel[i * 3] -= I * nx; vel[i * 3 + 1] -= I * ny; vel[i * 3 + 2] -= I * nz;
          vel[j * 3] += I * nx; vel[j * 3 + 1] += I * ny; vel[j * 3 + 2] += I * nz;
        }
      }
    }

    // advance positions
    for (let i = 0; i < n; i++) {
      const move = pinned[i] ? 0 : dt;
      for (let a = i * 3; a < i * 3 + 3; a++) {
        prev[a] = pos[a];
        pos[a] += vel[a] * move;
      }
    }

    // double density relaxation
    this.buildNeighbors();
    const dt2 = dt * dt;
    for (let i = 0; i < n; i++) {
      const cnt = nbrCount[i];
      const base = i * MAX_NEIGHBORS;
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      let rho = 0, rhoN = 0;
      for (let k = 0; k < cnt; k++) {
        const j = nbrs[base + k];
        const dx = pos[j * 3] - px, dy = pos[j * 3 + 1] - py, dz = pos[j * 3 + 2] - pz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const q = 1 - r / h;
        rho += q * q;
        rhoN += q * q * q;
      }
      // only resist compression: avoids surface particles clumping together
      const P = Math.max(this.stiffness * (rho - this.rho0), 0);
      const Pn = this.stiffnessNear * rhoN;
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < cnt; k++) {
        const j = nbrs[base + k];
        const dx = pos[j * 3] - px, dy = pos[j * 3 + 1] - py, dz = pos[j * 3 + 2] - pz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < 1e-6) continue;
        const q = 1 - r / h;
        const D = (0.5 * dt2 * (P * q + Pn * q * q)) / r;
        if (!pinned[j]) {
          pos[j * 3] += D * dx * 0.5;
          pos[j * 3 + 1] += D * dy * 0.5;
          pos[j * 3 + 2] += D * dz * 0.5;
        }
        ax -= D * dx * 0.5; ay -= D * dy * 0.5; az -= D * dz * 0.5;
      }
      if (!pinned[i]) {
        pos[i * 3] += ax; pos[i * 3 + 1] += ay; pos[i * 3 + 2] += az;
      }
    }

    // tank walls
    const m = 0.02;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const j = i * 3;
      if (pos[j] < TANK.minX + m) pos[j] = TANK.minX + m;
      else if (pos[j] > TANK.maxX - m) pos[j] = TANK.maxX - m;
      if (pos[j + 1] < TANK.minY + m) pos[j + 1] = TANK.minY + m;
      else if (pos[j + 1] > TANK.maxY - m) pos[j + 1] = TANK.maxY - m;
      if (pos[j + 2] < TANK.minZ + m) pos[j + 2] = TANK.minZ + m;
      else if (pos[j + 2] > TANK.maxZ - m) pos[j + 2] = TANK.maxZ - m;
    }

    // velocities from displacement
    const inv = 1 / dt;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (pinned[i]) {
        vel[j] = vel[j + 1] = vel[j + 2] = 0;
        continue;
      }
      let vx = (pos[j] - prev[j]) * inv;
      let vy = (pos[j + 1] - prev[j + 1]) * inv;
      let vz = (pos[j + 2] - prev[j + 2]) * inv;
      const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (s > this.maxSpeed) {
        const f = this.maxSpeed / s;
        vx *= f; vy *= f; vz *= f;
      }
      vel[j] = vx; vel[j + 1] = vy; vel[j + 2] = vz;
    }
  }

  /**
   * Collect pairs of nearby particles to draw as lattice links.
   * Writes [a0, b0, a1, b1, ...] into `out` and returns the number of pairs.
   * Links longer than `maxDist` are skipped, so the lattice tears apart
   * where the fluid splashes.
   */
  collectLinks(maxDist: number, out: Uint32Array): number {
    const { count: n, pos, nbrs, nbrCount } = this;
    const max2 = maxDist * maxDist;
    const cap = out.length >> 1;
    let pairs = 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < nbrCount[i]; k++) {
        const j = nbrs[i * MAX_NEIGHBORS + k];
        if (j < i) continue;
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        if (dx * dx + dy * dy + dz * dz > max2) continue;
        if (pairs >= cap) return pairs;
        out[pairs * 2] = i;
        out[pairs * 2 + 1] = j;
        pairs++;
      }
    }
    return pairs;
  }


  /**
   * Grab the globule of particles under a ray (stuck ones included) and make
   * them kinematic so they can be dragged with moveGrab(). Returns the globule
   * centre, or null if the ray misses the fluid.
   */
  grab(
    origin: [number, number, number],
    dir: [number, number, number],
    globuleRadius = 0.18,
    rayRadius = 0.12,
  ): [number, number, number] | null {
    const { count: n, pos } = this;
    const [ox, oy, oz] = origin;
    const [dx, dy, dz] = dir;
    const r2 = rayRadius * rayRadius;

    let tMin = Infinity;
    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - ox, ry = pos[i * 3 + 1] - oy, rz = pos[i * 3 + 2] - oz;
      const t = rx * dx + ry * dy + rz * dz;
      if (t < 0) continue;
      const cx = rx - dx * t, cy = ry - dy * t, cz = rz - dz * t;
      if (cx * cx + cy * cy + cz * cz < r2 && t < tMin) tMin = t;
    }
    if (tMin === Infinity) return null;

    // centre sits slightly inside the surface layer that was hit
    const c: [number, number, number] = [
      ox + dx * (tMin + globuleRadius * 0.4),
      oy + dy * (tMin + globuleRadius * 0.4),
      oz + dz * (tMin + globuleRadius * 0.4),
    ];
    this.held = [];
    this.heldOff = [];
    this.heldMin = [Infinity, Infinity, Infinity];
    this.heldMax = [-Infinity, -Infinity, -Infinity];
    const g2 = globuleRadius * globuleRadius;
    for (let i = 0; i < n; i++) {
      const ex = pos[i * 3] - c[0], ey = pos[i * 3 + 1] - c[1], ez = pos[i * 3 + 2] - c[2];
      if (ex * ex + ey * ey + ez * ez > g2) continue;
      this.held.push(i);
      this.heldOff.push(ex, ey, ez);
      this.pinned[i] = 1;
      this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
      const off = [ex, ey, ez];
      for (let a = 0; a < 3; a++) {
        this.heldMin[a] = Math.min(this.heldMin[a], off[a]);
        this.heldMax[a] = Math.max(this.heldMax[a], off[a]);
      }
    }
    return c;
  }

  get isGrabbing() {
    return this.held.length > 0;
  }

  /** Move the grabbed globule so its centre is at (cx, cy, cz), kept inside the tank. */
  moveGrab(cx: number, cy: number, cz: number): [number, number, number] {
    const m = 0.02;
    const clamp = (v: number, lo: number, hi: number, a: number) =>
      Math.min(Math.max(v, lo + m - this.heldMin[a]), hi - m - this.heldMax[a]);
    const x = clamp(cx, TANK.minX, TANK.maxX, 0);
    const y = clamp(cy, TANK.minY, TANK.maxY, 1);
    const z = clamp(cz, TANK.minZ, TANK.maxZ, 2);
    for (let k = 0; k < this.held.length; k++) {
      const i = this.held[k] * 3;
      this.pos[i] = x + this.heldOff[k * 3];
      this.pos[i + 1] = y + this.heldOff[k * 3 + 1];
      this.pos[i + 2] = z + this.heldOff[k * 3 + 2];
    }
    return [x, y, z];
  }

  /** Let go: the globule stays pinned exactly where it is. */
  releaseGrab() {
    this.held = [];
    this.heldOff = [];
  }

  /** Turn every stuck point back into fluid. */
  unpinAll() {
    this.pinned.fill(0);
    this.releaseGrab();
  }

  /**
   * Poke the fluid along a ray (e.g. from the cursor). Only the first layer of
   * fluid the ray touches is affected, so it feels like touching the surface.
   * Returns the hit point, or null if the ray misses the fluid.
   */
  splash(
    origin: [number, number, number],
    dir: [number, number, number],
    radius: number,
    impulse: [number, number, number],
    depth = 0.3,
  ): [number, number, number] | null {
    const { count: n, pos, vel } = this;
    const [ox, oy, oz] = origin;
    const [dx, dy, dz] = dir;
    const r2 = radius * radius;

    let tMin = Infinity;
    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - ox, ry = pos[i * 3 + 1] - oy, rz = pos[i * 3 + 2] - oz;
      const t = rx * dx + ry * dy + rz * dz;
      if (t < 0) continue;
      const cx = rx - dx * t, cy = ry - dy * t, cz = rz - dz * t;
      if (cx * cx + cy * cy + cz * cz < r2 && t < tMin) tMin = t;
    }
    if (tMin === Infinity) return null;

    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - ox, ry = pos[i * 3 + 1] - oy, rz = pos[i * 3 + 2] - oz;
      const t = rx * dx + ry * dy + rz * dz;
      if (t < tMin || t > tMin + depth) continue;
      const cx = rx - dx * t, cy = ry - dy * t, cz = rz - dz * t;
      const d2 = cx * cx + cy * cy + cz * cz;
      if (d2 >= r2 || this.pinned[i]) continue;
      const w = 1 - d2 / r2; // soft falloff
      vel[i * 3] += impulse[0] * w;
      vel[i * 3 + 1] += impulse[1] * w;
      vel[i * 3 + 2] += impulse[2] * w;
    }
    return [ox + dx * tMin, oy + dy * tMin, oz + dz * tMin];
  }
}
