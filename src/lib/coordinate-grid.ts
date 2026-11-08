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

/** The interface serif (Cormorant Garamond), resolved from the CSS variable next/font sets. */
function serifFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-cormorant").trim();
  return v ? `${v}, Georgia, serif` : "Georgia, serif";
}

type Label = THREE.Sprite & { redraw: () => void };

/** A small serif label. It redraws itself once the web font has actually loaded. */
function makeLabel(text: string, color: string, scale = 1, italic = false): Label {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext("2d")!;
  const tex = new THREE.CanvasTexture(cv);
  const draw = () => {
    g.clearRect(0, 0, cv.width, cv.height);
    g.font = `${italic ? "italic " : ""}600 76px ${serifFamily()}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = "rgba(190,210,255,0.55)"; // a faint starlight glow
    g.shadowBlur = 10;
    g.fillStyle = color;
    g.fillText(text, 128, 66);
  };
  draw();
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    fog: false, // labels stay readable even when far points are dimmed
  });
  const sprite = new THREE.Sprite(mat) as Label;
  sprite.scale.set(0.22 * scale, 0.11 * scale, 1);
  sprite.renderOrder = 10;
  sprite.redraw = () => {
    draw();
    tex.needsUpdate = true;
  };
  return sprite;
}

/** A glowing four-pointed star or a hollow ring, for marking corners and the origin. */
function makeMarkerTexture(kind: "star" | "ring") {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d")!;
  g.shadowColor = "rgba(200,220,255,0.9)";
  g.shadowBlur = 6;
  g.strokeStyle = g.fillStyle = "#fff";
  if (kind === "star") {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      const r = i % 2 === 0 ? 24 : 5;
      g.lineTo(32 + r * Math.cos(a), 32 + r * Math.sin(a));
    }
    g.closePath();
    g.fill();
  } else {
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(32, 32, 15, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(32, 32, 4, 0, Math.PI * 2);
    g.fill();
  }
  return new THREE.CanvasTexture(cv);
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
    new THREE.LineBasicMaterial({ color: "#9fb3e8", transparent: true, opacity: 0.16 }),
  );
  const floorMat = track(
    new THREE.LineBasicMaterial({ color: "#c4d2f5", transparent: true, opacity: 0.26 }),
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

  // axes, all starting at the origin corner: soft white hairlines, one colour so the
  // labels (x, y, z) do the telling-apart
  const INK = "#ffffff";
  const axisMat = track(new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.8 }));
  group.add(
    new THREE.LineSegments(
      lineGeometry([
        box.minX, box.minY, box.minZ, box.maxX, box.minY, box.minZ,
        box.minX, box.minY, box.minZ, box.minX, box.maxY, box.minZ,
        box.minX, box.minY, box.minZ, box.minX, box.minY, box.maxZ,
      ]),
      axisMat,
    ),
  );

  // tick marks at every division, longer where there is a number
  const ticks: number[] = [];
  const short = 0.035;
  const long = 0.075;
  for (let i = 0; i <= divisions; i++) {
    const t = i / divisions;
    const len = Math.abs((t * units) % labelEvery) < 1e-6 ? long : short;
    const x = lerp(box.minX, box.maxX, t);
    const y = lerp(box.minY, box.maxY, t);
    const z = lerp(box.minZ, box.maxZ, t);
    ticks.push(x, box.minY, box.minZ, x, box.minY, box.minZ - len); // along x, pointing out
    ticks.push(box.minX, box.minY, z, box.minX - len, box.minY, z); // along z
    ticks.push(box.minX, y, box.minZ, box.minX - len, y, box.minZ); // along y
  }
  group.add(
    new THREE.LineSegments(
      lineGeometry(ticks),
      track(new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.7 })),
    ),
  );

  // markers: a small ring at the origin, a four-pointed star at each other corner
  const starTex = makeMarkerTexture("star");
  const ringTex = makeMarkerTexture("ring");
  const marker = (tex: THREE.Texture, x: number, y: number, z: number, size: number, op: number) => {
    const m = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: op,
          depthTest: false,
          fog: false,
        }),
      ),
    );
    m.position.set(x, y, z);
    m.scale.setScalar(size);
    m.renderOrder = 9;
    group.add(m);
  };
  for (const x of [box.minX, box.maxX])
    for (const y of [box.minY, box.maxY])
      for (const z of [box.minZ, box.maxZ]) {
        const origin = x === box.minX && y === box.minY && z === box.minZ;
        if (origin) marker(ringTex, x, y, z, 0.15, 0.95);
        else marker(starTex, x, y, z, 0.1, 0.75);
      }

  // numbers (0, 20, ... 100) just outside the origin corner, in the interface serif
  const labels: Label[] = [];
  const off = 0.14;
  const ly = box.minY - 0.09;
  const tickFractions: number[] = [];
  for (let v = 0; v <= units + 1e-9; v += labelEvery) tickFractions.push(v / units);

  const put = (text: string, x: number, y: number, z: number, scale = 0.8, italic = false) => {
    const s = makeLabel(text, INK, scale, italic);
    track(s.material);
    s.material.opacity = italic ? 0.95 : 0.75;
    fades[fades.length - 1].full = s.material.opacity;
    s.position.set(x, y, z);
    group.add(s);
    labels.push(s);
  };
  for (const t of tickFractions) {
    const text = String(Math.round(t * units));
    put(text, lerp(box.minX, box.maxX, t), ly, box.minZ - off);
    put(text, box.minX - off, ly, lerp(box.minZ, box.maxZ, t));
    if (t > 0) put(text, box.minX - off, lerp(box.minY, box.maxY, t), box.minZ - off);
  }
  // the axes are swapped: the graph's z runs along world X, and its x along world Z
  put("z", box.maxX + 0.17, ly, box.minZ - off, 1.5, true);
  put("x", box.minX - off, ly, box.maxZ + 0.17, 1.5, true);
  put("y", box.minX - off, box.maxY + 0.15, box.minZ - off, 1.5, true);

  // the web font may not have arrived when the labels were first drawn: redraw once it has
  if (document.fonts) {
    const family = serifFamily();
    Promise.all([
      document.fonts.load(`600 76px ${family}`),
      document.fonts.load(`italic 600 76px ${family}`),
    ])
      .then(() => labels.forEach((l) => l.redraw()))
      .catch(() => {});
  }

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
