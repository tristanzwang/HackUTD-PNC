/**
 * Loads .env.local for standalone scripts. Next.js does this automatically for
 * the app, but tsx does not, so a script run without it silently reports
 * baseline numbers that look like a model failure. No dependency needed.
 * Import this FIRST, before anything that reads process.env.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

for (const name of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), name);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // an empty exported var must not win over the file
    if (!process.env[key]) process.env[key] = val;
  }
}
