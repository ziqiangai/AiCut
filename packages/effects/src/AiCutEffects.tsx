/**
 * `<AiCutEffects>` — the overlay layer for the operation event bus.
 *
 * Mount it once inside `<EditorProvider>` (anywhere, though the
 * composition demo puts it at the top of the shell so it stacks
 * above the timeline / preview). On mount it:
 *
 *   1. subscribes to `editor.on("operation", ...)`
 *   2. builds an `EffectContext` snapshot at emit time (reading
 *      timeline + preview rects live)
 *   3. dispatches to a registered handler for that op kind
 *   4. mounts whatever JSX the handler returns into a fixed-position
 *      overlay div (`pointer-events: none` — never intercepts input)
 *
 * The overlay layer holds ONE active effect per kind at a time. If
 * a second op of the same kind fires while the first effect is still
 * running, the first is unmounted (React key change), the new one
 * mounts. Ops of different kinds run concurrently.
 *
 * Everything is opt-in: `enabled={false}` disables the whole layer.
 * Per-kind `effects={{ kind: false }}` disables just one. Custom
 * implementations replace the default: `effects={{ splitClip: myFn }}`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { useEditor } from "@aicut/react";
import type { OperationEvent } from "@aicut/core";
import type { EffectHandler, EffectsMap } from "./types.js";
import { buildEffectContext } from "./geometry.js";
import { defaultSplitEffect } from "./effects/splitEffect.js";
import { defaultMoveEffect } from "./effects/moveEffect.js";

export interface AiCutEffectsProps {
  /** Global on/off. `false` mounts nothing, no subscription. Default true. */
  enabled?: boolean;
  /**
   * Per-kind handler overrides. Missing kinds fall through to the
   * shipped defaults; `false` explicitly disables a kind (no default,
   * no custom).
   */
  effects?: EffectsMap;
  /**
   * Overlay z-index — sits above the timeline (10) and preview but
   * below any modal chrome. Default 9999.
   */
  zIndex?: number;
}

/**
 * Default handlers per op kind. All `false` in the current build —
 * the professional in-canvas animations wired directly on the
 * `<Timeline>` primitive (`animateClip` / `flashCut`) now handle
 * the primary feedback, and stacking a mascot overlay on top of that
 * would be double-drawing the same event.
 *
 * The `defaultSplitEffect` (chop bear) and `defaultMoveEffect`
 * (carry bear) are still exported for hosts that explicitly want
 * the playful vibe — opt in via
 *
 *   import { AiCutEffects, defaultSplitEffect, defaultMoveEffect } from "@aicut/effects";
 *   <AiCutEffects effects={{
 *     splitClip: defaultSplitEffect,
 *     moveClipTo: defaultMoveEffect,
 *   }} />
 *
 * A custom handler always wins over the default, so a host can also
 * pass its own overlay per kind without touching this map.
 */
const DEFAULT_EFFECTS: Record<
  OperationEvent["kind"],
  EffectHandler | false
> = {
  splitClip: false,
  moveClipTo: false,
  trimClip: false,
  deleteClip: false,
  addClip: false,
};

interface ActiveEffect {
  key: string;
  op: OperationEvent;
  node: ReactElement | null;
}

export function AiCutEffects({
  enabled = true,
  effects = {},
  zIndex = 9999,
}: AiCutEffectsProps): ReactElement | null {
  const editor = useEditor();
  const [active, setActive] = useState<Record<string, ActiveEffect | null>>(
    {},
  );

  const resolveHandler = useCallback(
    (kind: OperationEvent["kind"]): EffectHandler | false => {
      // Explicit false in the override map disables the kind entirely.
      if (kind in effects) {
        const override = effects[kind];
        return override === false || typeof override === "function"
          ? override
          : DEFAULT_EFFECTS[kind];
      }
      return DEFAULT_EFFECTS[kind];
    },
    [effects],
  );

  useEffect(() => {
    if (!enabled) return;
    const off = editor.on("operation", (op) => {
      const handler = resolveHandler(op.kind);
      if (!handler) return;
      const ctx = buildEffectContext(editor);
      // Complete callback removes the effect from state — cleanup
      // point. If a handler never calls it, the effect sticks around
      // until the next op of the same kind replaces it.
      const key = `${op.kind}-${op.timestamp}`;
      const onComplete = (): void => {
        setActive((prev) => {
          if (prev[op.kind]?.key !== key) return prev;
          return { ...prev, [op.kind]: null };
        });
      };
      const node = handler(op, ctx, onComplete);
      setActive((prev) => ({ ...prev, [op.kind]: { key, op, node } }));
    });
    return () => off();
  }, [editor, enabled, resolveHandler]);

  const items = useMemo(
    () =>
      Object.entries(active).filter(
        (kv): kv is [string, ActiveEffect] => kv[1] != null,
      ),
    [active],
  );

  if (!enabled) return null;

  return (
    <div
      data-aicut-effects=""
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex,
      }}
    >
      {items.map(([kind, eff]) =>
        eff.node ? (
          <div key={`${kind}-${eff.key}`} data-effect-kind={kind}>
            {eff.node}
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * Low-level hook — subscribe to the operation stream directly. Use
 * when you want to render effects without going through
 * `<AiCutEffects>` (e.g. Canvas-based effects, non-React overlays,
 * telemetry loggers).
 */
export function useOperationStream(
  handler: (op: OperationEvent) => void,
  enabled = true,
): void {
  const editor = useEditor();
  useEffect(() => {
    if (!enabled) return;
    const off = editor.on("operation", handler);
    return () => off();
  }, [editor, enabled, handler]);
}
