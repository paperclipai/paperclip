import type { ReactNode } from "react";
import { ResponsibleUserDenialNotice } from "@/components/ResponsibleUserDenialNotice";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { t } from "@/i18n";

/**
 * UX lab for PAP-12462 (P7): run "on behalf of {user}" surfacing + responsible-user
 * denial copy. Renders before/after of both surfaces with real design tokens so the
 * states can be captured for UX review. Route: /ux-lab/responsible-user-denial
 */

function LabSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-background/85 p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

function BeforeAfter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </div>
      <Card className="block border-border/60 p-3">{children}</Card>
    </div>
  );
}

/** A faithful copy of a run ledger row header (see IssueRunLedger.tsx). */
function RunLedgerRow({
  onBehalfOf,
  denial,
}: {
  onBehalfOf?: string | null;
  denial?: ReactNode;
}) {
  return (
    <article className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">{t("app.responsibleUserDenialUxLab.run", { defaultValue: "Run" })}</span>
        <span className="min-w-0 max-w-full truncate font-mono text-foreground">a1b2c3d4</span>
        <span>{t("app.responsibleUserDenialUxLab.byCodexcoder", { defaultValue: "by CodexCoder" })}</span>
        {onBehalfOf ? (
          <span className="min-w-0 max-w-full truncate text-muted-foreground">
            {t("app.responsibleUserDenialUxLab.onBehalfOf", { defaultValue: "on behalf of " })}<span className="text-foreground">{onBehalfOf}</span>
          </span>
        ) : null}
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? t("app.responsibleUserDenialUxLab.failed", { defaultValue: "Failed" }) : t("app.responsibleUserDenialUxLab.succeeded", { defaultValue: "Succeeded" })}
        </span>
        <span className="ml-auto shrink-0">{t("app.responsibleUserDenialUxLab.2mAgo", { defaultValue: "2m ago" })}</span>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="min-w-0">
          <span className="text-foreground">{t("app.responsibleUserDenialUxLab.elapsed", { defaultValue: "Elapsed" })}</span> {t("app.responsibleUserDenialUxLab.1m4s", { defaultValue: "1m 4s" })}</div>
        <div className="min-w-0">
          <span className="text-foreground">{t("app.responsibleUserDenialUxLab.lastUsefulAction", { defaultValue: "Last useful action" })}</span> {t("app.responsibleUserDenialUxLab.2mAgo", { defaultValue: "2m ago" })}</div>
        <div className="min-w-0">
          <span className="text-foreground">{t("app.responsibleUserDenialUxLab.stop", { defaultValue: "Stop" })}</span> {denial ? t("app.responsibleUserDenialUxLab.denied", { defaultValue: "Denied" }) : t("app.responsibleUserDenialUxLab.completed", { defaultValue: "Completed" })}
        </div>
      </div>
      {denial}
    </article>
  );
}

/** A faithful copy of the run-detail header identity block (see AgentDetail.tsx RunDetail). */
function RunDetailHeader({ onBehalfOf, denial }: { onBehalfOf?: string | null; denial?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold text-foreground">{t("app.responsibleUserDenialUxLab.runA1b2c3d4", { defaultValue: "Run a1b2c3d4" })}</span>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? "failed" : "succeeded"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-(length:--text-micro) text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide">
          {t("app.responsibleUserDenialUxLab.codexLocal", { defaultValue: "codex local" })}</span>
        <span>anthropic/claude-opus-4-8</span>
      </div>
      {onBehalfOf ? (
        <div className="text-xs text-muted-foreground">
          {t("app.responsibleUserDenialUxLab.onBehalfOf2", { defaultValue: "On behalf of " })}<span className="text-foreground">{onBehalfOf}</span>
        </div>
      ) : null}
      {denial}
    </div>
  );
}

export function ResponsibleUserDenialUxLab() {
  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {t("app.responsibleUserDenialUxLab.pap12462P7", { defaultValue: "PAP-12462 · P7" })}</div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">
            {t("app.responsibleUserDenialUxLab.runOnBehalfOfSurfacingDenialCopy", { defaultValue: "Run \"on behalf of\" surfacing + denial copy" })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("app.responsibleUserDenialUxLab.beforeAfterOfTheTwoRunSurfacesAndTheFourDenialRelatedStates", { defaultValue: "Before/after of the two run surfaces and the four denial-related states." })}</p>
        </header>

        <LabSection
          title={t("app.responsibleUserDenialUxLab.1RunIdentityOnBehalfOfUser", { defaultValue: "1 · Run identity — “on behalf of {user}”" })}
          description={t("app.responsibleUserDenialUxLab.aRunActingForAHumanNowNamesThatUserOnBothTheIssueRunLedgerAndTheRunDetailHeader", { defaultValue: "A run acting for a human now names that user on both the issue run ledger and the run detail header." })}
        >
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.beforeRunLedger", { defaultValue: "Before — run ledger" })}>
            <RunLedgerRow />
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.afterRunLedger", { defaultValue: "After — run ledger" })}>
            <RunLedgerRow onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.beforeRunDetail", { defaultValue: "Before — run detail" })}>
            <RunDetailHeader />
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.afterRunDetail", { defaultValue: "After — run detail" })}>
            <RunDetailHeader onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("app.responsibleUserDenialUxLab.2DenialStateResponsibleUserNotAuthorized", { defaultValue: "2 · Denial state — responsible user not authorized" })}
          description={t("app.responsibleUserDenialUxLab.theAgentIsAllowedButTheUserTheRunActsForIsNotDistinctFromAPlainAgentLacksPermissionFailure", { defaultValue: "The agent is allowed, but the user the run acts for is not. Distinct from a plain agent-lacks-permission failure." })}
        >
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.beforeGenericFailureText", { defaultValue: "Before — generic failure text" })}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("app.responsibleUserDenialUxLab.forbiddenActionNotPermitted", { defaultValue: "Forbidden: action not permitted" })}</span>
              <span className="ml-1 text-muted-foreground">(RESPONSIBLE_USER_UNAUTHORIZED)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.afterActionableDenialCopy", { defaultValue: "After — actionable denial copy" })}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAUTHORIZED"
              userName="Ada Lovelace"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("app.responsibleUserDenialUxLab.3DenialStateAgentLacksPermissionUnchanged", { defaultValue: "3 · Denial state — agent lacks permission (unchanged)" })}
          description={t("app.responsibleUserDenialUxLab.aDenialThatIsNotAResponsibleUserCodeKeepsTheExistingGenericErrorCopyNoResponsibleUserNotice", { defaultValue: "A denial that is NOT a responsible-user code keeps the existing generic error copy — no responsible-user notice." })}
        >
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.agentLacksPermissionFailure", { defaultValue: "Agent-lacks-permission failure" })}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("app.responsibleUserDenialUxLab.forbiddenAgentIsNotPermittedToPerformThisAction", { defaultValue: "Forbidden: agent is not permitted to perform this action" })}</span>
              <span className="ml-1 text-muted-foreground">(deny_missing_membership)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.noResponsibleUserNoticeRendered", { defaultValue: "No responsible-user notice rendered" })}>
            <div className="text-xs text-muted-foreground">
              {t("app.responsibleUserDenialUxLab.responsibleUserDenialNoticeIntentionallyAbsentForNonResponsibleUserCodes", { defaultValue: "Responsible-user denial notice intentionally absent for non-responsible-user codes." })}</div>
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("app.responsibleUserDenialUxLab.4DenialStateResponsibleUserUnavailable", { defaultValue: "4 · Denial state — responsible user unavailable" })}
          description={t("app.responsibleUserDenialUxLab.theUserThisRunActsForWasRemovedOrDeactivatedSteersTheAgentToMarkWorkBlocked", { defaultValue: "The user this run acts for was removed or deactivated. Steers the agent to mark work blocked." })}
        >
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.beforeGenericFailureText", { defaultValue: "Before — generic failure text" })}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("app.responsibleUserDenialUxLab.forbiddenResponsibleUserUnavailable", { defaultValue: "Forbidden: responsible user unavailable" })}</span>
              <span className="ml-1 text-muted-foreground">(RESPONSIBLE_USER_UNAVAILABLE)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.afterActionableDenialCopy", { defaultValue: "After — actionable denial copy" })}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAVAILABLE"
              userName="Grace Hopper"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("app.responsibleUserDenialUxLab.inContextDenialInsideAFailedRunLedgerRow", { defaultValue: "In-context — denial inside a failed run ledger row" })}
          description={t("app.responsibleUserDenialUxLab.howTheNoticeReadsWithinARunRowOnTheIssueTimeline", { defaultValue: "How the notice reads within a run row on the issue timeline." })}
        >
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.unauthorized", { defaultValue: "Unauthorized" })}>
            <RunLedgerRow
              onBehalfOf="Ada Lovelace"
              denial={
                <ResponsibleUserDenialNotice
                  code="RESPONSIBLE_USER_UNAUTHORIZED"
                  userName="Ada Lovelace"
                />
              }
            />
          </BeforeAfter>
          <BeforeAfter label={t("app.responsibleUserDenialUxLab.unavailable", { defaultValue: "Unavailable" })}>
            <RunLedgerRow
              onBehalfOf="Grace Hopper"
              denial={
                <ResponsibleUserDenialNotice
                  code="RESPONSIBLE_USER_UNAVAILABLE"
                  userName="Grace Hopper"
                />
              }
            />
          </BeforeAfter>
        </LabSection>

        <p className={cn("text-center text-(length:--text-micro) text-muted-foreground")}>
          {t("app.responsibleUserDenialUxLab.copyIsSourcedFromTheShared", { defaultValue: "Copy is sourced from the shared " })}<code>describeResponsibleUserDenial</code> contract.
        </p>
      </div>
    </div>
  );
}
