"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FinanceScene, ForecastMode } from "@/lib/finance/graph-data";
import { formatUSD } from "@/lib/finance/scene-bridge";
import type { Scenario } from "@/lib/finance/scenario";
import type { Scrub } from "@/lib/finance/scrub";
import { sfxReceive, sfxSend } from "@/lib/sfx";
import type { CategoryKey } from "@/lib/finance/synth";
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
  scrubMax,
}: {
  scrub: Scrub;
  scene: FinanceScene;
  show: boolean;
  /** Months the scrubber reaches. Defaults to the full horizon; the app keeps it at 24
   *  normally and extends it to a scenario's run so long scenarios stay reachable. */
  scrubMax?: number;
}) {
  const max = Math.min(scrubMax ?? scene.horizon, scene.horizon);
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
      if (next >= max) {
        scrub.set(max);
        setPlaying(false);
        return;
      }
      scrub.set(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, scrub, max]);

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
            if (!playing && k >= max) scrub.set(0);
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
            max={max}
            step={0.05}
            value={Math.min(k, max)}
            onChange={(e) => {
              setPlaying(false);
              scrub.set(parseFloat(e.target.value));
            }}
            aria-label="Months from today"
            aria-valuetext={months === 0 ? "Today" : `${months} months from today`}
            className="slider mt-1 w-full"
            style={{ "--fill": `${(Math.min(k, max) / max) * 100}%` } as React.CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}

const MODE_INFO: Record<ForecastMode, string> = {
  raw: "Carry-forward — every category just holds today's value.",
  interpreted: "Nemotron picks a model per category (trend, seasonal, drift…).",
};

/**
 * The console for the Galaxy view: pick the forecast source and set what the
 * orbits protect first. Docked to the left edge so it never sits over the
 * scrubber. The forecast flip is disabled at k = 0 — history is identical either
 * way — and each mode label carries a clickable superscript ⁱ for its blurb.
 */
export function ControlCenter({
  scrub,
  scene,
  show,
  priority,
  onMove,
}: {
  scrub: Scrub;
  scene: FinanceScene;
  show: boolean;
  priority: CategoryKey[];
  onMove: (key: CategoryKey, dir: -1 | 1) => void;
}) {
  const k = useSyncExternalStore(scrub.subscribe, scrub.get, scrub.get);
  const [mode, setMode] = useState<ForecastMode>("interpreted");
  const [info, setInfo] = useState<ForecastMode | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const modeLocked = k <= 0;

  // a fresh projection rebuilds the scene back on "interpreted"; keep it in step
  useEffect(() => {
    scene.setMode(mode);
  }, [scene, mode]);

  const choose = (m: ForecastMode) => {
    if (modeLocked) return;
    setMode(m);
    scene.setMode(m); // the frame loop reads this next tick; planets resize smoothly
  };

  // label + colour per category, from the scene; rows follow the current priority
  const meta = new Map(scene.graphs.map((g) => [g.cat.key, { label: g.label, color: g.color }]));
  const rows = priority.filter((key) => meta.has(key));

  // date stamp for the handle, e.g. "NOV 8, 2026"
  const dateStamp = new Date()
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    .toUpperCase();

  return (
    <>
      {/* the handle on the left wall: the console's name and the date, with a
          chevron. Click to slide the console out, or tuck it away again. */}
      <button
        inert={!show}
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Open control center" : "Collapse control center"}
        aria-expanded={!collapsed}
        className={
          "absolute left-0 top-1/2 z-10 flex h-[min(28rem,66vh)] w-7 -translate-y-1/2 " +
          "flex-col items-center justify-center gap-6 rounded-r-2xl py-4 text-white/70 hover:text-white " +
          GLASS +
          " ring-1 ring-white/10 " +
          PRESS +
          " " +
          FOCUS +
          " " +
          materialize(show)
        }
      >
        <span aria-hidden className="absolute top-2.5 text-sm">
          {collapsed ? "›" : "‹"}
        </span>
        <span className="font-sans text-[0.62rem] font-medium uppercase tracking-[0.25em] text-white/80 [writing-mode:vertical-rl]">
          Control Center
        </span>
        <span className="font-sans text-[0.56rem] uppercase tracking-[0.2em] text-white/55 [writing-mode:vertical-rl]">
          {dateStamp}
        </span>
      </button>

      {/* the console; hugs the handle when open, tucks left behind it when closed */}
      <div
        className={
          "absolute left-7 top-1/2 -translate-y-1/2 transition-transform duration-[400ms] " +
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none " +
          (collapsed ? "pointer-events-none -translate-x-[calc(100%+2.5rem)]" : "translate-x-0")
        }
      >
        <aside
          inert={!show || collapsed}
          aria-label="Control center"
          className={
            "relative max-h-[74vh] w-72 select-none overflow-y-auto overflow-x-hidden " +
            "rounded-2xl px-4 py-3.5 text-white " +
            GLASS +
            " ring-1 ring-white/10 " +
            materialize(show)
          }
        >
          {/* forecast source — only meaningful once you've scrubbed into the
              future, so it appears only while time-warping (k > 0) */}
          {k > 0 && (
            <>
              <p className="mb-2 font-sans text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-white/50">
                Forecast source
              </p>
              <div
                role="tablist"
                aria-label="Forecast source"
                className="flex gap-0.5 rounded-full bg-white/[0.06] p-0.5"
              >
                {(["raw", "interpreted"] as ForecastMode[]).map((m) => {
                  const active = mode === m;
                  return (
                    <div key={m} className="relative flex flex-1">
                      <button
                        role="tab"
                        aria-selected={active}
                        onClick={() => choose(m)}
                        className={
                          "w-full rounded-full py-1 pl-7 pr-3 text-[0.95rem] " +
                          (active
                            ? "bg-white/15 text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                            : "text-white/55 hover:text-white/85") +
                          " " +
                          PRESS +
                          " " +
                          FOCUS
                        }
                      >
                        {m === "raw" ? "Raw" : "Interpreted"}
                      </button>
                      {/* circled-i on the left; its own button so it always clicks */}
                      <button
                        type="button"
                        aria-label={`What does ${m} mean?`}
                        aria-pressed={info === m}
                        onClick={() => setInfo(info === m ? null : m)}
                        className={
                          "absolute left-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center " +
                          "justify-center rounded-full border border-white/40 font-sans text-[0.58rem] " +
                          "leading-none text-white/70 hover:border-white/80 hover:text-white " +
                          FOCUS
                        }
                      >
                        i
                      </button>
                    </div>
                  );
                })}
              </div>
              {info && (
                <p className="mt-2 rounded-xl bg-white/5 px-3 py-2 text-[0.84rem] leading-snug text-white/70">
                  {MODE_INFO[info]}
                </p>
              )}

              <div className="my-3 h-px bg-white/10" />
            </>
          )}

          {/* priorities */}
          <p className="mb-2 font-sans text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-white/50">
            Priorities
          </p>
          <ol className="flex flex-col gap-0.5">
            {rows.map((key, i) => {
              const m = meta.get(key)!;
              return (
                <li
                  key={key}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/5"
                >
                  <span className="w-3 font-sans text-[0.72rem] tabular-nums text-white/35">{i + 1}</span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                  <span className="min-w-0 flex-1 truncate text-[1rem]">{m.label}</span>
                  <button
                    disabled={i === 0}
                    onClick={() => onMove(key, -1)}
                    aria-label={`Move ${m.label} closer to the sun`}
                    className={
                      "flex h-6 w-6 items-center justify-center rounded-lg text-white/55 " +
                      "hover:bg-white/10 hover:text-white disabled:opacity-20 " +
                      PRESS +
                      " " +
                      FOCUS
                    }
                  >
                    ↑
                  </button>
                  <button
                    disabled={i === rows.length - 1}
                    onClick={() => onMove(key, 1)}
                    aria-label={`Move ${m.label} away from the sun`}
                    className={
                      "flex h-6 w-6 items-center justify-center rounded-lg text-white/55 " +
                      "hover:bg-white/10 hover:text-white disabled:opacity-20 " +
                      PRESS +
                      " " +
                      FOCUS
                    }
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-2.5 px-1 text-[0.88rem] italic leading-snug text-white/45">
            Closer to the sun is what you protect first.
          </p>
        </aside>
      </div>
    </>
  );
}

/**
 * A small pill saying what is reading the user's history: whether Nemotron or the
 * built-in rules chose the forecasts, how much history it has seen, and when.
 */
export function AgentStatus({ state }: { state: ProjectionState }) {
  const { data, error, loading } = state;
  let dot = "bg-white/40";
  let hideDot = false;
  let text = "Reading your history…";
  let title = "";
  if (data) {
    const n = data.months.length;
    if (data.agent.live) {
      hideDot = true; // no status dot for the healthy Nemotron state
      text = `Nemotron ${n} months read`; // and no middle dot
    } else {
      dot = "bg-amber-300";
      text = `Built-in rules · ${n} months read`;
    }
    title =
      (data.agent.note ? data.agent.note + "\n" : "") +
      (data.stale ? "Pre-built snapshot; a fresh forecast is loading.\n" : "") +
      `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  }
  if (error) {
    dot = "bg-rose-300";
    hideDot = false;
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
        "rise absolute bottom-5 left-5 flex select-none items-center gap-2 rounded-full px-3.5 py-2 " +
        "text-[0.98rem] text-white/80 " +
        GLASS
      }
    >
      {!hideDot && (
        <span className={"h-2 w-2 rounded-full " + dot + (loading ? " animate-pulse" : "")} />
      )}
      {text}
      {data?.stale && (
        <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[0.7rem] uppercase tracking-wide text-white/55">
          cached
        </span>
      )}
    </div>
  );
}

/** Strip an optional "Pluto" wake word (any case, optional comma) from the front. */
function stripWakeWord(s: string): string {
  return s.replace(/^\s*pluto\b\s*,?\s*/i, "");
}

// Text the user has already watched type out once; reopening shows it at once.
const typed = new Set<string>();
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Types `text` out at a natural pace the FIRST time it is shown — used for prose
 * Nemotron generated (a category's rationale, a scenario reply), so reading it
 * feels like it is being written. Already-seen text (and reduced motion) appears
 * instantly. ~220 wpm.
 */
// NOTE: give this a `key={text}` at the call site, so a new text remounts it and
// re-runs the animation from the start.
export function Typewriter({ text, className }: { text: string; className?: string }) {
  const animate = !typed.has(text) && !prefersReducedMotion();
  const [len, setLen] = useState(animate ? 0 : text.length);

  useEffect(() => {
    if (!animate) return;
    const id = window.setInterval(() => {
      setLen((n) => {
        if (n >= text.length) {
          typed.add(text);
          window.clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, 46);
    return () => window.clearInterval(id);
  }, [text, animate]);

  return <span className={className}>{text.slice(0, len)}</span>;
}

type ChatReply =
  | { kind: "scenario"; reply: string; scenario: Scenario }
  | { kind: "priority"; reply: string; order: CategoryKey[] }
  | { kind: "none"; reply: string };

type PlutoMsg = { role: "you" | "pluto"; text: string };

const PANEL_W = 340; // px; used to keep the panel on screen
const PANEL_H = 440;

/** Clamp a panel top-left so the whole panel stays within the viewport. */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - PANEL_W - 8)),
    y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - PANEL_H - 8)),
  };
}

/** Pluto's planet glyph, idly bobbing. */
function PlutoGlyph({ size }: { size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/pluto.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="pluto-bob object-contain"
    />
  );
}

/**
 * Pluto, the guide. A small wobbling badge in the corner that opens into a
 * draggable chat panel. He talks like a friend and only conjures a "what if"
 * overlay when you actually ask for one. React state only — nothing persisted.
 */
export function PlutoChat({
  onScenario,
  onPriority,
}: {
  onScenario: (s: Scenario) => void;
  onPriority: (order: CategoryKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<PlutoMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const openRef = useRef(open);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const openPanel = () => {
    // open from the top-left corner the badge sits in, the first time
    setPos((p) => p ?? clampToViewport(20, 20));
    setOpen(true);
    setUnread(false);
  };

  // keep it fully on screen when the window resizes
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampToViewport(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // stick to the newest message
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, open, busy]);

  const send = async () => {
    const message = stripWakeWord(input).trim();
    if (!message || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "you", text: message }]);
    setBusy(true);
    sfxSend();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = (await res.json()) as ChatReply;
      setMessages((m) => [...m, { role: "pluto", text: data.reply }]);
      sfxReceive();
      if (data.kind === "scenario") onScenario(data.scenario);
      else if (data.kind === "priority") onPriority(data.order);
    } catch {
      setMessages((m) => [...m, { role: "pluto", text: "I couldn’t reach the stars just now — try again?" }]);
    } finally {
      setBusy(false);
      if (!openRef.current) setUnread(true);
    }
  };

  // drag the panel by its header
  const onHeaderDown = (e: React.PointerEvent) => {
    if (!pos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos(clampToViewport(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onHeaderUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <>
      {/* collapsed: a small wobbling badge in the corner */}
      <button
        onClick={openPanel}
        aria-label="Open Pluto"
        className={
          "absolute left-5 top-5 flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-white " +
          "transition-opacity duration-300 " +
          (open ? "pointer-events-none opacity-0 " : "opacity-100 ") +
          GLASS +
          " " +
          PRESS +
          " " +
          FOCUS
        }
      >
        <span className="relative flex h-8 w-8 items-center justify-center">
          <PlutoGlyph size={30} />
          {unread && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-sky-400 ring-2 ring-[#0b1226]" />
          )}
        </span>
        <span className="text-[0.95rem] font-medium tracking-[0.01em]">Pluto</span>
      </button>

      {/* expanded: the draggable chat panel */}
      {pos && (
        <div
          inert={!open}
          style={{ left: pos.x, top: pos.y, width: PANEL_W }}
          className={
            "absolute flex max-h-[min(27.5rem,calc(100vh-2.5rem))] flex-col overflow-hidden " +
            "rounded-[1.5rem] text-white " +
            GLASS +
            " " +
            materialize(open)
          }
        >
          {/* header is the drag handle */}
          <div
            onPointerDown={onHeaderDown}
            onPointerMove={onHeaderMove}
            onPointerUp={onHeaderUp}
            className="flex cursor-grab touch-none select-none items-center gap-2 px-3 py-2.5 active:cursor-grabbing"
          >
            <PlutoGlyph size={26} />
            <span className="flex-1 text-[1rem] font-semibold tracking-[0.01em]">Pluto</span>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
              className={
                "rounded-full px-2.5 py-1 text-[0.78rem] text-white/60 enabled:hover:bg-white/10 " +
                "enabled:hover:text-white disabled:opacity-30 " +
                PRESS +
                " " +
                FOCUS
              }
            >
              Clear
            </button>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setOpen(false)}
              aria-label="Collapse Pluto"
              className={
                "flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10 " +
                "hover:text-white " +
                PRESS +
                " " +
                FOCUS
              }
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* transcript */}
          <div
            ref={bodyRef}
            className="flex-1 space-y-2 overflow-y-auto px-3 pb-2 [scrollbar-width:thin]"
          >
            {messages.length === 0 && (
              <p className="px-1 py-6 text-center text-[0.92rem] leading-snug text-white/45">
                Hi, I’m Pluto. Ask me about your money — or try a what-if and watch it play out.
              </p>
            )}
            {messages.map((m, i) =>
              m.role === "you" ? (
                <p
                  key={i}
                  className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-sky-400/20 px-3 py-1.5 text-[0.92rem] leading-snug"
                >
                  {m.text}
                </p>
              ) : (
                <p
                  key={i}
                  className="mr-auto w-fit max-w-[90%] rounded-2xl rounded-bl-md bg-white/[0.07] px-3 py-1.5 text-[0.92rem] leading-snug text-white/85"
                >
                  <Typewriter key={m.text} text={m.text} />
                </p>
              ),
            )}
            {busy && (
              <p className="mr-auto flex w-fit gap-1 rounded-2xl bg-white/[0.07] px-3 py-2.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:300ms]" />
              </p>
            )}
          </div>

          {/* input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-center gap-2 p-2.5"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              placeholder="Talk to Pluto…"
              aria-label="Message Pluto"
              className={
                "min-w-0 flex-1 rounded-full bg-white/[0.06] px-3.5 py-2 text-[0.95rem] " +
                "placeholder:text-white/35 focus:outline-none " +
                FOCUS
              }
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className={
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/25 " +
                "bg-white/[0.06] hover:bg-white/15 disabled:opacity-40 " +
                PRESS +
                " " +
                FOCUS
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M2 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
        </div>
      )}
    </>
  );
}

/**
 * The hypothetical banner: the scenario label and its net-worth difference at the
 * end of the run against reality, with a way back. Shown while an overlay is up.
 */
export function ScenarioBanner({
  label,
  delta,
  show,
  onExit,
}: {
  label: string;
  delta: number;
  show: boolean;
  onExit: () => void;
}) {
  const up = delta >= 0;
  return (
    <div
      inert={!show}
      className={
        "absolute left-1/2 top-[4.75rem] flex w-[min(44rem,calc(100vw-2.5rem))] -translate-x-1/2 select-none " +
        "items-center gap-4 rounded-full px-5 py-2.5 text-white ring-1 ring-fuchsia-300/25 " +
        GLASS +
        " " +
        materialize(show)
      }
    >
      <span className="shrink-0 rounded-full bg-fuchsia-400/20 px-2.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fuchsia-100/90">
        What if
      </span>
      <Typewriter key={label} text={label} className="min-w-0 flex-1 truncate text-[1rem]" />
      <span className="shrink-0 text-[0.95rem] tabular-nums">
        Net worth{" "}
        <span className={up ? "text-emerald-300" : "text-rose-300"}>
          {up ? "+" : "−"}
          {formatUSD(Math.abs(delta))}
        </span>
      </span>
      <button
        onClick={onExit}
        className={
          "shrink-0 rounded-full px-3.5 py-1 text-[0.9rem] text-white " +
          "border border-white/25 bg-white/[0.06] hover:bg-white/15 " +
          PRESS +
          " " +
          FOCUS
        }
      >
        Back to reality
      </button>
    </div>
  );
}
