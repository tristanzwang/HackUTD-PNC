/**
 * The arbiter: several domain agents bid for the same surplus, and a reasoning
 * model scores their bids against the user's stated priority order.
 *
 * Two things make this honest rather than theatre:
 *
 *  1. The proposals come from SEPARATE calls with separate contexts. One prompt
 *     that writes a whole fake debate is slop and judges spot it instantly. If
 *     you cannot afford N calls, show N proposals and no transcript - never a
 *     transcript you generated in one shot.
 *
 *  2. The arbiter ranks and scores; it does not do the arithmetic. Shares are
 *     normalised and applied deterministically after the verdict comes back.
 *
 * Note on naming: this is LLM-as-judge, not a trained reward model. Call it
 * what it is. There is no Nemotron 3 reward model on build.nvidia.com, and
 * describing a chat model as one is the kind of claim that loses a room.
 */

import { callTier, type CallRecord } from "../nemotron/client";
import { Proposal, Verdict } from "./schemas";

const SYSTEM = `You are the arbiter in a multi-agent personal finance system.
Several agents have each bid for a share of this month's surplus. Score every
bid from 0 to 10 against the user's priority list, which is absolute: a lower
priority never outranks a higher one, however strong its argument.

For each bid, "basis" must quote the priority-list entry that decided it.
Score on: whether the bid serves a higher priority, the cost of delay, and
whether the argument is supported by the numbers given. Ignore rhetoric.
Do not invent dollar amounts. Rank and score only.`;

export async function arbitrate(input: {
  priorities: string[];
  surplus: number;
  context: string;
  proposals: Proposal[];
}): Promise<{ verdict: Verdict; shares: Record<string, number>; record: CallRecord }> {
  const list = input.priorities.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const bids = input.proposals
    .map((p) => `- ${p.agent} | asks ${(p.share * 100).toFixed(0)}% | urgency ${p.urgency.toFixed(2)}\n  "${p.argument}"`)
    .join("\n");

  const { data, record } = await callTier({
    label: "arbitrate",
    tier: "deep",
    system: SYSTEM,
    schema: Verdict,
    user:
      `User priority list (absolute, highest first):\n${list}\n\n` +
      `Surplus to allocate this month: ${input.surplus.toFixed(2)}\n\n` +
      `Position:\n${input.context}\n\nBids:\n${bids}`,
  });

  // Deterministic allocation: scores become weights, weights become shares.
  // The model's numbers are never spent directly.
  const scored = data.ranking.filter((r) => input.proposals.some((p) => p.agent === r.agent));
  const total = scored.reduce((a, r) => a + r.score, 0);
  const shares: Record<string, number> = {};
  for (const r of scored) shares[r.agent] = total > 0 ? r.score / total : 1 / Math.max(scored.length, 1);

  return { verdict: data, shares, record };
}
