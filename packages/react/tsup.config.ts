import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/lighting.ts", "src/webcodecs.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Each `@aicut/core/*` sub-path is listed explicitly so the React
  // wrapper doesn't try to bundle the (large) sub-entries. Host
  // bundlers resolve the sub-path via package.json exports.
  external: [
    "react",
    "react-dom",
    "@aicut/core",
    "@aicut/core/lighting",
    "@aicut/core/webcodecs",
  ],
});
