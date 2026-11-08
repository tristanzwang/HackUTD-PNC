import type { NextRequest } from "next/server";
import { getProjection } from "@/lib/finance/pipeline";
import type { PersonaId } from "@/lib/finance/synth";

/**
 * The user's projected finances. Reading the request makes this a request-time
 * handler (it must run live: it calls the model and reads the current history).
 *
 *   GET /api/projection            cached against a hash of the history
 *   GET /api/projection?refresh=1  re-run the agents now
 */
export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  const raw = request.nextUrl.searchParams.get("persona");
  const persona: PersonaId | undefined = raw === "yuva" ? "yuva" : raw === "tristan" ? "tristan" : undefined;
  try {
    const projection = await getProjection({ force, persona });
    return Response.json(projection, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "projection failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
