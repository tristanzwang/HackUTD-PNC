/**
 * Shared look-and-feel tokens. Every panel, chip and control draws from these,
 * so the whole interface moves and sits the same way.
 *
 * (Complete class strings on purpose: Tailwind finds classes by scanning source.)
 */

/** One easing for everything that enters or leaves: quick start, long soft landing. */
const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/**
 * Translucent glass: blurred, slightly saturated backdrop, a bright top edge where
 * light catches it, and a deep shadow. Honours reduced-transparency and more-contrast.
 */
export const GLASS =
  "border border-white/[0.12] bg-[#0b1226]/65 backdrop-blur-2xl backdrop-saturate-150 " +
  "shadow-[0_10px_40px_-8px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.09)] " +
  "[@media(prefers-reduced-transparency:reduce)]:bg-[#0b1226] " +
  "[@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none " +
  "contrast-more:border-white/50 contrast-more:bg-[#0b1226]";

/** Small pill buttons and chips. */
export const CHIP =
  "rounded-full border border-white/[0.14] bg-white/[0.06] text-white/80 " +
  "enabled:hover:bg-white/[0.14] enabled:hover:text-white";

/** The selected state of a chip. */
export const CHIP_ON = "border-sky-300/60 bg-sky-300/20 text-white";

/** Keyboard focus ring (mouse clicks never show it). */
export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-sky-300/80 focus-visible:ring-offset-1 " +
  "focus-visible:ring-offset-[#070b17]";

/** Press feedback: responds on pointer-down, not on release. */
export const PRESS =
  `transition-[scale,background-color,color,opacity,border-color] duration-200 ${EASE} ` +
  "active:scale-[0.96] active:duration-75 disabled:active:scale-100";

/**
 * A surface arriving or leaving: it blurs, scales and fades together, so it reads
 * as a material materializing rather than a plain fade. Set `origin-*` on the
 * element so it grows from the corner it lives in. Reduced motion falls back to a
 * short cross-fade. Pair with the `inert` attribute so hidden chrome is unreachable.
 */
export const materialize = (show: boolean) =>
  `transition-[opacity,scale,filter] duration-500 ${EASE} ` +
  "motion-reduce:transition-opacity motion-reduce:duration-200 " +
  (show
    ? "opacity-100 scale-100 blur-0"
    : "pointer-events-none opacity-0 scale-[0.94] blur-md motion-reduce:scale-100 motion-reduce:blur-0");

/**
 * Height-animating disclosure (no measured heights): wrap the content in a single
 * `min-h-0 overflow-hidden` child. Pair with `inert` while closed.
 */
export const collapsible = (open: boolean) =>
  `grid transition-[grid-template-rows,opacity] duration-500 ${EASE} motion-reduce:duration-150 ` +
  (open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0");
