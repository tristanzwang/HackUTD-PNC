"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mountIntro } from "@/lib/intro";
import styles from "./intro.module.css";

export default function Intro({
  ready,
  onComplete,
}: {
  ready: boolean;
  onComplete: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [assembled, setAssembled] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [exiting, setExiting] = useState(false);
  const settled = useCallback(() => setAssembled(true), []);

  useEffect(() => {
    if (root.current) return mountIntro(root.current, settled);
  }, [settled]);

  useEffect(() => {
    if (!skipped && !(assembled && ready)) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fade = setTimeout(() => setExiting(true), skipped || reduced ? 0 : 900);
    const complete = setTimeout(onComplete, (skipped || reduced ? 0 : 900) + (reduced ? 0 : 800));
    return () => { clearTimeout(fade); clearTimeout(complete); };
  }, [assembled, ready, skipped, onComplete]);

  return (
    <section
      ref={root}
      className={`${styles.overlay}${exiting ? ` ${styles.exiting}` : ""}`}
      aria-label="orbit loading animation"
      aria-busy={!ready || !assembled}
    >
      <canvas data-orbit-canvas aria-hidden="true" />
      <div
        data-orbit-track
        className={styles.track}
        role="progressbar"
        aria-label="assembling orbit logo"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
      >
        <span data-orbit-fill className={styles.fill} />
      </div>
      <button className={styles.skip} type="button" onClick={() => setSkipped(true)}>
        skip intro ↗
      </button>
    </section>
  );
}
