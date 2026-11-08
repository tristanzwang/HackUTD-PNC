/**
 * End-to-end evaluation of the estimator.
 *
 * Generate a persona with KNOWN parameters, hide the last 6 months, let
 * Nemotron choose a forecaster per category from the first 30, then score its
 * choices on the months it never saw - against carry-forward (the baseline any
 * budgeting app already gives you) and against the oracle (the best choice
 * available in hindsight).
 *
 * This is the slide. Run it, screenshot it, quote it.
 */

import "./env"; // must come before anything reading process.env

import { makePersona } from "../src/lib/finance/synth";
import { chooseModel } from "../src/lib/agents/estimator";
import { scoreSpec, rankSpecs } from "../src/lib/finance/backtest";
import type { FitSpec } from "../src/lib/finance/forecast";

const MONTHS = 36;
const TRAIN = 30;

(async () => {
  const p = makePersona({ id: "student", label: "College student", seed: 20261108, nMonths: MONTHS });
  console.log(`persona: ${p.label} | ${MONTHS} months | train ${TRAIN}, hold out ${MONTHS - TRAIN}`);
  console.log(`models: Lightning (fast) / Ultra (deep)\n`);

  type Row = {
    label: string; picked: string; oracle: string; conf: number;
    nemo: number; naive: number; best: number; ms: number; tier: string; why: string;
  };
  const rows: Row[] = [];

  for (const c of p.categories) {
    const y = p.series[c.key];
    const train = y.slice(0, TRAIN);
    let spec: FitSpec, conf = 0, why = "", ms = 0, tier = "-";
    try {
      const r = await chooseModel({
        label: c.label,
        kind: c.kind,
        months: p.months.slice(0, TRAIN),
        values: train,
      });
      spec = r.spec; conf = r.choice.confidence; why = r.choice.rationale;
      ms = r.record.ms; tier = r.record.tier;
    } catch (e) {
      spec = { kind: "naive" };
      why = `CALL FAILED: ${e instanceof Error ? e.message.slice(0, 80) : e}`;
    }
    const ranked = rankSpecs(y, TRAIN);
    rows.push({
      label: c.label,
      picked: spec.kind + (spec.kind === "seasonal" ? `(${spec.period})` : ""),
      oracle: ranked[0].spec.kind,
      conf,
      nemo: scoreSpec(y, TRAIN, spec).mae,
      naive: ranked.find((r) => r.spec.kind === "naive")!.mae,
      best: ranked[0].mae,
      ms, tier, why,
    });
    process.stdout.write(".");
  }
  console.log("\n");

  console.log("category        picked        oracle     conf   nemoMAE   naiveMAE    gain%   tier     ms");
  for (const r of rows) {
    const gain = r.naive === 0 ? 0 : ((r.naive - r.nemo) / r.naive) * 100;
    console.log(
      r.label.padEnd(15) + r.picked.padEnd(14) + r.oracle.padEnd(11) +
      r.conf.toFixed(2).padStart(5) + r.nemo.toFixed(1).padStart(10) +
      r.naive.toFixed(1).padStart(11) + (gain >= 0 ? "+" : "") + gain.toFixed(1).padStart(7) +
      "   " + r.tier.padEnd(7) + String(r.ms).padStart(6),
    );
  }

  const gains = rows.map((r) => (r.naive === 0 ? 0 : ((r.naive - r.nemo) / r.naive) * 100));
  const mean = (x: number[]) => x.reduce((a, v) => a + v, 0) / x.length;
  const totalNemo = rows.reduce((a, r) => a + r.nemo, 0);
  const totalNaive = rows.reduce((a, r) => a + r.naive, 0);
  const totalBest = rows.reduce((a, r) => a + r.best, 0);
  const matched = rows.filter((r) => r.picked.replace(/\(.*/, "") === r.oracle).length;

  console.log(`\nmean per-category improvement vs carry-forward : ${mean(gains).toFixed(1)}%`);
  console.log(`total absolute error, Nemotron picks           : ${totalNemo.toFixed(0)}`);
  console.log(`total absolute error, carry-forward baseline   : ${totalNaive.toFixed(0)}  (${(((totalNaive - totalNemo) / totalNaive) * 100).toFixed(1)}% better)`);
  console.log(`total absolute error, oracle (hindsight)       : ${totalBest.toFixed(0)}  (ceiling)`);
  console.log(`matched the oracle on ${matched}/${rows.length} categories`);

  console.log(`\n--- what it said ---`);
  for (const r of rows) console.log(`${r.label}: ${r.why}`);
})();
