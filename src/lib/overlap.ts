import { TANK, type FluidSim } from "./fluid-sim";

const CELL = 0.2; // occupancy-grid cell size (points are ~0.1-0.14 apart, so cells stay reliably filled)
const GX = Math.ceil((TANK.maxX - TANK.minX) / CELL);
const GY = Math.ceil((TANK.maxY - TANK.minY) / CELL);
const GZ = Math.ceil((TANK.maxZ - TANK.minZ) / CELL);

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, v) => {
  let n = 0;
  for (let b = v; b; b >>= 1) n += b & 1;
  return n;
});

/**
 * Finds where different fluids occupy the same space so those regions can be
 * dimmed. Fluids never interact physically; this only affects how they look.
 *
 * Each frame, update() marks which fluids are present in every cell of a coarse
 * 3D grid (one bit per fluid, up to 8). A point is "overlapped" when its cell
 * also holds some other fluid, and factors() turns that into a brightness
 * multiplier (1 = normal, smaller = dimmer), eased over time so it doesn't flicker.
 */
export class OverlapField {
  private mask = new Uint8Array(GX * GY * GZ);
  private bit = new Map<FluidSim, number>();
  private amount = 0.6;

  /** Overlap dimming strength, 0 (off) .. 1 (strongest). */
  setAmount(v: number) {
    this.amount = v;
  }

  private cellOf(x: number, y: number, z: number) {
    let cx = Math.floor((x - TANK.minX) / CELL);
    let cy = Math.floor((y - TANK.minY) / CELL);
    let cz = Math.floor((z - TANK.minZ) / CELL);
    cx = cx < 0 ? 0 : cx >= GX ? GX - 1 : cx;
    cy = cy < 0 ? 0 : cy >= GY ? GY - 1 : cy;
    cz = cz < 0 ? 0 : cz >= GZ ? GZ - 1 : cz;
    return (cy * GZ + cz) * GX + cx;
  }

  /** Rebuild the occupancy grid from the current particle positions. Call once per frame. */
  update(sims: FluidSim[]) {
    this.mask.fill(0);
    this.bit.clear();
    sims.forEach((sim, k) => {
      if (k > 7) return;
      this.bit.set(sim, k);
      const b = 1 << k;
      const pos = sim.pos;
      for (let i = 0; i < sim.count; i++) {
        this.mask[this.cellOf(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])] |= b;
      }
    });
  }

  /**
   * Ease each particle's brightness multiplier `out` (1 = normal) toward the
   * value for its current cell: the more other fluids share the cell, the dimmer.
   */
  factors(sim: FluidSim, out: Float32Array) {
    const k = this.bit.get(sim);
    if (k === undefined) return;
    const notMe = ~(1 << k) & 0xff;
    const pos = sim.pos;
    const strength = this.amount * 0.7; // never fully black
    for (let i = 0; i < sim.count; i++) {
      const others = POPCOUNT[this.mask[this.cellOf(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])] & notMe];
      const target = others === 0 ? 1 : 1 - strength * (1 - Math.pow(0.5, others));
      out[i] += (target - out[i]) * 0.25;
    }
  }
}
