"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { createCoordinateGrid } from "@/lib/coordinate-grid";
import {
  FLUID_COLORS,
  MAX_FLUIDS,
  createFluid,
  type FluidEntry,
} from "@/lib/fluid-config";
import { FluidSim, TANK } from "@/lib/fluid-sim";
import type { SurfaceFn } from "@/lib/expression";
import { OverlapField } from "@/lib/overlap";
import { createSolarScenery } from "@/lib/solar-scenery";
import {
  ViewTransition,
  clamp01,
  easeInOutCubic,
  orbitPosition,
  spinAxis,
  spinRate,
  systemRadius,
} from "@/lib/solar-system";
import SurfacePanel from "./SurfacePanel";

const STEP = 1 / 60;
const LINK_RATIO = 1.317; // neighbours closer than this x spacing get a lattice link
const POINT_RATIO = 0.49; // point size relative to particle spacing
const LINK_DIM = 0.7; // links are drawn slightly darker than the points
// Links from pinned points stretch this much further, so a dragged blob stays
// joined to the fluid it came from instead of tearing off.
const STRETCH_RATIO = 7;
const MIN_STRETCH = 0.6;
const STRETCH_FADE = 0.82; // how far a fully stretched link fades out
const PIN_COLOR = new THREE.Color("#ffb347"); // stuck points
const WHITE = new THREE.Color("#ffffff");
const BG = "#070b17";
const DEFAULT_DIMMING = 0.6;
const DEFAULT_OVERLAP_DIMMING = 0.6;
const TANK_CENTER = new THREE.Vector3(0, (TANK.maxY - TANK.minY) * 0.3, 0);
const SUN_CENTER = new THREE.Vector3(0, 0, 0);
/** How long the tank <-> solar system transition takes. */
const TRANSITION_SECONDS = 2.6;
/** How much tighter a planet's dots sit than the same water does in the tank. */
const ORBIT_PACKING = 0.65;

// cursor reach scales with a fluid's particle spacing so sparse fluids stay grabbable
const splashRadius = (sim: FluidSim) => Math.max(0.16, 1.8 * sim.spacing);
const grabRadius = (sim: FluidSim) => Math.max(0.22, 2.3 * sim.spacing); // size of the globule you pick up
const grabRayRadius = (sim: FluidSim) => Math.max(0.12, 1.3 * sim.spacing);

export type View = "tank" | "solar";

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

type LatticeBuffers = {
  pointGeo: THREE.BufferGeometry;
  pointColors: THREE.BufferAttribute;
  lineGeo: THREE.BufferGeometry;
  linePos: THREE.BufferAttribute;
  lineCol: THREE.BufferAttribute;
  linkIdx: Uint32Array;
  linkStretch: Float32Array;
};

let spriteTexture: THREE.CanvasTexture | null = null;
/** Soft round sprite so points aren't squares (shared by every fluid). */
function getSprite() {
  if (!spriteTexture) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const g = cv.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.6, "#fff");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    spriteTexture = new THREE.CanvasTexture(cv);
  }
  return spriteTexture;
}

/**
 * Points share the sim's position buffer directly (no per-frame copy).
 * Lattice links are rebuilt every frame from nearby particle pairs.
 */
function createBuffers(sim: FluidSim): LatticeBuffers {
  const n = sim.capacity; // sim.count (active nodes) changes with the graph's volume
  const maxLinks = n * 6; // ordinary lattice links, plus the stretched ones from pinned points

  const pointGeo = new THREE.BufferGeometry();
  pointGeo.setAttribute("position", new THREE.BufferAttribute(sim.pos, 3));
  const pointColors = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  pointGeo.setAttribute("color", pointColors);

  const lineGeo = new THREE.BufferGeometry();
  const linePos = new THREE.BufferAttribute(new Float32Array(maxLinks * 6), 3);
  const lineCol = new THREE.BufferAttribute(new Float32Array(maxLinks * 6), 3);
  linePos.setUsage(THREE.DynamicDrawUsage);
  lineCol.setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute("position", linePos);
  lineGeo.setAttribute("color", lineCol);
  lineGeo.setDrawRange(0, 0);

  return {
    pointGeo,
    pointColors,
    lineGeo,
    linePos,
    lineCol,
    linkIdx: new Uint32Array(maxLinks * 2),
    linkStretch: new Float32Array(maxLinks),
  };
}

/** Refresh point colours (fluid colour -> white with speed) and rebuild the link lines. */
function updateLattice(
  sim: FluidSim,
  buffers: LatticeBuffers,
  c: THREE.Color,
  deep: THREE.Color,
  foam: THREE.Color,
  brightness: Float32Array, // per-point multiplier (dims regions where fluids overlap)
) {
  const { vel, pos } = sim;
  const { pointGeo, pointColors, lineGeo, linePos, lineCol, linkIdx, linkStretch } = buffers;

  // Fast water turns to foam, but a planet should just be its own colour, so the
  // effect fades out as the fluid balls up.
  const foamK = 1 - sim.orbitBlend;
  const pc = pointColors.array as Float32Array;
  for (let i = 0; i < sim.count; i++) {
    const j = i * 3;
    if (sim.pinned[i]) {
      c.copy(PIN_COLOR);
    } else {
      const speed = Math.hypot(vel[j], vel[j + 1], vel[j + 2]);
      c.copy(deep)
        .lerp(foam, Math.min(speed / 3.5, 1) * foamK)
        .multiplyScalar(brightness[i]);
    }
    pc[j] = c.r;
    pc[j + 1] = c.g;
    pc[j + 2] = c.b;
  }
  pointColors.needsUpdate = true;
  (pointGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

  const maxDist = sim.spacing * LINK_RATIO;
  const links = sim.collectLinks(
    maxDist,
    linkIdx,
    Math.max(sim.spacing * STRETCH_RATIO, MIN_STRETCH),
    linkStretch,
  );
  const lp = linePos.array as Float32Array;
  const lc = lineCol.array as Float32Array;
  for (let l = 0; l < links; l++) {
    const bothStuck = sim.pinned[linkIdx[l * 2]] && sim.pinned[linkIdx[l * 2 + 1]];
    // a stretched link thins out the further it reaches, so the blob melts into the surface
    const dim = (bothStuck ? 1 : LINK_DIM) * (1 - STRETCH_FADE * linkStretch[l]);
    for (let e = 0; e < 2; e++) {
      const p = linkIdx[l * 2 + e] * 3;
      const o = (l * 2 + e) * 3;
      lp[o] = pos[p];
      lp[o + 1] = pos[p + 1];
      lp[o + 2] = pos[p + 2];
      lc[o] = pc[p] * dim;
      lc[o + 1] = pc[p + 1] * dim;
      lc[o + 2] = pc[p + 2] * dim;
    }
  }
  linePos.needsUpdate = true;
  lineCol.needsUpdate = true;
  lineGeo.setDrawRange(0, links * 2);
}

/**
 * Dot size tracks the fluid's spacing, but shrinks less than orbit packing does
 * — that is what makes a planet read as densely packed rather than merely small.
 */
const pointSize = (sim: FluidSim) =>
  Math.max(sim.spacing, sim.tankSpacing * 0.95) * POINT_RATIO;

/** Draw only the active nodes, and keep point size matched to the (possibly re-spaced) fluid. */
function syncDrawState(geo: THREE.BufferGeometry, mat: THREE.PointsMaterial | null, sim: FluidSim) {
  geo.setDrawRange(0, sim.count);
  if (mat) mat.size = pointSize(sim);
}

/**
 * Depth dimming: fog runs from just in front of the subject to just behind it,
 * so points far from the camera fade into the background. `amount` is 0..1.
 */
function updateFog(scene: THREE.Scene, camDist: number, amount: number, spread: number) {
  const fog = scene.fog as THREE.Fog | null;
  if (!fog) return;
  fog.near = Math.max(camDist - spread * 0.5, 0.1);
  fog.far = camDist + spread * 0.75 + (1 - amount) * spread * 3;
}

/** The fluid whose nearest particle the ray reaches first (fluids never interact; the cursor picks one). */
function pickFluid(
  fluids: FluidEntry[],
  o: THREE.Vector3,
  d: THREE.Vector3,
  radiusOf: (sim: FluidSim) => number,
): FluidEntry | null {
  let best: FluidEntry | null = null;
  let bestT = Infinity;
  for (const f of fluids) {
    const t = f.sim.probe([o.x, o.y, o.z], [d.x, d.y, d.z], radiusOf(f.sim));
    if (t < bestT) {
      bestT = t;
      best = f;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// the conductor: advances the transition, flies the planets, steps every fluid
// ---------------------------------------------------------------------------

function SimDriver({
  fluids,
  conductor,
  overlap,
  overlapDimming,
}: {
  fluids: FluidEntry[];
  conductor: ViewTransition;
  overlap: OverlapField;
  overlapDimming: number;
}) {
  const acc = useRef(0);
  const live = useRef({ fluids, overlapDimming });
  useEffect(() => {
    live.current = { fluids, overlapDimming };
  }, [fluids, overlapDimming]);
  const tmp = useMemo(() => ({ orbit: [0, 0, 0] as [number, number, number] }), []);
  const axes = useMemo(() => Array.from({ length: MAX_FLUIDS }, (_, i) => spinAxis(i)), []);

  useFrame((_, delta) => {
    const d = Math.min(delta, 0.05);
    const c = conductor;
    const { fluids: list } = live.current;

    const { gather, launch } = c.advance(d, TRANSITION_SECONDS);
    c.forget(c.p === 0 ? undefined : new Set(list.map((f) => f.id)));

    list.forEach((f, i) => {
      const sim = f.sim;
      sim.orbitBlend = gather;
      // the ball condenses as it forms, so planets are denser than their pools
      sim.setPacking(1 - (1 - ORBIT_PACKING) * gather);
      if (c.p === 0) return;

      // the ball forms right where the water already is, then sets off
      const { home, fresh } = c.home(f.id, () => sim.centroid([0, 0, 0]));
      if (fresh) {
        sim.orbitX = home[0];
        sim.orbitY = home[1];
        sim.orbitZ = home[2];
        sim.unpinAll(); // stuck points would otherwise ride along frozen
      }
      orbitPosition(i, c.t, tmp.orbit);
      // carry the whole planet rigidly, so orbiting never smears it
      sim.translate(
        home[0] + (tmp.orbit[0] - home[0]) * launch - sim.orbitX,
        home[1] + (tmp.orbit[1] - home[1]) * launch - sim.orbitY,
        home[2] + (tmp.orbit[2] - home[2]) * launch - sim.orbitZ,
      );
      const axis = axes[i % axes.length];
      sim.spin(axis[0], axis[1], axis[2], spinRate(i) * gather * d);
    });

    // planets are far apart in space, so overlap dimming only makes sense in the tank
    overlap.setAmount(live.current.overlapDimming * (1 - clamp01(c.p / 0.4)));

    // fixed step; cap so a slow frame can't spiral
    acc.current = Math.min(acc.current + d, STEP * 2);
    while (acc.current >= STEP) {
      for (const f of list) f.sim.step(STEP);
      acc.current -= STEP;
    }
  });
  return null;
}

// ---------------------------------------------------------------------------
// one fluid: draws its points and links (the driver above steps it)
// ---------------------------------------------------------------------------

function FluidLayer({ fluid, overlap }: { fluid: FluidEntry; overlap: OverlapField }) {
  const { sim, color } = fluid;
  const buffers = useMemo(() => createBuffers(sim), [sim]);
  const brightness = useMemo(() => new Float32Array(sim.capacity).fill(1), [sim]);
  const pointsMat = useRef<THREE.PointsMaterial>(null);
  const colors = useMemo(() => {
    const deep = new THREE.Color(color);
    return { c: new THREE.Color(), deep, foam: deep.clone().lerp(WHITE, 0.88) };
  }, [color]);

  useEffect(
    () => () => {
      buffers.pointGeo.dispose();
      buffers.lineGeo.dispose();
    },
    [buffers],
  );

  useFrame(() => {
    overlap.factors(sim, brightness);
    updateLattice(sim, buffers, colors.c, colors.deep, colors.foam, brightness);
    syncDrawState(buffers.pointGeo, pointsMat.current, sim);
  });

  return (
    <>
      <points geometry={buffers.pointGeo} frustumCulled={false}>
        <pointsMaterial
          ref={pointsMat}
          size={pointSize(sim)}
          sizeAttenuation
          vertexColors
          map={getSprite()}
          alphaTest={0.4}
          transparent
        />
      </points>
      <lineSegments geometry={buffers.lineGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.55} depthWrite={false} />
      </lineSegments>
    </>
  );
}

/** Rebuilds the fluid-overlap grid each frame (mounted before the layers so they read a fresh one). */
function OverlapUpdater({ fluids, overlap }: { fluids: FluidEntry[]; overlap: OverlapField }) {
  const fluidsRef = useRef(fluids);
  useEffect(() => {
    fluidsRef.current = fluids;
  }, [fluids]);
  useFrame(() => overlap.update(fluidsRef.current.map((f) => f.sim)));
  return null;
}

// ---------------------------------------------------------------------------
// scenery
// ---------------------------------------------------------------------------

/** The tank: fixed coordinate grid (origin corner is 0,0,0; axes run to 100). */
function Tank({ conductor }: { conductor: ViewTransition }) {
  const grid = useMemo(() => createCoordinateGrid(TANK), []);
  const edges = useRef<THREE.LineSegments>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);
  const tankW = TANK.maxX - TANK.minX;
  const tankH = TANK.maxY - TANK.minY;
  const edgeGeo = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(tankW, tankH, tankW)),
    [tankW, tankH],
  );

  useFrame(() => {
    // the tank is gone well before the planets reach their orbits
    const k = 1 - easeInOutCubic(clamp01(conductor.p / 0.6));
    grid.setOpacity(k);
    if (edges.current) edges.current.visible = k > 0.002;
    if (edgeMat.current) edgeMat.current.opacity = 0.25 * k;
  });

  return (
    <>
      <primitive object={grid.group} />
      <lineSegments ref={edges} geometry={edgeGeo} position={[0, tankH / 2, 0]}>
        <lineBasicMaterial ref={edgeMat} color="#8fb4ff" transparent opacity={0.25} />
      </lineSegments>
    </>
  );
}

/** The sun, its orbit rings and the starfield. */
function SolarSystem({ conductor, count }: { conductor: ViewTransition; count: number }) {
  const scenery = useMemo(() => createSolarScenery(MAX_FLUIDS), []);
  const live = useRef(count);
  useEffect(() => {
    live.current = count;
  }, [count]);
  useEffect(() => () => scenery.dispose(), [scenery]);
  useFrame(() => scenery.update(conductor.p, conductor.t, live.current));
  return <primitive object={scenery.group} />;
}

// ---------------------------------------------------------------------------
// camera, pointer input, cursor splash / grab, depth dimming
// ---------------------------------------------------------------------------

function Interaction({
  fluids,
  dimming,
  conductor,
}: {
  fluids: FluidEntry[];
  dimming: number;
  conductor: ViewTransition;
}) {
  const cursor = useRef<THREE.Mesh>(null);
  const { camera, gl, scene } = useThree();

  const live = useRef({ fluids, dimming });
  useEffect(() => {
    live.current = { fluids, dimming };
  }, [fluids, dimming]);

  const tmp = useMemo(
    () => ({
      ray: new THREE.Raycaster(),
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      target: new THREE.Vector3(),
    }),
    [],
  );

  // Interaction state lives in a ref so we never re-render React per pointer event.
  const input = useRef({
    theta: 0.7, // orbit azimuth, shared by both views
    phi: [1.15, 0.9], // polar angle, one per view
    dist: [3.4, 9], // camera distance, one per view
    dragging: false,
    grabbing: false,
    grabSim: null as FluidSim | null,
    grabPlane: new THREE.Plane(),
    inside: false,
    ndc: new THREE.Vector2(),
    prevNdc: new THREE.Vector2(),
    hasPrev: false,
    delta: new THREE.Vector2(),
    lastX: 0,
    lastY: 0,
  });

  // frame the whole system when the solar view is picked
  useEffect(() => {
    input.current.dist[1] = THREE.MathUtils.clamp(
      systemRadius(fluids.length) * 1.55 + 3.2,
      5,
      34,
    );
  }, [fluids.length]);

  useEffect(() => {
    const el = gl.domElement;
    const s = input.current;
    /** Which view's camera settings the pointer is editing. */
    const activeView = () => (conductor.headingToSolar ? 1 : 0);

    const setNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      s.ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };
    const down = (e: PointerEvent) => {
      // right click: everything stuck (in every fluid) turns back into fluid
      if (e.button === 2) {
        for (const f of live.current.fluids) f.sim.unpinAll();
        s.grabbing = false;
        s.grabSim = null;
        return;
      }
      if (e.button !== 0) return;
      setNdc(e);
      el.setPointerCapture(e.pointerId);

      // left click on a fluid grabs a globule of it (hold Shift to orbit instead).
      // Only in the tank: in the solar view a grabbed blob would fight its orbit.
      if (!e.shiftKey && conductor.p < 0.02) {
        tmp.ray.setFromCamera(s.ndc, camera);
        const o = tmp.ray.ray.origin;
        const d = tmp.ray.ray.direction;
        const target = pickFluid(live.current.fluids, o, d, grabRayRadius);
        const center = target?.sim.grab(
          [o.x, o.y, o.z],
          [d.x, d.y, d.z],
          grabRadius(target.sim),
          grabRayRadius(target.sim),
        );
        if (target && center) {
          // drag the globule on a plane facing the camera
          camera.getWorldDirection(tmp.normal);
          tmp.point.set(center[0], center[1], center[2]);
          s.grabPlane.setFromNormalAndCoplanarPoint(tmp.normal, tmp.point);
          s.grabbing = true;
          s.grabSim = target.sim;
          el.style.cursor = "grabbing";
          return;
        }
      }
      s.dragging = true;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      setNdc(e);
      s.inside = true;
      if (s.dragging) {
        const v = activeView();
        s.theta -= (e.clientX - s.lastX) * 0.007;
        s.phi[v] = THREE.MathUtils.clamp(
          s.phi[v] - (e.clientY - s.lastY) * 0.007,
          0.15,
          Math.PI / 2 - 0.02,
        );
        s.lastX = e.clientX;
        s.lastY = e.clientY;
        s.hasPrev = false;
      }
    };
    const up = (e: PointerEvent) => {
      if (s.grabbing) {
        s.grabSim?.releaseGrab(); // points stay pinned where they were let go
        s.grabbing = false;
        s.grabSim = null;
        el.style.cursor = "crosshair";
      }
      s.dragging = false;
      s.hasPrev = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      // touch has no hover, so stop splashing once the finger lifts
      if (e.pointerType !== "mouse") s.inside = false;
    };
    const leave = () => {
      if (!s.dragging) s.inside = false;
      s.hasPrev = false;
    };
    const noMenu = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = activeView();
      const [lo, hi] = v === 0 ? [1.8, 7] : [3, 45];
      s.dist[v] = THREE.MathUtils.clamp(s.dist[v] * Math.exp(e.deltaY * 0.001), lo, hi);
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", noMenu);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", noMenu);
    };
  }, [gl, camera, tmp, conductor]);

  useFrame(() => {
    const s = input.current;
    const e = easeInOutCubic(conductor.p);

    // ---- camera: eases from framing the tank to framing the whole system ----
    const dist = s.dist[0] + (s.dist[1] - s.dist[0]) * e;
    const phi = s.phi[0] + (s.phi[1] - s.phi[0]) * e;
    tmp.target.copy(TANK_CENTER).lerp(SUN_CENTER, e);
    const sp = Math.sin(phi);
    camera.position.set(
      tmp.target.x + dist * sp * Math.sin(s.theta),
      tmp.target.y + dist * Math.cos(phi),
      tmp.target.z + dist * sp * Math.cos(s.theta),
    );
    camera.lookAt(tmp.target);
    camera.updateMatrixWorld();
    // the solar system is far deeper than the tank, so the fade has to spread out
    updateFog(scene, dist, live.current.dimming, 2 + e * dist * 0.9);

    // ---- dragging a grabbed globule ----
    let hit: [number, number, number] | null = null;
    let cursorScale = 1;
    if (s.grabbing && s.grabSim) {
      tmp.ray.setFromCamera(s.ndc, camera);
      if (tmp.ray.ray.intersectPlane(s.grabPlane, tmp.point)) {
        hit = s.grabSim.moveGrab(tmp.point.x, tmp.point.y, tmp.point.z);
        cursorScale = grabRadius(s.grabSim) / 0.07;
      }
    }

    // ---- cursor splash (only the first fluid the cursor touches) ----
    if (!s.grabbing && s.inside && !s.dragging) {
      tmp.ray.setFromCamera(s.ndc, camera);
      const o = tmp.ray.ray.origin;
      const d = tmp.ray.ray.direction;
      if (s.hasPrev) s.delta.subVectors(s.ndc, s.prevNdc);
      else s.delta.set(0, 0);
      s.prevNdc.copy(s.ndc);
      s.hasPrev = true;

      const speed = s.delta.length();
      tmp.right.setFromMatrixColumn(camera.matrixWorld, 0);
      tmp.up.setFromMatrixColumn(camera.matrixWorld, 1);
      const G = 5 * dist;
      const push = Math.min(speed * G * 0.5, 1);
      const ix = tmp.right.x * s.delta.x * G + tmp.up.x * s.delta.y * G + d.x * push;
      const iy = tmp.right.y * s.delta.x * G + tmp.up.y * s.delta.y * G + d.y * push;
      const iz = tmp.right.z * s.delta.x * G + tmp.up.z * s.delta.y * G + d.z * push;
      const target = pickFluid(live.current.fluids, o, d, splashRadius);
      if (target) {
        hit = target.sim.splash(
          [o.x, o.y, o.z],
          [d.x, d.y, d.z],
          splashRadius(target.sim),
          [ix, iy, iz],
          0.25,
        );
      }
    }
    if (cursor.current) {
      cursor.current.visible = !!hit;
      if (hit) {
        cursor.current.position.set(hit[0], hit[1], hit[2]);
        cursor.current.scale.setScalar(cursorScale);
      }
    }
  });

  return (
    // where the cursor is touching the fluid
    <mesh ref={cursor} visible={false}>
      <sphereGeometry args={[0.07, 16, 16]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const tabs: { id: View; label: string }[] = [
    { id: "tank", label: "Tank" },
    { id: "solar", label: "Solar system" },
  ];
  return (
    <div
      role="tablist"
      aria-label="View"
      className="absolute left-1/2 top-5 flex -translate-x-1/2 select-none gap-1 rounded-full border border-white/15 bg-[#0b1226]/80 p-1 backdrop-blur"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          onClick={() => onChange(t.id)}
          className={
            "rounded-full px-4 py-1.5 text-sm transition duration-300 " +
            (view === t.id
              ? "bg-white/90 text-[#0b1226] shadow"
              : "text-white/60 hover:bg-white/10 hover:text-white")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Which planet is which, and how big it is. The groundwork for showing amounts. */
function SolarLegend({ fluids }: { fluids: FluidEntry[] }) {
  const total = fluids.reduce((a, f) => a + f.sim.count, 0) || 1;
  return (
    <div className="absolute right-5 top-5 w-64 select-none rounded-2xl border border-white/15 bg-[#0b1226]/80 p-4 text-white shadow-xl backdrop-blur">
      <h2 className="text-sm font-semibold tracking-tight">Planets</h2>
      <p className="mt-0.5 text-xs text-white/50">
        Each fluid becomes a world. Its size is the volume you gave it in the tank.
      </p>
      <ul className="mt-3 space-y-1.5">
        {fluids.map((f, i) => (
          <li key={f.id} className="flex items-center gap-2 text-xs">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ background: f.color, boxShadow: `0 0 10px ${f.color}` }}
            />
            <span className="w-14 shrink-0 text-white/80">Orbit {i + 1}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full transition-[width] duration-700"
                style={{ width: `${(f.sim.count / total) * 100}%`, background: f.color }}
              />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-white/45">
              {Math.round((f.sim.count / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] leading-snug text-white/35">
        Switch back to the tank to add worlds or change how much each one holds.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function FluidScene() {
  const nextId = useRef(1);
  const [fluids, setFluids] = useState<FluidEntry[]>(() => [createFluid(0, 0, FLUID_COLORS[0])]);
  const [dimming, setDimming] = useState(DEFAULT_DIMMING);
  const [overlapDimming, setOverlapDimming] = useState(DEFAULT_OVERLAP_DIMMING);
  const [view, setView] = useState<View>("tank");
  const overlap = useMemo(() => new OverlapField(), []);
  const conductor = useMemo(() => new ViewTransition(), []);
  const inTank = view === "tank";
  useEffect(() => {
    conductor.setTarget(view === "solar" ? 1 : 0);
  }, [conductor, view]);

  const addFluid = () => {
    if (fluids.length >= MAX_FLUIDS) return;
    const used = new Set(fluids.map((f) => f.color));
    const color =
      FLUID_COLORS.find((c) => !used.has(c)) ?? FLUID_COLORS[fluids.length % FLUID_COLORS.length];
    const entry = createFluid(nextId.current++, fluids.length, color);
    setFluids((prev) => [...prev, entry]);
  };
  const removeFluid = (id: number) =>
    setFluids((prev) => (prev.length > 1 ? prev.filter((f) => f.id !== id) : prev));
  const setColor = (id: number, color: string) =>
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, color } : f)));
  const applySurface = (id: number, expr: string, fn: SurfaceFn) => {
    fluids.find((f) => f.id === id)?.sim.setSurface(fn);
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, expr } : f)));
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#070b17]">
      <Canvas
        camera={{ fov: 45, near: 0.1, far: 250, position: [2, 2, 3] }}
        dpr={[1, 2]}
        style={{ touchAction: "none", cursor: "crosshair" }}
      >
        <color attach="background" args={[BG]} />
        <fog attach="fog" args={[BG, 3, 8]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 5, 2]} intensity={2.2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#7aa7ff" />
        <SimDriver
          fluids={fluids}
          conductor={conductor}
          overlap={overlap}
          overlapDimming={overlapDimming}
        />
        <Tank conductor={conductor} />
        <SolarSystem conductor={conductor} count={fluids.length} />
        <OverlapUpdater fluids={fluids} overlap={overlap} />
        {fluids.map((f) => (
          <FluidLayer key={f.id} fluid={f} overlap={overlap} />
        ))}
        <Interaction fluids={fluids} dimming={dimming} conductor={conductor} />
      </Canvas>

      <ViewTabs view={view} onChange={setView} />

      <div className="pointer-events-none absolute left-5 top-5 max-w-sm select-none text-white/80">
        <h1 className="text-lg font-semibold tracking-tight">
          {inTank ? "3D Fluid" : "Your system"}
        </h1>
        <p className="mt-1 text-sm text-white/50 transition-opacity duration-500">
          {inTank
            ? "Move to splash · drag a fluid to grab a blob · right-click to melt it back · drag empty space (or hold Shift) to rotate · scroll to zoom"
            : "Every fluid has balled up into a world of the same dots. Drag to rotate · scroll to zoom · move the cursor to disturb a planet."}
        </p>
      </div>

      <div className="absolute bottom-5 left-5 flex select-none flex-col gap-2">
        {(
          [
            ["Depth dimming", dimming, setDimming],
            ["Overlap dimming", overlapDimming, setOverlapDimming],
          ] as const
        ).map(([label, value, set]) => (
          <label
            key={label}
            className="flex items-center justify-between gap-3 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur"
          >
            {label}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={value}
              onChange={(e) => set(parseFloat(e.target.value))}
              aria-label={label}
              className="w-28 accent-sky-400"
            />
          </label>
        ))}
      </div>

      {/* the panels cross-fade with the view (opacity only: a transform here would
          re-anchor the absolutely-positioned panels inside) */}
      <div
        className={
          "transition-opacity duration-500 " +
          (inTank ? "opacity-100" : "pointer-events-none opacity-0")
        }
      >
        <SurfacePanel
          fluids={fluids}
          maxFluids={MAX_FLUIDS}
          onAdd={addFluid}
          onRemove={removeFluid}
          onColor={setColor}
          onApply={applySurface}
        />
        <button
          onClick={() => fluids.forEach((f) => f.sim.reset())}
          className="absolute bottom-5 right-5 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur transition hover:bg-white/20"
        >
          Drop new water
        </button>
      </div>
      <div
        className={
          "transition-opacity duration-500 " +
          (inTank ? "pointer-events-none opacity-0" : "opacity-100")
        }
      >
        <SolarLegend fluids={fluids} />
      </div>
    </div>
  );
}
