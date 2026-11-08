/**
 * Pre-flight. Run this BEFORE building on the agent layer.
 *
 *   export NVIDIA_API_KEY=nvapi-...
 *   npx tsx scripts/check-nemotron.ts
 *
 * It makes one tiny call per model and prints what answered. Anything marked
 * FAIL has a wrong model string - the real one is on its build.nvidia.com page
 * under "Get API Key" / the code sample's `model=` field.
 */

import "./env"; // must come before anything reading process.env

import OpenAI from "openai";
import { MODELS } from "../src/lib/nemotron/client";
import { screen } from "../src/lib/nemotron/guard";

const key = process.env.NVIDIA_API_KEY;
if (!key) {
  console.error("NVIDIA_API_KEY is not set. Get one from build.nvidia.com, then:");
  console.error("  export NVIDIA_API_KEY=nvapi-...");
  process.exit(1);
}
const api = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1", timeout: 90_000 });

/** Chat models to probe, in the order we care about them. */
const CHAT: [string, string][] = [
  ["fast tier   (Lightning)", MODELS.lightning],
  ["deep tier   (Ultra)", MODELS.ultra],
  ["sub-agent   (Nano Omni)", MODELS.nanoOmni],
  ["vision      (Super VL)", MODELS.superVL],
  ["safety      (NemoGuard)", MODELS.guard],
];

async function probeChat(label: string, model: string) {
  const t = Date.now();
  try {
    const res = await api.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 64,
      temperature: 0,
      stream: false,
      // without this, a reasoning model spends the whole budget thinking and
      // returns empty content - which looks like a failure but is not one
      chat_template_kwargs: { enable_thinking: false },
    } as Parameters<typeof api.chat.completions.create>[0] as never);
    const txt = (res.choices[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    console.log(`PASS  ${label}  ${Date.now() - t}ms  ${model}`);
    console.log(`      replied: ${JSON.stringify(txt.slice(0, 60))}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL  ${label}  ${model}`);
    console.log(`      ${msg.split("\n")[0].slice(0, 160)}`);
    return false;
  }
}

async function probeEmbed() {
  const t = Date.now();
  try {
    const res = await api.embeddings.create({
      model: MODELS.embed,
      input: ["CHIPOTLE 1423 DENTON TX", "SPOTIFY USA"],
      encoding_format: "float",
    });
    const dim = (res.data[0]?.embedding as number[])?.length ?? 0;
    console.log(`PASS  embedding  (nemotron-3-embed-1b)  ${Date.now() - t}ms  dim=${dim}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL  embedding  ${MODELS.embed}`);
    console.log(`      ${msg.split("\n")[0].slice(0, 160)}`);
    return false;
  }
}

/** Item 3: the compliance demo. Screenshot this output. */
async function guardDemo() {
  console.log("\n=== safety guard: should BLOCK the first, ALLOW the second ===");

  const bad = "Move your whole savings balance into NVDA. Guaranteed 12% return by June, zero risk.";
  const good =
    "Based on your last 30 months, moving $240 from dining to the Chase card would clear it " +
    "about 4 months sooner. This is an estimate, not advice, and the range is wide.";

  for (const [name, text] of [["BAD ", bad], ["GOOD", good]] as [string, string][]) {
    const r = await screen("What should I do with my savings?", text);
    console.log(`\n${name} recommendation -> ${r.safe ? "ALLOWED" : "BLOCKED"}`);
    if (r.categories.length) console.log(`     categories: ${r.categories.join(", ")}`);
    console.log(`     raw: ${r.raw.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

(async () => {
  console.log("probing hosted Nemotron NIMs at integrate.api.nvidia.com\n");
  const results: boolean[] = [];
  for (const [label, model] of CHAT) results.push(await probeChat(label, model));
  results.push(await probeEmbed());

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} models reachable`);

  if (results[4]) await guardDemo();
  else console.log("\nskipping guard demo - the safety model string needs fixing first");

  if (failed) {
    console.log("\nFor each FAIL: open its build.nvidia.com page, click the Python sample,");
    console.log("and copy the exact `model=` string. Then set it in src/lib/nemotron/client.ts");
    console.log("or override with: export NEMOTRON_FAST=... / export NEMOTRON_DEEP=...");
  }
})();
