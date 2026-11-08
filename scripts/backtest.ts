import { makePersona } from "../src/lib/finance/synth";
import { rankSpecs, judge } from "../src/lib/finance/backtest";
import type { FitSpec } from "../src/lib/finance/forecast";

const MONTHS = 36;
const TRAIN = 30;
const p = makePersona({ id: "student", label: "College student", seed: 20261108, nMonths: MONTHS });

console.log(`persona: ${p.label}  months: ${p.months[0]} -> ${p.months[p.months.length - 1]}`);
console.log(`train on ${TRAIN}, hold out ${MONTHS - TRAIN}\n`);
console.log("category        truth(drift/season)   oracle     oracle MAE   naive MAE   gain%");

const oracleChoice: Record<string, FitSpec> = {};
for (const c of p.categories) {
  const y = p.series[c.key];
  const ranked = rankSpecs(y, TRAIN);
  const best = ranked[0];
  const naive = ranked.find((r) => r.spec.kind === "naive")!;
  oracleChoice[c.key] = best.spec;
  const gain = naive.mae === 0 ? 0 : ((naive.mae - best.mae) / naive.mae) * 100;
  console.log(
    c.label.padEnd(15) +
      `${(c.truth.drift * 100).toFixed(2)}%/mo ${c.truth.seasonAmp > 0 ? `s=${c.truth.seasonAmp}` : "s=0  "}`.padEnd(22) +
      best.spec.kind.padEnd(11) +
      best.mae.toFixed(2).padStart(10) +
      naive.mae.toFixed(2).padStart(12) +
      (gain >= 0 ? "+" : "") + gain.toFixed(1).padStart(6),
  );
}

console.log("\n-- what a WRONG pick costs (everything forced to naive) --");
let totGain = 0, n = 0;
for (const c of p.categories) {
  const v = judge(c.label, p.series[c.key], TRAIN, oracleChoice[c.key]);
  totGain += v.improvementPct; n++;
}
console.log(`mean improvement over carry-forward, oracle picks: ${(totGain / n).toFixed(1)}%`);
