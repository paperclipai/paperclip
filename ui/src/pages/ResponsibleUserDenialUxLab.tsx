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
        <span className="font-medium text-foreground">{t("responsible-user-denial-ux-lab.run-137")}</span>
        <span className="min-w-0 max-w-full truncate font-mono text-foreground">a1b2c3d4</span>
        <span>{t("responsible-user-denial-ux-lab.by-codex-coder-179")}</span>
        {onBehalfOf ? (
          <span className="min-w-0 max-w-full truncate text-muted-foreground">
            {t("responsible-user-denial-ux-lab.on-behalf-of-z2p")} <span className="text-foreground">{onBehalfOf}</span>
          </span>
        ) : null}
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? "Failed" : "Succeeded"}
        </span>
        <span className="ml-auto shrink-0">{t("responsible-user-denial-ux-lab.2m-ago-1r2")}</span>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="min-w-0">
          <span className="text-foreground">{t("responsible-user-denial-ux-lab.elapsed-14q")}</span> 1m 4s
        </div>
        <div className="min-w-0">
          <span className="text-foreground">{t("responsible-user-denial-ux-lab.last-useful-action-1j9")}</span> {t("responsible-user-denial-ux-lab.2m-ago-1r2")}
        </div>
        <div className="min-w-0">
          <span className="text-foreground">{t("responsible-user-denial-ux-lab.stop-ky4")}</span> {denial ? "Denied" : "Completed"}
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
        <span className="text-lg font-semibold text-foreground">{t("responsible-user-denial-ux-lab.run-a1b2c3d4-309")}</span>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize text-muted-foreground">
          {denial ? "failed" : "succeeded"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-(length:--text-micro) text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide">
          {t("responsible-user-denial-ux-lab.codex-local-1qr")}
        </span>
        <span>anthropic/claude-opus-4-8</span>
      </div>
      {onBehalfOf ? (
        <div className="text-xs text-muted-foreground">
          {t("responsible-user-denial-ux-lab.on-behalf-of-gtj")} <span className="text-foreground">{onBehalfOf}</span>
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
            {t("responsible-user-denial-ux-lab.pap-12462-p7-jcw")}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">
            {t("responsible-user-denial-ux-lab.run-on-behalf-of-surfacing-denial-co-1m5")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("responsible-user-denial-ux-lab.before-after-of-the-two-run-surfaces-3y0")}
          </p>
        </header>

        <LabSection
          title={t("responsible-user-denial-ux-lab.1-run-identity-on-behalf-of-user-h4a")}
          description={t("responsible-user-denial-ux-lab.a-run-acting-for-a-human-now-names-t-1tv")}
        >
          <BeforeAfter label={t("responsible-user-denial-ux-lab.before-run-ledger-1vz")}>
            <RunLedgerRow />
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.after-run-ledger-1g7")}>
            <RunLedgerRow onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.before-run-detail-1lg")}>
            <RunDetailHeader />
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.after-run-detail-1v7")}>
            <RunDetailHeader onBehalfOf="Ada Lovelace" />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("responsible-user-denial-ux-lab.2-denial-state-responsible-user-not-pw1")}
          description="The agent is allowed, but the user the run acts for is not. Distinct from a plain agent-lacks-permission failure."
        >
          <BeforeAfter label={t("responsible-user-denial-ux-lab.before-generic-failure-text-f2j")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("responsible-user-denial-ux-lab.forbidden-action-not-permitted-15s")}
              </span>
              <span className="ml-1 text-muted-foreground">{t("responsible-user-denial-ux-lab.responsible-user-unauthorized-res")}</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.after-actionable-denial-copy-114")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAUTHORIZED"
              userName="Ada Lovelace"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("responsible-user-denial-ux-lab.3-denial-state-agent-lacks-permissio-d85")}
          description={t("responsible-user-denial-ux-lab.a-denial-that-is-not-a-responsible-u-iqe")}
        >
          <BeforeAfter label={t("responsible-user-denial-ux-lab.agent-lacks-permission-failure-3xk")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("responsible-user-denial-ux-lab.forbidden-agent-is-not-permitted-to-1p0")}
              </span>
              <span className="ml-1 text-muted-foreground">(deny_missing_membership)</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.no-responsible-user-notice-rendered-1o8")}>
            <div className="text-xs text-muted-foreground">
              Responsible-user denial notice intentionally absent for non-responsible-user codes.
            </div>
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("responsible-user-denial-ux-lab.4-denial-state-responsible-user-unav-1h8")}
          description={t("responsible-user-denial-ux-lab.the-user-this-run-acts-for-was-remov-1pb")}
        >
          <BeforeAfter label={t("responsible-user-denial-ux-lab.before-generic-failure-text-f2j")}>
            <div className="text-xs">
              <span className="text-red-600 dark:text-red-400">
                {t("responsible-user-denial-ux-lab.forbidden-responsible-user-unavailab-1h1")}
              </span>
              <span className="ml-1 text-muted-foreground">{t("responsible-user-denial-ux-lab.responsible-user-unavailable-1a2")}</span>
            </div>
          </BeforeAfter>
          <BeforeAfter label={t("responsible-user-denial-ux-lab.after-actionable-denial-copy-114")}>
            <ResponsibleUserDenialNotice
              code="RESPONSIBLE_USER_UNAVAILABLE"
              userName="Grace Hopper"
            />
          </BeforeAfter>
        </LabSection>

        <LabSection
          title={t("responsible-user-denial-ux-lab.in-context-denial-inside-a-failed-ru-61f")}
          description={t("responsible-user-denial-ux-lab.how-the-notice-reads-within-a-run-ro-1y0")}
        >
          <BeforeAfter label={t("responsible-user-denial-ux-lab.unauthorized-t5f")}>
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
          <BeforeAfter label={t("responsible-user-denial-ux-lab.unavailable-1ok")}>
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
          {t("responsible-user-denial-ux-lab.copy-is-sourced-from-the-shared-1m1")} <code>describeResponsibleUserDenial</code> {t("responsible-user-denial-ux-lab.contract-1q0")}
        </p>
      </div>
    </div>
  );
}
