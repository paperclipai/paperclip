import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

export interface CopyFieldProps {
  /** The value shown and copied. */
  value: string;
  /** Accessible label for the copy button (e.g. "Copy redirect URI"). */
  label?: string;
  /** Render the value in a monospace field (default true). */
  mono?: boolean;
  className?: string;
}

/**
 * Read-only value with an inline copy-to-clipboard button. Centralizes the
 * `navigator.clipboard.writeText` + "Copied ✓" affordance that feature surfaces
 * (gateways, redirect-URI callouts, UID display) were hand-rolling.
 */
export function CopyField({ value, label = "Copy", mono = true, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [value]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2",
        className,
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate text-sm", mono && "font-mono")} title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy
          </>
        )}
      </button>
    </div>
  );
}
