/**
 * Vitest global setup — install just enough of the browser surface
 * that happy-dom doesn't ship for the Timeline + Editor to construct
 * without throwing. We never assert on actual canvas pixels in tests;
 * the stub only needs to not throw when the timeline paints.
 */

import { afterAll } from "vitest";

// happy-dom returns null from canvas.getContext("2d"). The Timeline
// throws when that happens. Stub a fully no-op CanvasRenderingContext2D
// so construction succeeds. Returning the same proxy each call lets
// internal reference equality (e.g. caching) still work.
const ctxStub = new Proxy(
  {},
  {
    get(_target, prop) {
      // Return chainable noops + sensible scalar defaults — covers
      // setTransform / fillRect / fillText / measureText / fillStyle =
      // … plus getter reads of e.g. canvas/width.
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "createLinearGradient" || prop === "createPattern") {
        return () => ctxStub;
      }
      return () => undefined;
    },
    set() {
      return true;
    },
  },
) as unknown as CanvasRenderingContext2D;

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function patchedGetContext(
  this: HTMLCanvasElement,
  contextId: string,
): RenderingContext | null {
  if (contextId === "2d") return ctxStub;
  return null;
} as typeof HTMLCanvasElement.prototype.getContext;

// happy-dom doesn't ship ResizeObserver. Timeline observes its host
// element on construction — a no-op observer is fine for tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver })
    .ResizeObserver = FakeResizeObserver;
}

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});
