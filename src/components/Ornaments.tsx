/**
 * A few light astrological touches, all white and hairline-thin: a row of moon
 * phases for dividers, a crescent for heading marks, and the glowing orb that
 * stands for a fluid. Pure SVG/CSS, no images.
 */

const INK = "#ffffff";

const ROMAN: [number, string][] = [
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];
/** 1 -> I, 4 -> IV, 8 -> VIII. */
export function roman(n: number) {
  let out = "";
  for (const [v, sym] of ROMAN) {
    while (n >= v) {
      out += sym;
      n -= v;
    }
  }
  return out;
}

/**
 * One moon, lit from the right. `lit` is the lit fraction: 0 new, 0.5 half, 1 full.
 * Drawn as an outline with the lit part filled, like a calendar glyph.
 */
export function Moon({
  lit,
  size = 12,
  className = "",
}: {
  lit: number;
  size?: number;
  className?: string;
}) {
  const r = 5;
  const c = 6;
  // lit area = right half-disc, plus (gibbous) or minus (crescent) half an ellipse
  const rx = Math.abs(1 - 2 * lit) * r;
  const sweep = lit < 0.5 ? 0 : 1;
  const d =
    lit >= 0.999
      ? `M${c} ${c - r}A${r} ${r} 0 1 1 ${c} ${c + r}A${r} ${r} 0 1 1 ${c} ${c - r}Z`
      : `M${c} ${c - r}A${r} ${r} 0 0 1 ${c} ${c + r}A${rx} ${r} 0 0 ${sweep} ${c} ${c - r}Z`;
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className={className}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={INK} strokeWidth="0.7" opacity="0.7" />
      {lit > 0.001 && <path d={d} fill={INK} opacity="0.9" />}
    </svg>
  );
}

/** A hairline that fades at both ends, with the moon's phases strung along the middle. */
export function Divider({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={"flex items-center gap-3 " + className}>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/30" />
      <span className="flex items-center gap-1.5 text-white">
        {[0, 0.25, 0.5, 0.75, 1].map((lit) => (
          <Moon key={lit} lit={lit} size={11} />
        ))}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/30" />
    </div>
  );
}

/**
 * An ornamental rule for one side of the tab bar: a long hairline that fades as it
 * runs outward, a shorter line beneath it, and a small orb-and-diamond at the inner
 * end. `side` is which side of the bar it sits on.
 */
export function Flourish({ side }: { side: "left" | "right" }) {
  const left = side === "left";
  return (
    <div
      aria-hidden
      className={
        "flex min-w-0 max-w-64 flex-1 items-center gap-2 " + (left ? "flex-row" : "flex-row-reverse")
      }
    >
      <div className={"flex min-w-0 flex-1 flex-col gap-[5px] " + (left ? "items-end" : "items-start")}>
        <span
          className={
            "h-px w-full " +
            (left
              ? "bg-gradient-to-r from-transparent to-white/35"
              : "bg-gradient-to-l from-transparent to-white/35")
          }
        />
        <span
          className={
            "h-px w-3/5 " +
            (left
              ? "bg-gradient-to-r from-transparent to-white/20"
              : "bg-gradient-to-l from-transparent to-white/20")
          }
        />
      </div>
      <span className="h-1 w-1 shrink-0 rounded-full bg-white/60" />
      <svg width="9" height="9" viewBox="0 0 9 9" className="shrink-0">
        <path d="M4.5 0 9 4.5 4.5 9 0 4.5Z" fill="none" stroke={INK} strokeWidth="0.8" opacity="0.75" />
        <circle cx="4.5" cy="4.5" r="1" fill={INK} opacity="0.85" />
      </svg>
    </div>
  );
}

/**
 * Two hairlines running down either edge of the page, each broken in the middle by a
 * rising moon (waxing on the left, waning on the right, so they mirror).
 */
export function PageFrame() {
  const edge = (side: "left" | "right") => (
    <div
      aria-hidden
      className={
        "pointer-events-none absolute inset-y-0 flex flex-col items-center " +
        (side === "left" ? "left-2.5" : "right-2.5")
      }
    >
      <span className="w-px flex-1 bg-gradient-to-b from-transparent to-white/25" />
      <span className="flex flex-col items-center gap-2.5 py-3">
        <span className="h-1 w-1 rounded-full bg-white/55" />
        {[0.2, 0.5, 0.8].map((lit) => (
          <Moon key={lit} lit={lit} size={12} className={side === "right" ? "-scale-x-100" : ""} />
        ))}
        <span className="h-1 w-1 rounded-full bg-white/55" />
      </span>
      <span className="w-px flex-1 bg-gradient-to-t from-transparent to-white/25" />
    </div>
  );
  return (
    <>
      {edge("left")}
      {edge("right")}
    </>
  );
}

/** A crescent with a couple of stars, used as a heading mark. */
export function Sigil({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        d="M15.5 3.2A9 9 0 1 0 20.8 15 7.2 7.2 0 0 1 15.5 3.2Z"
        fill="none"
        stroke={INK}
        strokeWidth="0.9"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path d="M19 4.2 19.6 5.9 21.3 6.5 19.6 7.1 19 8.8 18.4 7.1 16.7 6.5 18.4 5.9Z" fill={INK} opacity="0.9" />
      <circle cx="21.6" cy="11.6" r="0.7" fill={INK} opacity="0.7" />
    </svg>
  );
}

/**
 * A fluid as a glowing orb. When `selected`, a slow-turning hairline ring with a
 * small moon on it surrounds it. The glow is the fluid's own colour.
 */
export function Orb({
  color,
  selected = false,
  size = 20,
}: {
  color: string;
  selected?: boolean;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size + 12, height: size + 12 }}
    >
      <svg
        viewBox="0 0 40 40"
        className={
          "absolute inset-0 transition-opacity duration-500 " +
          (selected ? "orb-ring opacity-100" : "opacity-0")
        }
      >
        <circle cx="20" cy="20" r="18.2" fill="none" stroke={INK} strokeWidth="0.7" opacity="0.7" />
        <circle cx="20" cy="1.8" r="2.4" fill="#0b1226" stroke={INK} strokeWidth="0.7" />
        <path d="M20 -0.2A2 2 0 0 1 20 3.8A1 2 0 0 0 20 -0.2Z" transform="translate(0 0)" fill={INK} />
      </svg>
      <span
        className="rounded-full"
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 32% 28%, #fff 0, ${color} 38%, color-mix(in srgb, ${color} 55%, #000) 100%)`,
          boxShadow: `0 0 ${size * 0.7}px ${color}88, inset 0 -2px 4px rgba(0,0,0,0.35)`,
        }}
      />
    </span>
  );
}
