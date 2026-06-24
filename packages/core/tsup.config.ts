import { defineConfig } from "tsup";

export default defineConfig({
  // Three entries:
  //   - index.ts                       → main API (Editor, Timeline, types).
  //                                      Zero runtime deps.
  //   - lighting/index.ts              → opt-in 3D picker. Bundles three.js.
  //   - playback/webcodecs/index.ts    → opt-in WebCodecs engine. Bundles
  //                                      mp4box.js for the MP4 demuxer.
  // Importing only `@aicut/core` leaves three.js + mp4box.js completely
  // out of the consumer's bundle; sub-entries opt in per feature.
  entry: [
    "src/index.ts",
    "src/lighting/index.ts",
    "src/playback/webcodecs/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  treeshake: true,
  // three.js + mp4box.js are real deps for their respective sub-entries —
  // bundle them so consumers don't have to install or configure them.
  // tsup defaults to externalising anything in `dependencies`; force-bundle
  // by listing them here.
  noExternal: ["three", "mp4box"],
});
