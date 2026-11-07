import { t, useTranslation, Trans } from "@/i18n";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  get hire_agent() { return t("approval-ui:types.hire_agent"); },
  get approve_ceo_strategy() { return t("approval-ui:types.approve_ceo_strategy"); },
  get budget_override_required() { return t("approval-ui:types.budget_override_required"); },
  get request_board_approval() { return t("approval-ui:types.request_board_approval"); },
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return t("approval-ui:subject", { type: base, subject });
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  useTranslation("task-components");
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  useTranslation("task-components");
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">{t("task-components:skills_66d0f523")}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  useTranslation("task-components");
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{t("task-components:name_dcd1d522")}</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label={t("task-components:role_14736a2e")} value={payload.role} />
      <PayloadField label={t("approval-ui:jobTitle")} value={payload.title} />
      <PayloadField label={t("task-components:icon_a35abcd6")} value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">{t("task-components:capabilities_9460f16a")}</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{t("task-components:adapter_0252b849")}</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  useTranslation("task-components");
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label={t("task-components:title_7e8cd205")} value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  useTranslation("task-components");
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label={t("task-components:scope_b073f6c6")} value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label={t("task-components:window_19734a1b")} value={payload.windowKind} />
      <PayloadField label={t("task-components:metric_2d275a74")} value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_875077d7f1a4" components={{ part1: <>{budgetAmount !== null ? formatCents(budgetAmount) : "—"}</>, part2: <>{observedAmount !== null ? formatCents(observedAmount) : "—"}</> }} /></div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  useTranslation("task-components");
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

/**
 * Risks render inside a custom bullet row, so a leading markdown list marker
 * would nest a second bullet inside the first. Strip one leading marker.
 */
function stripLeadingListMarker(value: string): string {
  return value.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  useTranslation("task-components");
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => stripLeadingListMarker(value.trim()))
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{t("task-components:title_7e8cd205")}</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{t("task-components:summary_8e76a94a")}</p>
          <MarkdownBody className="leading-6 text-foreground/90">{summary}</MarkdownBody>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">{t("task-components:recommendedAction_0cdf19ee")}</p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{recommendedAction}</MarkdownBody>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{t("task-components:onApproval_e65731c1")}</p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</MarkdownBody>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{t("task-components:risks_bb685708")}</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk, index) => (
              <li key={`${index}-${risk}`} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <MarkdownBody className="leading-6">{risk}</MarkdownBody>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{t("task-components:proposedComment_36e856c1")}</p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  useTranslation("task-components");
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
