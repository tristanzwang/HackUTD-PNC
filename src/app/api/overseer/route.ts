import type { NextRequest } from "next/server";
import * as z from "zod";
import { MessagesSchema, ObservationSchema, StoredProfile } from "@/lib/agents/chat-schemas";
import { integrate, makeBrief } from "@/lib/agents/overseer";
import { buildFacts } from "@/lib/finance/facts";
import { getProjection } from "@/lib/finance/pipeline";

const NO_STORE = { "Cache-Control": "no-store" };
const clean = (e: unknown) =>
  (e instanceof Error ? e.message : "overseer failed").replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***");

// the dataset on screen, so the facts Pluto may quote are the numbers the user sees
const Persona = z.enum(["tristan", "yuva"]).optional();

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("brief"), profile: StoredProfile, messages: MessagesSchema, persona: Persona }),
  z.object({
    action: z.literal("integrate"),
    profile: StoredProfile,
    messages: MessagesSchema,
    observations: z.array(ObservationSchema).max(5),
    askedAbout: z.string().max(120),
    persona: Persona,
  }),
]);

/**
 * The overseer.
 *   action "brief"      what should Pluto bring up now?  -> { brief }
 *   action "integrate"  fold in what Pluto learned: update the profile, verify any
 *                       forecast plans against the user's own words, and re-plan
 *                       -> { profile, brief, added, rejected }
 */
export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400, headers: NO_STORE });
  }
  if (!process.env.NVIDIA_API_KEY) {
    return Response.json({ error: "Pluto needs an NVIDIA_API_KEY." }, { status: 503, headers: NO_STORE });
  }
  const body = parsed.data;

  try {
    const projection = await getProjection({ adjustments: body.profile.adjustments, persona: body.persona });
    const facts = buildFacts(projection);

    if (body.action === "brief") {
      const { brief } = await makeBrief({ profile: body.profile, facts, messages: body.messages });
      return Response.json({ brief }, { headers: NO_STORE });
    }

    const r = await integrate({
      profile: body.profile,
      facts,
      observations: body.observations,
      messages: body.messages,
      askedAbout: body.askedAbout,
      futureMonths: projection.futureMonths,
      today: projection.months[projection.months.length - 1],
    });
    return Response.json(
      { profile: r.profile, brief: r.brief, added: r.added, rejected: r.rejected },
      { headers: NO_STORE },
    );
  } catch (e) {
    return Response.json({ error: clean(e) }, { status: 500, headers: NO_STORE });
  }
}
