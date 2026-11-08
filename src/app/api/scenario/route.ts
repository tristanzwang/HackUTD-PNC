import { askPluto } from "@/lib/agents/scenario-intent";
import type { ScenarioIntent } from "@/lib/agents/schemas";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * The what-if endpoint (Pluto's intent router). Its whole job is intent: turn one message into a scenario
 * to overlay, or a plain reply. It never returns a projection — the client runs
 * applyScenario locally so the real projection is never mutated server-side.
 *
 *   POST /api/scenario  { message: string }  ->  ScenarioIntent
 */
export async function POST(request: Request): Promise<Response> {
  let message = "";
  try {
    const body = await request.json();
    message = String(body?.message ?? "").slice(0, 500).trim();
  } catch {
    // fall through to the empty-message reply
  }

  if (!message) {
    return Response.json(
      { kind: "none", reply: "I'm here — ask me anything, or try a what-if like \"save $200 a month\"." } satisfies ScenarioIntent,
      noStore,
    );
  }
  if (!process.env.NVIDIA_API_KEY) {
    return Response.json(
      { kind: "none", reply: "I'm offline right now — the model isn't configured here." } satisfies ScenarioIntent,
      noStore,
    );
  }

  try {
    const { intent } = await askPluto(message);
    return Response.json(intent, noStore);
  } catch {
    return Response.json(
      { kind: "none", reply: "Sorry — my mind went blank there. Try asking again?" } satisfies ScenarioIntent,
      noStore,
    );
  }
}
