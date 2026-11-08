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
import SurfacePanel from "./SurfacePanel";

const STEP = 1 / 60;
const LINK_RATIO = 1.317; // neighbours closer than this x spacing get a lattice link
const POINT_RATIO = 0.49; // point size relative to particle spacing
const LINK_DIM = 0.7; // links are drawn slightly darker than the points
const PIN_COLOR = new THREE.Color("#ffb347"); // stuck points
const WHITE = new THREE.Color("#ffffff");
const BG = "#070b17";
const DEFAULT_DIMMING = 0.6;
const DEFAULT_OVERLAP_DIMMING = 0.6;
const TANK_CENTER = new THREE.Vector3(0, (TANK.maxY - TANK.minY) * 0.3, 0);

// cursor reach scales with a fluid's particle spacing so sparse fluids stay grabbable
const splashRadius = (sim: FluidSim) => Math.max(0.16, 1.8 * sim.spacing);
const grabRadius = (sim: FluidSim) => Math.max(0.22, 2.3 * sim.spacing); // size of the globule you pick up
const grabRayRadius = (sim: FluidSim) => Math.max(0.12, 1.3 * sim.spacing);

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
  const maxLinks = n * 5;

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

  return { pointGeo, pointColors, lineGeo, linePos, lineCol, linkIdx: new Uint32Array(maxLinks * 2) };
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
  const { pointGeo, pointColors, lineGeo, linePos, lineCol, linkIdx } = buffers;

  const pc = pointColors.array as Float32Array;
  for (let i = 0; i < sim.count; i++) {
    const j = i * 3;
    if (sim.pinned[i]) {
      c.copy(PIN_COLOR);
    } else {
      const speed = Math.hypot(vel[j], vel[j + 1], vel[j + 2]);
      c.copy(deep).lerp(foam, Math.min(speed / 3.5, 1)).multiplyScalar(brightness[i]);
    }
    pc[j] = c.r;
    pc[j + 1] = c.g;
    pc[j + 2] = c.b;
  }
  pointColors.needsUpdate = true;
  (pointGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

  const links = sim.collectLinks(sim.spacing * LINK_RATIO, linkIdx);
  const lp = linePos.array as Float32Array;
  const lc = lineCol.array as Float32Array;
  for (let l = 0; l < links; l++) {
    const bothStuck = sim.pinned[linkIdx[l * 2]] && sim.pinned[linkIdx[l * 2 + 1]];
    const dim = bothStuck ? 1 : LINK_DIM;
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

/** Draw only the active nodes, and keep point size matched to the (possibly re-spaced) fluid. */
function syncDrawState(geo: THREE.BufferGeometry, mat: THREE.PointsMaterial | null, sim: FluidSim) {
  geo.setDrawRange(0, sim.count);
  if (mat) mat.size = sim.spacing * POINT_RATIO;
}

/**
 * Depth dimming: fog runs from just in front of the tank to just behind it,
 * so points far from the camera fade into the background. `amount` is 0..1.
 */
function updateFog(scene: THREE.Scene, camDist: number, amount: number) {
  const fog = scene.fog as THREE.Fog | null;
  if (!fog) return;
  fog.near = Math.max(camDist - 0.8, 0.1);
  fog.far = camDist + 1.2 + (1 - amount) * 5; // amount 1 -> far points almost vanish, 0 -> barely any fade
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
// one fluid: steps its own simulation and draws its own points + links
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
  const acc = useRef(0);

  useEffect(
    () => () => {
      buffers.pointGeo.dispose();
      buffers.lineGeo.dispose();
    },
    [buffers],
  );

  useFrame((_, delta) => {
    // fixed step; cap so a slow frame can't spiral
    acc.current = Math.min(acc.current + delta, STEP * 2);
    while (acc.current >= STEP) {
      sim.step(STEP);
      acc.current -= STEP;
    }
    overlap.factors(sim, brightness);
    updateLattice(sim, buffers, colors.c, colors.deep, colors.foam, brightness);
    syncDrawState(buffers.pointGeo, pointsMat.current, sim);
  });

  return (
    <>
      <points geometry={buffers.pointGeo} frustumCulled={false}>
        <pointsMaterial
          ref={pointsMat}
          size={sim.spacing * POINT_RATIO}
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
// the tank: fixed coordinate grid (origin corner is 0,0,0; axes run to 100)
// ---------------------------------------------------------------------------

function Tank() {
  const grid = useMemo(() => createCoordinateGrid(TANK), []);
  const tankW = TANK.maxX - TANK.minX;
  const tankH = TANK.maxY - TANK.minY;
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(tankW, tankH, tankW)),
    [tankW, tankH],
  );
  return (
    <>
      <primitive object={grid.group} />
      <lineSegments geometry={edges} position={[0, tankH / 2, 0]}>
        <lineBasicMaterial color="#8fb4ff" transparent opacity={0.25} />
      </lineSegments>
    </>
  );
}

// ---------------------------------------------------------------------------
// camera, pointer input, cursor splash / grab, depth dimming
// ---------------------------------------------------------------------------

function Interaction({ fluids, dimming }: { fluids: FluidEntry[]; dimming: number }) {
  const cursor = useRef<THREE.Mesh>(null);
  const { camera, gl, scene } = useThree();

  const fluidsRef = useRef(fluids);
  const dimRef = useRef(dimming);
  useEffect(() => {
    fluidsRef.current = fluids;
    dimRef.current = dimming;
  }, [fluids, dimming]);

  const tmp = useMemo(
    () => ({
      ray: new THREE.Raycaster(),
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
    }),
    [],
  );

  // Interaction state lives in a ref so we never re-render React per pointer event.
  const input = useRef({
    theta: 0.7, // orbit azimuth
    phi: 1.15, // orbit polar angle
    dist: 3.4,
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

  useEffect(() => {
    const el = gl.domElement;
    const s = input.current;

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
        for (const f of fluidsRef.current) f.sim.unpinAll();
        s.grabbing = false;
        s.grabSim = null;
        return;
      }
      if (e.button !== 0) return;
      setNdc(e);
      el.setPointerCapture(e.pointerId);

      // left click on a fluid grabs a globule of it (hold Shift to orbit instead)
      if (!e.shiftKey) {
        tmp.ray.setFromCamera(s.ndc, camera);
        const o = tmp.ray.ray.origin;
        const d = tmp.ray.ray.direction;
        const target = pickFluid(fluidsRef.current, o, d, grabRayRadius);
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
        s.theta -= (e.clientX - s.lastX) * 0.007;
        s.phi = THREE.MathUtils.clamp(
          s.phi - (e.clientY - s.lastY) * 0.007,
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
      s.dist = THREE.MathUtils.clamp(s.dist * Math.exp(e.deltaY * 0.001), 1.8, 7);
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
  }, [gl, camera, tmp]);

  useFrame(() => {
    const s = input.current;

    // ---- camera orbit ----
    const sp = Math.sin(s.phi);
    camera.position.set(
      TANK_CENTER.x + s.dist * sp * Math.sin(s.theta),
      TANK_CENTER.y + s.dist * Math.cos(s.phi),
      TANK_CENTER.z + s.dist * sp * Math.cos(s.theta),
    );
    camera.lookAt(TANK_CENTER);
    camera.updateMatrixWorld();
    updateFog(scene, s.dist, dimRef.current);

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
      const G = 5 * s.dist;
      const push = Math.min(speed * G * 0.5, 1);
      const ix = tmp.right.x * s.delta.x * G + tmp.up.x * s.delta.y * G + d.x * push;
      const iy = tmp.right.y * s.delta.x * G + tmp.up.y * s.delta.y * G + d.y * push;
      const iz = tmp.right.z * s.delta.x * G + tmp.up.z * s.delta.y * G + d.z * push;
      const target = pickFluid(fluidsRef.current, o, d, splashRadius);
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

export default function FluidScene() {
  const nextId = useRef(1);
  const [fluids, setFluids] = useState<FluidEntry[]>(() => [createFluid(0, 0, FLUID_COLORS[0])]);
  const [dimming, setDimming] = useState(DEFAULT_DIMMING);
  const [overlapDimming, setOverlapDimming] = useState(DEFAULT_OVERLAP_DIMMING);
  const overlap = useMemo(() => new OverlapField(), []);
  useEffect(() => {
    overlap.setAmount(overlapDimming);
  }, [overlap, overlapDimming]);

  const addFluid = () => {
    if (fluids.length >= MAX_FLUIDS) return;
    const used = new Set(fluids.map((f) => f.color));
    const color =
      FLUID_COLORS.find((c) => !used.has(c)) ?? FLUID_COLORS[fluids.length % FLUID_COLORS.length];
    const entry = createFluid(nextId.current++, fluids.length, color);
    setFluids((prev) => [...prev, entry]);
  };
  const removeFluid = (id: number) => setFluids((prev) => (prev.length > 1 ? prev.filter((f) => f.id !== id) : prev));
  const setColor = (id: number, color: string) =>
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, color } : f)));
  const applySurface = (id: number, expr: string, fn: SurfaceFn) => {
    fluids.find((f) => f.id === id)?.sim.setSurface(fn);
    setFluids((prev) => prev.map((f) => (f.id === id ? { ...f, expr } : f)));
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#070b17]">
      <Canvas
        camera={{ fov: 45, near: 0.1, far: 50, position: [2, 2, 3] }}
        dpr={[1, 2]}
        style={{ touchAction: "none", cursor: "crosshair" }}
      >
        <color attach="background" args={[BG]} />
        <fog attach="fog" args={[BG, 3, 8]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 5, 2]} intensity={2.2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#7aa7ff" />
        <Tank />
        <OverlapUpdater fluids={fluids} overlap={overlap} />
        {fluids.map((f) => (
          <FluidLayer key={f.id} fluid={f} overlap={overlap} />
        ))}
        <Interaction fluids={fluids} dimming={dimming} />
      </Canvas>

      <div className="pointer-events-none absolute left-5 top-5 max-w-md select-none text-white/80">
        <h1 className="text-lg font-semibold tracking-tight">3D Fluid</h1>
        <p className="mt-1 text-sm text-white/50">
          Move to splash · drag a fluid to grab a blob · right-click to melt it back · drag empty space (or
          hold Shift) to rotate · scroll to zoom
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
  );
}
