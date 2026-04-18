import { useEffect, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { Check, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useToast, type ToastItem, type ToastTone } from "../context/ToastContext";
import { cn } from "../lib/utils";

const toneClasses: Record<ToastTone, string> = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/25 dark:bg-sky-950/60 dark:text-sky-100",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/60 dark:text-emerald-100",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/60 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-950/60 dark:text-red-100",
};

const toneIconClasses: Record<ToastTone, string> = {
  info: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  const Icon = tone === "success"
    ? Check
    : tone === "warn"
      ? TriangleAlert
      : tone === "error"
        ? CircleAlert
        : Info;

  return (
    <span
      data-testid="toast-leading-icon"
      className={cn(
        "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        toneIconClasses[tone],
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function AnimatedToast({
  toast,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();
  const isActionable = Boolean(toast.action);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleNavigate = () => {
    if (!toast.action) return;
    onDismiss(toast.id);
    navigate(toast.action.href);
  };

  return (
    <li
      role={isActionable ? "link" : undefined}
      tabIndex={isActionable ? 0 : undefined}
      onMouseEnter={() => onPause(toast.id)}
      onMouseLeave={() => onResume(toast.id)}
      onClick={isActionable ? handleNavigate : undefined}
      onKeyDown={isActionable
        ? (event) => {
            if (event.currentTarget !== event.target) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleNavigate();
            }
          }
        : undefined}
      className={cn(
        "pointer-events-auto rounded-sm border shadow-lg backdrop-blur-xl transition-[transform,opacity] duration-200 ease-out",
        isActionable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/30",
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0",
        toneClasses[toast.tone],
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <ToneIcon tone={toast.tone} />
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
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(toast.id);
              }}
              className="mt-2 inline-flex text-xs font-medium underline underline-offset-4 hover:opacity-90"
            >
              {toast.action.label}
            </Link>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss(toast.id);
          }}
          className="mt-0.5 shrink-0 rounded p-1 opacity-50 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast, pauseToast, resumeToast } = useToast();

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
            onPause={pauseToast}
            onResume={resumeToast}
          />
        ))}
      </ol>
    </aside>
  );
}
