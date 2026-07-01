import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
  copiedLabel = "Copied!",
}: CopyTextProps) {
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState(copiedLabel);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = useCallback(async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (e.g. HTTP on non-localhost)
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          const success = document.execCommand("copy");
          if (!success) throw new Error("execCommand copy failed");
        } finally {
          document.body.removeChild(textarea);
        }
      }
      setLabel(copiedLabel);
    } catch {
      setLabel("Copy failed");
    }
    clearTimeout(timerRef.current);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), 1500);
  }, [copiedLabel, text]);

  return (
    <span className={cn("relative inline-flex", containerClassName)}>
      <TooltipProvider>
        {/* Controlled (not hover-driven): the tooltip surfaces the copy result
            for ~1.5s after a click — the affordance itself is inline copy-styled
            text, which no system Button variant matches without breaking text
            flow, so the trigger stays an inline <button>. */}
        <Tooltip open={visible}>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent role="status" aria-live="polite">
            {label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
