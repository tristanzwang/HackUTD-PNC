/**
 * The chatbot ("Pluto"): the only agent that talks to the user.
 *
 * It is deliberately separate from the overseer. Pluto has no memory of its own and
 * no say over the forecast: it gets a brief from the overseer (what is worth
 * exploring, which computed facts it may mention, what to avoid) and reports back
 * what it learned as quoted observations. The overseer decides what to keep.
 *
 * Pluto's manner is enforced three ways, because a prompt alone is not a guarantee:
 *   1. the system prompt (curious, courteous, options not orders);
 *   2. a wording check that catches directive phrasing and asks for a rewrite;
 *   3. the NemoGuard classifier, which catches specific advice or promised returns.
 */

import { callTier, type CallRecord } from "../nemotron/client";
import { screen } from "../nemotron/guard";
import { verifyObservations, userTextsOf } from "../chat/profile";
import type { ChatBrief, ChatMessage, FinanceFact, Observation, Profile } from "../chat/types";
import { profileForPrompt } from "../chat/profile";
import { ChatTurn } from "./chat-schemas";

const SYSTEM = `You are "Pluto", a warm, curious companion inside a personal-finance visualizer. The user sees their money drawn as graphs and planets. You help them understand it, and you get to know them.

YOUR TWO JOBS
1. Get to know them. Learn their character, how they actually spend, what they care about, what they are working toward, and what is coming up in their life. Ask one open, genuine question at a time and follow what they say. Be curious about the person, not just the numbers.
2. Help them understand their money. When it is relevant and they seem interested, explain what the numbers mean in plain language (define any jargon in a few words) and lay out options with their trade-offs.

HOW YOU TREAT THEM (hard rules)
- It is their life and their money. You offer; you never push. Never tell them what they must, should, or need to do. Never request, urge, plead, pressure, guilt, or scare. Phrase suggestions as options: "one option is...", "some people in this spot...", "if it would help, we could...".
- If they decline, deflect, or do not want to discuss something, accept it warmly and move on. Do not raise it again unless they do.
- No judgement about their spending or choices.
- You are not a licensed advisor. Never recommend a specific stock, fund, or product, and never promise or guarantee a result. Projections are estimates from past patterns.
- Only state a dollar figure or percentage that appears in FACTS or that the user said. Never calculate, estimate or invent numbers, and do not draw your own conclusions about what a number will become (for example how a new rent changes their share of income); say you can show that in the forecast instead.
- Keep it short: at most three short sentences, then ONE question (or none, if they just asked you something and an answer is enough). No lists, no headings, no emoji.
- Do not repeat a question listed under ALREADY ASKED.
- The overseer's BRIEF is guidance on what is worth exploring now, not a script. Follow the conversation first; if they bring up something else, go with that.

WHAT YOU REPORT
Besides your reply, report what you learned. "observations" lists things the user actually said about themselves in their messages, never guesses. For each: "kind", a short statement in the third person (for example "Works part-time at the campus library"), "evidence" which is an exact quote copied from the user's words, and "confidence" from 0 to 1. If they said nothing new about themselves, return an empty list. "askedAbout" is a few words naming the topic of the question you just asked, or "".

Reply with JSON: {"reply": string, "observations": [...], "askedAbout": string}.`;

/** Directive wording that breaks "offer, never push". Checked after every draft. */
const DIRECTIVE =
  /\b(you (must|need to|have to|ought to|better|really should|definitely should|should)|make sure (you|to)|don'?t forget to|i (urge|insist|implore|beg)|i strongly (recommend|suggest|advise)|please (do|try to|consider|stop|start|make sure))\b/i;

const FALLBACK =
  "I’d rather keep this general than steer you wrong. Tell me a bit more about what you’re trying to figure out, and we can look at it together.";

function briefText(brief: ChatBrief | null) {
  if (!brief) return "(none yet: just be curious about who they are and what they are working toward)";
  const lines = brief.topics.map((t) => `- ${t.topic}: ${t.why}`);
  if (brief.avoid.length) lines.push(`Avoid: ${brief.avoid.join("; ")}`);
  if (brief.tone) lines.push(`Tone: ${brief.tone}`);
  return lines.join("\n");
}

function convoText(messages: ChatMessage[]) {
  if (!messages.length) return "(the conversation has not started)";
  return messages
    .slice(-12)
    .map((m) => `${m.role === "user" ? "User" : "Pluto"}: ${m.content}`)
    .join("\n");
}

export type ChatResult = {
  reply: string;
  observations: Observation[];
  askedAbout: string;
  /** Whether a draft had to be rewritten: for transparency, not shown by default. */
  safety: "ok" | "rewritten" | "fallback";
  record: CallRecord;
};

export async function chat(input: {
  mode: "greet" | "reply";
  brief: ChatBrief | null;
  /** The finance facts the overseer allowed. These are the only numbers Pluto may use. */
  facts: FinanceFact[];
  profile: Profile;
  messages: ChatMessage[];
}): Promise<ChatResult> {
  const task =
    input.mode === "greet"
      ? "This is the very start. Greet them briefly and warmly in your own words, then ask one easy, open question about THEM as a person (what a typical week looks like, or what they are hoping their money can do for them), not for a number. Do not list what you can do."
      : "Reply to the user's last message.";

  const base =
    `BRIEF FROM THE OVERSEER:\n${briefText(input.brief)}\n\n` +
    `FACTS YOU MAY MENTION (the only numbers you may use):\n` +
    `${input.facts.length ? input.facts.map((f) => `- ${f.text}`).join("\n") : "(none right now)"}\n\n` +
    `WHAT WE KNOW ABOUT THEM:\n${profileForPrompt(input.profile)}\n\n` +
    `ALREADY ASKED ABOUT: ${input.profile.asked.length ? input.profile.asked.join("; ") : "(nothing yet)"}\n\n` +
    `CONVERSATION SO FAR:\n${convoText(input.messages)}\n\n${task}`;

  const draft = async (extra: string) =>
    callTier({
      label: `chat:${input.mode}`,
      tier: "fast",
      system: SYSTEM,
      schema: ChatTurn,
      temperature: 0.6,
      user: extra ? `${base}\n\n${extra}` : base,
    });

  let { data, record } = await draft("");
  let safety: ChatResult["safety"] = "ok";

  // 2. directive wording -> one rewrite as options
  const pushy = DIRECTIVE.exec(data.reply);
  if (pushy) {
    safety = "rewritten";
    ({ data, record } = await draft(
      `Your previous draft said "${pushy[0]}", which tells the user what to do. Rewrite the reply so it only offers options and asks a question; never instruct or request.`,
    ));
  }

  // 3. NemoGuard on the reply (the user side is neutral on purpose: people share their
  // own finances here, and that must not be flagged as private data)
  const neutral = "The user is talking about their own personal finances.";
  let verdict = await screen(neutral, data.reply);
  if (!verdict.safe) {
    safety = "rewritten";
    ({ data, record } = await draft(
      "Your previous draft was flagged as unsafe financial advice. Rewrite it with no specific product, no promised return, and no certainty about the future; keep it to understanding and options.",
    ));
    verdict = await screen(neutral, data.reply);
    if (!verdict.safe || DIRECTIVE.test(data.reply)) {
      safety = "fallback";
      data = { reply: FALLBACK, observations: data.observations, askedAbout: "" };
    }
  } else if (DIRECTIVE.test(data.reply)) {
    // the rewrite was still directive: fall back rather than push
    safety = "fallback";
    data = { reply: FALLBACK, observations: data.observations, askedAbout: "" };
  }

  // an observation only counts if its quote is something the user really said
  const observations = verifyObservations(data.observations.slice(0, 5), userTextsOf(input.messages));
  return { reply: data.reply, observations, askedAbout: data.askedAbout, safety, record };
}
