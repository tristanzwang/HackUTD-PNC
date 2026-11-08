"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compileSurface, type SurfaceFn } from "@/lib/expression";
import { MAX_SURFACE_HEIGHT, TANK } from "@/lib/fluid-sim";
import { AXIS_MAX, MAX_SURFACE_UNITS, gridToWorldSurface } from "@/lib/units";

// x and z run 0..100 across the floor of the grid; the result is height in y-axis units
const PRESETS: { name: string; expr: string }[] = [
  { name: "Flat", expr: "0" },
  { name: "Hill", expr: "25*exp(-((x-50)^2+(z-50)^2)/800)" },
  { name: "Bowl", expr: "0.0073*((x-50)^2+(z-50)^2)" },
  { name: "Ramp", expr: "0.35*(x-50)" },
  { name: "Waves", expr: "7*sin(0.08*x)" },
  { name: "Ripples", expr: "6*sin(0.13*sqrt((x-50)^2+(z-50)^2))" },
  { name: "Saddle", expr: "0.009*((x-50)^2-(z-50)^2)" },
  { name: "Egg carton", expr: "5*sin(0.1*x)*sin(0.1*z)" },
];
const CLIP_LABEL = String(Math.round(MAX_SURFACE_UNITS));

// diverging ramp: low = deep blue, 0 = near white, high = amber (matches the colour bar)
const LOW = [23, 48, 107];
const MID = [232, 246, 255];
const HIGH = [255, 179, 71];
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

const RES = 72;

function drawPreview(canvas: HTMLCanvasElement, fn: SurfaceFn) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const img = g.createImageData(RES, RES);
  const w = TANK.maxX - TANK.minX;
  const d = TANK.maxZ - TANK.minZ;
  for (let k = 0; k < RES; k++) {
    for (let i = 0; i < RES; i++) {
      const x = TANK.minX + ((i + 0.5) / RES) * w;
      const z = TANK.maxZ - ((k + 0.5) / RES) * d; // z increases upward
      let v = fn(x, z);
      if (!Number.isFinite(v)) v = 0;
      const t = Math.max(-1, Math.min(1, v / MAX_SURFACE_HEIGHT));
      const c = t < 0 ? lerp(MID, LOW, -t) : lerp(MID, HIGH, t);
      const o = (k * RES + i) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

export default function SurfacePanel({ onApply }: { onApply: (fn: SurfaceFn | null) => void }) {
  const [text, setText] = useState("0");
  const [applied, setApplied] = useState("0");
  const canvas = useRef<HTMLCanvasElement>(null);

  const compiled = useMemo(() => compileSurface(text), [text]);

  // live preview of whatever is typed (once it's valid)
  const lastGood = useRef<SurfaceFn>(() => 0);
  useEffect(() => {
    if (compiled.ok) lastGood.current = gridToWorldSurface(compiled.fn);
    if (canvas.current) drawPreview(canvas.current, lastGood.current);
  }, [compiled]);

  const apply = (expr: string) => {
    const r = compileSurface(expr);
    if (!r.ok) return;
    setApplied(expr);
    onApply(gridToWorldSurface(r.fn));
  };

  const selectPreset = (expr: string) => {
    setText(expr);
    apply(expr);
  };

  return (
    <div className="absolute right-5 top-5 w-72 select-none rounded-2xl border border-white/15 bg-[#0b1226]/80 p-4 text-white shadow-xl backdrop-blur">
      <h2 className="text-sm font-semibold tracking-tight">Surface shape</h2>
      <p className="mt-0.5 text-xs text-white/50">
        The fluid&apos;s natural surface height <span className="font-mono">h(x, z)</span> in grid units
      </p>

      <div className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply(text)}
          spellCheck={false}
          autoComplete="off"
          aria-label="Surface height expression in x and z"
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-400/70"
        />
        <button
          onClick={() => apply(text)}
          disabled={!compiled.ok || text === applied}
          className="rounded-lg bg-sky-500/80 px-3 text-sm font-medium transition enabled:hover:bg-sky-400 disabled:opacity-35"
        >
          Apply
        </button>
      </div>
      <p className={"mt-1 h-4 text-xs " + (compiled.ok ? "text-white/40" : "text-red-300")}>
        {compiled.ok ? (text === applied ? "Applied" : "Press Enter or Apply") : compiled.error}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => selectPreset(p.expr)}
            className={
              "rounded-full border px-2.5 py-1 text-xs transition " +
              (applied === p.expr
                ? "border-sky-400/70 bg-sky-400/20"
                : "border-white/15 bg-white/5 hover:bg-white/15")
            }
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-stretch gap-2">
        <span className="flex items-center text-[10px] text-white/40 [writing-mode:vertical-rl] rotate-180">
          z →
        </span>
        <canvas
          ref={canvas}
          width={RES}
          height={RES}
          aria-label="Top-down preview of the surface height graph"
          className="aspect-square flex-1 rounded-lg border border-white/15"
          style={{ imageRendering: "auto" }}
        />
      </div>
      <p className="mt-1 text-center text-[10px] text-white/40">x →</p>
      <div
        className="mx-auto mt-1 h-2 w-full rounded-full"
        style={{ background: "linear-gradient(to right, #17306b, #e8f6ff, #ffb347)" }}
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-white/40">
        <span>−{CLIP_LABEL}</span>
        <span>0</span>
        <span>+{CLIP_LABEL}</span>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-white/35">
        Top-down view of the grid floor: x and z run 0–{AXIS_MAX}, and h is height in y-axis units. Use
        x, z, pi, e, + − * / ^ and sin, cos, sqrt, exp, abs, min, max… Heights beyond ±{CLIP_LABEL} are
        clipped.
      </p>
    </div>
  );
}
