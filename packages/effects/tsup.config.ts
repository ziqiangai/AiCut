import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Copy the CSS file as-is. tsup can't process `.css` imports out
  // of the box, but the runtime import statement works when host
  // bundlers (Vite, Next.js, etc.) resolve it from the dist tree.
  loader: { ".css": "copy" },
  external: ["react", "react-dom", "@aicut/core", "@aicut/react"],
});
