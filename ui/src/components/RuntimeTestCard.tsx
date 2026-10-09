import {
  CircleCheck,
  CircleAlert,
  Loader2,
  Play,
  ChevronRight,
} from "lucide-react";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
export type TestState = "idle" | "running" | "pass" | "fail";

const copy = {
  idle: {
    title: "Test your agent",
    description: "Check that your runtime and model can respond.",
    action: "Run test",
  },
  running: {
    title: "Testing connection",
    description: "Checking the runtime and waiting for a model response…",
    action: "Testing…",
  },
  pass: {
    title: "Connection successful",
    description: "Your runtime checks passed. Review the details below.",
    action: "Test again",
  },
  warn: {
    title: "Connection needs attention",
    description: "Review the test details before running your agent.",
    action: "Test again",
  },
  fail: {
    title: "Couldn't connect",
    description: "Check your model and provider connection, then try again.",
    action: "Retry test",
  },
} as const;

const prerequisiteCopy = {
  idle: { title: "Check prerequisites", description: "Check instance settings and public connection configuration.", action: "Check setup" },
  running: { title: "Checking prerequisites", description: "Checking instance settings and public connection configuration…", action: "Checking…" },
  pass: { title: "Setup checks passed", description: "Review the setup details before assigning work.", action: "Check again" },
  warn: { title: "Pairing required", description: "Create this agent, then pair it and verify event delivery.", action: "Check again" },
  fail: { title: "Prerequisite check failed", description: "Review the setup details and retry.", action: "Retry check" },
} as const;

export function RuntimeTestCard({
  state,
  result,
  error,
  onTest,
  disabled = false,
  variant = "connection",
  metadataOnly = false,
}: {
  state: TestState | "warn";
  result: AdapterEnvironmentTestResult | null;
  error?: string | null;
  onTest: () => void;
  disabled?: boolean;
  variant?: "connection" | "prerequisites";
  metadataOnly?: boolean;
}) {
  const content = (variant === "prerequisites" ? prerequisiteCopy : copy)[state];
  const description = metadataOnly && state === "idle"
    ? "Verify your saved token, runtime installation, and selected model without sending a model prompt."
    : metadataOnly && state === "running"
      ? "Checking the saved token, runtime, and selected model…"
      : content.description;
  const Icon =
    state === "running"
      ? Loader2
      : state === "pass"
        ? CircleCheck
        : state === "fail" || state === "warn"
          ? CircleAlert
          : Play;
  return (
    <section
      aria-label="Runtime test"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-start gap-3 p-4 sm:items-center">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted",
            state === "pass"
              ? "text-green-600 dark:text-green-400"
              : state === "fail"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-4",
              state === "running" && "animate-spin motion-reduce:animate-none",
            )}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            role={state === "fail" ? "alert" : "status"}
            aria-atomic="true"
            className="min-w-0 space-y-1"
          >
            <h3 className="text-sm font-medium">{content.title}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {state === "fail" && error ? error : description}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 self-start sm:self-center"
            disabled={disabled || state === "running"}
            onClick={onTest}
          >
            {content.action}
          </Button>
        </div>
      </div>
      {result && result.checks.length > 0 && (
        <details
          key={`${state}:${result.testedAt}`}
          className="group border-t border-border"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              aria-hidden="true"
              className="size-3 transition-transform group-open:rotate-90"
            />
            Test details
          </summary>
          <ul className="space-y-3 px-4 pb-4">
            {result.checks.map((check) => (
              <li
                key={check.code}
                className="flex gap-2 text-xs leading-relaxed"
              >
                {check.level === "error" || check.level === "warn" ? (
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-destructive"
                  />
                ) : (
                  <CircleCheck
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-foreground">{check.message}</p>
                  {check.detail && (
                    <p className="break-all text-muted-foreground">
                      {check.detail}
                    </p>
                  )}
                  {check.hint && (
                    <p className="text-muted-foreground">{check.hint}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
