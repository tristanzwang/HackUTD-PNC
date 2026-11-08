"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
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
  orbitPhase,
  orbitRadius,
  orbitSpeed,
  orbitTilt,
  spinAxis,
  spinRate,
  systemRadius,
} from "@/lib/solar-system";
import { Spring, glide } from "@/lib/spring";
import { SurfaceSkin } from "@/lib/surface-skin";
import { Flourish, Orb, PageFrame } from "./Ornaments";
import { buildFinanceScene, type FinanceScene } from "@/lib/finance/graph-data";
import { DEFAULT_PRIORITY, INFLATION, formatUSD, orbitOrder } from "@/lib/finance/scene-bridge";
import type { CategoryKey, PersonaId } from "@/lib/finance/synth";
import { Scrub } from "@/lib/finance/scrub";
import { gridToWorldSurface } from "@/lib/units";
import CategoryPanel from "./CategoryPanel";
import { AgentStatus, ControlCenter, PlutoChat, ScenarioBanner, Scrubber } from "./FinanceUI";
import { applyScenario, runLength, type Scenario } from "@/lib/finance/scenario";
import type { Projection } from "@/lib/finance/projection";
import { setVolume as setAudioVolume, sfxUnwarp, sfxWarp, startAmbient } from "@/lib/sfx";
import SurfacePanel from "./SurfacePanel";
import { useProjection } from "./useProjection";
import { CHIP, FOCUS, GLASS, PRESS, collapsible } from "./ui";

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
/** How strongly points buried below the top surface are dimmed (0 = not at all). */
const DEFAULT_UNDER_DIMMING = 0.85;
const TANK_CENTER = new THREE.Vector3(0, (TANK.maxY - TANK.minY) * 0.3, 0);
const SUN_CENTER = new THREE.Vector3(0, 0, 0);
/** Camera zoom spring: snappy, never bouncy. */
const ZOOM_RESPONSE = 0.28;
/** A camera flick this slow (rad/s) has stopped. */
const GLIDE_STOP = 0.02;
/** Release velocity only counts if the pointer was still moving this recently (ms). */
const FLICK_WINDOW = 90;
/** How much tighter a planet's dots sit than the same water does in the tank. */
const ORBIT_PACKING = 0.65;
const ORBIT_GLIDE_TAU = 0.45; // seconds; how fast a planet eases to a new orbit on reorder
// How strongly a unit of yearly inflation dissolves a planet's sun-facing dots.
// Tuned so the effect reads over ~10s of spin without erasing the planet. Tunable.
const INFLATION_DISSOLVE = 9;

// cursor reach scales with a fluid's particle spacing so sparse fluids stay grabbable
const splashRadius = (sim: FluidSim) => Math.max(0.16, 1.8 * sim.spacing);
const grabRadius = (sim: FluidSim) => Math.max(0.22, 2.3 * sim.spacing); // size of the globule you pick up
// Straight down (phi 0) would make the camera's up vector degenerate, so stop a hair short.
const TOP_DOWN = 0.03;
const PHI_MIN = 0.02;
const PHI_MAX = Math.PI / 2 - 0.02;
const activeViewOf = (c: ViewTransition) => (c.headingToSolar ? 1 : 0);
const grabRayRadius = (sim: FluidSim) => Math.max(0.12, 1.3 * sim.spacing);

export type View = "graph" | "solar";

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
  under: Float32Array, // per-point multiplier (dims points buried below the top surface)
) {
  const { vel, pos } = sim;
  const {
    pointGeo,
    pointColors,
    lineGeo,
    linePos,
    lineCol,
    linkIdx,
    linkStretch,
  } = buffers;

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
        .multiplyScalar(brightness[i] * under[i]);
    }
    pc[j] = c.r;
    pc[j + 1] = c.g;
    pc[j + 2] = c.b;
  }
  pointColors.needsUpdate = true;
  (pointGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate =
    true;

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
    const bothStuck =
      sim.pinned[linkIdx[l * 2]] && sim.pinned[linkIdx[l * 2 + 1]];
    // a stretched link thins out the further it reaches, so the blob melts into the surface
    const dim =
      (bothStuck ? 1 : LINK_DIM) * (1 - STRETCH_FADE * linkStretch[l]);
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
function syncDrawState(
  geo: THREE.BufferGeometry,
  mat: THREE.PointsMaterial | null,
  sim: FluidSim,
) {
  geo.setDrawRange(0, sim.count);
  if (mat) mat.size = pointSize(sim);
}

/**
 * Inflation: dim a planet's sun-facing dots so they dissolve, then re-brighten as
 * the ball spins them back round — the sun is inflation. Pure render (it only
 * scales the per-dot shading in `under`), so it can't destabilise or strip points.
 * Only acts in the orbit view (orbitBlend > 0), scaled by the category's rate.
 */
function dissolveSunward(sim: FluidSim, under: Float32Array, inflation: number) {
  if (inflation <= 0 || sim.orbitBlend <= 0.05) return;
  const cx = sim.orbitX, cy = sim.orbitY, cz = sim.orbitZ;
  const clen = Math.hypot(cx, cy, cz) || 1;
  const sx = -cx / clen, sy = -cy / clen, sz = -cz / clen; // unit vector toward the sun
  const reach = sim.ballRadius || 1;
  const strength = Math.min(0.9, inflation * INFLATION_DISSOLVE) * sim.orbitBlend;
  const p = sim.pos;
  for (let i = 0, n = sim.count; i < n; i++) {
    const progress =
      ((p[i * 3] - cx) * sx + (p[i * 3 + 1] - cy) * sy + (p[i * 3 + 2] - cz) * sz) / reach;
    if (progress > 0) under[i] *= 1 - strength * Math.min(progress, 1);
  }
}

/**
 * Depth dimming: fog runs from just in front of the subject to just behind it,
 * so points far from the camera fade into the background. `amount` is 0..1.
 */
function updateFog(
  scene: THREE.Scene,
  camDist: number,
  amount: number,
  spread: number,
) {
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
  scrub,
  orbitTargets,
}: {
  fluids: FluidEntry[];
  conductor: ViewTransition;
  overlap: OverlapField;
  overlapDimming: number;
  scrub: Scrub;
  orbitTargets: number[];
}) {
  const acc = useRef(0);
  const live = useRef({ fluids, overlapDimming, orbitTargets });
  useEffect(() => {
    live.current = { fluids, overlapDimming, orbitTargets };
  }, [fluids, overlapDimming, orbitTargets]);
  // per-planet eased orbit index + integrated angle, keyed by fluid id, so a
  // priority change glides the radius without snapping the orbital angle
  const orbits = useRef(new Map<number, { idx: number; angle: number }>());
  const tmp = useMemo(
    () => ({ orbit: [0, 0, 0] as [number, number, number] }),
    [],
  );
  const axes = useMemo(
    () => Array.from({ length: MAX_FLUIDS }, (_, i) => spinAxis(i)),
    [],
  );

  useFrame((_, delta) => {
    const d = Math.min(delta, 0.05);
    const c = conductor;
    const { fluids: list } = live.current;

    const { gather, launch } = c.advance(d);
    const alive = c.p === 0 ? undefined : new Set(list.map((f) => f.id));
    c.forget(alive);
    // drop remembered orbits for fluids that are gone (mirrors conductor.forget)
    if (!alive) orbits.current.clear();
    else for (const id of orbits.current.keys()) if (!alive.has(id)) orbits.current.delete(id);

    const { orbitTargets: targets } = live.current;
    list.forEach((f, i) => {
      const sim = f.sim;
      sim.orbitBlend = gather;
      // The ball condenses as it forms, so planets are denser than their pools. A
      // finance planet is sized so its volume matches what its category is worth at
      // the scrubbed month (radius = packing x its natural radius).
      const orbitPacking = f.data
        ? Math.min(Math.max(f.data.radiusAt(scrub.k) / sim.tankBallRadius, 0.2), 1.4)
        : ORBIT_PACKING;
      sim.setPacking(1 - (1 - orbitPacking) * gather);
      if (c.p === 0) return;

      // the ball forms right where the water already is, then sets off
      const { home, fresh } = c.home(f.id, () => sim.centroid([0, 0, 0]));
      if (fresh) {
        sim.orbitX = home[0];
        sim.orbitY = home[1];
        sim.orbitZ = home[2];
        sim.unpinAll(); // stuck points would otherwise ride along frozen
      }
      // ease this planet's orbit index toward its priority target and integrate
      // the angle, so a reorder glides the radius instead of teleporting it
      const target = targets[i] ?? i;
      let ob = orbits.current.get(f.id);
      if (!ob) {
        ob = { idx: target, angle: orbitPhase(target) };
        orbits.current.set(f.id, ob);
      }
      ob.idx += (target - ob.idx) * (1 - Math.exp(-d / ORBIT_GLIDE_TAU));
      ob.angle += orbitSpeed(ob.idx) * d;
      const rr = orbitRadius(ob.idx);
      const tl = orbitTilt(ob.idx);
      const zz = rr * Math.sin(ob.angle);
      tmp.orbit[0] = rr * Math.cos(ob.angle);
      tmp.orbit[1] = -zz * Math.sin(tl);
      tmp.orbit[2] = zz * Math.cos(tl);
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

function FluidLayer({
  fluid,
  overlap,
  underDimming,
  emphasis,
  declutter,
  inflation,
}: {
  fluid: FluidEntry;
  overlap: OverlapField;
  underDimming: number;
  /** 1 = normal; lower pushes this graph into the background while another is the focus. */
  emphasis: number;
  /** Hide the point cloud and the links, leaving just the translucent surface plane. */
  declutter: boolean;
  /** Per-category yearly inflation; dissolves this planet's sun-facing dots in the orbit view. */
  inflation: number;
}) {
  const { sim, color } = fluid;
  const buffers = useMemo(() => createBuffers(sim), [sim]);
  const brightness = useMemo(
    () => new Float32Array(sim.capacity).fill(1),
    [sim],
  );
  const under = useMemo(() => new Float32Array(sim.capacity).fill(1), [sim]);
  const fade = useRef(1); // eases toward `emphasis`, so a change of focus is not a cut
  const declutterFade = useRef(0); // eases toward `declutter`, so dots/lines dissolve smoothly
  const pointsMat = useRef<THREE.PointsMaterial>(null);
  const lineMat = useRef<THREE.LineBasicMaterial>(null);
  // a translucent skin over the top layer of points, so the graph's shape reads at a glance
  const skin = useMemo(() => new SurfaceSkin(), []);
  useEffect(() => skin.setColor(color), [skin, color]);
  useEffect(() => () => skin.dispose(), [skin]);
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
    // the skin goes first: it finds the surface that the points below are dimmed against
    fade.current += (emphasis - fade.current) * 0.14;
    skin.setEmphasis(fade.current);
    skin.update(sim);
    skin.shade(sim, under, underDimming, fade.current);
    dissolveSunward(sim, under, inflation);
    updateLattice(
      sim,
      buffers,
      colors.c,
      colors.deep,
      colors.foam,
      brightness,
      under,
    );
    syncDrawState(buffers.pointGeo, pointsMat.current, sim);
    // declutter: dissolve the dots (shrink + fade) and the links, leaving the
    // clean surface plane. Eased so the clutter animates away rather than popping.
    declutterFade.current += ((declutter ? 1 : 0) - declutterFade.current) * 0.1;
    const vis = 1 - declutterFade.current;
    if (pointsMat.current) {
      pointsMat.current.size = pointSize(sim) * vis;
      pointsMat.current.opacity = vis;
    }
    if (lineMat.current) lineMat.current.opacity = 0.55 * vis;
  });

  return (
    <>
      <primitive object={skin.mesh} />
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
        <lineBasicMaterial
          ref={lineMat}
          vertexColors
          transparent
          opacity={0.55}
          depthWrite={false}
        />
      </lineSegments>
    </>
  );
}

/** Rebuilds the fluid-overlap grid each frame (mounted before the layers so they read a fresh one). */
function OverlapUpdater({
  fluids,
  overlap,
}: {
  fluids: FluidEntry[];
  overlap: OverlapField;
}) {
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
function Tank({
  conductor,
  scene,
}: {
  conductor: ViewTransition;
  scene: FinanceScene | null;
}) {
  // with finance data the axes read months, dollars and low-to-high, with a "today" line
  const grid = useMemo(
    () =>
      createCoordinateGrid(
        TANK,
        scene ? { labels: scene.labels, today: scene.todayFraction } : {},
      ),
    [scene],
  );
  useEffect(() => () => grid.dispose(), [grid]);
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
        <lineBasicMaterial
          ref={edgeMat}
          color="#dfe8ff"
          transparent
          opacity={0.25}
        />
      </lineSegments>
    </>
  );
}

/** The sun, its orbit rings and the starfield. */
function SolarSystem({
  conductor,
  count,
}: {
  conductor: ViewTransition;
  count: number;
}) {
  const scenery = useMemo(() => createSolarScenery(MAX_FLUIDS), []);
  const live = useRef(count);
  useEffect(() => {
    live.current = count;
  }, [count]);
  useEffect(() => () => scenery.dispose(), [scenery]);
  useFrame(({ camera }) =>
    scenery.update(
      conductor.p,
      conductor.t,
      live.current,
      camera as THREE.PerspectiveCamera,
    ),
  );
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
  const aspect = useThree((st) => st.size.width / st.size.height);

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
    phi: [1.15, TOP_DOWN], // polar angle, one per view (the solar view always opens top-down)
    zoom: [new Spring(3.4, ZOOM_RESPONSE), new Spring(9, ZOOM_RESPONSE)], // camera distance, one per view
    wasSolar: false,
    homing: false, // the camera is swinging up to the top-down view
    phiHome: new Spring(TOP_DOWN, 0.7),
    vTheta: 0, // camera angular velocity (rad/s): carried into a glide on release
    vPhi: 0,
    lastMoveT: 0,
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
    // The solar view looks straight down, so the outermost orbit has to fit the
    // screen's *shorter* side (the vertical one on a wide window), planet and all.
    const halfFov = THREE.MathUtils.degToRad(
      (camera as THREE.PerspectiveCamera).fov / 2,
    );
    const reach = systemRadius(fluids.length) + 0.9;
    const fit = (reach * 1.1) / (Math.tan(halfFov) * Math.min(1, aspect));
    input.current.zoom[1].to(THREE.MathUtils.clamp(fit, 5, 44));
  }, [fluids.length, aspect, camera]);

  useEffect(() => {
    const el = gl.domElement;
    const s = input.current;
    /** Which view's camera settings the pointer is editing. */
    const activeView = () => activeViewOf(conductor);

    const setNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      s.ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };
    const down = (e: PointerEvent) => {
      // touching the scene stops any glide dead, like catching a spinning globe
      s.vTheta = 0;
      s.vPhi = 0;
      s.homing = false;
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
      s.lastMoveT = e.timeStamp;
    };
    const move = (e: PointerEvent) => {
      setNdc(e);
      s.inside = true;
      if (s.dragging) {
        const v = activeView();
        const dTheta = -(e.clientX - s.lastX) * 0.007;
        const wanted = s.phi[v] - (e.clientY - s.lastY) * 0.007;
        const phi = THREE.MathUtils.clamp(wanted, PHI_MIN, PHI_MAX);
        // track velocity (smoothed) so a flick can carry on after release
        const dt = Math.max(e.timeStamp - s.lastMoveT, 1) / 1000;
        s.vTheta += (dTheta / dt - s.vTheta) * 0.4;
        s.vPhi += ((phi - s.phi[v]) / dt - s.vPhi) * 0.4;
        s.lastMoveT = e.timeStamp;
        s.theta += dTheta;
        s.phi[v] = phi;
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
      // a pause before release means "stop here"; otherwise the camera coasts on
      if (e.timeStamp - s.lastMoveT > FLICK_WINDOW) {
        s.vTheta = 0;
        s.vPhi = 0;
      }
      s.dragging = false;
      s.hasPrev = false;
      if (el.hasPointerCapture(e.pointerId))
        el.releasePointerCapture(e.pointerId);
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
      // scroll sets where the zoom is heading; the spring carries the camera there
      const z = s.zoom[v];
      z.to(z.target * Math.exp(e.deltaY * 0.001));
      z.clamp(lo, hi);
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

  useFrame((_, delta) => {
    const s = input.current;
    const dt = Math.min(delta, 0.1);
    // the transition is already a spring, so progress is used as-is
    const e = conductor.p;

    // ---- entering the solar system always swings the camera to look straight down ----
    const solar = conductor.headingToSolar;
    if (solar && !s.wasSolar) {
      s.phiHome.snap(s.phi[1]);
      s.phiHome.to(TOP_DOWN);
      s.homing = true;
      s.vPhi = 0;
    }
    s.wasSolar = solar;
    if (s.homing && !s.dragging) {
      s.phi[1] = s.phiHome.advance(dt);
      if (s.phiHome.settled) s.homing = false;
    }

    // ---- a released drag coasts to a stop, at scroll-deceleration rate ----
    if (!s.dragging && (s.vTheta !== 0 || s.vPhi !== 0)) {
      const v = activeViewOf(conductor);
      s.theta += s.vTheta * dt;
      const phi = THREE.MathUtils.clamp(
        s.phi[v] + s.vPhi * dt,
        PHI_MIN,
        PHI_MAX,
      );
      if (phi !== s.phi[v] + s.vPhi * dt) s.vPhi = 0; // hit the pole: stop that axis
      s.phi[v] = phi;
      s.vTheta = glide(s.vTheta, dt);
      s.vPhi = glide(s.vPhi, dt);
      if (Math.abs(s.vTheta) < GLIDE_STOP) s.vTheta = 0;
      if (Math.abs(s.vPhi) < GLIDE_STOP) s.vPhi = 0;
    }

    // ---- camera: eases from framing the tank to framing the whole system ----
    const d0 = s.zoom[0].advance(dt);
    const d1 = s.zoom[1].advance(dt);
    const dist = d0 + (d1 - d0) * e;
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
      const ix =
        tmp.right.x * s.delta.x * G + tmp.up.x * s.delta.y * G + d.x * push;
      const iy =
        tmp.right.y * s.delta.x * G + tmp.up.y * s.delta.y * G + d.y * push;
      const iz =
        tmp.right.z * s.delta.x * G + tmp.up.z * s.delta.y * G + d.z * push;
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
      <meshBasicMaterial
        color="#ffffff"
        transparent
        opacity={0.35}
        depthWrite={false}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

/** Segmented control with an indicator that glides between the two views. */
function ViewTabs({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  const tabs: { id: View; label: string }[] = [
    { id: "graph", label: "Sandbox" },
    { id: "solar", label: "Galaxy" },
  ];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // arrow keys move between tabs, as in any native segmented control
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: View = view === "graph" ? "solar" : "graph";
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="rise pointer-events-none absolute inset-x-0 top-5 flex items-center justify-center gap-3 px-8">
      <Flourish side="left" />
      <div
        role="tablist"
        aria-label="View"
        onKeyDown={onKeyDown}
        className={
          "pointer-events-auto relative grid select-none grid-cols-2 rounded-full p-1 " +
          GLASS
        }
      >
        <span
          aria-hidden
          className={
            "absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full " +
            "bg-white/90 " +
            "shadow-[0_1px_8px_rgba(0,0,0,0.35)] transition-[translate] duration-500 " +
            "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:duration-150 " +
            (view === "solar" ? "translate-x-full" : "")
          }
        />
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            role="tab"
            aria-selected={view === t.id}
            tabIndex={view === t.id ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={
              "relative z-10 rounded-full px-6 py-1.5 text-[1.05rem] font-semibold tracking-[0.02em] " +
              "transition-colors duration-300 active:opacity-70 " +
              FOCUS +
              " " +
              (view === t.id
                ? "text-[#0b1226]"
                : "text-white/65 hover:text-white")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <Flourish side="right" />
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-base text-white/80">
        {label}
        <span className="tabular-nums font-normal text-white/40">
          {Math.round(value * 100)}
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
        className="slider mt-1.5 w-full"
        style={{ "--fill": `${value * 100}%` } as CSSProperties}
      />
    </label>
  );
}

/**
 * One settings menu, bottom right: the two dimming sliders and the reset button.
 * The card grows upward from its header. Reset only exists in the graph view.
 */
function SettingsMenu(props: {
  inGraph: boolean;
  dimming: number;
  onDimming: (v: number) => void;
  overlapDimming: number;
  onOverlapDimming: (v: number) => void;
  underDimming: number;
  onUnderDimming: (v: number) => void;
  declutter: boolean;
  onDeclutter: (v: boolean) => void;
  volume: number;
  onVolume: (v: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div
      className={
        "rise absolute bottom-5 right-5 flex select-none flex-col-reverse overflow-hidden " +
        "rounded-[1.75rem] text-white transition-[width] duration-500 " +
        "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:duration-150 " +
        (open ? "w-64 " : "w-10 ") +
        GLASS
      }
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Settings"
        title="Settings"
        className={
          // icon-only, pinned to the right edge so it stays put as the card widens
          "flex h-10 w-full items-center justify-end px-3 text-white/85 " +
          "transition-colors hover:bg-white/[0.06] hover:text-white active:bg-white/10 " +
          FOCUS
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0"
        >
          {/* Lucide "settings" gear — the standard preferences glyph */}
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <div id={panelId} className={collapsible(open)} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-3.5 px-4 pb-3 pt-4">
            <Slider
              label="Sound"
              value={props.volume}
              onChange={props.onVolume}
            />
            <Slider
              label="Depth dimming"
              value={props.dimming}
              onChange={props.onDimming}
            />
            <Slider
              label="Overlap dimming"
              value={props.overlapDimming}
              onChange={props.onOverlapDimming}
            />
            <Slider
              label="Below-surface dimming"
              value={props.underDimming}
              onChange={props.onUnderDimming}
            />
            <div className={collapsible(props.inGraph)} inert={!props.inGraph}>
              <div className="min-h-0 space-y-3 overflow-hidden">
                <div className="flex items-center justify-between pt-0.5">
                  <span className="text-base text-white/85">Declutter</span>
                  <button
                    role="switch"
                    aria-checked={props.declutter}
                    aria-label="Hide sandbox chrome"
                    onClick={() => props.onDeclutter(!props.declutter)}
                    className={
                      "relative h-6 w-11 rounded-full transition-colors duration-200 " +
                      (props.declutter ? "bg-sky-400/80" : "bg-white/15") +
                      " " +
                      PRESS +
                      " " +
                      FOCUS
                    }
                  >
                    <span
                      aria-hidden
                      className={
                        "absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow " +
                        "transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] " +
                        (props.declutter ? "translate-x-5" : "translate-x-0")
                      }
                    />
                  </button>
                </div>
                <button
                  onClick={props.onReset}
                  className={
                    "w-full rounded-full px-4 py-1.5 text-base font-semibold " +
                    "tracking-[0.02em] text-white " +
                    CHIP +
                    " " +
                    PRESS +
                    " " +
                    FOCUS
                  }
                >
                  Reset points
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The compact legend: one glowing orb per fluid, always on screen. In the tank, an
 * orb opens that fluid's sidebar; a rune button adds another fluid.
 */
function FluidDock({
  fluids,
  selectedId,
  panelOpen,
  inGraph,
  maxFluids,
  onSelect,
  onAdd,
}: {
  fluids: FluidEntry[];
  selectedId: number;
  panelOpen: boolean;
  inGraph: boolean;
  maxFluids: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}) {
  const full = fluids.length >= maxFluids;
  // finance categories can be opened in either view; hand-made graphs only in the graph view
  const finance = fluids.some((f) => f.data);
  const canOpen = inGraph || finance;
  const canAdd = inGraph && !finance;
  return (
    <div
      role="group"
      aria-label="Graphs"
      className={
        "rise absolute right-5 top-5 flex select-none items-center rounded-full p-1 " +
        GLASS
      }
    >
      {fluids.map((f, i) => {
        const on = canOpen && panelOpen && f.id === selectedId;
        const name = f.data ? f.data.label : `Graph ${i + 1}`;
        return (
          <button
            key={f.id}
            onClick={() => onSelect(f.id)}
            inert={!canOpen}
            aria-label={name}
            aria-pressed={on}
            title={f.data ? `${name} · ${formatUSD(f.data.amountAt(0))}` : inGraph ? `${name}: edit` : name}
            className={
              "flex items-center justify-center rounded-full p-0.5 " +
              PRESS +
              " " +
              FOCUS +
              " hover:bg-white/[0.07]"
            }
          >
            <Orb color={f.color} selected={on} size={18} />
          </button>
        );
      })}
      {/* the add rune folds away in the solar view */}
      <div
        inert={!canAdd}
        className={
          "grid transition-[grid-template-columns,opacity] duration-500 " +
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:duration-150 " +
          (canAdd
            ? "grid-cols-[1fr] opacity-100"
            : "grid-cols-[0fr] opacity-0")
        }
      >
        <div className="min-w-0 overflow-hidden">
          <button
            onClick={onAdd}
            disabled={full}
            aria-label="Add graph"
            title={full ? `Maximum of ${maxFluids} graphs` : "Add a graph"}
            className={
              "ml-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-full border border-dashed " +
              "border-white/45 text-white enabled:hover:bg-white/15 disabled:opacity-35 " +
              PRESS +
              " " +
              FOCUS
            }
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path
                d="M6 1v10M1 6h10"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function FluidScene() {
  const nextId = useRef(1);
  const [fluids, setFluids] = useState<FluidEntry[]>(() => [
    createFluid(0, 0, FLUID_COLORS[0]),
  ]);
  const [dimming, setDimming] = useState(DEFAULT_DIMMING);
  const [overlapDimming, setOverlapDimming] = useState(DEFAULT_OVERLAP_DIMMING);
  const [underDimming, setUnderDimming] = useState(DEFAULT_UNDER_DIMMING);
  const [view, setView] = useState<View>("graph");
  const [declutter, setDeclutter] = useState(false); // hide sandbox chrome for a clean view
  const [volume, setVolume] = useState(0.35); // master audio volume (Settings)
  const [selectedId, setSelectedId] = useState(fluids[0].id);
  const [panelOpen, setPanelOpen] = useState(false); // the sidebar opens from the legend
  const overlap = useMemo(() => new OverlapField(), []);
  const conductor = useMemo(() => new ViewTransition(), []);
  const inGraph = view === "graph";
  const sandboxClean = declutter && inGraph; // decluttered sandbox: decorative chrome hidden

  // ---- the user's finances: read, forecast, and turned into graphs and planets ----
  const [persona, setPersona] = useState<PersonaId>("tristan"); // demo dataset toggle
  const projection = useProjection(persona);
  const realData = projection.data;
  // a hypothetical overlay built by applyScenario; the real projection is never touched
  const [overlay, setOverlay] = useState<
    { projection: Projection; label: string; delta: number; run: number } | null
  >(null);
  const activeData = overlay ? overlay.projection : realData;
  const scene = useMemo(
    // a scenario overlay is sized against the real projection, so normal planets
    // keep their size and only the changed category balloons
    () => (activeData ? buildFinanceScene(activeData, realData ?? activeData) : null),
    [activeData, realData],
  );
  const scrub = useMemo(() => new Scrub(), []);
  const DEFAULT_SCRUB_MONTHS = 24; // the scrubber's default range; scenarios extend it to their run
  const savedScrub = useRef(0); // scrub position to restore when leaving a scenario

  const enterScenario = (s: Scenario) => {
    if (!realData) return;
    const proj = applyScenario(realData, s);
    const run = runLength(realData, s);
    const delta = proj.summary.netWorth[run] - realData.summary.netWorth[run];
    savedScrub.current = scrub.get();
    setOverlay({ projection: proj, label: s.label, delta, run });
    scrub.set(run); // jump to the end of the run so the effect is visible at once
    sfxWarp();
  };
  const exitScenario = () => {
    if (!overlay) return;
    scrub.set(savedScrub.current); // restore the previous scrub position
    setOverlay(null);
    sfxUnwarp();
  };
  const switchPersona = (id: PersonaId) => {
    if (id === persona) return;
    if (overlay) {
      scrub.set(savedScrub.current);
      setOverlay(null); // a scenario belongs to the old dataset; drop it
    }
    setPersona(id);
  };
  // Escape also leaves the hypothetical
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        scrub.set(savedScrub.current);
        setOverlay(null);
        sfxUnwarp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, scrub]);

  // audio: push the volume setting to the engine, and start the ambient bed on
  // the first user gesture (browsers won't let it autoplay before then)
  useEffect(() => {
    setAudioVolume(volume);
  }, [volume]);
  useEffect(() => {
    const go = () => {
      startAmbient();
      setAudioVolume(volume);
    };
    window.addEventListener("pointerdown", go, { once: true });
    return () => window.removeEventListener("pointerdown", go);
  }, [volume]);
  // what the user protects first; orbit radius follows this (React state only)
  const [priority, setPriority] = useState<CategoryKey[]>(DEFAULT_PRIORITY);
  // target orbit index per fluid (by array position), from the current priority
  const orbitTargets = useMemo(() => {
    const keys = fluids.map((f) => f.data?.key).filter(Boolean) as CategoryKey[];
    const order = orbitOrder(keys, priority);
    return fluids.map((f, i) => (f.data ? order.get(f.data.key) ?? i : i));
  }, [fluids, priority]);
  // Pluto can set the whole order; dedupe and backfill any it left out so all
  // eight planets are always present.
  const setPriorityOrder = (order: CategoryKey[]) =>
    setPriority((prev) => {
      const seen = new Set<CategoryKey>();
      const next = [...order, ...prev].filter((k) => prev.includes(k) && !seen.has(k) && seen.add(k));
      return next.length === prev.length ? next : prev;
    });
  const movePriority = (key: CategoryKey, dir: -1 | 1) =>
    setPriority((prev) => {
      const i = prev.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const fluidsRef = useRef(fluids);
  const syncedVersion = useRef<string | null>(null);
  useEffect(() => {
    fluidsRef.current = fluids;
  }, [fluids]);
  // Turn a scene into graphs. Two cases:
  //  - same categories, new numbers (a scenario overlay, or a refreshed forecast):
  //    swap each fluid's data so radiusAt follows the new scene. The pool surface
  //    is only reshaped in the graph view; in the solar view that refill would yank
  //    a planet off its orbit, and planet size there comes from radiusAt anyway —
  //    so a scenario is visible on the planets without waiting to return to graphs.
  //  - different categories (first load): a full rebuild, which refills pools, so
  //    it is deferred until the graph view.
  useEffect(() => {
    if (!scene) return;
    const prev = fluidsRef.current;
    const sameKeys =
      prev.length === scene.graphs.length &&
      prev.every((f, i) => f.data?.key === scene.graphs[i].key);

    if (sameKeys) {
      const next = prev.map((f, i) => {
        const g = scene.graphs[i];
        if (inGraph) f.sim.setSurface(gridToWorldSurface(g.surface));
        return { ...f, expr: g.label, data: g };
      });
      setFluids(next);
      if (inGraph) syncedVersion.current = scene.version; // surface only truly synced in graphs
      return;
    }

    if (!inGraph || syncedVersion.current === scene.version) return;
    syncedVersion.current = scene.version;
    const next = scene.graphs.map((g) => {
      const entry = createFluid(1000 + g.orbit, g.slot, FLUID_COLORS[g.orbit % FLUID_COLORS.length]);
      entry.sim.setSurface(gridToWorldSurface(g.surface));
      return { ...entry, expr: g.label, data: g };
    });
    setFluids(next);
    setSelectedId((id) => (next.some((f) => f.id === id) ? id : next[0].id));
  }, [scene, inGraph]);
  useEffect(() => {
    conductor.setTarget(view === "solar" ? 1 : 0);
  }, [conductor, view]);

  // reduced motion: the view change becomes a quick dissolve instead of a flight
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => conductor.setReducedMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [conductor]);

  const addFluid = () => {
    if (fluids.length >= MAX_FLUIDS) return;
    const used = new Set(fluids.map((f) => f.color));
    const color =
      FLUID_COLORS.find((c) => !used.has(c)) ??
      FLUID_COLORS[fluids.length % FLUID_COLORS.length];
    const entry = createFluid(nextId.current++, fluids.length, color);
    setFluids((prev) => [...prev, entry]);
    // a freshly summoned fluid opens straight to its settings
    setSelectedId(entry.id);
    setPanelOpen(true);
  };
  const removeFluid = (id: number) => {
    setFluids((prev) =>
      prev.length > 1 ? prev.filter((f) => f.id !== id) : prev,
    );
    setPanelOpen(false);
  };
  // clicking the open fluid's orb again folds the sidebar away
  const selectFluid = (id: number) => {
    setPanelOpen(!(panelOpen && id === selectedId));
    setSelectedId(id);
  };
  const selectedIndex = Math.max(
    0,
    fluids.findIndex((f) => f.id === selectedId),
  );
  const selected = fluids[selectedIndex];
  // in the graph view the open category stands out and the rest recede
  const focusId = panelOpen && inGraph && selected.data ? selected.id : null;
  const closePanel = () => setPanelOpen(false);
  const setColor = (id: number, color: string) =>
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, color } : f)));
  const applySurface = (id: number, expr: string, fn: SurfaceFn) => {
    fluids.find((f) => f.id === id)?.sim.setSurface(fn);
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, expr } : f)));
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#070b17] font-serif">
      <div className="fade-in absolute inset-0">
        <Canvas
          camera={{ fov: 45, near: 0.1, far: 250, position: [2, 2, 3] }}
          dpr={[1, 2]}
          style={{ touchAction: "none", cursor: "crosshair" }}
        >
          <color attach="background" args={[BG]} />
          <fog attach="fog" args={[BG, 3, 8]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[3, 5, 2]} intensity={2.2} />
          <directionalLight
            position={[-3, 2, -2]}
            intensity={0.6}
            color="#7aa7ff"
          />
          <SimDriver
            fluids={fluids}
            conductor={conductor}
            overlap={overlap}
            overlapDimming={overlapDimming}
            scrub={scrub}
            orbitTargets={orbitTargets}
          />
          <Tank conductor={conductor} scene={scene} />
          <SolarSystem conductor={conductor} count={fluids.length} />
          <OverlapUpdater fluids={fluids} overlap={overlap} />
          {fluids.map((f) => (
            <FluidLayer
              key={f.id}
              fluid={f}
              overlap={overlap}
              underDimming={underDimming}
              emphasis={focusId !== null && f.id !== focusId ? 0.22 : 1}
              declutter={sandboxClean}
              inflation={f.data ? INFLATION[f.data.key] ?? 0 : 0}
            />
          ))}
          <Interaction
            fluids={fluids}
            dimming={dimming}
            conductor={conductor}
          />
        </Canvas>
      </div>

      {/* a soft vignette pulls the eye to the middle */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(6,3,20,0.55)_100%)]"
      />
      {/* a distinct tint while a hypothetical scenario is overlaid */}
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-0 bg-fuchsia-600/15 transition-opacity duration-500 " +
          (overlay ? "opacity-100" : "opacity-0")
        }
      />

      <PageFrame />
      <ViewTabs view={view} onChange={setView} />

      {/* inconspicuous demo-only dataset toggle, tucked at the very top */}
      <div className="rise absolute left-1/2 top-1 z-10 flex -translate-x-1/2 select-none items-center gap-1.5 text-[0.62rem] tracking-wide text-white/35">
        {(["tristan", "yuva"] as PersonaId[]).map((id) => (
          <button
            key={id}
            onClick={() => switchPersona(id)}
            aria-pressed={persona === id}
            className={
              (persona === id ? "text-white/70" : "text-white/35 hover:text-white/55") + " " + FOCUS
            }
          >
            {id === "tristan" ? "Tristan" : "Yuva"}
          </button>
        ))}
        <span className="ml-1 uppercase tracking-[0.18em] text-white/20">demo only</span>
      </div>

      <SettingsMenu
        inGraph={inGraph}
        dimming={dimming}
        onDimming={setDimming}
        overlapDimming={overlapDimming}
        onOverlapDimming={setOverlapDimming}
        underDimming={underDimming}
        onUnderDimming={setUnderDimming}
        declutter={declutter}
        onDeclutter={setDeclutter}
        volume={volume}
        onVolume={setVolume}
        onReset={() => fluids.forEach((f) => f.sim.reset())}
      />

      <FluidDock
        fluids={fluids}
        selectedId={selectedId}
        panelOpen={panelOpen}
        inGraph={inGraph}
        maxFluids={MAX_FLUIDS}
        onSelect={selectFluid}
        onAdd={addFluid}
      />
      {selected.data && scene ? (
        <CategoryPanel
          open={panelOpen}
          graph={selected.data}
          scene={scene}
          scrub={scrub}
          onClose={closePanel}
        />
      ) : (
        <SurfacePanel
          open={panelOpen && inGraph}
          fluid={selected}
          number={selectedIndex + 1}
          canRemove={fluids.length > 1}
          onClose={closePanel}
          onRemove={removeFluid}
          onColor={setColor}
          onApply={applySurface}
        />
      )}

      {scene && (
        <Scrubber
          scrub={scrub}
          scene={scene}
          show={!inGraph}
          scrubMax={overlay ? overlay.run : DEFAULT_SCRUB_MONTHS}
        />
      )}
      {scene && (
        <ControlCenter
          scrub={scrub}
          scene={scene}
          show={!inGraph}
          priority={priority}
          onMove={movePriority}
        />
      )}
      <AgentStatus state={projection} />

      {/* Pluto the guide + the hypothetical overlay he conjures */}
      <PlutoChat onScenario={enterScenario} onPriority={setPriorityOrder} />
      {overlay && (
        <ScenarioBanner
          label={overlay.label}
          delta={overlay.delta}
          show={true}
          onExit={exitScenario}
        />
      )}
    </div>
  );
}
