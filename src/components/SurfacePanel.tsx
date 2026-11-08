"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compileSurface, type SurfaceFn } from "@/lib/expression";
import type { FluidEntry } from "@/lib/fluid-config";
import { analyzeSurface as analyze, adviceFor } from "@/lib/surface-analysis";
import { AXIS_MAX, gridToWorldSurface } from "@/lib/units";
import { Divider, Orb } from "./Ornaments";
import { CHIP, CHIP_ON, FOCUS, GLASS, PRESS, materialize } from "./ui";

// x and z run 0..100 across the floor of the grid; the result is the surface's height on the y axis (0..100)
const PRESETS: { name: string; expr: string }[] = [
  { name: "Flat", expr: "40" },
  { name: "Shallow", expr: "15" },
  { name: "Deep", expr: "70" },
  { name: "Hill", expr: "25+30*exp(-((x-50)^2+(z-50)^2)/800)" },
  { name: "Bowl", expr: "15+0.007*((x-50)^2+(z-50)^2)" },
  { name: "Ramp", expr: "40+0.35*(x-50)" },
  { name: "Waves", expr: "40+7*sin(0.08*x)" },
  { name: "Ripples", expr: "40+6*sin(0.13*sqrt((x-50)^2+(z-50)^2))" },
  { name: "Saddle", expr: "40+0.009*((x-50)^2-(z-50)^2)" },
  { name: "Egg carton", expr: "40+5*sin(0.1*x)*sin(0.1*z)" },
];

// height ramp: 0 = deep blue, 50 = near white, 100 = amber (matches the colour bar)
const LOW = [23, 48, 107];
const MID = [232, 246, 255];
const HIGH = [255, 179, 71];
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

const RES = 72;

function drawPreview(canvas: HTMLCanvasElement, fn: SurfaceFn) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const img = g.createImageData(RES, RES);
  for (let k = 0; k < RES; k++) {
    for (let i = 0; i < RES; i++) {
      const x = ((i + 0.5) / RES) * AXIS_MAX;
      const z = AXIS_MAX - ((k + 0.5) / RES) * AXIS_MAX; // z increases upward
      let v = fn(x, z);
      if (!Number.isFinite(v)) v = 0;
      const t = Math.max(0, Math.min(1, v / AXIS_MAX));
      const c = t < 0.5 ? lerp(LOW, MID, t * 2) : lerp(MID, HIGH, (t - 0.5) * 2);
      const o = (k * RES + i) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** Expression box, presets and live preview for one graph's surface. */
function SurfaceEditor({
  initialExpr,
  onApply,
}: {
  initialExpr: string;
  onApply: (expr: string, fn: SurfaceFn) => void;
}) {
  const [text, setText] = useState(initialExpr);
  const [applied, setApplied] = useState(initialExpr);
  const canvas = useRef<HTMLCanvasElement>(null);

  const compiled = useMemo(() => compileSurface(text), [text]);
  const stats = useMemo(() => (compiled.ok ? analyze(compiled.fn) : null), [compiled]);
  const advice = stats ? adviceFor(stats) : null;

  // live preview of whatever is typed (once it's valid)
  const lastGood = useRef<SurfaceFn>(() => 0);
  useEffect(() => {
    if (compiled.ok) lastGood.current = compiled.fn;
    if (canvas.current) drawPreview(canvas.current, lastGood.current);
  }, [compiled]);

  const apply = (expr: string) => {
    const r = compileSurface(expr);
    if (!r.ok) return;
    setApplied(expr);
    onApply(expr, gridToWorldSurface(r.fn));
  };

  const selectPreset = (expr: string) => {
    setText(expr);
    apply(expr);
  };

  return (
    <div>
      <p className="text-sm text-white/55">
        Surface height h(x, z) on the y axis (0–{AXIS_MAX})
      </p>

      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply(text)}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. 40+15*sin(x/15)*cos(z/15)"
          aria-label="Surface height expression in x and z"
          className="min-w-0 flex-1 rounded-xl border border-white/20 bg-black/35 px-3 py-1.5 font-mono text-sm outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-white/25 focus:border-white/70 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.14)]"
        />
        <button
          onClick={() => apply(text)}
          disabled={!compiled.ok || text === applied}
          className={"rounded-xl bg-white/90 px-3.5 text-sm font-semibold text-[#0b1226] enabled:hover:bg-white disabled:opacity-35 " + PRESS + " " + FOCUS}
        >
          Apply
        </button>
      </div>
      <p className={"mt-1 h-4 text-sm " + (compiled.ok ? "text-white/40" : "text-red-300")}>
        {compiled.ok ? (text === applied ? "Applied" : "Press Enter or Apply") : compiled.error}
      </p>

      {advice && <p className="mt-1 text-[13px] leading-snug text-amber-200/85">{advice}</p>}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => selectPreset(p.expr)}
            aria-pressed={applied === p.expr}
            className={
              "px-2.5 py-1 text-sm " + PRESS + " " + FOCUS + " " + CHIP + " " + (applied === p.expr ? CHIP_ON : "")
            }
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-stretch gap-2">
        <span className="flex items-center text-sm text-white/40 [writing-mode:vertical-rl] rotate-180">
          z →
        </span>
        <canvas
          ref={canvas}
          width={RES}
          height={RES}
          aria-label="Top-down preview of the surface height graph"
          className="aspect-square flex-1 rounded-xl border border-white/20"
          style={{ imageRendering: "auto" }}
        />
      </div>
      <p className="mt-1 text-center text-sm text-white/40">
        x →{stats && Number.isFinite(stats.min) ? ` · h from ${stats.min.toFixed(1)} to ${stats.max.toFixed(1)}` : ""}
      </p>
      <div
        className="mx-auto mt-1 h-2 w-full rounded-full"
        style={{ background: "linear-gradient(to right, #17306b, #e8f6ff, #ffb347)" }}
      />
      <div className="mt-0.5 flex justify-between text-sm text-white/40">
        <span>0</span>
        <span>{AXIS_MAX / 2}</span>
        <span>{AXIS_MAX}</span>
      </div>
      <p className="mt-2 text-sm leading-snug text-white/35">
        Top-down view of the grid floor (x and z run 0–{AXIS_MAX}); colour is height. The points fill up to
        the graph, and their number follows the volume under it. Use x, z, pi, e, + − * / ^ and
        sin, cos, sqrt, exp, abs, min, max…
      </p>
    </div>
  );
}

type PanelProps = {
  /** Whether the sidebar is showing; it materializes in and out. */
  open: boolean;
  fluid: FluidEntry;
  /** 1-based, as the legend numbers it. */
  number: number;
  canRemove: boolean;
  onClose: () => void;
  onRemove: (id: number) => void;
  onColor: (id: number, color: string) => void;
  onApply: (id: number, expr: string, fn: SurfaceFn) => void;
};

/**
 * The sidebar for one fluid: colour, removal, and its surface graph. It opens
 * from the legend (click a fluid's orb) and closes with the ✕ or Escape.
 */
export default function SurfacePanel({
  open,
  fluid,
  number,
  canRemove,
  onClose,
  onRemove,
  onColor,
  onApply,
}: PanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside
      inert={!open}
      aria-label={`Graph ${number} settings`}
      className={
        "absolute right-5 top-[4.9rem] max-h-[calc(100vh-9.5rem)] w-80 origin-top-right select-none " +
        "overflow-y-auto rounded-[1.75rem] p-5 text-white tabular-nums lining-nums " +
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
        GLASS +
        " " +
        materialize(open)
      }
    >
      <div className="relative flex items-center gap-3">
        <Orb color={fluid.color} size={22} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-none tracking-[-0.01em] text-white">
            Graph {number}
          </h2>
          <p className="mt-1 text-sm text-white/45">{fluid.sim.count} points</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close graph settings"
          className={"flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white " + PRESS + " " + FOCUS}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 2.5l7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <Divider className="relative my-3.5" />

      <div className="relative flex items-center justify-between gap-2">
        <label className="flex items-center gap-2.5 text-sm text-white/65">
          Colour
          <input
            type="color"
            value={fluid.color}
            onChange={(e) => onColor(fluid.id, e.target.value)}
            aria-label={`Colour of graph ${number}`}
            className={"h-6 w-9 cursor-pointer rounded-md border border-white/30 bg-transparent p-0 " + FOCUS}
          />
        </label>
        <button
          onClick={() => onRemove(fluid.id)}
          disabled={!canRemove}
          className={"px-3.5 py-1 text-sm enabled:hover:border-red-300/40 enabled:hover:bg-red-500/20 enabled:hover:text-red-100 disabled:opacity-35 " + PRESS + " " + FOCUS + " " + CHIP}
        >
          Remove
        </button>
      </div>

      <Divider className="relative my-3.5" />

      <div className="relative">
      <SurfaceEditor
        key={fluid.id}
        initialExpr={fluid.expr}
        onApply={(expr, fn) => onApply(fluid.id, expr, fn)}
      />
      </div>
    </aside>
  );
}
