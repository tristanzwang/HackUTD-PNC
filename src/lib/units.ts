import type { SurfaceFn } from "./expression";
import { MAX_SURFACE_HEIGHT, TANK } from "./fluid-sim";

/** Every axis of the coordinate grid runs 0 -> AXIS_MAX, whatever the tank's world size. */
export const AXIS_MAX = 100;

/** The surface-height clip expressed in axis units (100 = full tank height). */
export const MAX_SURFACE_UNITS = (MAX_SURFACE_HEIGHT / (TANK.maxY - TANK.minY)) * AXIS_MAX;

/**
 * Turn a graph written in grid units, h(x, z) with x, z in 0..100 across the
 * tank floor and h in y-axis units, into a world-space height function.
 *
 * The graph's x runs along the world Z axis and its z along the world X axis
 * (they are swapped), so `hx(xw, zw) = fn(x = along world Z, z = along world X)`.
 */
export function gridToWorldSurface(fn: SurfaceFn): SurfaceFn {
  const w = TANK.maxX - TANK.minX;
  const d = TANK.maxZ - TANK.minZ;
  const hgt = TANK.maxY - TANK.minY;
  return (xw, zw) =>
    fn(((zw - TANK.minZ) / d) * AXIS_MAX, ((xw - TANK.minX) / w) * AXIS_MAX) * (hgt / AXIS_MAX);
}
