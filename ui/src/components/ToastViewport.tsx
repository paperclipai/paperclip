import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { X } from "lucide-react";
import { useToast, type ToastItem, type ToastTone } from "../context/ToastContext";
import { cn } from "../lib/utils";

const toneClasses: Record<ToastTone, string> = {
  info: "border-[var(--primary)]/30 bg-[var(--primary)]/5 text-[var(--primary)]",
  success: "border-[var(--status-active)]/30 bg-[var(--status-active)]/5 text-[var(--status-active)]",
  warn: "border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 text-[var(--status-warning)]",
  error: "border-[var(--status-error)]/30 bg-[var(--status-error)]/5 text-[var(--status-error)]",
};

const toneDotClasses: Record<ToastTone, string> = {
  info: "bg-[var(--primary)]",
  success: "bg-[var(--status-active)]",
  warn: "bg-[var(--status-warning)]",
  error: "bg-[var(--status-error)]",
};

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <li
      className={cn(
        "pointer-events-auto rounded-sm border shadow-lg backdrop-blur-xl transition-[transform,opacity] duration-200 ease-out",
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0",
        toneClasses[toast.tone],
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", toneDotClasses[toast.tone])} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">{toast.title}</p>
          {toast.body && (
            <p className="mt-1 text-xs leading-4 opacity-70">
              {toast.body}
            </p>
          )}
          {toast.action && (
            <Link
              to={toast.action.href}
              onClick={() => onDismiss(toast.id)}
              className="mt-2 inline-flex text-xs font-medium underline underline-offset-4 hover:opacity-90"
            >
              {toast.action.label}
            </Link>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="mt-0.5 shrink-0 rounded p-1 opacity-50 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <aside
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-3 left-3 z-[120] w-full max-w-sm px-1"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast
            key={toast.id}
            toast={toast}
            onDismiss={dismissToast}
          />
        ))}
      </ol>
    </aside>
  );
}
