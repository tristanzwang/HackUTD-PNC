"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Divider, Orb } from "./Ornaments";
import type { Companion } from "./useCompanion";
import { FOCUS, GLASS, PRESS, collapsible, materialize } from "./ui";

const KIND_LABEL: Record<string, string> = {
  character: "About you",
  habit: "Habit",
  priority: "Priority",
  goal: "Goal",
  constraint: "Constraint",
  event: "Coming up",
  preference: "Preference",
};

const XIcon = () => (
  <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
    <path d="M2.5 2.5l7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * The chat with Pluto. Everything it has learned is one click away and removable,
 * because the person this is about should always be able to see what is known and
 * take it back.
 */
export default function ChatPanel({
  open,
  companion,
  onClose,
}: {
  open: boolean;
  companion: Companion;
  onClose: () => void;
}) {
  const { messages, busy, error, notice, profile, brief } = companion;
  const [draft, setDraft] = useState("");
  const [showLearned, setShowLearned] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, busy, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey as (e: globalThis.KeyboardEvent) => void);
    return () => window.removeEventListener("keydown", onKey as (e: globalThis.KeyboardEvent) => void);
  }, [open, onClose]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    companion.send(t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const learnedCount = profile.facts.length + profile.adjustments.length;

  return (
    <section
      inert={!open}
      aria-label="Chat with Pluto"
      className={
        "absolute bottom-[4.5rem] left-5 flex h-[min(34rem,calc(100vh-9rem))] w-[min(23rem,calc(100vw-2.5rem))] " +
        "origin-bottom-left select-none flex-col overflow-hidden rounded-[1.75rem] text-white " +
        GLASS +
        " " +
        materialize(open)
      }
    >
      {/* header */}
      <div className="flex items-center gap-3 px-5 pb-3 pt-4">
        <Orb color="#ffffff" size={16} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-none tracking-[-0.01em]">Pluto</h2>
          <p className="mt-1 text-sm text-white/45">Here to listen and explain, never to push</p>
        </div>
        <button
          onClick={() => setShowLearned((v) => !v)}
          aria-expanded={showLearned}
          title="What Pluto has learned about you"
          className={
            "flex h-8 items-center gap-1.5 rounded-full border border-white/20 px-2.5 text-sm text-white/80 " +
            "hover:bg-white/10 " +
            PRESS +
            " " +
            FOCUS
          }
        >
          Learned
          <span className="tabular-nums text-white/50">{learnedCount}</span>
        </button>
        <button
          onClick={onClose}
          aria-label="Close chat"
          className={
            "flex h-8 w-8 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white " +
            PRESS +
            " " +
            FOCUS
          }
        >
          <XIcon />
        </button>
      </div>

      {/* what has been learned: visible, and removable */}
      <div className={collapsible(showLearned)} inert={!showLearned}>
        <div className="min-h-0 overflow-hidden">
          <div className="max-h-56 overflow-y-auto border-y border-white/10 px-5 py-3 text-[0.95rem] [scrollbar-width:thin]">
            {brief && (
              <div className="mb-3">
                <p className="text-xs uppercase tracking-[0.12em] text-white/40">The overseer’s focus right now</p>
                <ul className="mt-1 space-y-0.5 text-white/65">
                  {brief.topics.slice(0, 3).map((t) => (
                    <li key={t.topic} className="leading-snug">
                      · {t.topic}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {profile.summary && (
              <p className="mb-3 text-[0.95rem] italic leading-snug text-white/70">{profile.summary}</p>
            )}
            {profile.facts.length === 0 && profile.adjustments.length === 0 ? (
              <p className="text-white/45">Nothing yet. As you chat, what Pluto learns appears here, and you can remove any of it.</p>
            ) : (
              <ul className="space-y-1.5">
                {profile.adjustments.map((a) => (
                  <li key={a.id} className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded-full border border-white/25 px-1.5 text-[0.7rem] uppercase tracking-wide text-white/60">
                      In forecast
                    </span>
                    <span className="min-w-0 flex-1 leading-snug text-white/85" title={`You said: “${a.evidence}”`}>
                      {a.note}
                    </span>
                    <button
                      onClick={() => companion.forgetPlan(a.id)}
                      aria-label={`Remove: ${a.note}`}
                      className={"mt-0.5 shrink-0 rounded-full p-1 text-white/45 hover:bg-white/10 hover:text-white " + FOCUS}
                    >
                      <XIcon />
                    </button>
                  </li>
                ))}
                {profile.facts.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 rounded-full border border-white/15 px-1.5 text-[0.7rem] uppercase tracking-wide text-white/45">
                      {KIND_LABEL[f.kind] ?? f.kind}
                    </span>
                    <span className="min-w-0 flex-1 leading-snug text-white/75" title={`You said: “${f.evidence}”`}>
                      {f.statement}
                    </span>
                    <button
                      onClick={() => companion.forgetFact(f.id)}
                      aria-label={`Remove: ${f.statement}`}
                      className={"mt-0.5 shrink-0 rounded-full p-1 text-white/45 hover:bg-white/10 hover:text-white " + FOCUS}
                    >
                      <XIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(messages.length > 0 || learnedCount > 0) && (
              <button
                onClick={() => {
                  if (window.confirm("Forget everything Pluto has learned and clear this chat?")) companion.forgetAll();
                }}
                className={"mt-3 text-sm text-white/45 underline-offset-2 hover:text-rose-200 hover:underline " + FOCUS}
              >
                Forget everything
              </button>
            )}
          </div>
        </div>
      </div>

      <Divider className="mx-5 mb-1 mt-0.5 shrink-0" />

      {/* messages */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.map((m, i) => (
          <div key={i} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
            <p
              className={
                "max-w-[88%] select-text whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[1.02rem] leading-snug " +
                (m.role === "user"
                  ? "rounded-br-md bg-white/90 text-[#0b1226]"
                  : "rounded-bl-md border border-white/10 bg-white/[0.07] text-white/90")
              }
            >
              {m.content}
            </p>
          </div>
        ))}
        {busy === "thinking" && (
          <div className="flex justify-start" aria-label="Pluto is typing">
            <span className="flex gap-1 rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.07] px-3.5 py-3">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </p>
        )}
        <div ref={end} />
      </div>

      {/* what the overseer just did */}
      <div className="min-h-[1.25rem] px-5 text-[0.9rem] italic text-white/50" aria-live="polite">
        {busy === "learning" ? "Updating what I know…" : notice}
      </div>

      {/* input */}
      <form onSubmit={submit} className="flex items-end gap-2 px-4 pb-4 pt-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={1500}
          placeholder="Say anything. Skip anything."
          aria-label="Message to Pluto"
          className={
            "min-w-0 flex-1 resize-none select-text rounded-2xl border border-white/[0.16] bg-black/30 px-3.5 py-2 " +
            "text-[1.02rem] leading-snug outline-none transition-[border-color,box-shadow] duration-200 " +
            "placeholder:text-white/30 focus:border-white/45 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.1)]"
          }
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy === "thinking"}
          aria-label="Send"
          className={
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/90 text-[#0b1226] " +
            "enabled:hover:bg-white disabled:opacity-35 " +
            PRESS +
            " " +
            FOCUS
          }
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
      <p className="px-5 pb-3 text-center text-[0.75rem] text-white/30">
        An AI, not a financial advisor. You decide everything.
      </p>
    </section>
  );
}

/** The round button that opens the chat. A small dot invites a first hello. */
export function ChatButton({
  open,
  invite,
  onClick,
}: {
  open: boolean;
  invite: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      aria-label="Chat with Pluto"
      title="Chat with Pluto"
      className={
        "rise relative flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full text-white/85 " +
        "hover:text-white " +
        GLASS +
        " " +
        PRESS +
        " " +
        FOCUS
      }
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z" />
      </svg>
      {invite && !open && (
        <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" />
      )}
    </button>
  );
}
