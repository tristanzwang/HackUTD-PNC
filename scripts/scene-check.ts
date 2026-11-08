/** Sanity-check the dollars -> scene mapping. No API key, no network. */
import { makePersona } from "../src/lib/finance/synth";
import { layout, heightForAmount, packingFor, shares, formatUSD } from "../src/lib/finance/scene-bridge";
import type { CategoryKey } from "../src/lib/finance/synth";

const p = makePersona({ id: "s", label: "College student", seed: 20261108, nMonths: 36 });
const latest = {} as Partial<Record<CategoryKey, number>>;
for (const c of p.categories) latest[c.key] = p.series[c.key][29]; // month 30 = "today"

const cats = layout(latest);
const largest = Math.max(...cats.map((c) => c.amount));
const sh = shares(cats);

console.log("category        amount     slot orbit  height  share   debt");
for (const c of cats) {
  console.log(
    c.label.padEnd(15) + formatUSD(c.amount).padStart(9) +
    String(c.slot).padStart(6) + String(c.orbit).padStart(6) +
    heightForAmount(c.amount, largest).toFixed(1).padStart(8) +
    ((sh[c.key] ?? 0) * 100).toFixed(1).padStart(7) + "%" +
    (c.isDebt ? "   yes" : ""),
  );
}

console.log("\nscrubber check - credit card paid down over 6 months at ORBIT_PACKING 0.65:");
const card = cats.find((c) => c.isDebt)!;
for (const f of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
  const now = card.amount * f;
  console.log(`  ${formatUSD(now).padStart(8)}  ->  setPacking(${packingFor(now, card.amount).toFixed(4)})`);
}
