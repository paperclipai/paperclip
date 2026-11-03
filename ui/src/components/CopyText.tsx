import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";

interface CopyTextProps {
  text: string;
  /** What to display. Defaults to `text`. */
  children?: React.ReactNode;
  containerClassName?: string;
  className?: string;
  ariaLabel?: string;
  title?: string;
  /** Tooltip message shown after copying. Default: "Copied!" */
  copiedLabel?: string;
}

export function CopyText({
  text,
  children,
  containerClassName,
  className,
  ariaLabel,
  title,
  copiedLabel,
}: CopyTextProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"success" | "error">("success");
  const label = copyStatus === "error"
    ? t("localizationCommonTail.copyFailed")
    : copiedLabel ?? t("common.copied");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }
    clearTimeout(timerRef.current);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), 1500);
  }, [text]);

  return (
    <span className={cn("relative inline-flex", containerClassName)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        title={title}
        className={cn(
          "cursor-copy hover:text-foreground transition-colors",
          className,
        )}
        onClick={handleClick}
      >
        {children ?? text}
      </button>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 rounded-md bg-foreground text-background px-2 py-1 text-xs whitespace-nowrap transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}
