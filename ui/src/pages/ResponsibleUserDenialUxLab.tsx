import { t as finalPagesT } from "@/i18n";
import { t as translateShell, useTranslation, Trans } from "@/i18n";
import type { ReactNode } from "react";
import { ResponsibleUserDenialNotice } from "@/components/ResponsibleUserDenialNotice";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
  return (
    <article className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">{translateShell("shell:run")}</span>
        <span className="min-w-0 max-w-full truncate font-mono text-foreground">a1b2c3d4</span>
        <span>{translateShell("shell:by_codexcoder")}</span>
        {onBehalfOf ? (
          <span className="min-w-0 max-w-full truncate text-muted-foreground"><Trans ns="shell" i18nKey="on_behalf_of" components={{ part1: <>{<span className="text-foreground">{onBehalfOf}</span>}</> }} /></span>
        ) : null}
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? translateShell("shell:failed") : translateShell("shell:succeeded")}
        </span>
        <span className="ml-auto shrink-0">{translateShell("shell:2m_ago")}</span>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="min-w-0">
          <span className="text-foreground">{translateShell("shell:elapsed")}</span>{finalPagesT("final-pages:1m_4s_f27e16")}
        </div>
        <div className="min-w-0"><Trans ns="shell" i18nKey="2m_ago_432b65" components={{ part1: <>{<span className="text-foreground">{finalPagesT("final-pages:Last_useful_action_72876f")}</span>}</> }} /></div>
        <div className="min-w-0">
          <span className="text-foreground">{translateShell("shell:stop")}</span> {denial ? translateShell("shell:denied") : translateShell("shell:completed")}
        </div>
      </div>
      {denial}
    </article>
  );
}

/** A faithful copy of the run-detail header identity block (see AgentDetail.tsx RunDetail). */
function RunDetailHeader({ onBehalfOf, denial }: { onBehalfOf?: string | null; denial?: ReactNode }) {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold text-foreground">{translateShell("shell:run_a1b2c3d4")}</span>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? finalPagesT("final-pages:failed_5d28a9") : finalPagesT("final-pages:succeeded_5dceae")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-(length:--text-micro) text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide">{translateShell("shell:codex_local")}</span>
        <span>anthropic/claude-opus-4-8</span>
      </div>
      {onBehalfOf ? (
        <div className="text-xs text-muted-foreground"><Trans ns="shell" i18nKey="on_behalf_of_2451d8" components={{ part1: <>{<span className="text-foreground">{onBehalfOf}</span>}</> }} /></div>
      ) : null}
      {denial}
    </div>
  );
}

export function ResponsibleUserDenialUxLab() {
  const { t: translateShell } = useTranslation("shell");
  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            PAP-12462 · P7
          </div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">{translateShell("shell:run_on_behalf_of_surfacing_denial_copy")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{translateShell("shell:before_after_of_the_two_run_surfaces")}</p>
        </header>

        <LabSection
          title={translateShell("shell:1_run_identity_on_behalf_of_user")}
          description={translateShell("shell:a_run_acting_for_a_human_now")}
        >
          <BeforeAfter label={translateShell("shell:before_run_ledger")}>
            <RunLedgerRow />
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:after_run_ledger")}>
            <RunLedgerRow onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:before_run_detail")}>
            <RunDetailHeader />
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:after_run_detail")}>
            <RunDetailHeader onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={translateShell("shell:2_denial_state_responsible_user_not_authorized")}
          description={translateShell("shell:the_agent_is_allowed_but_the_user")}
        >
          <BeforeAfter label={translateShell("shell:before_generic_failure_text")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">{translateShell("shell:forbidden_action_not_permitted")}</span>
              <span className="ml-1 text-muted-foreground">{"(RESPONSIBLE_USER_UNAUTHORIZED)"}</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:after_actionable_denial_copy")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAUTHORIZED"
              userName="Ada Lovelace"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={translateShell("shell:3_denial_state_agent_lacks_permission_unchanged")}
          description={translateShell("shell:a_denial_that_is_not_a_responsible")}
        >
          <BeforeAfter label={translateShell("shell:agent_lacks_permission_failure")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">{translateShell("shell:forbidden_agent_is_not_permitted_to_perform")}</span>
              <span className="ml-1 text-muted-foreground">{"(deny_missing_membership)"}</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:no_responsible_user_notice_rendered")}>
            <div className="text-xs text-muted-foreground">{translateShell("shell:responsible_user_denial_notice_intentionally_absent_for")}</div>
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={translateShell("shell:4_denial_state_responsible_user_unavailable")}
          description={translateShell("shell:the_user_this_run_acts_for_was")}
        >
          <BeforeAfter label={translateShell("shell:before_generic_failure_text")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">{translateShell("shell:forbidden_responsible_user_unavailable")}</span>
              <span className="ml-1 text-muted-foreground">{"(RESPONSIBLE_USER_UNAVAILABLE)"}</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={translateShell("shell:after_actionable_denial_copy")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAVAILABLE"
              userName="Grace Hopper"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={translateShell("shell:in_context_denial_inside_a_failed_run")}
          description={translateShell("shell:how_the_notice_reads_within_a_run")}
        >
          <BeforeAfter label={translateShell("shell:unauthorized")}>
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
          <BeforeAfter label={translateShell("shell:unavailable")}>
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

        <p className={cn("text-center text-(length:--text-micro) text-muted-foreground")}><Trans ns="shell" i18nKey="copy_is_sourced_from_the_shared_contract" components={{ part1: <>{<code>describeResponsibleUserDenial</code>}</> }} /></p>
      </div>
    </div>
  );
}
