/**
 * The overseer: the agent above the chatbot. It never speaks to the user.
 *
 * Two jobs:
 *   makeBrief   decide what Pluto should bring up right now (and what to leave alone),
 *               from the profile, the computed finance facts and the conversation so far.
 *   integrate   take what Pluto learned, keep the profile, propose forecast changes,
 *               and re-plan Pluto's next turns.
 *
 * What it can and cannot do to the forecast: it may PROPOSE a plan ("rent becomes
 * $1,500 in March"), but a plan is applied only if the user's own quote contains
 * that dollar amount and the month is inside the forecast (validateAdjustment).
 * The model chooses; code checks; the forecast code does all the arithmetic.
 */

import { callTier, type CallRecord } from "../nemotron/client";
import {
  mergeProfile,
  profileForPrompt,
  userTextsOf,
  validateAdjustment,
  verifyObservations,
} from "../chat/profile";
import type {
  ChatBrief,
  ChatMessage,
  FinanceFact,
  ForecastAdjustment,
  Observation,
  Profile,
} from "../chat/types";
import { BriefSchema, CATEGORY_KEYS, makeIntegrateSchema, type BriefOut } from "./chat-schemas";

const CATEGORY_HELP = `income (money coming in each month), housing (rent), essentials (groceries, utilities, transport), discretionary (fun, eating out, shopping), subscriptions, checking (balance), savings (balance), retirement (balance), card (credit card balance owed)`;

const BRIEF_RULES = `brief: plan what Pluto should do next.
- topics: up to 4, most valuable first, each with why it matters. Prefer (1) gaps in the portrait, (2) things in FACTS that the user's own context would help explain (only if they have not declined that subject), (3) follow-ups on things they already said, and (4) anything that would sharpen the forecast: a coming cost or change in income with an amount and timing, a goal, a constraint.
- mentionFactIds: up to 3 ids that appear in FACTS which Pluto may quote now. Fewer is better.
- avoid: concrete things Pluto should not do or raise: topics the user declined, angles that would feel pushy, sensitive things they have not opened up about.
- tone: one line on how to talk to this person, based only on what they have shown.
Never write a dollar figure of your own; refer to facts by id.`;

const BRIEF_SYSTEM = `You are the overseer in a multi-agent personal-finance system. You never speak to the user. A separate chatbot, "Pluto", does. Your job is to decide what Pluto should bring up right now so conversations are useful and the forecasts get better.

Pluto has two goals: learn about the user (character, spending habits, priorities, goals, upcoming events) and help them understand their finances. The forecasts improve when Pluto learns things the numbers cannot show.

The user's agency comes first. Pluto only offers; it never pushes. Plan topics that invite the user to share, not ones that corner them.

${BRIEF_RULES}

Reply with JSON: {"topics": [{"topic": string, "why": string}], "mentionFactIds": [string], "avoid": [string], "tone": string}.`;

const INTEGRATE_SYSTEM = `You are the overseer in a multi-agent personal-finance system. You never speak to the user. A separate chatbot, "Pluto", just talked with them and reported observations. You keep the user's profile, decide whether anything they said changes their forecast, and plan what Pluto should do next.

RULES
- Record only what the user said. Never infer sensitive traits (health, relationships, politics, religion), and never diagnose or judge.
- summary: a short, kind portrait (at most 4 sentences) built only from the profile and the new observations.
- priorities: ONLY things the user said they want, care about, or are working toward. Never turn a habit or an event into a priority (spending on food delivery is a habit, not a priority; a move is an event). When unsure, leave it out. Most important first; keep existing ones unless contradicted. At most 6.
- retireFactIds: ids of existing facts that the new information makes outdated or wrong.
- adjustments: changes to the forecast. Create one ONLY when the user stated a concrete change with BOTH a dollar amount and a timing, for example "my rent goes up to $1,500 in March". Rules:
    * "evidence" must be an exact quote from the user that contains the dollar amount.
    * "amount" is that exact figure. Do not add, subtract, convert or estimate.
    * "startMonth" must be one of the allowed months, and "category" one of the listed categories.
    * If the amount or the timing is vague, do NOT create an adjustment. Put what to clarify into the brief topics instead.
    * kind: level_shift = the monthly amount changes from startMonth on; one_off = a single month's cost or income (for savings, retirement or card: a one-time deposit, withdrawal or payment); recurring = repeats every "everyMonths" months.
    * direction: increase or decrease of that category's amount. For income: more or less income. For rent, essentials, discretionary, subscriptions: higher or lower spending. For savings or retirement: a deposit is an increase. For the card: a payment is a decrease, a new charge an increase.
    * mode "set" only with level_shift when the user gave the new level itself ("rent will be $1,500"). Otherwise "add".
    * "note": one plain line the user will read, such as "Rent rises to $1,500 from Mar 2027".
- dropAdjustmentIds: ids of existing plans the user has now changed or cancelled.
- The user's agency comes first. Never plan topics that corner or pressure them.

${BRIEF_RULES}

CATEGORIES: ${CATEGORY_HELP}.`;

function factsText(facts: FinanceFact[]) {
  return facts.length ? facts.map((f) => `[${f.id}] ${f.text}`).join("\n") : "(none)";
}

function convoText(messages: ChatMessage[]) {
  if (!messages.length) return "(the conversation has not started)";
  return messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Pluto"}: ${m.content}`)
    .join("\n");
}

/** Keep only fact ids that exist, and stamp the brief. */
function toBrief(out: BriefOut, facts: FinanceFact[], now = new Date()): ChatBrief {
  const ids = new Set(facts.map((f) => f.id));
  // model output is allowed to run long; trim to what the chatbot and the UI are built for
  return {
    topics: out.topics.slice(0, 4).map((t) => ({ topic: t.topic.slice(0, 160), why: t.why.slice(0, 300) })),
    mentionFactIds: out.mentionFactIds.filter((id) => ids.has(id)).slice(0, 3),
    avoid: out.avoid.slice(0, 5).map((a) => a.slice(0, 240)),
    tone: out.tone.slice(0, 300),
    createdAt: now.toISOString(),
  };
}

/** What should Pluto bring up now? Called when the chat opens. */
export async function makeBrief(input: {
  profile: Profile;
  facts: FinanceFact[];
  messages: ChatMessage[];
}): Promise<{ brief: ChatBrief; record: CallRecord }> {
  const { data, record } = await callTier({
    label: "overseer:brief",
    tier: "fast",
    system: BRIEF_SYSTEM,
    schema: BriefSchema,
    temperature: 0.4,
    user:
      `WHAT WE KNOW ABOUT THE USER:\n${profileForPrompt(input.profile)}\n\n` +
      `FINANCE FACTS (computed; the only figures Pluto may quote):\n${factsText(input.facts)}\n\n` +
      `ALREADY ASKED ABOUT: ${input.profile.asked.length ? input.profile.asked.join("; ") : "(nothing yet)"}\n\n` +
      `CONVERSATION SO FAR:\n${convoText(input.messages)}`,
  });
  return { brief: toBrief(data, input.facts), record };
}

export type IntegrateResult = {
  profile: Profile;
  brief: ChatBrief;
  /** Plans that passed verification and are now part of the forecast. */
  added: ForecastAdjustment[];
  /** Plans the model proposed that were not applied, and why (shown to the user). */
  rejected: { note: string; reason: string }[];
  record: CallRecord;
};

/** Fold what Pluto learned into the profile, check any forecast plans, and re-plan. */
export async function integrate(input: {
  profile: Profile;
  facts: FinanceFact[];
  observations: Observation[];
  messages: ChatMessage[];
  askedAbout: string;
  /** Forecast month labels (index 0 = next month) and today's label. */
  futureMonths: string[];
  today: string;
}): Promise<IntegrateResult> {
  const userTexts = userTextsOf(input.messages);
  // Pluto's observations were already checked, but this endpoint takes them from the
  // client, so check again against the user's words.
  const observations = verifyObservations(input.observations, userTexts);

  // A figure in the user's words may be a plan worth checking carefully, so use the deep tier then.
  const hasNumbers = observations.some((o) => /\d/.test(o.evidence));
  const schema = makeIntegrateSchema(input.futureMonths);

  const { data, record } = await callTier({
    label: "overseer:integrate",
    tier: hasNumbers ? "deep" : "fast",
    system: INTEGRATE_SYSTEM,
    schema,
    temperature: 0.2,
    user:
      `TODAY: ${input.today} (month 0). ALLOWED START MONTHS: ${input.futureMonths.join(", ")}.\n\n` +
      `WHAT WE KNEW BEFORE:\n${profileForPrompt(input.profile)}\n\n` +
      `NEW OBSERVATIONS FROM PLUTO:\n${observations.length ? observations.map((o) => `- (${o.kind}) ${o.statement}  | quote: "${o.evidence}"`).join("\n") : "(none)"}\n\n` +
      `FINANCE FACTS (computed):\n${factsText(input.facts)}\n\n` +
      `RECENT USER MESSAGES, verbatim, for quoting:\n${userTexts.slice(-6).map((t) => `"${t}"`).join("\n") || "(none)"}\n\n` +
      `Topic Pluto just asked about: ${input.askedAbout || "(none)"}`,
  });

  const added: ForecastAdjustment[] = [];
  const rejected: { note: string; reason: string }[] = [];
  for (const draft of data.adjustments.slice(0, 6)) {
    const v = validateAdjustment(draft, userTexts, input.futureMonths, CATEGORY_KEYS);
    if (v.ok) added.push(v.adjustment);
    else rejected.push({ note: draft.note, reason: v.reason });
  }

  const profile = mergeProfile(input.profile, {
    summary: data.summary,
    priorities: data.priorities.slice(0, 6).map((x) => x.slice(0, 160)),
    retireFactIds: data.retireFactIds,
    newFacts: observations.filter((o) => o.confidence >= 0.4),
    adjustments: added,
    dropAdjustmentIds: data.dropAdjustmentIds,
    asked: input.askedAbout || undefined,
  });

  return { profile, brief: toBrief(data.brief, input.facts), added, rejected, record };
}
