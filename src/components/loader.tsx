"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import Intro from "./intro";

// WebGL only exists in the browser, so skip server rendering for the scene.
const FluidScene = dynamic(() => import("./FluidScene"), { ssr: false });

export default function FluidLoader() {
  const [sceneReady, setSceneReady] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const onReady = useCallback(() => setSceneReady(true), []);
  const onComplete = useCallback(() => setRevealed(true), []);

  return (
    <>
      <div inert={!revealed} aria-hidden={!revealed}>
        <FluidScene onReady={onReady} />
      </div>
      {!revealed && <Intro ready={sceneReady} onComplete={onComplete} />}
    </>
  );
}
