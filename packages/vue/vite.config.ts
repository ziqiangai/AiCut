import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue()],
  build: {
    sourcemap: true,
    lib: {
      // Three entries: main (zero deps) + lighting (three via the core
      // sub-entry) + webcodecs (mp4box via the core sub-entry). The
      // sub-entries are kept external so they aren't bundled here.
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        lighting: resolve(__dirname, "src/lighting.ts"),
        webcodecs: resolve(__dirname, "src/webcodecs.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entry) =>
        format === "es" ? `${entry}.js` : `${entry}.cjs`,
    },
    rollupOptions: {
      external: [
        "vue",
        "@aicut/core",
        "@aicut/core/lighting",
        "@aicut/core/webcodecs",
      ],
      output: { globals: { vue: "Vue" } },
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
