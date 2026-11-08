import type { NextRequest } from "next/server";
import * as z from "zod";
import { chat } from "@/lib/agents/chatbot";
import { MessagesSchema, StoredBrief, StoredProfile } from "@/lib/agents/chat-schemas";
import { buildFacts } from "@/lib/finance/facts";
import { getProjection } from "@/lib/finance/pipeline";

const NO_STORE = { "Cache-Control": "no-store" };
const clean = (e: unknown) =>
  (e instanceof Error ? e.message : "chat failed").replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***");

const Body = z.object({
  mode: z.enum(["greet", "reply"]),
  messages: MessagesSchema,
  profile: StoredProfile,
  brief: StoredBrief.nullable(),
  persona: z.enum(["tristan", "yuva"]).optional(),
});

/**
 * One turn with the chatbot (Pluto). It is told what the overseer wants discussed
 * (the brief) and which computed finance facts it may quote; it returns its reply
 * plus what it learned from the user's message, as quoted observations. It does NOT
 * update the profile or the forecast: that is the overseer's job (/api/overseer).
 */
export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400, headers: NO_STORE });
  }
  const { mode, messages, profile, brief, persona } = parsed.data;
  if (mode === "reply" && messages.at(-1)?.role !== "user") {
    return Response.json({ error: "nothing to reply to" }, { status: 400, headers: NO_STORE });
  }
  if (!process.env.NVIDIA_API_KEY) {
    return Response.json(
      { error: "Pluto needs an NVIDIA_API_KEY to talk." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const projection = await getProjection({ adjustments: profile.adjustments, persona });
    const all = buildFacts(projection);
    // only the facts the overseer allowed; with no brief yet, a couple of the basics
    const facts = brief ? all.filter((f) => brief.mentionFactIds.includes(f.id)) : all.slice(0, 2);
    const r = await chat({ mode, brief, facts, profile, messages });
    return Response.json(
      { reply: r.reply, observations: r.observations, askedAbout: r.askedAbout, safety: r.safety },
      { headers: NO_STORE },
    );
  } catch (e) {
    return Response.json({ error: clean(e) }, { status: 500, headers: NO_STORE });
  }
}
