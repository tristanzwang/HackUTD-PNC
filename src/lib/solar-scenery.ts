import * as THREE from "three";
import { SUN_RADIUS, orbitRadius, orbitTilt } from "./solar-system";

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

  // ---- sun: a small sphere of light, wrapped in two additive halos ----
  // The halos draw before the fluids (renderOrder -1) so that a planet passing
  // behind the sun is painted over them rather than washed pale by them.
  const INNER_GLOW = 3.6;
  const OUTER_GLOW = 10;
  const sun = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 32, 24),
    track(new THREE.MeshBasicMaterial({ color: "#fff6dd", fog: false }), 1),
  );
  core.renderOrder = -1;
  sun.add(core);

  const halo = (scale: number, inner: string, stop: number, full: number) => {
    const sprite = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: radialTexture(inner, "rgba(255,150,40,0)", stop),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
        full,
      ),
    );
    sprite.scale.setScalar(SUN_RADIUS * scale);
    sprite.renderOrder = -1;
    sun.add(sprite);
    return sprite;
  };
  const innerGlow = halo(INNER_GLOW, "rgba(255,226,160,0.95)", 0.16, 0.9);
  const outerGlow = halo(OUTER_GLOW, "rgba(255,168,70,0.55)", 0.02, 0.75);
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
      // the sun breathes, and swells into place as the view arrives
      sun.scale.setScalar(0.35 + 0.65 * p);
      innerGlow.scale.setScalar(SUN_RADIUS * INNER_GLOW * (1 + Math.sin(t * 0.7) * 0.05));
      outerGlow.scale.setScalar(SUN_RADIUS * OUTER_GLOW * (1 + Math.sin(t * 0.45) * 0.07));
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
