import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // happy-dom is enough for our needs: HTMLVideoElement / div / event
    // wiring. The canvas timeline + the ResizeObserver it uses are
    // stubbed in test-setup.ts so Editor construction doesn't throw.
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    globals: false,
  },
});
