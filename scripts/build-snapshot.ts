/**
 * Bakes a projection snapshot the pipeline ships with, so a cold serverless
 * start answers the first request instantly instead of blocking on ~9 Nemotron
 * calls. Re-run it whenever the history source or the models change:
 *
 *   npx tsx scripts/build-snapshot.ts
 *
 * It forces a live run (ignoring any existing snapshot) and writes the result to
 * src/lib/finance/projection-snapshot.json, which pipeline.ts imports as its
 * initial cache. Run with NVIDIA_API_KEY set, or the snapshot bakes in the local
 * heuristic picks rather than Nemotron's.
 */

import "./env"; // must come before anything reading process.env

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProjection } from "../src/lib/finance/pipeline";

(async () => {
  const projection = await getProjection({ force: true });

  const out = resolve(process.cwd(), "src/lib/finance/projection-snapshot.json");
  writeFileSync(out, JSON.stringify(projection, null, 2) + "\n");

  console.log(`wrote ${out}`);
  console.log(
    `version ${projection.version}  generatedAt ${projection.generatedAt}  agent.live=${projection.agent.live}`,
  );
  if (projection.agent.note) console.log(`note: ${projection.agent.note}`);

  console.log();
  console.log(
    "category        model".padEnd(51) + "source".padEnd(12) + "tier".padEnd(10) + "ms".padStart(7),
  );
  for (const c of projection.categories) {
    const call = c.model.call;
    console.log(
      c.label.padEnd(15) +
        (call?.model ?? "-").padEnd(36) +
        c.model.source.padEnd(12) +
        (call?.tier ?? "-").padEnd(10) +
        (call?.ms != null ? String(call.ms) : "-").padStart(7),
    );
  }
})();
