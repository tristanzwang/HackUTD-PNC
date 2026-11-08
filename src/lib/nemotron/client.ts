/**
 * Single entry point for every Nemotron call.
 *
 * Two things matter here and nothing else does:
 *
 *  1. TIERS. Nemotron 3 is a family, not a model. A per-asset tick that runs
 *     on every commit uses Nano with thinking off (fast, cheap). A strategic
 *     replan or an arbitration runs Super/Ultra with thinking on (slow, deep).
 *     `callTier` records latency and token counts per call so the UI can show
 *     which tier answered and what it cost. That record is the evidence that
 *     this is a routed system and not one model behind a chat box.
 *
 *  2. STRUCTURE. Every call returns JSON validated against a Zod schema.
 *     Reasoning models wrap output in <think> blocks and markdown fences, so
 *     we strip both, parse, validate, and on failure retry ONCE with the
 *     validation error fed back. If it still fails we throw - we never hand a
 *     half-parsed object to the simulator.
 *
 * The LLM never produces a dollar figure. It returns model choices, priors,
 * labels, rankings and prose. Arithmetic happens in ../finance.
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import * as z from "zod";

export const BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Every model here is a hosted NIM on build.nvidia.com. Slugs follow the
 * build.nvidia.com URL path, which is what the OpenAI-compatible endpoint
 * expects. Re-check them before the demo; the lineup moves fast.
 *
 * LIGHTNING is the 3.5 reasoning tier NVIDIA built for always-on agents
 * (30B MoE, 3B active, 1M context) - the right hot path. ULTRA is the frontier
 * tier for multi-agent arbitration. Nemotron 3 Super (120B-A12B) is NOT
 * confirmed as a hosted NIM, so it is deliberately absent.
 */
export const MODELS = {
  /** Hot path: fast reasoning, thinking off. */
  lightning: "nvidia/nemotron-3.5-lightning-30b-a3b",
  /** Multimodal sub-agent alternative to lightning (video/audio/image/text). */
  nanoOmni: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  /** Frontier reasoning for arbitration and strategic replans. */
  ultra: "nvidia/nemotron-3-ultra-550b-a55b",
  /** Vision-language, for reading a statement screenshot. */
  superVL: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  /** Nemotron Retrieval embedding model: 2048-dim, L2-normalised. */
  embed: "nvidia/nemotron-3-embed-1b",
  /** NemoGuard safety classifier. Bespoke prompt format - see guard.ts. */
  guard: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
} as const;

/**
 * Probed live against this account on 2026-11-08. All six MODELS entries above
 * answered. These are listed by /v1/models but 404 on call - do not use them:
 *   nvidia/nemotron-3-super-120b-a12b   (no Super tier; Ultra is the deep tier)
 *   nvidia/nemotron-4-340b-reward       (no reward model; arbiter is LLM-as-judge)
 *   nvidia/nemotron-3.5-content-safety  (use MODELS.guard instead)
 * Measured: Lightning ~0.4s thinking off; Ultra ~7.4s thinking on, which is why
 * the deep tier only runs on commit and never inside the render loop.
 */

export type Tier = "fast" | "deep";

/** What each tier maps to. Thinking off on the hot path, on for judgement. */
const TIER_CONFIG: Record<Tier, { model: string; thinking: boolean; maxTokens: number }> = {
  fast: { model: MODELS.lightning, thinking: false, maxTokens: 1024 },
  deep: { model: MODELS.ultra, thinking: true, maxTokens: 8192 },
};

/** Override either tier from the environment if a slug turns out to be wrong. */
if (process.env.NEMOTRON_FAST) TIER_CONFIG.fast.model = process.env.NEMOTRON_FAST;
if (process.env.NEMOTRON_DEEP) TIER_CONFIG.deep.model = process.env.NEMOTRON_DEEP;

let cached: OpenAI | null = null;
export function client(): OpenAI {
  if (!cached) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
    cached = new OpenAI({ apiKey, baseURL: BASE_URL, timeout: 120_000, maxRetries: 2 });
  }
  return cached;
}

/** Per-call telemetry. Push these into the agent panel; they are the proof. */
export type CallRecord = {
  label: string;
  tier: Tier;
  model: string;
  thinking: boolean;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** How many times the schema had to be re-asked. 0 = first try was valid. */
  repairs: number;
};

export const callLog: CallRecord[] = [];

/** Reasoning models leak <think> blocks and ```json fences into content. */
function stripToJson(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  // an unterminated think block means the model ran out of tokens mid-thought
  s = s.replace(/<think>[\s\S]*$/g, "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const start = s.search(/[[{]/);
  if (start === -1) return s.trim();
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  return end > start ? s.slice(start, end + 1).trim() : s.slice(start).trim();
}

/**
 * Call a tier and return JSON validated against `schema`.
 * Throws if the model cannot produce valid JSON in two attempts.
 */
export async function callTier<T extends z.ZodType>(opts: {
  label: string;
  tier: Tier;
  system: string;
  user: string;
  schema: T;
  temperature?: number;
}): Promise<{ data: z.output<T>; record: CallRecord }> {
  const cfg = TIER_CONFIG[opts.tier];
  const jsonShape = JSON.stringify(z.toJSONSchema(opts.schema));
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    {
      role: "system",
      content:
        `${opts.system}\n\n` +
        `Reply with a single JSON object and nothing else. No prose, no code fences.\n` +
        `It must validate against this JSON Schema:\n${jsonShape}\n\n` +
        `You do not compute dollar amounts. You choose models, estimate ` +
        `coefficients, classify, rank and explain. Arithmetic is done downstream.`,
    },
    { role: "user", content: opts.user },
  ];

  const started = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;

  for (let repairs = 0; repairs <= 1; repairs++) {
    // chat_template_kwargs is a NIM extension, so the body is widened past the
    // SDK's type. stream stays false, so the result is a plain ChatCompletion.
    const body: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      top_p: 0.95,
      max_tokens: cfg.maxTokens,
      stream: false,
      chat_template_kwargs: { enable_thinking: cfg.thinking },
    };
    const res = await client().chat.completions.create(body);

    promptTokens += res.usage?.prompt_tokens ?? 0;
    completionTokens += res.usage?.completion_tokens ?? 0;

    const content = res.choices[0]?.message?.content ?? "";
    const parsed = opts.schema.safeParse(JSON.parse(stripToJson(content) || "null"));

    if (parsed.success) {
      const record: CallRecord = {
        label: opts.label,
        tier: opts.tier,
        model: cfg.model,
        thinking: cfg.thinking,
        ms: Date.now() - started,
        promptTokens,
        completionTokens,
        repairs,
      };
      callLog.push(record);
      return { data: parsed.data, record };
    }

    if (repairs === 1) {
      throw new Error(
        `${opts.label}: schema invalid after repair - ${JSON.stringify(parsed.error.issues).slice(0, 400)}`,
      );
    }
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content:
        `That failed schema validation:\n${JSON.stringify(parsed.error.issues).slice(0, 800)}\n` +
        `Return corrected JSON only.`,
    });
  }
  throw new Error("unreachable");
}

/**
 * Embed strings with nemotron-3-embed-1b. 2048 dimensions; vectors come back
 * L2-normalised, so cosine similarity is a plain dot product.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const res = await client().embeddings.create({
    model: MODELS.embed,
    input: texts,
    encoding_format: "float",
  });
  return res.data.map((d) => d.embedding as number[]);
}
