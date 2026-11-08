"use client";

import dynamic from "next/dynamic";

// WebGL only exists in the browser, so skip server rendering for the scene.
const FluidScene = dynamic(() => import("./FluidScene"), { ssr: false });

export default function FluidLoader() {
  return <FluidScene />;
}
