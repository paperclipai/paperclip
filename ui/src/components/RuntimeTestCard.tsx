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
import { useTranslation } from "@/i18n";
export type TestState = "idle" | "running" | "pass" | "fail";

export function RuntimeTestCard({
  state,
  result,
  error,
  onTest,
  disabled = false,
  variant = "connection",
  metadataOnly = false,
  tone = "card",
}: {
  state: TestState | "warn";
  result: AdapterEnvironmentTestResult | null;
  error?: string | null;
  onTest: () => void;
  disabled?: boolean;
  variant?: "connection" | "prerequisites";
  metadataOnly?: boolean;
  tone?: "card" | "tile";
}) {
  const { t } = useTranslation();
  const copy = {
    idle: {
      title: t("agents.RuntimeTestCard.idleTitle"),
      description: t("agents.RuntimeTestCard.idleDescription"),
      action: t("agents.RuntimeTestCard.idleAction"),
    },
    running: {
      title: t("agents.RuntimeTestCard.runningTitle"),
      description: t("agents.RuntimeTestCard.runningDescription"),
      action: t("agents.RuntimeTestCard.runningAction"),
    },
    pass: {
      title: t("agents.RuntimeTestCard.passTitle"),
      description: t("agents.RuntimeTestCard.passDescription"),
      action: t("agents.RuntimeTestCard.passAction"),
    },
    warn: {
      title: t("agents.RuntimeTestCard.warnTitle"),
      description: t("agents.RuntimeTestCard.warnDescription"),
      action: t("agents.RuntimeTestCard.warnAction"),
    },
    fail: {
      title: t("agents.RuntimeTestCard.failTitle"),
      description: t("agents.RuntimeTestCard.failDescription"),
      action: t("agents.RuntimeTestCard.failAction"),
    },
  };
  const prerequisiteCopy = {
    idle: {
      title: t("agents.RuntimeTestCard.prereqIdleTitle"),
      description: t("agents.RuntimeTestCard.prereqIdleDescription"),
      action: t("agents.RuntimeTestCard.prereqIdleAction"),
    },
    running: {
      title: t("agents.RuntimeTestCard.prereqRunningTitle"),
      description: t("agents.RuntimeTestCard.prereqRunningDescription"),
      action: t("agents.RuntimeTestCard.prereqRunningAction"),
    },
    pass: {
      title: t("agents.RuntimeTestCard.prereqPassTitle"),
      description: t("agents.RuntimeTestCard.prereqPassDescription"),
      action: t("agents.RuntimeTestCard.prereqPassAction"),
    },
    warn: {
      title: t("agents.RuntimeTestCard.prereqWarnTitle"),
      description: t("agents.RuntimeTestCard.prereqWarnDescription"),
      action: t("agents.RuntimeTestCard.prereqWarnAction"),
    },
    fail: {
      title: t("agents.RuntimeTestCard.prereqFailTitle"),
      description: t("agents.RuntimeTestCard.prereqFailDescription"),
      action: t("agents.RuntimeTestCard.prereqFailAction"),
    },
  };
  const missingRuntime = state === "fail"
    ? result?.checks.find(check => check.code === "acpx_runtime_package_missing")
    : undefined;
  const content = missingRuntime
    ? { ...copy.fail, title: t("agents.RuntimeTestCard.runtimeMissingTitle"), description: missingRuntime.message }
    : (variant === "prerequisites" ? prerequisiteCopy : copy)[state];
  const description = metadataOnly && state === "idle"
    ? t("agents.RuntimeTestCard.metadataIdleDescription")
    : metadataOnly && state === "running"
      ? t("agents.RuntimeTestCard.metadataRunningDescription")
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
      aria-label={t("agents.RuntimeTestCard.ariaLabel")}
      data-agent-tile={tone === "tile" ? "" : undefined}
      className={tone === "tile" ? "rounded-lg bg-(--agent-detail-tile)" : "rounded-lg border border-border bg-card"}
    >
      <div className={cn("flex items-start gap-3 sm:items-center", tone === "tile" ? "p-(--agent-detail-module-inset)" : "p-4")}>
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
            {t("agents.RuntimeTestCard.testDetails")}
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
