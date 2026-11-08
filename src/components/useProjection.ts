"use client";

import { useEffect, useState } from "react";
import type { ForecastAdjustment } from "@/lib/chat/types";
import type { Projection } from "@/lib/finance/projection";

export type ProjectionState = {
  data: Projection | null;
  /** The last failed refresh, if any. The previous data stays on screen. */
  error: string | null;
  loading: boolean;
};

/**
 * Loads the user's projection when the scene mounts, and again only when the user's
 * plans change (what they have told Pluto). There is deliberately no timer: a
 * fetch for the same history and plans is free on the server, and a changed plan
 * re-runs only the local forecast math, never the model. To stay current with the
 * account itself, refetch when a new checking-account transaction arrives.
 */
export function useProjection(adjustments: ForecastAdjustment[]): ProjectionState {
  const [state, setState] = useState<ProjectionState>({ data: null, error: null, loading: true });
  // a string, so the effect re-runs when the plans change in content, not just in identity
  const body = JSON.stringify({ adjustments });
  const hasPlans = adjustments.length > 0;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = hasPlans
          ? await fetch("/api/projection", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              cache: "no-store",
            })
          : await fetch("/api/projection", { cache: "no-store" });
        if (!res.ok) throw new Error(`projection request failed (${res.status})`);
        const data = (await res.json()) as Projection;
        if (!alive) return;
        setState((prev) =>
          // same version: keep the same object so nothing downstream rebuilds
          prev.data?.version === data.version
            ? { data: prev.data, error: null, loading: false }
            : { data, error: null, loading: false },
        );
      } catch (e) {
        if (!alive) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: e instanceof Error ? e.message : "could not load projections",
        }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [body, hasPlans]);

  return state;
}
