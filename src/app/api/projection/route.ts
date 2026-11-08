import type { NextRequest } from "next/server";
import * as z from "zod";
import { StoredAdjustment } from "@/lib/agents/chat-schemas";
import { getProjection } from "@/lib/finance/pipeline";
import type { PersonaId } from "@/lib/finance/synth";

const NO_STORE = { "Cache-Control": "no-store" };

const personaOf = (raw: unknown): PersonaId | undefined =>
  raw === "yuva" ? "yuva" : raw === "tristan" ? "tristan" : undefined;

/** Never echo anything that looks like an API key back to a client. */
const clean = (e: unknown) =>
  (e instanceof Error ? e.message : "projection failed").replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***");

/**
 * The user's projected finances. Reading the request makes this a request-time
 * handler (it must run live: it calls the model and reads the current history).
 *
 *   GET  /api/projection            the baseline, cached against a hash of the history
 *   GET  /api/projection?refresh=1  re-run the agents now
 *   GET  /api/projection?persona=yuva|tristan   a demo dataset (default: tristan)
 *   POST /api/projection            the same, with the user's plans applied
 *                                   body: { adjustments: ForecastAdjustment[], persona? }
 *
 * Plans never trigger new model calls: the forecaster picks are cached.
 */
export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  const persona = personaOf(request.nextUrl.searchParams.get("persona"));
  try {
    return Response.json(await getProjection({ force, persona }), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: clean(e) }, { status: 500, headers: NO_STORE });
  }
}

const Body = z.object({
  adjustments: z.array(StoredAdjustment).max(24),
  persona: z.enum(["tristan", "yuva"]).optional(),
});

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json(
      await getProjection({ adjustments: parsed.data.adjustments, persona: parsed.data.persona }),
      { headers: NO_STORE },
    );
  } catch (e) {
    return Response.json({ error: clean(e) }, { status: 500, headers: NO_STORE });
  }
}
