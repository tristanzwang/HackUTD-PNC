"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenarioIntent } from "@/lib/agents/schemas";
import { emptyProfile, mergeProfile } from "@/lib/chat/profile";
import type { Scenario } from "@/lib/finance/scenario";
import type { CategoryKey, PersonaId } from "@/lib/finance/synth";
import type {
  ChatBrief,
  ChatMessage,
  ForecastAdjustment,
  Observation,
  Profile,
} from "@/lib/chat/types";

const STORAGE_KEY = "finance-companion-v1";
/** A brief older than this is refreshed when the chat is opened. */
const BRIEF_MAX_AGE_MS = 10 * 60_000;

type Stored = { profile: Profile; messages: ChatMessage[]; brief: ChatBrief | null };

const blank = (): Stored => ({ profile: emptyProfile(), messages: [], brief: null });

/** What Pluto knows lives in this browser only (the server keeps nothing). */
function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blank();
    const s = JSON.parse(raw) as Partial<Stored>;
    if (!s.profile || !Array.isArray(s.profile.facts) || !Array.isArray(s.profile.adjustments)) return blank();
    return {
      profile: { ...emptyProfile(), ...s.profile },
      messages: Array.isArray(s.messages) ? s.messages : [],
      brief: s.brief ?? null,
    };
  } catch {
    return blank();
  }
}

function save(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, messages: s.messages.slice(-40) }));
  } catch {
    // private mode or full storage: Pluto still works, it just won't remember
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `request failed (${res.status})`);
  return json as T;
}

/** What Pluto can do to the scene besides talk: conjure a what-if, or reorder the orbits. */
export type SceneActions = {
  persona: PersonaId;
  onScenario: (s: Scenario) => void;
  onPriority: (order: CategoryKey[]) => void;
};

/** A what-if is a fast, cheap call; if it is slow, just talk instead of making the user wait. */
const INTENT_TIMEOUT_MS = 12_000;

async function readIntent(message: string): Promise<ScenarioIntent | null> {
  try {
    return await Promise.race([
      post<ScenarioIntent>("/api/scenario", { message }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), INTENT_TIMEOUT_MS)),
    ]);
  } catch {
    return null; // the router failing must never stop the conversation
  }
}

export type Companion = {
  profile: Profile;
  messages: ChatMessage[];
  brief: ChatBrief | null;
  /** thinking: Pluto is replying. learning: the overseer is updating the profile and forecast. */
  busy: "idle" | "thinking" | "learning";
  error: string | null;
  /** A short line about what the overseer just did with the forecast. */
  notice: string | null;
  /** Call when the chat window opens: the overseer briefs Pluto, and Pluto says hello. */
  open: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /** Empty the conversation (what Pluto has learned stays), and Pluto says hello again. */
  clearChat: () => Promise<void>;
  forgetFact: (id: string) => void;
  forgetPlan: (id: string) => void;
  forgetAll: () => void;
};

/**
 * The conversation with Pluto, and everything the overseer has learned from it.
 *
 * Two agents are involved and this hook is what keeps them apart: /api/chat is Pluto
 * (talks to the user, reports what it heard) and /api/overseer keeps the profile,
 * checks any forecast plans against the user's own words, and briefs Pluto for next
 * time. The overseer runs in the background so a reply never waits for it.
 */
export function useCompanion(actions: SceneActions): Companion {
  // the scene is client-only (no server render), so reading storage here is safe
  const [state, setState] = useState<Stored>(() => load());
  const [busy, setBusy] = useState<Companion["busy"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // the latest state for async work, which would otherwise see a stale copy
  const latest = useRef(state);
  const opening = useRef(false);
  const sending = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  // the scene's current persona and handlers, for async work that outlives a render
  const scene = useRef(actions);
  useEffect(() => {
    scene.current = actions;
  }, [actions]);

  const commit = useCallback((next: Stored) => {
    latest.current = next;
    setState(next);
    save(next);
  }, []);

  /** Hand what Pluto learned to the overseer, one at a time, without blocking the chat. */
  const learn = useCallback(
    (observations: Observation[], askedAbout: string) => {
      chain.current = chain.current.then(async () => {
        setBusy("learning");
        try {
          const s = latest.current;
          const r = await post<{
            profile: Profile;
            brief: ChatBrief;
            added: ForecastAdjustment[];
            rejected: { note: string; reason: string }[];
          }>("/api/overseer", {
            action: "integrate",
            profile: s.profile,
            messages: s.messages.slice(-20),
            observations,
            askedAbout,
            persona: scene.current.persona,
          });
          commit({ ...latest.current, profile: r.profile, brief: r.brief });
          if (r.added.length) setNotice(`Added to your forecast: ${r.added.map((a) => a.note).join("; ")}`);
          else if (r.rejected.length)
            setNotice(`I didn’t apply “${r.rejected[0].note}” (${r.rejected[0].reason}).`);
        } catch {
          // the overseer failing must not break the conversation; it will catch up next turn
        } finally {
          setBusy(sending.current ? "thinking" : "idle");
        }
      });
    },
    [commit],
  );

  const open = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setError(null);
    try {
      let s = latest.current;
      const stale = !s.brief || Date.now() - Date.parse(s.brief.createdAt) > BRIEF_MAX_AGE_MS;
      if (stale || s.messages.length === 0) {
        setBusy("thinking");
        const { brief } = await post<{ brief: ChatBrief }>("/api/overseer", {
          action: "brief",
          profile: s.profile,
          messages: s.messages.slice(-12),
          persona: scene.current.persona,
        });
        s = { ...latest.current, brief };
        commit(s);
      }
      if (latest.current.messages.length === 0) {
        setBusy("thinking");
        const r = await post<{ reply: string; askedAbout: string }>("/api/chat", {
          mode: "greet",
          messages: [],
          profile: s.profile,
          brief: s.brief,
          persona: scene.current.persona,
        });
        const cur = latest.current;
        commit({
          ...cur,
          // never replace a conversation that has already started while the hello was loading
          messages: cur.messages.length ? cur.messages : [{ role: "assistant", content: r.reply }],
          profile: mergeProfile(cur.profile, { asked: r.askedAbout || undefined }),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t reach Pluto.");
    } finally {
      setBusy("idle");
      opening.current = false;
    }
  }, [commit]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || sending.current) return;
      sending.current = true;
      setError(null);
      setNotice(null);
      try {
        commit({ ...latest.current, messages: [...latest.current.messages, { role: "user", content: t }] });
        setBusy("thinking");

        // A what-if or a "protect this first" is an action on the scene, not a chat turn:
        // do it and answer in Pluto's voice. Everything else (including real plans, which
        // the overseer must verify) goes through the chat and the overseer as usual.
        const intent = await readIntent(t);
        if (intent && intent.kind !== "none") {
          const cur = latest.current;
          commit({ ...cur, messages: [...cur.messages, { role: "assistant", content: intent.reply }] });
          if (intent.kind === "scenario") scene.current.onScenario(intent.scenario);
          else scene.current.onPriority(intent.order);
          setBusy("idle");
          return;
        }

        const s = latest.current;
        const r = await post<{ reply: string; observations: Observation[]; askedAbout: string }>("/api/chat", {
          mode: "reply",
          messages: s.messages.slice(-20),
          profile: s.profile,
          brief: s.brief,
          persona: scene.current.persona,
        });
        const cur = latest.current;
        commit({
          ...cur,
          messages: [...cur.messages, { role: "assistant", content: r.reply }],
          profile: mergeProfile(cur.profile, { asked: r.askedAbout || undefined }),
        });
        setBusy("idle");
        if (r.observations.length) learn(r.observations, r.askedAbout);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn’t reach Pluto.");
        setBusy("idle");
      } finally {
        sending.current = false;
      }
    },
    [commit, learn],
  );

  const clearChat = useCallback(async () => {
    if (sending.current || opening.current) return; // not mid-turn
    setError(null);
    setNotice(null);
    commit({ ...latest.current, messages: [] });
    await open(); // an empty chat gets a fresh hello
  }, [commit, open]);

  // Agency: everything learned can be seen and removed. Removing a plan changes the forecast.
  const forgetFact = useCallback(
    (id: string) => {
      const s = latest.current;
      commit({ ...s, profile: { ...s.profile, facts: s.profile.facts.filter((f) => f.id !== id) } });
    },
    [commit],
  );
  const forgetPlan = useCallback(
    (id: string) => {
      const s = latest.current;
      commit({ ...s, profile: { ...s.profile, adjustments: s.profile.adjustments.filter((a) => a.id !== id) } });
    },
    [commit],
  );
  const forgetAll = useCallback(() => {
    setNotice(null);
    setError(null);
    commit(blank());
  }, [commit]);

  return {
    profile: state.profile,
    messages: state.messages,
    brief: state.brief,
    busy,
    error,
    notice,
    open,
    send,
    clearChat,
    forgetFact,
    forgetPlan,
    forgetAll,
  };
}
