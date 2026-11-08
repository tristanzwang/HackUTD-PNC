import * as THREE from "three";
import { SUN_RADIUS, fibonacciSphere, orbitRadius, orbitTilt } from "./solar-system";

/** A soft radial blob, used for the dots and for the sun's glow. */
function radialTexture(inner: string, outer: string, stop = 0.5) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
  grad.addColorStop(0, inner);
  grad.addColorStop(stop, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

function pointsFrom(positions: Float32Array, material: THREE.PointsMaterial) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const pts = new THREE.Points(geo, material);
  pts.frustumCulled = false;
  return pts;
}

/**
 * The backdrop for the solar-system view: a sun built from dots (so it matches
 * the fluids), its glow, one ring per orbit, and a starfield. Everything fades
 * in and out with the view transition.
 */
export function createSolarScenery(maxOrbits: number) {
  const group = new THREE.Group();
  group.visible = false;

  // fade bookkeeping: every material, with the opacity it should reach at full view
  const fades: { mat: THREE.Material & { opacity: number }; full: number }[] = [];
  const track = <T extends THREE.Material & { opacity: number }>(mat: T, full: number) => {
    mat.transparent = true;
    mat.opacity = 0;
    fades.push({ mat, full });
    return mat;
  };

  const dot = radialTexture("#ffffff", "rgba(255,255,255,0)", 0.45);

  // ---- sun: nested shells of dots, hottest in the middle ----
  const sun = new THREE.Group();
  const shells: { n: number; r: number; color: string; size: number; full: number }[] = [
    { n: 900, r: 1, color: "#ffd27a", size: 0.1, full: 0.95 },
    { n: 420, r: 0.74, color: "#ffb13c", size: 0.12, full: 0.8 },
    { n: 160, r: 0.42, color: "#fff6d8", size: 0.15, full: 0.9 },
  ];
  for (const sh of shells) {
    const mat = track(
      new THREE.PointsMaterial({
        size: sh.size,
        sizeAttenuation: true,
        color: sh.color,
        map: dot,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
      sh.full,
    );
    sun.add(pointsFrom(fibonacciSphere(sh.n, SUN_RADIUS * sh.r), mat));
  }
  const glowMat = track(
    new THREE.SpriteMaterial({
      map: radialTexture("rgba(255,196,92,0.85)", "rgba(255,140,30,0)", 0.06),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
    0.85,
  );
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(SUN_RADIUS * 7);
  sun.add(glow);
  group.add(sun);

  // ---- orbit rings ----
  const rings: THREE.LineLoop[] = [];
  const SEG = 160;
  for (let i = 0; i < maxOrbits; i++) {
    const r = orbitRadius(i);
    const v = new Float32Array(SEG * 3);
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      v[k * 3] = Math.cos(a) * r;
      v[k * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    const ring = new THREE.LineLoop(
      geo,
      track(new THREE.LineBasicMaterial({ color: "#5f7bbf", fog: false }), 0.3),
    );
    ring.rotation.x = orbitTilt(i);
    ring.frustumCulled = false;
    rings.push(ring);
    group.add(ring);
  }

  // ---- starfield ----
  const STARS = 1400;
  const sv = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) {
    // a shell well outside the outermost orbit
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = 34 + Math.random() * 16;
    const s = Math.sqrt(Math.max(1 - u * u, 0));
    sv[i * 3] = Math.cos(a) * s * r;
    sv[i * 3 + 1] = u * r;
    sv[i * 3 + 2] = Math.sin(a) * s * r;
  }
  const stars = pointsFrom(
    sv,
    track(
      new THREE.PointsMaterial({
        size: 0.22,
        sizeAttenuation: true,
        color: "#cfe0ff",
        map: dot,
        depthWrite: false,
        fog: false,
      }),
      0.75,
    ),
  );
  group.add(stars);

  return {
    group,
    /** `p` is the view transition (0 = tank, 1 = solar); `t` is the orbital clock. */
    update(p: number, t: number, orbitsInUse: number) {
      group.visible = p > 0.002;
      if (!group.visible) return;
      for (const f of fades) f.mat.opacity = f.full * p;
      // the sun breathes, and settles into place as the view arrives
      const pulse = 1 + Math.sin(t * 0.7) * 0.015;
      sun.scale.setScalar(pulse * (0.35 + 0.65 * p));
      glow.scale.setScalar(SUN_RADIUS * 7 * (1 + Math.sin(t * 0.45) * 0.04));
      for (let i = 0; i < rings.length; i++) rings[i].visible = i < orbitsInUse;
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      for (const f of fades) f.mat.dispose();
      dot.dispose();
    },
  };
}
