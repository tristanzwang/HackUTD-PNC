/**
 * Server-only. Reads the user's financial history, asks the Nemotron estimator to
 * pick a forecaster for every category, and builds the projection the frontend draws.
 *
 * Staying current: the result is cached against a hash of the history, so asking
 * again is free until the history changes. Whatever learns of a new checking-account
 * transaction should call getProjection() (or GET /api/projection) once; the changed
 * hash then re-runs the agents. Nothing polls on a timer.
 */

import { chooseModel } from "../agents/estimator";
import type { ForecastAdjustment } from "../chat/types";
import { buildProjection, heuristicChoice, type Choice, type Projection } from "./projection";
import { makePersona, type CategoryKey, type Persona } from "./synth";

export const HORIZON = 24;

// ---------------------------------------------------------------------------
// the history source
// ---------------------------------------------------------------------------

/**
 * Where the user's monthly history comes from. There is no bank connection yet, so
 * this is the synthetic college-student persona, ending at the current month. When
 * real data exists (transactions rolled up to these categories by month), replace
 * the body of this one function and nothing else in the pipeline changes.
 */
export async function loadHistory(): Promise<Persona> {
  const now = new Date();
  return makePersona({
    id: "student",
    label: "College student",
    nMonths: 36,
    endYear: now.getFullYear(),
    endMonth: now.getMonth(),
  });
}

/** A short hash of the history, so unchanged data is recognised cheaply. */
function versionOf(p: Persona): string {
  const s = p.months.join("|") + JSON.stringify(p.series);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// choosing a forecaster per category
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 40_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function chooseAll(persona: Persona) {
  const choices: Partial<Record<CategoryKey, Choice>> = {};
  const failures: string[] = [];
  const haveKey = !!process.env.NVIDIA_API_KEY;

  await Promise.all(
    persona.categories.map(async (spec) => {
      const y = persona.series[spec.key];
      if (!haveKey) {
        choices[spec.key] = heuristicChoice(y, spec.kind);
        return;
      }
      try {
        const { spec: fitSpec, choice, record } = await withTimeout(
          chooseModel({ label: spec.label, kind: spec.kind, months: persona.months, values: y }),
          CALL_TIMEOUT_MS,
        );
        // The estimator's guard can override the model (e.g. "seasonal" with no measured
        // cycle). Then the model's own rationale describes a pick we did not use, so
        // say what actually happened instead of showing text that contradicts the label.
        const overridden = fitSpec.kind !== choice.kind;
        choices[spec.key] = {
          spec: fitSpec,
          confidence: overridden ? Math.min(choice.confidence, 0.5) : choice.confidence,
          rationale: overridden
            ? `Nemotron suggested a ${choice.kind} model, but the measured pattern doesn’t support it, so a steady trend is used instead.`
            : choice.rationale,
          source: "nemotron",
          call: {
            model: record.model,
            tier: record.tier,
            thinking: record.thinking,
            ms: record.ms,
            repairs: record.repairs,
          },
        };
      } catch (e) {
        // one failed call must not blank the screen: fall back for this category only
        failures.push(`${spec.label}: ${e instanceof Error ? e.message : String(e)}`);
        choices[spec.key] = heuristicChoice(y, spec.kind);
      }
    }),
  );

  let note: string | undefined;
  if (!haveKey) note = "NVIDIA_API_KEY is not set, so projections use the built-in rules instead of Nemotron.";
  else if (failures.length) note = `Nemotron failed for ${failures.length} categor${failures.length === 1 ? "y" : "ies"} (used built-in rules there): ${failures[0]}`;
  return { choices, note };
}

// ---------------------------------------------------------------------------
// cached entry point
// ---------------------------------------------------------------------------

type Chosen = { version: string; choices: Partial<Record<CategoryKey, Choice>>; note?: string };
let chosen: Chosen | null = null;
let inflight: Promise<Chosen> | null = null;
/** Finished projections by history + plans, so the same question is never answered twice. */
const results = new Map<string, Projection>();

/** The model's forecaster picks. Expensive, so cached against the history alone. */
async function getChoices(persona: Persona, version: string, force: boolean): Promise<Chosen> {
  if (chosen && chosen.version === version && !force) return chosen;
  if (inflight) return inflight; // several callers at once share one set of model calls
  inflight = (async () => {
    try {
      const { choices, note } = await chooseAll(persona);
      chosen = { version, choices, note };
      return chosen;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** A short hash of a set of plans, so a changed plan list is a changed version. */
function plansKey(plans: ForecastAdjustment[]): string {
  if (!plans.length) return "";
  const s = plans.map((p) => [p.id, p.category, p.kind, p.startOffset, p.everyMonths, p.amount, p.direction, p.mode].join(",")).join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * The projection for the current history and the user's plans. The model's picks are
 * cached against the history, so changing a plan re-runs only the (instant, local)
 * forecast math and never spends model tokens.
 */
export async function getProjection(
  opts: { force?: boolean; adjustments?: ForecastAdjustment[] } = {},
): Promise<Projection> {
  const persona = await loadHistory();
  const version = versionOf(persona);
  const plans = opts.adjustments ?? [];
  const pk = plansKey(plans);
  const key = `${version}:${pk}`;

  if (opts.force) {
    chosen = null;
    results.clear();
  }
  const hit = results.get(key);
  if (hit) return hit;

  const { choices, note } = await getChoices(persona, version, !!opts.force);
  const result = buildProjection(
    persona,
    HORIZON,
    choices,
    { version: pk ? `${version}+${pk}` : version, generatedAt: new Date().toISOString(), note },
    plans,
  );
  if (results.size >= 12) results.delete(results.keys().next().value as string);
  results.set(key, result);
  return result;
}
