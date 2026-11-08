"use client";

import { useEffect, useState } from "react";
import type { Projection } from "@/lib/finance/projection";
import type { PersonaId } from "@/lib/finance/synth";

export type ProjectionState = {
  data: Projection | null;
  /** The last failed refresh, if any. The previous data stays on screen. */
  error: string | null;
  loading: boolean;
};

/**
 * Loads the user's projection once, when the scene mounts. There is deliberately
 * no timer: every fetch can cost model tokens, and the history only changes when
 * the user's account does. To stay current, refetch when a new checking-account
 * transaction arrives (not on a clock); the server re-runs the agents only if the
 * history actually changed.
 */
export function useProjection(persona?: PersonaId): ProjectionState {
  const [state, setState] = useState<ProjectionState>({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    // keep the current forecast on screen while a different persona loads
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const url = persona ? `/api/projection?persona=${persona}` : "/api/projection";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`projection request failed (${res.status})`);
        const data = (await res.json()) as Projection;
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) {
          setState((s) => ({
            data: s.data,
            loading: false,
            error: e instanceof Error ? e.message : "could not load projections",
          }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [persona]);

  return state;
}
