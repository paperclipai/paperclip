import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Check } from "lucide-react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function CaseCopyableToken({
  value,
  label,
  className,
  containerClassName,
  truncate = true,
  stopPropagation,
}: {
  value: string;
  label: string;
  className?: string;
  containerClassName?: string;
  truncate?: boolean;
  stopPropagation?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) {
      event.preventDefault();
      event.stopPropagation();
    }
    void copyTextToClipboard(value).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [stopPropagation, value]);

  return (
    <span className={cn("relative inline-flex min-w-0 max-w-full", containerClassName)}>
      <button
        type="button"
        className={cn(
          "min-w-0 cursor-copy text-left transition-colors hover:text-foreground",
          truncate ? "truncate" : "whitespace-normal break-all",
          className,
        )}
        title={value}
        aria-label={`Copy ${label} ${value}`}
        onClick={handleCopy}
      >
        {value}
      </button>
      {copied ? (
        <span
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 inline-flex -translate-x-1/2 items-center gap-1 rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background"
        >
          <Check className="h-3 w-3 shrink-0" />
          Copied
        </span>
      ) : null}
    </span>
  );
}

export function CaseIdentifierKey({
  identifier,
  caseKey,
  className,
  stopPropagation,
}: {
  identifier: string;
  caseKey?: string | null;
  className?: string;
  stopPropagation?: boolean;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center gap-2 whitespace-nowrap", className)}
      data-case-identity-group="true"
    >
      <CaseCopyableToken
        value={identifier}
        label="case ID"
        className="shrink-0 font-mono text-xs text-muted-foreground"
        containerClassName="shrink-0"
        stopPropagation={stopPropagation}
      />
      {caseKey ? (
        <CaseCopyableToken
          value={caseKey}
          label="case key"
          className="font-mono text-xs text-muted-foreground"
          stopPropagation={stopPropagation}
        />
      ) : null}
    </span>
  );
}
