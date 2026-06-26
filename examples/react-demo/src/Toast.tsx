import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Minimal in-app toast — no external dep. One slot at the top-center
 * of the viewport, auto-dismiss after `duration` ms (default 3s),
 * stacks vertically when multiple fire close together. The library
 * doesn't need toasts; this is purely demo chrome to surface
 * "missing config" hints when the user clicks export without a
 * backend wired up.
 */
export type ToastVariant = "info" | "warn" | "error" | "success";

interface ToastItem {
  id: number;
  text: string;
  variant: ToastVariant;
}

interface ToastCtx {
  push(text: string, opts?: { variant?: ToastVariant; duration?: number }): void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(1);

  const push = useCallback(
    (text: string, opts?: { variant?: ToastVariant; duration?: number }) => {
      const id = idRef.current++;
      const variant = opts?.variant ?? "info";
      setItems((prev) => [...prev, { id, text, variant }]);
      const ms = opts?.duration ?? 3000;
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, ms);
    },
    [],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastStack items={items} />
    </Ctx.Provider>
  );
}

function ToastStack({ items }: { items: ToastItem[] }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {items.map((t) => (
        <Toast key={t.id} item={t} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: ToastItem }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const palette: Record<ToastVariant, { bg: string; fg: string }> = {
    info: { bg: "rgba(28, 28, 30, 0.94)", fg: "#fafafa" },
    warn: { bg: "rgba(255, 138, 0, 0.94)", fg: "#1a1a1a" },
    error: { bg: "rgba(255, 59, 48, 0.94)", fg: "#fff" },
    success: { bg: "rgba(48, 168, 96, 0.94)", fg: "#fff" },
  };
  const p = palette[item.variant];
  return (
    <div
      role="status"
      style={{
        background: p.bg,
        color: p.fg,
        padding: "10px 16px",
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.45,
        boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
        maxWidth: 480,
        pointerEvents: "auto",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-6px)",
        transition: "opacity 160ms ease, transform 160ms ease",
        backdropFilter: "blur(8px)",
      }}
    >
      {item.text}
    </div>
  );
}
