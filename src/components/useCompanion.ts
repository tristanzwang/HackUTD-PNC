"use client";

import { useCallback, useRef, useState } from "react";
import { emptyProfile, mergeProfile } from "@/lib/chat/profile";
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
export function useCompanion(): Companion {
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
        });
        const cur = latest.current;
        commit({
          ...cur,
          messages: [{ role: "assistant", content: r.reply }],
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
        const s = latest.current;
        const r = await post<{ reply: string; observations: Observation[]; askedAbout: string }>("/api/chat", {
          mode: "reply",
          messages: s.messages.slice(-20),
          profile: s.profile,
          brief: s.brief,
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
    forgetFact,
    forgetPlan,
    forgetAll,
  };
}
