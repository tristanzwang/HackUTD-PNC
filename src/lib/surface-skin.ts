import * as THREE from "three";
import { TANK, type FluidSim } from "./fluid-sim";

const SIZE = TANK.maxX - TANK.minX; // the tank footprint is square
/** How opaque the skin is when fully shown: faint enough to read the points through it. */
const OPACITY = 0.3;

/**
 * A translucent skin over the top layer of one graph's points, so the shape of
 * the surface reads at a glance.
 *
 * The points are an SPH fluid, so there is no ready-made surface to draw. Each frame
 * this lays a grid over the tank floor, finds the height of the highest point near
 * every grid vertex, smooths that lightly, and triangulates wherever there is fluid.
 * It only describes the graph in the tank, so it dissolves as the points ball up
 * into a planet.
 */
export class SurfaceSkin {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshLambertMaterial;
  private spacing = 0; // the point spacing the grid was built for
  private n = 0; // grid cells per side
  private cell = 0;
  private top = new Float32Array(0); // height per vertex; -Infinity = no fluid here
  private smooth = new Float32Array(0);
  private pos = new Float32Array(0);
  private index = new Uint32Array(0);
  private heights = new Float32Array(0); // smoothed surface height per vertex, from the last update
  private shown = 0; // 1 = skin fully in the graph view, 0 = gone (planet)

  constructor() {
    this.material = new THREE.MeshLambertMaterial({
      color: "#ffffff",
      emissive: "#ffffff",
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setColor(color: string) {
    this.material.color.set(color);
    this.material.emissive.set(color);
  }

  /** (Re)build the grid for a given point spacing: finer points get a finer skin. */
  private build(spacing: number) {
    this.spacing = spacing;
    const n = Math.ceil(SIZE / Math.max(0.04, spacing * 0.55));
    this.n = n;
    this.cell = SIZE / n;
    const verts = (n + 1) * (n + 1);
    this.top = new Float32Array(verts);
    this.smooth = new Float32Array(verts);
    this.pos = new Float32Array(verts * 3);
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const v = (j * (n + 1) + i) * 3;
        this.pos[v] = TANK.minX + i * this.cell;
        this.pos[v + 2] = TANK.minZ + j * this.cell;
      }
    this.index = new Uint32Array(n * n * 6);

    const geo = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.pos, 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const index = new THREE.BufferAttribute(this.index, 1);
    index.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", position);
    geo.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  update(sim: FluidSim) {
    // gone by the time the graph has started to ball up
    const k = 1 - Math.min(sim.orbitBlend * 4, 1);
    this.shown = k;
    this.material.opacity = OPACITY * k;
    this.mesh.visible = k > 0.01 && sim.count > 0;
    if (!this.mesh.visible) return;
    if (Math.abs(sim.tankSpacing - this.spacing) > 1e-5) this.build(sim.tankSpacing);

    const { n, cell, top, smooth, pos, index } = this;
    const stride = n + 1;
    const p = sim.pos;

    // ---- height of the highest point near each vertex ----
    top.fill(-Infinity);
    const radius = sim.tankSpacing * 1.05;
    const r2 = radius * radius;
    const reach = Math.ceil(radius / cell);
    for (let q = 0; q < sim.count; q++) {
      const x = p[q * 3], y = p[q * 3 + 1], z = p[q * 3 + 2];
      if (!(y > -1e3 && y < 1e3)) continue; // skip anything non-finite
      const ci = Math.round((x - TANK.minX) / cell);
      const cj = Math.round((z - TANK.minZ) / cell);
      for (let j = Math.max(cj - reach, 0); j <= Math.min(cj + reach, n); j++) {
        const dz = TANK.minZ + j * cell - z;
        for (let i = Math.max(ci - reach, 0); i <= Math.min(ci + reach, n); i++) {
          const dx = TANK.minX + i * cell - x;
          if (dx * dx + dz * dz > r2) continue;
          const v = j * stride + i;
          if (y > top[v]) top[v] = y;
        }
      }
    }

    // ---- two light smoothing passes over the vertices that have fluid ----
    let src = top;
    let dst = smooth;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j <= n; j++)
        for (let i = 0; i <= n; i++) {
          const v = j * stride + i;
          if (src[v] === -Infinity) {
            dst[v] = -Infinity;
            continue;
          }
          let sum = src[v] * 2;
          let w = 2;
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              if (!di && !dj) continue;
              const jj = j + dj, ii = i + di;
              if (jj < 0 || jj > n || ii < 0 || ii > n) continue;
              const s = src[jj * stride + ii];
              if (s === -Infinity) continue;
              sum += s;
              w++;
            }
          dst[v] = sum / w;
        }
      [src, dst] = [dst, src];
    }
    const height = src; // the last pass wrote here (after the swap)
    this.heights = height;

    // ---- vertices and triangles ----
    const lift = sim.tankSpacing * 0.2; // the skin sits on the points, not inside them
    for (let v = 0; v < height.length; v++) {
      pos[v * 3 + 1] = height[v] === -Infinity ? TANK.minY : height[v] + lift;
    }
    let t = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * stride + i;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (
          height[a] === -Infinity ||
          height[b] === -Infinity ||
          height[c] === -Infinity ||
          height[d] === -Infinity
        )
          continue;
        index[t++] = a; index[t++] = c; index[t++] = b;
        index[t++] = b; index[t++] = c; index[t++] = d;
      }
    index.fill(0, t); // degenerate leftovers, so they add nothing to the normals

    const geo = this.mesh.geometry;
    geo.setDrawRange(0, t);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    geo.index!.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /**
   * Fill `out` with a brightness multiplier per point: 1 for points in the top
   * layer, falling toward `1 - strength` for points buried deeper below the
   * surface. Call after update(). Planets (no skin) are left at 1.
   */
  shade(sim: FluidSim, out: Float32Array, strength: number) {
    const amount = strength * this.shown;
    if (amount <= 0.001 || this.heights.length === 0) {
      out.fill(1, 0, sim.count);
      return;
    }
    const { n, cell, heights } = this;
    const p = sim.pos;
    const top = sim.tankSpacing * 0.6; // only the surface layer or two stays bright
    const span = sim.tankSpacing * 2.5; // ...and it is fully dimmed this far further down
    for (let q = 0; q < sim.count; q++) {
      const i = Math.min(Math.max(Math.round((p[q * 3] - TANK.minX) / cell), 0), n);
      const j = Math.min(Math.max(Math.round((p[q * 3 + 2] - TANK.minZ) / cell), 0), n);
      const surface = heights[j * (n + 1) + i];
      if (surface === -Infinity) {
        out[q] = 1;
        continue;
      }
      const t = Math.min(Math.max((surface - p[q * 3 + 1] - top) / span, 0), 1);
      out[q] = 1 - amount * 0.94 * (t * t * (3 - 2 * t));
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
