"use client";

import { useEffect, useState } from "react";
import type { ForecastAdjustment } from "@/lib/chat/types";
import type { Projection } from "@/lib/finance/projection";
import type { PersonaId } from "@/lib/finance/synth";

export type ProjectionState = {
  data: Projection | null;
  /** The last failed refresh, if any. The previous data stays on screen. */
  error: string | null;
  loading: boolean;
};

type Loaded = { data: Projection | null; error: string | null; key: string | null };

/**
 * Loads the user's projection when the scene mounts, and again only when the demo
 * dataset or the user's plans change (what they have told Pluto). There is
 * deliberately no timer: a fetch for the same history and plans is free on the
 * server, and a changed plan re-runs only the local forecast math, never the model.
 * To stay current with the account itself, refetch when a new checking-account
 * transaction arrives.
 *
 * While a different dataset or plan set loads, the previous forecast stays on screen.
 */
export function useProjection(adjustments: ForecastAdjustment[], persona: PersonaId): ProjectionState {
  const [loaded, setLoaded] = useState<Loaded>({ data: null, error: null, key: null });
  const hasPlans = adjustments.length > 0;
  // a string, so the effect re-runs when the plans change in content, not just in identity
  const key = JSON.stringify({ persona, adjustments });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = hasPlans
          ? await fetch("/api/projection", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: key,
              cache: "no-store",
            })
          : await fetch(`/api/projection?persona=${persona}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`projection request failed (${res.status})`);
        const data = (await res.json()) as Projection;
        if (!alive) return;
        setLoaded((prev) => ({
          // same version: keep the same object so nothing downstream rebuilds
          data: prev.data?.version === data.version ? prev.data : data,
          error: null,
          key,
        }));
      } catch (e) {
        if (!alive) return;
        setLoaded((prev) => ({
          ...prev,
          key,
          error: e instanceof Error ? e.message : "could not load projections",
        }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, hasPlans, persona]);

  return { data: loaded.data, error: loaded.error, loading: loaded.key !== key };
}
