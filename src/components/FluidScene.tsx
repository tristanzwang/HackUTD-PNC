"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { createCoordinateGrid } from "@/lib/coordinate-grid";
import { FluidSim, TANK } from "@/lib/fluid-sim";
import SurfacePanel from "./SurfacePanel";

const STEP = 1 / 60;
const LINK_DIST = 0.108; // neighbours closer than this get a lattice link (rest spacing ≈ 0.082)
const LINK_DIM = 0.7; // links are drawn slightly darker than the points
const PIN_COLOR = new THREE.Color("#ffb347"); // stuck points
const GRAB_RADIUS = 0.22; // size of the globule you pick up
const BG = "#070b17";
const DEFAULT_DIMMING = 0.6;
const TANK_CENTER = new THREE.Vector3(0, (TANK.maxY - TANK.minY) * 0.3, 0);

type LatticeBuffers = {
  pointGeo: THREE.BufferGeometry;
  pointColors: THREE.BufferAttribute;
  lineGeo: THREE.BufferGeometry;
  linePos: THREE.BufferAttribute;
  lineCol: THREE.BufferAttribute;
  linkIdx: Uint32Array;
};

/** Refresh point colours (blue -> white with speed) and rebuild the link lines. */
function updateLattice(
  sim: FluidSim,
  buffers: LatticeBuffers,
  c: THREE.Color,
  deep: THREE.Color,
  foam: THREE.Color,
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
      c.copy(deep).lerp(foam, Math.min(speed / 3.5, 1));
    }
    pc[j] = c.r;
    pc[j + 1] = c.g;
    pc[j + 2] = c.b;
  }
  pointColors.needsUpdate = true;
  (pointGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

  const links = sim.collectLinks(LINK_DIST, linkIdx);
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

function Fluid({ sim, dimming }: { sim: FluidSim; dimming: number }) {
  const cursor = useRef<THREE.Mesh>(null);
  const { camera, gl, scene } = useThree();
  const dimRef = useRef(dimming);
  useEffect(() => {
    dimRef.current = dimming;
  }, [dimming]);

  // Points share the sim's position buffer directly (no per-frame copy).
  // Lattice links are rebuilt every frame from nearby particle pairs.
  const buffers = useMemo(() => {
    const n = sim.count;
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

    // soft round sprite so points aren't squares
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const g = cv.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.6, "#fff");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(cv);

    return {
      pointGeo,
      pointColors,
      lineGeo,
      linePos,
      lineCol,
      sprite,
      linkIdx: new Uint32Array(maxLinks * 2),
    };
  }, [sim]);

  // fixed x/y/z coordinate grid: origin corner is (0,0,0), every axis runs to 100
  const grid = useMemo(() => createCoordinateGrid(TANK), []);

  const tmp = useMemo(
    () => ({
      c: new THREE.Color(),
      deep: new THREE.Color("#1b5fd1"),
      foam: new THREE.Color("#e8f6ff"),
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
      // right click: everything stuck turns back into fluid
      if (e.button === 2) {
        sim.unpinAll();
        s.grabbing = false;
        return;
      }
      if (e.button !== 0) return;
      setNdc(e);
      el.setPointerCapture(e.pointerId);

      // left click on fluid grabs a globule (hold Shift to orbit instead)
      if (!e.shiftKey) {
        tmp.ray.setFromCamera(s.ndc, camera);
        const o = tmp.ray.ray.origin;
        const d = tmp.ray.ray.direction;
        const center = sim.grab([o.x, o.y, o.z], [d.x, d.y, d.z], GRAB_RADIUS);
        if (center) {
          // drag the globule on a plane facing the camera
          camera.getWorldDirection(tmp.normal);
          tmp.point.set(center[0], center[1], center[2]);
          s.grabPlane.setFromNormalAndCoplanarPoint(tmp.normal, tmp.point);
          s.grabbing = true;
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
        sim.releaseGrab(); // points stay pinned where they were let go
        s.grabbing = false;
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
  }, [gl, camera, sim, tmp]);

  const acc = useRef(0);

  useFrame((_, delta) => {
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
    if (s.grabbing) {
      tmp.ray.setFromCamera(s.ndc, camera);
      if (tmp.ray.ray.intersectPlane(s.grabPlane, tmp.point)) {
        hit = sim.moveGrab(tmp.point.x, tmp.point.y, tmp.point.z);
        cursorScale = GRAB_RADIUS / 0.07;
      }
    }

    // ---- cursor splash ----
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
      hit = sim.splash([o.x, o.y, o.z], [d.x, d.y, d.z], 0.16, [ix, iy, iz], 0.25);
    }
    if (cursor.current) {
      cursor.current.visible = !!hit;
      if (hit) {
        cursor.current.position.set(hit[0], hit[1], hit[2]);
        cursor.current.scale.setScalar(cursorScale);
      }
    }

    // ---- physics (fixed step; cap so a slow frame can't spiral) ----
    acc.current = Math.min(acc.current + delta, STEP * 2);
    while (acc.current >= STEP) {
      sim.step(STEP);
      acc.current -= STEP;
    }

    updateLattice(sim, buffers, tmp.c, tmp.deep, tmp.foam);
  });

  const tankW = TANK.maxX - TANK.minX;
  const tankH = TANK.maxY - TANK.minY;
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(tankW, tankH, tankW)),
    [tankW, tankH],
  );

  return (
    <>
      {/* fluid as points... */}
      <points geometry={buffers.pointGeo} frustumCulled={false}>
        <pointsMaterial
          size={0.04}
          sizeAttenuation
          vertexColors
          map={buffers.sprite}
          alphaTest={0.4}
          transparent
        />
      </points>
      {/* ...connected by a lattice of links */}
      <lineSegments geometry={buffers.lineGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.55} depthWrite={false} />
      </lineSegments>

      {/* x/y/z coordinate grid */}
      <primitive object={grid.group} />
      <lineSegments geometry={edges} position={[0, tankH / 2, 0]}>
        <lineBasicMaterial color="#8fb4ff" transparent opacity={0.25} />
      </lineSegments>

      {/* where the cursor is touching the fluid */}
      <mesh ref={cursor} visible={false}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
}

export default function FluidScene() {
  const sim = useMemo(() => new FluidSim(), []);
  const [dimming, setDimming] = useState(DEFAULT_DIMMING);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#070b17]">
      <Canvas
        camera={{ fov: 45, near: 0.1, far: 50, position: [2, 2, 3] }}
        dpr={[1, 2]}
        style={{ touchAction: "none", cursor: "crosshair" }}
      >
        <color attach="background" args={["#070b17"]} />
        <fog attach="fog" args={[BG, 3, 8]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 5, 2]} intensity={2.2} />
        <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#7aa7ff" />
        <Fluid sim={sim} dimming={dimming} />
      </Canvas>

      <div className="pointer-events-none absolute left-5 top-5 select-none text-white/80">
        <h1 className="text-lg font-semibold tracking-tight">3D Fluid</h1>
        <p className="mt-1 text-sm text-white/50">
          Move to splash · drag the fluid to grab a blob · right-click to melt it back · drag empty space (or hold Shift) to rotate · scroll to zoom
        </p>
      </div>
      <label className="absolute bottom-5 left-5 flex select-none items-center gap-3 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur">
        Depth dimming
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={dimming}
          onChange={(e) => setDimming(parseFloat(e.target.value))}
          aria-label="Depth dimming"
          className="w-28 accent-sky-400"
        />
      </label>
      <SurfacePanel onApply={(fn) => sim.setSurface(fn)} />
      <button
        onClick={() => sim.reset()}
        className="absolute bottom-5 right-5 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white backdrop-blur transition hover:bg-white/20"
      >
        Drop new water
      </button>
    </div>
  );
}
