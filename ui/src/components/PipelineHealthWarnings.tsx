import { t, useTranslation } from "@/i18n";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { PipelineHealthWarning } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * Setup-health warnings for pipelines, rendered in the same plain-language
 * prosumer voice as the rest of the pipelines UI. The copy comes straight from
 * `computePipelineHealth`; known messages are localized only at this display boundary.
 */

/** Translate known product copy at the UI boundary; keep custom/server messages intact. */
export function pipelineHealthWarningMessage(warning: PipelineHealthWarning): string {
  if (warning.message === "Assigned to a teammate who's no longer here. Pick someone else to run this step.") return t("localizationOperations.healthMessage0");
  if (warning.message === "Assigned to a teammate, but there are no instructions yet. Add instructions so this step doesn't stall.") return t("localizationOperations.healthMessage1");
  if (warning.message === "This step has instructions, but no agent is assigned. Add an agent to run this step, or make it a review step if a person should decide.") return t("localizationOperations.healthMessage2");
  if (warning.message === "Nothing runs here automatically — items will sit until a person moves them. Add an agent to run this step, or make it a review step if a person should decide.") return t("localizationOperations.healthMessage3");
  if (warning.message === "No approver picked yet, so work will pile up here. Choose who approves.") return t("localizationOperations.healthMessage4");
  if (warning.message === "This step breaks work into another workflow, but that destination is missing. Pick where the pieces should go.") return t("localizationOperations.healthMessage5");
  if (warning.message === "These instructions hand off to a workflow that's been deleted. Point them at one that exists.") return t("localizationOperations.healthMessage6");
  const match0 = new RegExp("^(.+) is paused, so this step won't run until they're back\\. Reassign it if you can't wait\\.$", "s").exec(warning.message);
  if (match0) return t("localizationOperations.health_pausedAgent", { name: match0[1] });
  const match1 = new RegExp("^(.+) is the approver and they're paused, so nothing can be approved until they're back\\.$", "s").exec(warning.message);
  if (match1) return t("localizationOperations.health_pausedApprover", { name: match1[1] });
  const match2 = new RegExp("^This step creates (.+)s but does not wait for them before moving on\\. Turn on waiting if the next step depends on the pieces finishing\\.$", "s").exec(warning.message);
  if (match2) return t("localizationOperations.health_noWait", { name: match2[1] });
  const match3 = new RegExp("^New (.+)s start in a destination step that may not accept new work cleanly\\. Choose the entry step for that workflow\\.$", "s").exec(warning.message);
  if (match3) return t("localizationOperations.health_unsafeEntry", { name: match3[1] });
  const match4 = new RegExp("^These instructions hand off to a step that no longer exists in \"(.+)\"\\. Point them at one that does\\.$", "s").exec(warning.message);
  if (match4) return t("localizationOperations.health_missingStage", { name: match4[1] });
  const match5 = new RegExp("^Automation failed on \"(.+)\"\\. Open the item to inspect the log and retry it\\.$", "s").exec(warning.message);
  if (match5) return t("localizationOperations.health_automationFailed", { name: match5[1] });
  return warning.message;
}

/** Board-bar caps its list so a busy pipeline doesn't render a wall of warnings. */
const BOARD_WARNING_CAP = 5;

function WarningMessage({ warning }: { warning: PipelineHealthWarning }) {
  useTranslation();
  return (
    <>
      {pipelineHealthWarningMessage(warning)}
      {warning.href ? (
        <>
          {" "}
          <Link to={warning.href} className="font-medium underline underline-offset-2">
            {warning.hrefLabel === "Open item" ? t("localizationOperations.openItem") : warning.hrefLabel ?? t("localizationOperations.ui_Open")}
          </Link>
        </>
      ) : null}
    </>
  );
}

/**
 * Board-header bar: a single amber strip summarising every stage that won't run,
 * with each warning optionally clickable to jump to that stage's settings.
 */
export function PipelineHealthBar({
  warnings,
  onSelectStage,
  className,
}: {
  warnings: PipelineHealthWarning[];
  onSelectStage?: (stageId: string) => void;
  className?: string;
}) {
  useTranslation();
  if (warnings.length === 0) return null;
  const shown = warnings.slice(0, BOARD_WARNING_CAP);
  const overflow = warnings.length - shown.length;
  return (
    <div
      role="region"
      aria-labelledby="pipeline-health-bar-heading"
      className={cn(
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200",
        className,
      )}
    >
      <h2 id="pipeline-health-bar-heading" className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{t("localizationOperations.healthBarTitle", { count: warnings.length })}</span>
      </h2>
      <ul className="mt-1.5 space-y-1 pl-6 text-sm">
        {shown.map((warning, index) => {
          const body = (
            <>
              <span className="font-medium">{warning.stageName}:</span> <WarningMessage warning={warning} />
            </>
          );
          return (
            <li key={`${warning.stageId}-${warning.code}-${index}`} className="list-disc">
              {warning.href ? (
                <span>{body}</span>
              ) : onSelectStage ? (
                <button
                  type="button"
                  aria-label={t("localizationOperations.openStageSettings", { stage: warning.stageName })}
                  className="group flex w-full items-start gap-1 text-left underline-offset-2 hover:underline"
                  onClick={() => onSelectStage(warning.stageId)}
                >
                  <span className="min-w-0 flex-1">{body}</span>
                  <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                </button>
              ) : (
                <span>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {overflow > 0 ? (
        <p className="mt-1.5 pl-6 text-xs text-amber-800/80 dark:text-amber-200/70">
          {t("localizationOperations.moreWarnings", { count: overflow })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Compact per-stage warning list, shown inside a stage's settings panel.
 */
export function StageHealthWarnings({
  warnings,
  className,
}: {
  warnings: PipelineHealthWarning[];
  className?: string;
}) {
  useTranslation();
  if (warnings.length === 0) return null;
  return (
    <div
      role="region"
      aria-labelledby="stage-health-warnings-heading"
      className={cn(
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-200",
        className,
      )}
    >
      <h2
        id="stage-health-warnings-heading"
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {t(warnings.length === 1 ? "localizationOperations.healthStageTitleSingle" : "localizationOperations.healthStageTitle", { count: warnings.length })}
        </span>
      </h2>
      <ul className="mt-1.5 space-y-1 pl-6">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`} className="list-disc">
            <WarningMessage warning={warning} />
          </li>
        ))}
      </ul>
    </div>
  );
}
