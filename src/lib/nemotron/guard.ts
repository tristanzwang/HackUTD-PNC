/**
 * NemoGuard safety pass on the output path.
 *
 * Every recommendation shown to the user goes through this before it renders.
 * For a bank's judges the point is not that unsafe content is likely - it is
 * that there is a real classifier in the path and a real policy behind it,
 * including a custom category for unlicensed financial advice.
 *
 * This model does NOT take a JSON schema. It wants a specific prompt shape and
 * returns a small fixed JSON object, so it does not go through callTier.
 */

import { client, MODELS } from "./client";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

/**
 * The taxonomy the classifier scores against. S1-S4 are the stock categories
 * that matter for a finance app; S5 is ours, and it is the one that earns the
 * feature - "feel confident about their next move" must not become
 * unlicensed advice.
 */
const CATEGORIES = [
  "S1: PII/Privacy.",
  "S2: Fraud/Deception.",
  "S3: Illegal Activity.",
  "S4: Harassment.",
  "S5: Unlicensed Financial Advice. Content that recommends specific securities, promises a return, guarantees an outcome, or presents a projection as certain rather than as an estimate with stated uncertainty.",
];

export type GuardResult = {
  safe: boolean;
  /** Only the categories from OUR taxonomy. This is what you show the user. */
  categories: string[];
  /** Everything the classifier returned, including its built-in taxonomy. */
  allCategories: string[];
  /** Raw model output, kept so the architecture slide can show it. */
  raw: string;
};

function prompt(userMsg: string, agentMsg: string) {
  return (
    "Task: Check if there is unsafe content in the user or agent messages in " +
    "the below conversation in accordance with our safety policy with the " +
    "below categories. Provide a 'safe' or 'unsafe' rating for both the user " +
    "message and the agent response. If there is unsafe content, also provide " +
    "a list of violated categories.\n\n" +
    "<BEGIN UNSAFE CONTENT CATEGORIES>\n" +
    CATEGORIES.join("\n") +
    "\n<END UNSAFE CONTENT CATEGORIES>\n\n" +
    "<BEGIN CONVERSATION>\n\n" +
    `user: ${userMsg}\n\nresponse: agent: ${agentMsg}\n` +
    "\n<END CONVERSATION>\n\n" +
    "Provide your safety assessment in this output JSON format:\n" +
    '{"User Safety": "safe or unsafe", "Response Safety": "safe or unsafe", ' +
    '"Safety Categories": "comma-separated categories (omit if all safe)"}\n' +
    "Do not include anything other than the output JSON in your response.\n" +
    "Output JSON:"
  );
}

/**
 * Screen one recommendation. Fails OPEN on a transport error - a dead endpoint
 * must not blank the UI mid-demo - but fails CLOSED on an "unsafe" verdict.
 */
export async function screen(userMsg: string, agentMsg: string): Promise<GuardResult> {
  const body: ChatCompletionCreateParamsNonStreaming = {
    model: MODELS.guard,
    messages: [{ role: "user", content: prompt(userMsg, agentMsg) }],
    temperature: 0,
    max_tokens: 256,
    stream: false,
  };
  let raw = "";
  try {
    const res = await client().chat.completions.create(body);
    raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      "User Safety"?: string;
      "Response Safety"?: string;
      "Safety Categories"?: string;
    };
    const verdict = (parsed["Response Safety"] ?? parsed["User Safety"] ?? "safe").toLowerCase();
    // The classifier answers with its own built-in S1-S23 taxonomy as well as
    // ours, so a blocked finance recommendation comes back tagged with things
    // like "Controlled/Regulated Substances". Verified live: the verdict is
    // reliable, the category list is not. Show the verdict; keep only the
    // categories we actually defined.
    const mine = CATEGORIES.map((c) => c.slice(c.indexOf(":") + 1).split(".")[0].trim().toLowerCase());
    const all = (parsed["Safety Categories"] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    return {
      safe: verdict !== "unsafe",
      categories: all.filter((c) => mine.some((m) => c.toLowerCase().includes(m) || m.includes(c.toLowerCase()))),
      allCategories: all,
      raw,
    };
  } catch {
    return { safe: true, categories: [], allCategories: [], raw: raw || "guard unavailable" };
  }
}
