import type { CSSProperties, ReactNode } from "react";
import type { ResponsibilityWorkSignal } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { RESPONSIBILITY_SIGNAL_TONE_VAR, signalHref } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";

const TONE_LABEL: Record<ResponsibilityWorkSignal["tone"], string> = {
  attention: "Needs attention",
  neutral: "",
  good: "Going well",
};

function ToneDot({ tone }: { tone: ResponsibilityWorkSignal["tone"] }) {
  return (
    <span
      className="status-fill mt-1.5 size-2 shrink-0 rounded-full"
      style={{ "--sc": `var(${RESPONSIBILITY_SIGNAL_TONE_VAR[tone]})` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/**
 * The signals bubbled up from the work under a responsibility, in the
 * server's order (what needs attention first). Each opens what it refers to;
 * the caller can put an action beside a line (giving its item to an agent).
 */
export function WorkSignalList({
  signals,
  renderAction,
  responsibilityHref,
  size = "sm",
  className,
}: {
  signals: readonly ResponsibilityWorkSignal[];
  /** An action beside a line, e.g. giving the project, task or routine it names to an agent. */
  renderAction?: (signal: ResponsibilityWorkSignal) => ReactNode;
  /** Where a line about the responsibility itself (its stale reading) leads. */
  responsibilityHref?: (id: string) => string;
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col", size === "xs" ? "gap-0.5" : "gap-1.5", className)}>
      {signals.map((signal, index) => {
        const href = signal.refType === "responsibility" && signal.refId && responsibilityHref
          ? responsibilityHref(signal.refId)
          : signalHref(signal);
        const toneLabel = TONE_LABEL[signal.tone];
        const text = (
          <>
            {signal.text}
            {toneLabel ? <span className="sr-only"> ({toneLabel.toLowerCase()})</span> : null}
          </>
        );
        return (
          <li
            key={`${signal.kind}:${signal.refId ?? index}`}
            data-tone={signal.tone}
            className={cn("flex min-w-0 items-start gap-2", size === "xs" ? "text-xs" : "text-sm")}
          >
            <ToneDot tone={signal.tone} />
            <span className={cn("min-w-0 flex-1", signal.tone === "attention" ? "text-foreground" : "text-muted-foreground")}>
              {href ? (
                href.startsWith("#") ? (
                  <a href={href} className="underline-offset-4 hover:underline">{text}</a>
                ) : (
                  <Link to={href} className="underline-offset-4 hover:underline">{text}</Link>
                )
              ) : (
                text
              )}
            </span>
            {renderAction ? renderAction(signal) : null}
          </li>
        );
      })}
    </ul>
  );
}
