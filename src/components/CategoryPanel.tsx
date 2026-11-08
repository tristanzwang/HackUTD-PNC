"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { FinanceGraph, FinanceScene } from "@/lib/finance/graph-data";
import type { ModelInfo } from "@/lib/finance/projection";
import { formatUSD } from "@/lib/finance/scene-bridge";
import type { Scrub } from "@/lib/finance/scrub";
import { Typewriter } from "./FinanceUI";
import { Divider, Orb } from "./Ornaments";
import { FOCUS, GLASS, PRESS, materialize } from "./ui";

const KIND_LABEL = {
  balance: "Asset",
  debt: "Debt",
  outflow: "Monthly spending",
  inflow: "Monthly income",
} as const;

/** Plain names for the forecasters, for people who have never heard of "drift". */
const MODEL_LABEL: Record<ModelInfo["kind"], string> = {
  naive: "Holding steady",
  drift: "Compounding trend",
  linear: "Steady trend",
  seasonal: "Yearly cycle",
};

const GOOD = "text-emerald-300";
const BAD = "text-rose-300";

/**
 * The sidebar for one finance category: what it is worth now and at the scrubbed
 * month, how the forecast was reached (and by whom), and a plain-language reading.
 * It opens from the legend in both views.
 */
export default function CategoryPanel({
  open,
  graph,
  scene,
  scrub,
  onClose,
}: {
  open: boolean;
  graph: FinanceGraph;
  scene: FinanceScene;
  scrub: Scrub;
  onClose: () => void;
}) {
  const k = useSyncExternalStore(scrub.subscribe, scrub.get, scrub.get);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const { cat } = graph;
  const now = graph.amountAt(0);
  const then = graph.amountAt(k);
  const range = graph.rangeAt(k);
  const change = then - now;
  // for money you owe or spend, more is worse; for money you have or earn, more is better
  const upIsGood = cat.kind === "balance" || cat.kind === "inflow";
  const tone = Math.abs(change) < 1 ? "text-white/60" : change > 0 === upIsGood ? GOOD : BAD;
  const m = cat.model;
  const call = m.call;

  return (
    <aside
      inert={!open}
      aria-label={`${cat.label} details`}
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
        <Orb color={graph.color} size={22} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-none tracking-[-0.01em]">{cat.label}</h2>
          <p className="mt-1 text-sm text-white/45">{KIND_LABEL[cat.kind]}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className={
            "flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white " +
            PRESS +
            " " +
            FOCUS
          }
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 2.5l7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <Divider className="relative my-3.5" />

      <dl className="relative space-y-2 text-[1.05rem]">
        <div className="flex items-baseline justify-between">
          <dt className="text-white/60">Today</dt>
          <dd className="font-semibold">{formatUSD(now)}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-white/60">{k < 0.5 ? "Now" : scene.monthAt(k)}</dt>
          <dd className="font-semibold">
            {formatUSD(then)}
            {k >= 0.5 && (
              <span className={"ml-2 text-sm font-normal " + tone}>
                {change >= 0 ? "+" : "−"}
                {formatUSD(Math.abs(change))}
              </span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt className="text-white/60">Likely range</dt>
          <dd className="text-white/85">
            {formatUSD(range.lo)}–{formatUSD(range.hi)}
          </dd>
        </div>
      </dl>

      <Divider className="relative my-3.5" />

      <div className="relative">
        <p className="text-sm text-white/45">How this was read</p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-base font-semibold">{MODEL_LABEL[m.kind]}</span>
          <span className="rounded-full border border-white/20 px-2 py-0.5 text-xs text-white/70">
            {m.source === "nemotron"
              ? `Nemotron${call ? ` · ${call.tier === "deep" ? "Ultra" : "Lightning"} · ${(call.ms / 1000).toFixed(1)}s` : ""}`
              : "Built-in rules"}
          </span>
        </div>
        <p
          title={m.rationale}
          className="mt-1.5 line-clamp-4 text-[0.98rem] italic leading-snug text-white/65"
        >
          {/* type Nemotron's rationale out the first time this panel is opened */}
          {open && m.source === "nemotron" ? (
            <Typewriter key={m.rationale} text={m.rationale} />
          ) : (
            m.rationale
          )}
        </p>
        <div className="mt-2.5 flex items-center gap-2 text-sm text-white/45">
          Confidence
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full bg-white/70"
              style={{ width: `${Math.round(m.confidence * 100)}%` }}
            />
          </span>
          <span className="w-9 text-right">{Math.round(m.confidence * 100)}%</span>
        </div>
      </div>

      <Divider className="relative my-3.5" />

      <p className="relative text-[1.02rem] leading-snug text-white/85">{cat.insight}</p>
      <p className="relative mt-3 text-[0.8rem] leading-snug text-white/35">
        An estimate from past patterns, not a guarantee. Real life changes.
      </p>
    </aside>
  );
}
