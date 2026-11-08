import { Fluid } from './flow';
import logo from '../../public/orbit/logo.png';

interface Rect { x: number; y: number; w: number; h: number }
interface Target { x: number; y: number; color: string; coral: boolean }
interface Particle extends Target { px: number; py: number; vx: number; vy: number; size: number; shape: number }

function element<T extends Element>(root: ParentNode, selector: string): T {
  const result = root.querySelector<T>(selector);
  if (!result) throw new Error(`Missing loader element: ${selector}`);
  return result;
}
function context2D(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', options);
  if (!context) throw new Error('A 2D canvas context is required for the Orbit intro.');
  return context;
}

/** Mount only in a React effect; cleanup cancels all work, including image callbacks. */
export function mountIntro(overlay: HTMLElement, onSettled: () => void): () => void {
  let disposed = false;
  const canvas = element<HTMLCanvasElement>(overlay, '[data-orbit-canvas]');
  const ctx = context2D(canvas);
  const progress = element<HTMLElement>(overlay, '[data-orbit-track]');
  const fill = element<HTMLElement>(overlay, '[data-orbit-fill]');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const image = new Image();
  let w = 0, h = 0, start = 0, last = 0, frame = 0;
  let box: Rect;
  let particles: Particle[] = [];
  let fluid: Fluid;
  let finished = false;
  const ease = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let targets: Target[] = [];
  let crop: Rect;

  function readArtwork() {
    const source = document.createElement('canvas'); source.width = image.width; source.height = image.height;
    const c = context2D(source, { willReadFrequently: true }); c.drawImage(image, 0, 0);
    const pixels = c.getImageData(0, 0, source.width, source.height).data;
    let left = image.width, right = 0, top = image.height, bottom = 0;
    const candidates: Target[] = [];
    for (let y = 0; y < image.height; y += 2) for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g, b) < 65) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      candidates.push({ x, y, color: `rgb(${r},${g},${b})`, coral: r > g * 1.25 });
    }
    crop = { x: left - 5, y: top - 5, w: right - left + 10, h: bottom - top + 10 };
    // Shuffle before sampling so all regions receive equal representation.
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    targets = candidates;
  }
  function layout() {
    w = innerWidth; h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!crop) return;
    const width = Math.min(w * .8, 1000, h * 1.75), height = width * crop.h / crop.w;
    box = { x: (w - width) / 2, y: (h - height) / 2 - h * .025, w: width, h: height };
  }
  function launch() {
    cancelAnimationFrame(frame);
    if (disposed) return;
    finished = false;
    layout(); fluid = new Fluid();
    fluid.vortex(20, 25, 1.3, 15); fluid.vortex(45, 40, -1, 18);
    const count = Math.min(targets.length, w < 600 ? 4200 : 9000);
    particles = targets.slice(0, count).map(t => ({ ...t, px: Math.random() * w, py: Math.random() * h, vx: 0, vy: 0, size: .65 + Math.random() * .9, shape: Math.random() }));
    start = last = performance.now(); fill.style.width = '0%'; progress.setAttribute('aria-valuenow', '0');
    frame = requestAnimationFrame(animate);
  }
  function settle() {
    if (disposed) return;
    cancelAnimationFrame(frame);
    onSettled();
  }
  function animate(now: number) {
    if (disposed) return;
    const dt = Math.min((now - last) / 1000, .033), t = (now - start) / 1000; last = now;
    const gather = ease(1.1, 5.3, t), reveal = reducedMotion.matches ? 1 : ease(5.5, 6.8, t);
    ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (!reducedMotion.matches && reveal < 1) {
      if (t < 4.8) { fluid.vortex(23 + Math.sin(t) * 9, 30, .12 * (1 - gather), 12); fluid.vortex(43, 36 + Math.cos(t) * 10, -.1 * (1 - gather), 14); }
      fluid.step(dt);
      for (const p of particles) {
        const gx = p.px / w * 63, gy = p.py / h * 63;
        const tx = box.x + (p.x - crop.x) / crop.w * box.w, ty = box.y + (p.y - crop.y) / crop.h * box.h;
        const force = gather * 28, damping = Math.exp(-(3 + gather * 9) * dt);
        p.vx = (p.vx + (tx - p.px) * force * dt + fluid.sample(fluid.u, gx, gy) * 45 * (1 - gather) * dt) * damping;
        p.vy = (p.vy + (ty - p.py) * force * dt + fluid.sample(fluid.v, gx, gy) * 45 * (1 - gather) * dt) * damping;
        p.px += p.vx * dt; p.py += p.vy * dt;
        p.px = Math.max(1, Math.min(w - 2, p.px)); p.py = Math.max(1, Math.min(h - 2, p.py));
        ctx.globalAlpha = (.6 + gather * .35) * (1 - reveal);
        ctx.fillStyle = p.color;
        // Small asymmetric grains, not a grid of identical circles.
        const s = p.size;
        ctx.fillRect(p.px, p.py, s, s * (.6 + p.shape * .65));
        if (p.shape > .7) { ctx.globalAlpha *= .5; ctx.fillRect(p.px + s * .6, p.py - s * .3, s * .6, s * .6); }
      }
    }
    if (reveal > 0) {
      ctx.globalAlpha = reveal;
      ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, box.x, box.y, box.w, box.h);
    }
    ctx.globalAlpha = 1;
    const percent = reducedMotion.matches ? 100 : Math.min(100, t / 6.8 * 100);
    fill.style.width = `${percent}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    if (reveal === 1) {
      if (!finished) {
        finished = true;
        onSettled();
      }
      return;
    }
    frame = requestAnimationFrame(animate);
  }
  const pointerMove = (event: PointerEvent) => {
    if (fluid && !finished) fluid.vortex(event.clientX / w * 63, event.clientY / h * 63, .7, 5);
  };
  const resize = () => { layout(); if (finished) animate(performance.now()); };
  canvas.addEventListener('pointermove', pointerMove);
  window.addEventListener('resize', resize);
  image.onload = () => {
    if (disposed) return;
    try { readArtwork(); launch(); } catch { settle(); }
  };
  image.onerror = settle;
  image.src = logo.src;
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    image.onload = null;
    image.onerror = null;
    canvas.removeEventListener('pointermove', pointerMove);
    window.removeEventListener('resize', resize);
  };
}
