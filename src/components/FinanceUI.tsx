"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { FinanceScene } from "@/lib/finance/graph-data";
import { formatUSD } from "@/lib/finance/scene-bridge";
import type { Scrub } from "@/lib/finance/scrub";
import type { ProjectionState } from "./useProjection";
import { FOCUS, GLASS, PRESS, materialize } from "./ui";

/** How fast "play" runs through the future. */
const MONTHS_PER_SECOND = 1.1;

/**
 * Time scrubber for the solar system: drag (or press play) to move through the
 * forecast and watch every planet grow or shrink to what that world is worth.
 */
export function Scrubber({
  scrub,
  scene,
  show,
}: {
  scrub: Scrub;
  scene: FinanceScene;
  show: boolean;
}) {
  const k = useSyncExternalStore(scrub.subscribe, scrub.get, scrub.get);
  const [playing, setPlaying] = useState(false);
  const running = playing && show;

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = scrub.k + ((now - last) / 1000) * MONTHS_PER_SECOND;
      last = now;
      if (next >= scene.horizon) {
        scrub.set(scene.horizon);
        setPlaying(false);
        return;
      }
      scrub.set(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, scrub, scene.horizon]);

  const step = Math.min(Math.round(k), scene.horizon);
  const worthNow = scene.summary.netWorth[0];
  const worthThen = scene.summary.netWorth[step];
  const delta = worthThen - worthNow;
  const months = Math.round(k);

  return (
    <div
      inert={!show}
      className={
        "absolute bottom-5 left-1/2 w-[min(34rem,calc(100vw-9rem))] -translate-x-1/2 select-none " +
        "rounded-[1.75rem] px-4 py-3 text-white tabular-nums lining-nums " +
        GLASS +
        " " +
        materialize(show)
      }
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            if (!playing && k >= scene.horizon) scrub.set(0);
            setPlaying((p) => !p);
          }}
          aria-label={running ? "Pause" : "Play through the future"}
          className={
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/25 " +
            "bg-white/[0.06] hover:bg-white/15 " +
            PRESS +
            " " +
            FOCUS
          }
        >
          {running ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M3.5 2 10 6l-6.5 4Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[1.1rem] font-semibold tracking-[0.01em]">
              {months === 0 ? "Today" : scene.monthAt(k)}
              <span className="ml-2 text-sm font-normal text-white/45">
                {months === 0 ? scene.monthAt(0) : `in ${months} month${months === 1 ? "" : "s"}`}
              </span>
            </span>
            <span className="text-base text-white/80">
              Net worth {formatUSD(worthThen)}
              {months > 0 && (
                <span className={"ml-1.5 text-sm " + (delta >= 0 ? "text-emerald-300" : "text-rose-300")}>
                  {delta >= 0 ? "+" : "−"}
                  {formatUSD(Math.abs(delta))}
                </span>
              )}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={scene.horizon}
            step={0.05}
            value={k}
            onChange={(e) => {
              setPlaying(false);
              scrub.set(parseFloat(e.target.value));
            }}
            aria-label="Months from today"
            aria-valuetext={months === 0 ? "Today" : `${months} months from today`}
            className="slider mt-1 w-full"
            style={{ "--fill": `${(k / scene.horizon) * 100}%` } as React.CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A small pill saying what is reading the user's history: whether Nemotron or the
 * built-in rules chose the forecasts, how much history it has seen, and when.
 */
export function AgentStatus({ state }: { state: ProjectionState }) {
  const { data, error, loading } = state;
  let dot = "bg-white/40";
  let text = "Reading your history…";
  let title = "";
  if (data) {
    const n = data.months.length;
    dot = data.agent.live ? "bg-emerald-300" : "bg-amber-300";
    text = data.agent.live
      ? `Nemotron · ${n} months read`
      : `Built-in rules · ${n} months read`;
    title =
      (data.agent.note ? data.agent.note + "\n" : "") +
      `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  }
  if (error) {
    dot = "bg-rose-300";
    text = data ? "Offline · showing last forecast" : "Couldn’t load forecasts";
    title = error;
  } else if (!data && !loading) {
    text = "No forecast yet";
  }
  return (
    <div
      title={title}
      role="status"
      className={
        "rise flex select-none items-center gap-2 rounded-full px-3.5 py-2 " +
        "text-[0.98rem] text-white/80 " +
        GLASS
      }
    >
      <span className={"h-2 w-2 rounded-full " + dot + (loading ? " animate-pulse" : "")} />
      {text}
    </div>
  );
}
