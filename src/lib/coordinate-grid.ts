import * as THREE from "three";

type Box = {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
};

function lineGeometry(verts: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

function makeLabel(text: string, color: string, scale = 1) {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 64;
  const g = cv.getContext("2d")!;
  g.font = "600 38px ui-sans-serif, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, 64, 34);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv),
    transparent: true,
    depthTest: false,
    fog: false, // labels stay readable even when far points are dimmed
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.22 * scale, 0.11 * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * A fixed x/y/z coordinate grid around the tank. The corner at the box's
 * (minX, minY, minZ) is the origin (0, 0, 0) and each axis runs to `units`
 * (100) at the opposite side, regardless of the tank's world size.
 */
export function createCoordinateGrid(
  box: Box,
  { divisions = 10, labelEvery = 20, units = 100 } = {},
) {
  const group = new THREE.Group();
  // every material, with the opacity it has when the grid is fully shown, so the
  // whole grid can fade out as the view turns into a solar system
  const fades: { mat: THREE.Material & { opacity: number }; full: number }[] = [];
  const track = <T extends THREE.Material & { opacity: number }>(mat: T) => {
    mat.transparent = true;
    fades.push({ mat, full: mat.opacity });
    return mat;
  };
  const gridMat = track(
    new THREE.LineBasicMaterial({ color: "#3a5190", transparent: true, opacity: 0.45 }),
  );
  const floorMat = track(
    new THREE.LineBasicMaterial({ color: "#4a64ad", transparent: true, opacity: 0.55 }),
  );

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const fr = Array.from({ length: divisions + 1 }, (_, i) => i / divisions);
  const xs = fr.map((t) => lerp(box.minX, box.maxX, t));
  const ys = fr.map((t) => lerp(box.minY, box.maxY, t));
  const zs = fr.map((t) => lerp(box.minZ, box.maxZ, t));

  // floor (y = 0)
  const floor: number[] = [];
  for (const x of xs) floor.push(x, box.minY, box.minZ, x, box.minY, box.maxZ);
  for (const z of zs) floor.push(box.minX, box.minY, z, box.maxX, box.minY, z);
  group.add(new THREE.LineSegments(lineGeometry(floor), floorMat));

  // wall at z = 0 (the x-y plane)
  const wallZ: number[] = [];
  for (const x of xs) wallZ.push(x, box.minY, box.minZ, x, box.maxY, box.minZ);
  for (const y of ys) wallZ.push(box.minX, y, box.minZ, box.maxX, y, box.minZ);
  group.add(new THREE.LineSegments(lineGeometry(wallZ), gridMat));

  // wall at x = 0 (the z-y plane)
  const wallX: number[] = [];
  for (const z of zs) wallX.push(box.minX, box.minY, z, box.minX, box.maxY, z);
  for (const y of ys) wallX.push(box.minX, y, box.minZ, box.minX, y, box.maxZ);
  group.add(new THREE.LineSegments(lineGeometry(wallX), gridMat));

  // axes, all starting at the origin corner
  const COLORS = { x: "#ff6b6b", y: "#5cf28a", z: "#6aa7ff" };
  const axis = (to: [number, number, number], color: string) =>
    new THREE.LineSegments(
      lineGeometry([box.minX, box.minY, box.minZ, ...to]),
      track(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 })),
    );
  group.add(
    axis([box.maxX, box.minY, box.minZ], COLORS.x),
    axis([box.minX, box.maxY, box.minZ], COLORS.y),
    axis([box.minX, box.minY, box.maxZ], COLORS.z),
  );

  // tick labels (0, 20, ... 100) just outside the origin corner
  const off = 0.12;
  const ly = box.minY - 0.09;
  const tickFractions: number[] = [];
  for (let v = 0; v <= units + 1e-9; v += labelEvery) tickFractions.push(v / units);

  const put = (text: string, color: string, x: number, y: number, z: number, scale = 0.8) => {
    const s = makeLabel(text, color, scale);
    track(s.material);
    s.position.set(x, y, z);
    group.add(s);
  };
  for (const t of tickFractions) {
    const text = String(Math.round(t * units));
    put(text, COLORS.x, lerp(box.minX, box.maxX, t), ly, box.minZ - off);
    put(text, COLORS.z, box.minX - off, ly, lerp(box.minZ, box.maxZ, t));
    if (t > 0) put(text, COLORS.y, box.minX - off, lerp(box.minY, box.maxY, t), box.minZ - off);
  }
  put("x", COLORS.x, box.maxX + 0.14, ly, box.minZ - off, 1.4);
  put("z", COLORS.z, box.minX - off, ly, box.maxZ + 0.14, 1.4);
  put("y", COLORS.y, box.minX - off, box.maxY + 0.12, box.minZ - off, 1.4);

  return {
    group,
    /** Fade the whole grid (1 = fully shown, 0 = gone). */
    setOpacity(k: number) {
      group.visible = k > 0.002;
      if (!group.visible) return;
      for (const f of fades) f.mat.opacity = f.full * k;
    },
  };
}
