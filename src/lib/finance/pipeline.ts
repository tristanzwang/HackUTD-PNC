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
import snapshot from "./projection-snapshot.json";
import { PERSONAS, makePersona, type CategoryKey, type Persona, type PersonaId } from "./synth";

export const DEFAULT_PERSONA: PersonaId = "tristan";

// Ten years, so a long "what if" scenario is reachable. The scrubber's default
// visible range stays at 24 (see DEFAULT_SCRUB_MONTHS), so raising this does not
// change the normal view — long scenarios are reached by scrubbing out.
export const HORIZON = 120;

/** The scrubber shows this many months by default; scenarios extend it to their run. */
export const DEFAULT_SCRUB_MONTHS = 24;

// ---------------------------------------------------------------------------
// the history source
// ---------------------------------------------------------------------------

/**
 * Where the user's monthly history comes from. There is no bank connection yet, so
 * this is the synthetic college-student persona, ending at the current month. When
 * real data exists (transactions rolled up to these categories by month), replace
 * the body of this one function and nothing else in the pipeline changes.
 */
export async function loadHistory(persona: PersonaId = DEFAULT_PERSONA): Promise<Persona> {
  const now = new Date();
  const p = PERSONAS[persona];
  return makePersona({
    id: p.id,
    label: p.label,
    categories: p.categories,
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

/** The model's forecaster picks for one history, and whether they were baked in at build time. */
type Chosen = {
  choices: Partial<Record<CategoryKey, Choice>>;
  note?: string;
  /** True when the picks come from the shipped snapshot rather than a model run in this process. */
  fromSnapshot: boolean;
};

/**
 * Picks are the expensive part (a model call per category), so they are cached against a
 * hash of the history alone: every persona, and every unchanged history, is remembered
 * separately, and a changed plan never re-spends tokens. A cold start is seeded from the
 * snapshot made by scripts/build-snapshot.ts, so the first request answers instantly.
 * Only the snapshot's picks are used; the numbers are always rebuilt locally, so plans
 * and the persona apply to them like to any other forecast.
 */
const chosen = new Map<string, Chosen>();
const inflight = new Map<string, Promise<Chosen>>();
/** Finished projections by history + plans, so the same question is never answered twice. */
const results = new Map<string, Projection>();

function seedFromSnapshot() {
  const s = snapshot as unknown as Pick<Projection, "version" | "categories" | "agent">;
  if (typeof s.version !== "string" || !Array.isArray(s.categories)) return;
  const choices: Partial<Record<CategoryKey, Choice>> = {};
  for (const c of s.categories) {
    choices[c.key] = {
      spec: { kind: c.model.kind, period: c.model.period },
      confidence: c.model.confidence,
      rationale: c.model.rationale,
      source: c.model.source,
      call: c.model.call,
    };
  }
  chosen.set(s.version, { choices, fromSnapshot: true });
}
seedFromSnapshot();

async function getChoices(persona: Persona, version: string, force: boolean): Promise<Chosen> {
  const hit = chosen.get(version);
  if (hit && !force) return hit;
  const pending = inflight.get(version);
  if (pending) return pending; // several callers at once share one set of model calls
  const run = (async () => {
    try {
      const { choices, note } = await chooseAll(persona);
      const fresh: Chosen = { choices, note, fromSnapshot: false };
      chosen.set(version, fresh);
      return fresh;
    } finally {
      inflight.delete(version);
    }
  })();
  inflight.set(version, run);
  return run;
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
 * The projection for a demo dataset and the user's plans. The model's picks are cached
 * against the history, so changing a plan re-runs only the (instant, local) forecast
 * math and never spends model tokens.
 */
export async function getProjection(
  opts: { force?: boolean; persona?: PersonaId; adjustments?: ForecastAdjustment[] } = {},
): Promise<Projection> {
  const persona = await loadHistory(opts.persona);
  const version = versionOf(persona);
  const plans = opts.adjustments ?? [];
  const pk = plansKey(plans);
  const key = `${version}:${pk}`;

  if (opts.force) {
    chosen.delete(version);
    for (const k of results.keys()) if (k.startsWith(`${version}:`)) results.delete(k);
  }
  const hit = results.get(key);
  if (hit) return hit;

  const picked = await getChoices(persona, version, !!opts.force);
  const result = buildProjection(
    persona,
    HORIZON,
    picked.choices,
    {
      version: pk ? `${version}+${pk}` : version,
      generatedAt: new Date().toISOString(),
      note: picked.note,
      stale: picked.fromSnapshot,
    },
    plans,
  );
  if (results.size >= 24) results.delete(results.keys().next().value as string);
  results.set(key, result);
  return result;
}
