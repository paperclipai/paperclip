import { t, useTranslation } from "@/i18n";
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
    get title() { return t("task-components:testYourAgent_bcf9391c"); },
    get description() { return t("task-components:checkThatYourRuntimeAndModelCan_0325fd6d"); },
    action: "Run test",
  },
  running: {
    get title() { return t("task-components:testingConnection_04dfed9c"); },
    get description() { return t("task-components:checkingTheRuntimeAndWaitingForA_a1c61e07"); },
    action: "Testing…",
  },
  pass: {
    get title() { return t("task-components:connectionSuccessful_856dd8c8"); },
    get description() { return t("task-components:yourRuntimeChecksPassedReviewTheDetails_4edd5666"); },
    get action() { return t("final-components-a:testAgain_022f6c3d"); },
  },
  warn: {
    get title() { return t("task-components:connectionNeedsAttention_4f1fc01d"); },
    get description() { return t("task-components:reviewTheTestDetailsBeforeRunningYour_a186aaf2"); },
    get action() { return t("final-components-a:testAgain_022f6c3d"); },
  },
  fail: {
    get title() { return t("task-components:couldnTConnect_babe5b38"); },
    get description() { return t("task-components:checkYourModelAndProviderConnectionThen_c7c75083"); },
    get action() { return t("final-components-a:retryTest_1fa8f72f"); },
  },
} as const;

const prerequisiteCopy = {
  idle: { get title() { return t("task-components:checkPrerequisites_4124f184"); }, get description() { return t("task-components:checkInstanceSettingsAndPublicConnectionConfiguration_14f52a04"); }, action: "Check setup" },
  running: { get title() { return t("task-components:checkingPrerequisites_bed2352f"); }, get description() { return t("task-components:checkingInstanceSettingsAndPublicConnectionConfiguration_bfe563cc"); }, action: "Checking…" },
  pass: { get title() { return t("task-components:setupChecksPassed_a3a23e98"); }, get description() { return t("task-components:reviewTheSetupDetailsBeforeAssigningWork_a82920ef"); }, action: "Check again" },
  warn: { get title() { return t("task-components:pairingRequired_4fd15e65"); }, get description() { return t("task-components:createThisAgentThenPairItAnd_ab95a97d"); }, action: "Check again" },
  fail: { get title() { return t("task-components:prerequisiteCheckFailed_b9631792"); }, get description() { return t("task-components:reviewTheSetupDetailsAndRetry_61e8d3c9"); }, action: "Retry check" },
} as const;

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
  useTranslation("task-components");
  const missingRuntime = state === "fail"
    ? result?.checks.find(check => check.code === "acpx_runtime_package_missing")
    : undefined;
  const content = missingRuntime
    ? { ...copy.fail, title: t("task-components:runtimeMissing_7649ce73"), description: missingRuntime.message }
    : (variant === "prerequisites" ? prerequisiteCopy : copy)[state];
  const description = metadataOnly && state === "idle"
    ? t("final-components-a:verifyYourSavedTokenRuntime_1618aa2b")
    : metadataOnly && state === "running"
      ? t("final-components-a:checkingTheSavedTokenRuntime_9df0383a")
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
      aria-label={t("task-components:runtimeTest_a3b5b907")}
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
            />{t("task-components:testDetails_7cc561a5")}</summary>
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
