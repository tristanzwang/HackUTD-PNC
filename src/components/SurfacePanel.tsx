"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compileSurface, type SurfaceFn } from "@/lib/expression";
import type { FluidEntry } from "@/lib/fluid-config";
import { analyzeSurface as analyze, adviceFor } from "@/lib/surface-analysis";
import { AXIS_MAX, gridToWorldSurface } from "@/lib/units";

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

/** Expression box, presets and live preview for one fluid's surface graph. */
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
      <p className="text-xs text-white/50">
        Surface height <span className="font-mono">h(x, z)</span> on the y axis (0–{AXIS_MAX})
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

      {advice && <p className="mt-1 text-[11px] leading-snug text-amber-200/85">{advice}</p>}

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
      <p className="mt-1 text-center text-[10px] text-white/40">
        x →{stats && Number.isFinite(stats.min) ? ` · h from ${stats.min.toFixed(1)} to ${stats.max.toFixed(1)}` : ""}
      </p>
      <div
        className="mx-auto mt-1 h-2 w-full rounded-full"
        style={{ background: "linear-gradient(to right, #17306b, #e8f6ff, #ffb347)" }}
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-white/40">
        <span>0</span>
        <span>{AXIS_MAX / 2}</span>
        <span>{AXIS_MAX}</span>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-white/35">
        Top-down view of the grid floor (x and z run 0–{AXIS_MAX}); colour is height. The water fills up to
        the graph, and the number of points follows the volume under it. Use x, z, pi, e, + − * / ^ and
        sin, cos, sqrt, exp, abs, min, max…
      </p>
    </div>
  );
}

type PanelProps = {
  fluids: FluidEntry[];
  maxFluids: number;
  onAdd: () => void;
  onRemove: (id: number) => void;
  onColor: (id: number, color: string) => void;
  onApply: (id: number, expr: string, fn: SurfaceFn) => void;
};

/** Fluid selector (add / remove / colour) plus the surface graph editor for the selected fluid. */
export default function SurfacePanel({ fluids, maxFluids, onAdd, onRemove, onColor, onApply }: PanelProps) {
  const [selectedId, setSelectedId] = useState(fluids[0].id);
  const [open, setOpen] = useState(true);
  const selectedIndex = Math.max(
    0,
    fluids.findIndex((f) => f.id === selectedId),
  );
  const selected = fluids[selectedIndex];
  const full = fluids.length >= maxFluids;

  return (
    <div className="absolute right-5 top-5 max-h-[calc(100vh-2.5rem)] w-72 select-none overflow-y-auto rounded-2xl border border-white/15 bg-[#0b1226]/80 p-4 text-white shadow-xl backdrop-blur">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">
          Fluids <span className="font-normal text-white/40">{fluids.length}/{maxFluids}</span>
        </h2>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse panel" : "Expand panel"}
          className="rounded-md px-2 text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          {open ? "−" : "+"}
        </button>
      </div>

      {open && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {fluids.map((f, i) => (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                aria-label={`Select fluid ${i + 1}`}
                aria-pressed={f.id === selected.id}
                className={
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition " +
                  (f.id === selected.id
                    ? "border-sky-400/70 bg-sky-400/20"
                    : "border-white/15 bg-white/5 hover:bg-white/15")
                }
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />
                {i + 1}
              </button>
            ))}
            <button
              onClick={onAdd}
              disabled={full}
              aria-label="Add fluid"
              title={full ? `Maximum of ${maxFluids} fluids` : "Add a fluid"}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-white/5 text-sm transition enabled:hover:bg-white/15 disabled:opacity-35"
            >
              +
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
            <label className="flex items-center gap-2 text-xs text-white/60">
              Fluid {selectedIndex + 1}
              <span className="text-white/35">· {selected.sim.count} pts</span>
              <input
                type="color"
                value={selected.color}
                onChange={(e) => onColor(selected.id, e.target.value)}
                aria-label={`Colour of fluid ${selectedIndex + 1}`}
                className="h-6 w-8 cursor-pointer rounded border border-white/20 bg-transparent p-0"
              />
            </label>
            <button
              onClick={() => onRemove(selected.id)}
              disabled={fluids.length <= 1}
              className="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/70 transition enabled:hover:bg-red-500/20 enabled:hover:text-red-200 disabled:opacity-35"
            >
              Remove
            </button>
          </div>

          <div className="mt-3">
            <SurfaceEditor
              key={selected.id}
              initialExpr={selected.expr}
              onApply={(expr, fn) => onApply(selected.id, expr, fn)}
            />
          </div>
        </>
      )}
    </div>
  );
}
