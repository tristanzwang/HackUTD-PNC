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
/**
 * Largest span the spatial hash has to cover: the tank, or a ball of fluid plus
 * its shell. The grid is this big and *follows the fluid*, so a planet works the
 * same whether it sits in the tank or orbits far away from it.
 */
const MAX_EXTENT = 3.4;

/** Surface-height grid: resolution over the tank footprint, height clip and slope clip. */
const SURF_N = 49;
/** Tallest surface a graph can ask for (the tank is 1.4 tall; leave a little headroom). */
export const MAX_SURFACE_HEIGHT = TANK.maxY - 0.05;
const MAX_SLOPE = 1.2;
const WALL_MARGIN = 0.02; // particles are kept this far inside the walls
const INTERIOR_AREA = (TANK.maxX - TANK.minX - 2 * WALL_MARGIN) * (TANK.maxZ - TANK.minZ - 2 * WALL_MARGIN);
/** Volume a settled particle occupies, as a multiple of spacing^3 (see DEPTH_K1). */
const SETTLED_VOLUME = 1.2;
/** Never fewer nodes than this, so a near-zero graph still shows a thin sheet of fluid. */
const MIN_NODES = 60;
/** A particle with fewer neighbours than this counts as thrown clear of the fluid. */
const STRAY_NEIGHBORS = 6;
/** Most stretched links drawn from any one pinned particle. */
const STRETCH_LINKS = 8;
/**
 * Settled depth of a column of fluid whose particles would fill nominal depth x
 * at spacing^3 each: top = K1*x - K2*x^3. K1 > 1 because settled particles sit a
 * little further apart than the lattice; K2 because deep fluid compresses under
 * its own weight. Fitted to simulations of flat pools (error ~1 unit on the 0-100
 * axis); nominalDepth() inverts it so the top of the point cloud lands on the graph.
 */
const DEPTH_K1 = 1.2;
const DEPTH_K2 = 0.1264;
function nominalDepth(top: number) {
  if (top <= 0) return 0;
  let x = top / DEPTH_K1;
  for (let i = 0; i < 6; i++) {
    const f = x * (DEPTH_K1 - DEPTH_K2 * x * x) - top;
    x -= f / (DEPTH_K1 - 3 * DEPTH_K2 * x * x);
  }
  return Math.max(x, 0);
}
const DEFAULT_LEVEL = 0.56; // initial fluid depth (40 on the 0-100 axis)

export class FluidSim {
  /** Active particles: scales with the volume under the surface graph (see setSurface). */
  count = 0;
  /** Buffer size; `count` never exceeds it. */
  readonly capacity: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** 1 = particle is stuck in place (no longer fluid) until unpinned. */
  readonly pinned: Uint8Array;
  /** Rest spacing between particles; shrinks/grows only when the fluid outgrows its budget. */
  spacing: number;
  private baseSpacing: number;
  /** Smoothing radius, kept at ~2.3x the particle spacing. */
  h: number;
  /** Surface height (metres above the floor) and slope grids; see setSurface. */
  private surfH = new Float32Array(SURF_N * SURF_N);
  private surfGX = new Float32Array(SURF_N * SURF_N);
  private surfGZ = new Float32Array(SURF_N * SURF_N);
  private hasTilt = false;
  /** How many particles are currently pinned (0 = skip all the stuck-point work). */
  pinnedCount = 0;
  /** How strongly fluid clings to nearby pinned points, pulling the surface into a hill. */
  pinnedCohesion = 4;
  private nearIdx = new Int32Array(STRETCH_LINKS);
  private nearD2 = new Float32Array(STRETCH_LINKS);
  private held: number[] = [];
  private heldOff: number[] = [];
  private heldMin = [0, 0, 0];
  private heldMax = [0, 0, 0];
  private prev: Float32Array;

  private rho0 = 1;
  gravity = 7;
  /**
   * 0 = the fluid lies in the tank under ordinary gravity; 1 = it is pulled
   * into a ball around (orbitX, orbitY, orbitZ) with the tank walls gone.
   * Values in between blend the two, which is what the view transition rides on.
   */
  orbitBlend = 0;
  /** Pull toward the gravity point when orbitBlend is 1. */
  orbitGravity = 9;
  orbitX = 0;
  orbitY = 0;
  orbitZ = 0;
  /** Fraction of a planet's whole-body spin removed each step (see despin). */
  despinRate = 0.05;
  /**
   * Speed lost per second by a particle that has lost contact with the fluid,
   * so a planet reabsorbs its splashes instead of keeping a ring of debris.
   */
  strayDrag = 1.4;
  /** The spacing this fluid has in the tank, before any orbit packing. */
  tankSpacing = 0;
  stiffness = 30;
  stiffnessNear = 60;
  viscosity = 0.15;
  maxSpeed = 7;

  // spatial hash (a fixed-size grid whose origin follows the fluid)
  private originX = 0;
  private originY = 0;
  private originZ = 0;
  private cellSize = 0.2;
  private gx = 1;
  private gy = 1;
  private gz = 1;
  private cellStart = new Int32Array(2);
  private cellItems: Int32Array;
  private cellOf: Int32Array;
  private nbrs: Int32Array;
  private nbrCount: Int32Array;

  constructor(capacity = 2400, spacing = 0.097) {
    this.capacity = capacity;
    this.baseSpacing = spacing;
    this.spacing = spacing;
    this.h = spacing * 2.3;
    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.prev = new Float32Array(n * 3);
    this.cellItems = new Int32Array(n);
    this.cellOf = new Int32Array(n);
    this.nbrs = new Int32Array(n * MAX_NEIGHBORS);
    this.nbrCount = new Int32Array(n);

    this.setSurface(() => DEFAULT_LEVEL);
  }

  /** Re-derive everything that depends on the particle spacing. */
  private configure(spacing: number) {
    this.spacing = spacing;
    this.h = spacing * 2.3;
    // displacements scale with the smoothing radius, so keep the response consistent
    this.stiffness = 30 * (spacing / 0.082);
    this.stiffnessNear = 60 * (spacing / 0.082);
    this.cellSize = this.h;
    const dim = Math.ceil(MAX_EXTENT / this.cellSize) + 2;
    this.gx = this.gy = this.gz = dim;
    const cells = dim * dim * dim + 1;
    if (this.cellStart.length !== cells) this.cellStart = new Int32Array(cells);
    this.calibrate();
  }

  /**
   * Refill the tank with the current number of particles, up to the current
   * surface graph, so the fluid falls and sloshes into its resting shape.
   */
  reset() {
    const s = this.spacing;
    const m = 0.04;
    const cols = Math.floor((TANK.maxX - TANK.minX - 2 * m) / s) + 1;
    const levels = Math.floor((TANK.maxY - TANK.minY - 2 * m) / s) + 1;
    const x0 = -(cols - 1) * s * 0.5;

    // lattice candidates, lowest "height above the surface graph" first
    const cand: { x: number; y: number; z: number; key: number }[] = [];
    for (let k = 0; k < levels; k++)
      for (let j = 0; j < cols; j++)
        for (let i = 0; i < cols; i++) {
          const x = x0 + i * s, z = x0 + j * s, y = TANK.minY + m + k * s;
          cand.push({ x, y, z, key: y - this.surfaceHeight(x, z) + Math.random() * 1e-3 });
        }
    cand.sort((a, b) => a.key - b.key);

    const n = Math.min(this.count, cand.length);
    this.count = n;
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
    this.buildNeighbors();
  }

  /**
   * Set the fluid's surface: fn(x, z) is the height in metres above the floor
   * (clipped to 0..MAX_SURFACE_HEIGHT), so the settled surface sits at y = fn(x, z).
   *
   * The number of particles follows the volume under the graph (more fluid =
   * more nodes, up to this fluid's capacity, beyond which spacing grows
   * instead), then the fluid is refilled and drops into place. Non-flat
   * surfaces use a body force a = g * (h_x, -1, h_z), i.e. gravity
   * perpendicular to the surface, so the resting surface follows the graph.
   */
  setSurface(fn: SurfaceFn) {
    const N = SURF_N;
    const w = TANK.maxX - TANK.minX, d = TANK.maxZ - TANK.minZ;
    const dx = w / (N - 1), dz = d / (N - 1);
    const H = this.surfH;
    let sumDepth = 0; // nominal depth, summed over the grid's columns
    for (let k = 0; k < N; k++)
      for (let i = 0; i < N; i++) {
        const v = fn(TANK.minX + i * dx, TANK.minZ + k * dz);
        const h = Number.isFinite(v) ? Math.max(0, Math.min(MAX_SURFACE_HEIGHT, v)) : 0;
        H[k * N + i] = h;
        sumDepth += nominalDepth(h);
      }
    let maxSlope = 0;
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
        maxSlope = Math.max(maxSlope, Math.min(sl, MAX_SLOPE));
        this.surfGX[k * N + i] = gx;
        this.surfGZ[k * N + i] = gz;
      }
    this.hasTilt = maxSlope > 1e-6;

    // How much fluid fills the space under the graph (in particle volumes)?
    const nominalVolume = INTERIOR_AREA * (sumDepth / (N * N));
    let sp = this.baseSpacing;
    let n = Math.round(nominalVolume / sp ** 3);
    if (n > this.capacity) {
      // more fluid than this slot's budget: keep the node count, widen the spacing
      sp = Math.cbrt(nominalVolume / this.capacity);
      n = this.capacity;
    }
    this.tankSpacing = sp;
    this.configure(sp);
    this.count = Math.max(MIN_NODES, n);
    this.reset();
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

  /** Surface height (metres above the floor) the graph asks for at (x, z). */
  surfaceHeight(x: number, z: number) {
    return this.sampleSurface(this.surfH, x, z);
  }

  /**
   * Rest density: the density of a particle inside an infinite cubic lattice
   * at the rest spacing. (Independent of how much fluid there is, so thin
   * fluids with no fully-surrounded particles are still calibrated correctly.)
   */
  private calibrate() {
    const { spacing: sp, h } = this;
    let rho = 0;
    for (let i = -3; i <= 3; i++)
      for (let j = -3; j <= 3; j++)
        for (let k = -3; k <= 3; k++) {
          if (i === 0 && j === 0 && k === 0) continue;
          const r = sp * Math.sqrt(i * i + j * j + k * k);
          if (r < h) {
            const q = 1 - r / h;
            rho += q * q;
          }
        }
    this.rho0 = rho;
  }

  private cellIndex(x: number, y: number, z: number) {
    let cx = Math.floor((x - this.originX) / this.cellSize);
    let cy = Math.floor((y - this.originY) / this.cellSize);
    let cz = Math.floor((z - this.originZ) / this.cellSize);
    cx = cx < 0 ? 0 : cx >= this.gx ? this.gx - 1 : cx;
    cy = cy < 0 ? 0 : cy >= this.gy ? this.gy - 1 : cy;
    cz = cz < 0 ? 0 : cz >= this.gz ? this.gz - 1 : cz;
    return (cy * this.gz + cz) * this.gx + cx;
  }

  private buildNeighbors() {
    const { count: n, pos, cellStart, cellItems, cellOf, gx, gy, gz, h } = this;
    if (n === 0) return;
    // park the grid on the fluid's own bounding box, wherever in space it is
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    for (let i = 0; i < n; i++) {
      if (pos[i * 3] < mnx) mnx = pos[i * 3];
      if (pos[i * 3 + 1] < mny) mny = pos[i * 3 + 1];
      if (pos[i * 3 + 2] < mnz) mnz = pos[i * 3 + 2];
    }
    this.originX = mnx - this.cellSize;
    this.originY = mny - this.cellSize;
    this.originZ = mnz - this.cellSize;

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
    const b = this.orbitBlend;
    const down = this.gravity * dt * (1 - b);
    const pull = this.orbitGravity * dt * b;
    const soft = this.spacing;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      if (down > 0) {
        vel[i * 3 + 1] -= down;
        if (this.hasTilt) {
          // tilt gravity to be perpendicular to the shaped surface
          const px = pos[i * 3], pz = pos[i * 3 + 2];
          vel[i * 3] += down * this.sampleSurface(this.surfGX, px, pz);
          vel[i * 3 + 2] += down * this.sampleSurface(this.surfGZ, px, pz);
        }
      }
      if (pull > 0) {
        // fall toward the gravity point, which is what balls the fluid up
        const dx = this.orbitX - pos[i * 3];
        const dy = this.orbitY - pos[i * 3 + 1];
        const dz = this.orbitZ - pos[i * 3 + 2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const f = pull / Math.max(r, soft);
        vel[i * 3] += dx * f;
        vel[i * 3 + 1] += dy * f;
        vel[i * 3 + 2] += dz * f;
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

    // Fluid clings to nearby pinned points, so a dragged blob pulls the surface
    // up (or down) with it instead of leaving a clean hole behind.
    if (this.pinnedCount > 0 && this.pinnedCohesion > 0) {
      const a = this.pinnedCohesion * dt;
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        const base = i * MAX_NEIGHBORS;
        for (let k = 0; k < nbrCount[i]; k++) {
          const j = nbrs[base + k];
          if (!pinned[j]) continue;
          const dx = pos[j * 3] - pos[i * 3];
          const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
          const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (r < 1e-6) continue;
          const f = (a * (1 - r / h)) / r;
          vel[i * 3] += dx * f;
          vel[i * 3 + 1] += dy * f;
          vel[i * 3 + 2] += dz * f;
        }
      }
    }

    // Particles knocked clear of a planet have no neighbours to slow them, so
    // they would circle it forever. Bleed their speed and gravity reels them in.
    if (b > 0 && this.strayDrag > 0) {
      const k = this.strayDrag * b * dt;
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        const lonely = 1 - Math.min(nbrCount[i], STRAY_NEIGHBORS) / STRAY_NEIGHBORS;
        if (lonely <= 0) continue;
        const f = 1 - k * lonely;
        vel[i * 3] *= f;
        vel[i * 3 + 1] *= f;
        vel[i * 3 + 2] *= f;
      }
    }

    // a planet should stay a sphere, so take out any whole-body spin
    if (b > 0) this.despin(this.despinRate * b);

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
    const m = WALL_MARGIN;
    // Both walls are applied as a weighted move toward the clamped position, so
    // the tank dissolves and the ball's shell forms smoothly across a transition.
    const keep = 1 - b; // weight of the tank walls
    const shell = b > 0 ? this.ballRadius * 1.6 : 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const j = i * 3;
      if (keep > 0) {
        const cx = Math.min(Math.max(pos[j], TANK.minX + m), TANK.maxX - m);
        const cy = Math.min(Math.max(pos[j + 1], TANK.minY + m), TANK.maxY - m);
        const cz = Math.min(Math.max(pos[j + 2], TANK.minZ + m), TANK.maxZ - m);
        pos[j] += (cx - pos[j]) * keep;
        pos[j + 1] += (cy - pos[j + 1]) * keep;
        pos[j + 2] += (cz - pos[j + 2]) * keep;
      }
      if (shell > 0) {
        // a loose shell around the gravity point, so nothing drifts off into space
        const dx = pos[j] - this.orbitX;
        const dy = pos[j + 1] - this.orbitY;
        const dz = pos[j + 2] - this.orbitZ;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > shell) {
          const t = (b * (shell / r - 1));
          pos[j] += dx * t;
          pos[j + 1] += dy * t;
          pos[j + 2] += dz * t;
        }
      }
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
   * Squeeze the particles closer together: 1 is tank density, lower packs the
   * fluid tighter. Lowering the rest spacing leaves the fluid under-dense, so
   * gravity draws it inward until it reaches the new density — the ball
   * condenses rather than snapping to a smaller size.
   */
  setPacking(k: number) {
    const target = this.tankSpacing * k;
    if (Math.abs(target - this.spacing) > 1e-6) this.configure(target);
  }

  /**
   * Bleed off whole-body rotation. Nothing else damps it: the viscosity model
   * only acts between particles that are approaching each other, and a rigidly
   * spinning ball has no such motion. Left alone, a planet keeps whatever spin
   * it picked up while balling up, and centrifugal force slowly draws it out
   * into an ellipsoid. `rate` is the fraction of the spin removed per step.
   */
  private despin(rate: number) {
    const { count: n, pos, vel } = this;
    if (n < 8 || rate <= 0) return;

    let cx = 0, cy = 0, cz = 0, mvx = 0, mvy = 0, mvz = 0;
    for (let i = 0; i < n; i++) {
      cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
      mvx += vel[i * 3]; mvy += vel[i * 3 + 1]; mvz += vel[i * 3 + 2];
    }
    cx /= n; cy /= n; cz /= n; mvx /= n; mvy /= n; mvz /= n;

    // angular momentum and inertia tensor about the centre of mass
    let lx = 0, ly = 0, lz = 0;
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - cx, ry = pos[i * 3 + 1] - cy, rz = pos[i * 3 + 2] - cz;
      const ux = vel[i * 3] - mvx, uy = vel[i * 3 + 1] - mvy, uz = vel[i * 3 + 2] - mvz;
      lx += ry * uz - rz * uy;
      ly += rz * ux - rx * uz;
      lz += rx * uy - ry * ux;
      ixx += ry * ry + rz * rz;
      iyy += rx * rx + rz * rz;
      izz += rx * rx + ry * ry;
      ixy -= rx * ry;
      ixz -= rx * rz;
      iyz -= ry * rz;
    }

    // omega = I^-1 L, by cofactors (the tensor is symmetric)
    const c00 = iyy * izz - iyz * iyz;
    const c01 = ixz * iyz - ixy * izz;
    const c02 = ixy * iyz - ixz * iyy;
    const det = ixx * c00 + ixy * c01 + ixz * c02;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return;
    const c11 = ixx * izz - ixz * ixz;
    const c12 = ixy * ixz - ixx * iyz;
    const c22 = ixx * iyy - ixy * ixy;
    const wx = ((c00 * lx + c01 * ly + c02 * lz) / det) * rate;
    const wy = ((c01 * lx + c11 * ly + c12 * lz) / det) * rate;
    const wz = ((c02 * lx + c12 * ly + c22 * lz) / det) * rate;

    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - cx, ry = pos[i * 3 + 1] - cy, rz = pos[i * 3 + 2] - cz;
      vel[i * 3] -= wy * rz - wz * ry;
      vel[i * 3 + 1] -= wz * rx - wx * rz;
      vel[i * 3 + 2] -= wx * ry - wy * rx;
    }
  }

  /** Radius of the ball this fluid settles into around a gravity point. */
  get ballRadius() {
    const volume = this.count * this.spacing ** 3 * SETTLED_VOLUME;
    return Math.cbrt((volume * 3) / (4 * Math.PI));
  }

  /**
   * Turn the fluid rigidly about its gravity point. Only positions move:
   * velocities stay in the non-rotating frame, so the planet visibly spins
   * without the centrifugal force that would pull it out of shape, and despin
   * has nothing to fight.
   */
  spin(ax: number, ay: number, az: number, angle: number) {
    const { count: n, pos } = this;
    if (n === 0 || angle === 0) return;
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-9) return;
    const kx = ax / len, ky = ay / len, kz = az / len;
    const c = Math.cos(angle), sn = Math.sin(angle), t = 1 - c;
    const ox = this.orbitX, oy = this.orbitY, oz = this.orbitZ;
    for (let i = 0; i < n; i++) {
      const rx = pos[i * 3] - ox, ry = pos[i * 3 + 1] - oy, rz = pos[i * 3 + 2] - oz;
      const dot = kx * rx + ky * ry + kz * rz;
      // Rodrigues' rotation formula
      pos[i * 3] = ox + rx * c + (ky * rz - kz * ry) * sn + kx * dot * t;
      pos[i * 3 + 1] = oy + ry * c + (kz * rx - kx * rz) * sn + ky * dot * t;
      pos[i * 3 + 2] = oz + rz * c + (kx * ry - ky * rx) * sn + kz * dot * t;
    }
  }

  /** Move every particle rigidly, e.g. to carry a planet along its orbit. */
  translate(dx: number, dy: number, dz: number) {
    const { count: n, pos } = this;
    for (let i = 0; i < n; i++) {
      pos[i * 3] += dx;
      pos[i * 3 + 1] += dy;
      pos[i * 3 + 2] += dz;
    }
    this.orbitX += dx;
    this.orbitY += dy;
    this.orbitZ += dz;
  }

  /** Average particle position. */
  centroid(out: [number, number, number]): [number, number, number] {
    const { count: n, pos } = this;
    out[0] = out[1] = out[2] = 0;
    if (n === 0) return out;
    for (let i = 0; i < n; i++) {
      out[0] += pos[i * 3];
      out[1] += pos[i * 3 + 1];
      out[2] += pos[i * 3 + 2];
    }
    out[0] /= n;
    out[1] /= n;
    out[2] /= n;
    return out;
  }

  /**
   * The (up to `k`) nearest *unpinned* particles to `i` within `radius`, nearest
   * first. Fills `idxOut`/`d2Out` (squared distances) and returns how many were
   * found. Pinned particles are skipped because a dragged blob's own points are
   * always the closest ones, and would otherwise crowd out the fluid it needs to
   * reach. Reads the spatial hash built by the last step().
   */
  private nearestFluidWithin(
    i: number,
    radius: number,
    k: number,
    idxOut: Int32Array,
    d2Out: Float32Array,
  ): number {
    const { pos, pinned, cellStart, cellItems, gx, gy, gz, cellSize } = this;
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    // hash the live position: a dragged point has moved since the last step
    const c = this.cellIndex(px, py, pz);
    const cx = c % gx;
    const cz = Math.floor(c / gx) % gz;
    const cy = Math.floor(c / (gx * gz));
    const ring = Math.ceil(radius / cellSize);
    const r2 = radius * radius;
    let found = 0;
    let worst = Infinity;
    for (let oy = Math.max(cy - ring, 0); oy <= Math.min(cy + ring, gy - 1); oy++)
      for (let oz = Math.max(cz - ring, 0); oz <= Math.min(cz + ring, gz - 1); oz++)
        for (let ox = Math.max(cx - ring, 0); ox <= Math.min(cx + ring, gx - 1); ox++) {
          const cc = (oy * gz + oz) * gx + ox;
          for (let sIdx = cellStart[cc]; sIdx < cellStart[cc + 1]; sIdx++) {
            const j = cellItems[sIdx];
            if (j === i || pinned[j]) continue;
            const dx = pos[j * 3] - px, dy = pos[j * 3 + 1] - py, dz = pos[j * 3 + 2] - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= r2 || d2 >= worst) continue;
            // keep the buffer sorted by distance, evicting the worst once it is full
            let p = found < k ? found++ : k - 1;
            while (p > 0 && d2Out[p - 1] > d2) {
              d2Out[p] = d2Out[p - 1];
              idxOut[p] = idxOut[p - 1];
              p--;
            }
            d2Out[p] = d2;
            idxOut[p] = j;
            worst = found === k ? d2Out[k - 1] : Infinity;
          }
        }
    return found;
  }

  /**
   * Collect pairs of particles to draw as lattice links. Writes [a0, b0, a1,
   * b1, ...] into `out` and returns the number of pairs.
   *
   * Ordinary fluid links are shorter than `maxDist`, so the lattice tears apart
   * where the fluid splashes. Pinned particles additionally reach out to the
   * nearest fluid as far as `stretchDist`, so a blob dragged out of the fluid
   * stays joined to the surface it came from: the lattice stretches into a hill
   * or divot instead of tearing off. For each pair, `outStretch` gets 0 for an
   * ordinary link, or how far a stretched one is drawn out (0..1], so the
   * renderer can fade it as it thins.
   */
  collectLinks(
    maxDist: number,
    out: Uint32Array,
    stretchDist = 0,
    outStretch?: Float32Array,
  ): number {
    const { count: n, pos, nbrs, nbrCount } = this;
    const max2 = maxDist * maxDist;
    const cap = out.length >> 1;
    let pairs = 0;

    const emit = (i: number, j: number, stretch: number) => {
      out[pairs * 2] = i;
      out[pairs * 2 + 1] = j;
      if (outStretch) outStretch[pairs] = stretch;
      pairs++;
    };

    for (let i = 0; i < n; i++) {
      for (let k = 0; k < nbrCount[i]; k++) {
        const j = nbrs[i * MAX_NEIGHBORS + k];
        if (j < i) continue;
        const dx = pos[j * 3] - pos[i * 3];
        const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
        const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
        if (dx * dx + dy * dy + dz * dz > max2) continue;
        if (pairs >= cap) return pairs;
        emit(i, j, 0);
      }
    }

    // stretched links, from the pinned points outward
    if (this.pinnedCount === 0 || stretchDist <= maxDist) return pairs;
    const span = stretchDist - maxDist;
    for (let i = 0; i < n; i++) {
      if (!this.pinned[i]) continue;
      const found = this.nearestFluidWithin(
        i,
        stretchDist,
        STRETCH_LINKS,
        this.nearIdx,
        this.nearD2,
      );
      for (let k = 0; k < found; k++) {
        const d = Math.sqrt(this.nearD2[k]);
        if (d <= maxDist) continue; // the pass above already drew this one
        if (pairs >= cap) return pairs;
        emit(i, this.nearIdx[k], (d - maxDist) / span);
      }
    }
    return pairs;
  }

  /**
   * Distance along a ray to the first particle within `radius` of it, or
   * Infinity if the ray misses. Used to find which fluid the cursor touches.
   */
  probe(
    origin: [number, number, number],
    dir: [number, number, number],
    radius: number,
  ): number {
    const { count: n, pos } = this;
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
    return tMin;
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

    const tMin = this.probe(origin, dir, rayRadius);
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
      if (!this.pinned[i]) this.pinnedCount++;
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
    this.pinnedCount = 0;
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

    const tMin = this.probe(origin, dir, radius);
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
