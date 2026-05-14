import { FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useDocumentOpenerStatus } from "../context/DocumentOpenerContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { openDocument, revealDocument } from "../lib/local-document";
import { cn } from "../lib/utils";

interface LocalDocumentLinkProps {
  href: string;
  children: ReactNode;
}

function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/.test(navigator.platform);
}

export function LocalDocumentLink({ href, children }: LocalDocumentLinkProps) {
  const status = useDocumentOpenerStatus();
  const toast = useOptionalToastActions();
  const disabled = status !== "ready";
  const revealLabel = isWindowsPlatform() ? "Im Explorer zeigen" : "Im Finder zeigen";

  const showError = useCallback(
    (err: unknown) => {
      const title = err instanceof Error ? err.message : "Aktion fehlgeschlagen";
      toast?.pushToast({ tone: "error", title });
    },
    [toast],
  );

  const handleOpen = useCallback(async () => {
    try {
      await openDocument(href);
    } catch (err) {
      showError(err);
    }
  }, [href, showError]);

  const handleReveal = useCallback(async () => {
    try {
      await revealDocument(href);
    } catch (err) {
      showError(err);
    }
  }, [href, showError]);

  return (
    <span className="paperclip-local-document">
      <span>{children}</span>
      <button
        type="button"
        aria-label="Öffnen"
        title={disabled ? "Document-Opener nicht aktiv" : "Öffnen"}
        disabled={disabled}
        onClick={handleOpen}
        className={cn(
          "ml-1 inline-flex h-4 w-4 items-center justify-center align-[-0.125em]",
          "text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300",
          disabled && "opacity-40 cursor-not-allowed hover:text-blue-600 dark:hover:text-blue-400",
        )}
      >
        <SquareArrowOutUpRight aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={revealLabel}
        title={disabled ? "Document-Opener nicht aktiv" : revealLabel}
        disabled={disabled}
        onClick={handleReveal}
        className={cn(
          "ml-1 inline-flex h-4 w-4 items-center justify-center align-[-0.125em]",
          "text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300",
          disabled && "opacity-40 cursor-not-allowed hover:text-blue-600 dark:hover:text-blue-400",
        )}
      >
        <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
