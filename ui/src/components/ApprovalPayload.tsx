import type { ReactNode } from "react";
import { ChevronRight, Lightbulb, ShieldAlert, ShieldCheck, UserPlus } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function firstNonEmptyArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      const items = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    if (typeof value === "string") {
      const item = value.trim();
      if (item.length > 0) return [item];
    }
  }
  return [];
}

type StrategyDecisionCard = {
  recommendation: string;
  why: string[];
  topRisk: string | null;
  confidence: "low" | "medium" | "high" | null;
  nextStepMode: "execute" | "probe" | "escalate" | null;
  nextStep: string | null;
  alternatives: string[];
  evidence: string[];
  changeMyMind: string | null;
};

const CONFIDENCE_TONES: Record<NonNullable<StrategyDecisionCard["confidence"]>, string> = {
  high: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const NEXT_STEP_LABELS: Record<NonNullable<StrategyDecisionCard["nextStepMode"]>, string> = {
  execute: "Execute",
  probe: "Run Probe",
  escalate: "Escalate",
};

function parseStrategyDecisionCard(payload: Record<string, unknown>): StrategyDecisionCard | null {
  const recommendation = firstNonEmptyString(
    payload.recommendation,
    payload.recommendedDirection,
  );
  const why = firstNonEmptyArray(payload.why, payload.whyThisDirection).slice(0, 3);
  const topRisk = firstNonEmptyString(payload.topRisk, Array.isArray(payload.risks) ? payload.risks[0] : null);
  const confidenceCandidate = firstNonEmptyString(payload.confidence)?.toLowerCase();
  const confidence =
    confidenceCandidate === "low" || confidenceCandidate === "medium" || confidenceCandidate === "high"
      ? confidenceCandidate
      : null;
  const nextStepModeCandidate = firstNonEmptyString(payload.nextStepMode)?.toLowerCase();
  const nextStepMode =
    nextStepModeCandidate === "execute" || nextStepModeCandidate === "probe" || nextStepModeCandidate === "escalate"
      ? nextStepModeCandidate
      : null;
  const nextStep = firstNonEmptyString(payload.nextStep, payload.nextActionOnApproval);
  const alternatives = firstNonEmptyArray(payload.alternatives, payload.alternativesConsidered).slice(0, 2);
  const evidence = firstNonEmptyArray(payload.evidence);
  const changeMyMind = firstNonEmptyString(payload.changeMyMind, payload.whatWouldChangeMyMind);

  if (!recommendation) return null;
  if (why.length === 0 && !topRisk && !confidence && !nextStep) return null;

  return {
    recommendation,
    why,
    topRisk,
    confidence,
    nextStepMode,
    nextStep,
    alternatives,
    evidence,
    changeMyMind,
  };
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendation,
    payload?.recommendedDirection,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
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

function StrategistSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function StrategistDisclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-border/60 bg-background/40 px-3.5 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span>{title}</span>
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2 text-sm text-foreground/90">{children}</div>
    </details>
  );
}

function StrategistDecisionCard({ payload }: { payload: Record<string, unknown> }) {
  const card = parseStrategyDecisionCard(payload);
  if (!card) return null;

  return (
    <div className="space-y-3.5 rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
      <StrategistSection title="Recommended Direction">
        <p className="leading-6 text-foreground">{card.recommendation}</p>
      </StrategistSection>

      {card.why.length > 0 && (
        <StrategistSection title="Why This Direction">
          <ul className="space-y-1.5 text-sm text-foreground/90">
            {card.why.map((reason) => (
              <li key={reason} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{reason}</span>
              </li>
            ))}
          </ul>
        </StrategistSection>
      )}

      {card.topRisk && (
        <StrategistSection title="Top Risk">
          <p className="leading-6 text-foreground/90">{card.topRisk}</p>
        </StrategistSection>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {card.confidence && (
          <StrategistSection title="Confidence">
            <span
              className={[
                "inline-flex rounded-full border px-2 py-1 text-xs font-medium capitalize",
                CONFIDENCE_TONES[card.confidence],
              ].join(" ")}
            >
              {card.confidence.slice(0, 1).toUpperCase() + card.confidence.slice(1)}
            </span>
          </StrategistSection>
        )}

        {(card.nextStepMode || card.nextStep) && (
          <StrategistSection title="Next Step">
            <div className="space-y-2">
              {card.nextStepMode && (
                <span className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-xs font-medium text-foreground">
                  {NEXT_STEP_LABELS[card.nextStepMode]}
                </span>
              )}
              {card.nextStep && (
                <p className="leading-6 text-foreground/90">{card.nextStep}</p>
              )}
            </div>
          </StrategistSection>
        )}
      </div>

      {card.alternatives.length > 0 && (
        <StrategistDisclosure title="Alternatives Considered">
          <ul className="space-y-1.5">
            {card.alternatives.map((alternative) => (
              <li key={alternative} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{alternative}</span>
              </li>
            ))}
          </ul>
        </StrategistDisclosure>
      )}

      {card.evidence.length > 0 && (
        <StrategistDisclosure title="Evidence">
          <ul className="space-y-1.5">
            {card.evidence.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{item}</span>
              </li>
            ))}
          </ul>
        </StrategistDisclosure>
      )}

      {card.changeMyMind && (
        <StrategistDisclosure title="What Would Change My Mind">
          <p className="leading-6">{card.changeMyMind}</p>
        </StrategistDisclosure>
      )}
    </div>
  );
}

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
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
  const decisionCard = parseStrategyDecisionCard(payload);
  if (decisionCard) {
    return (
      <div className="mt-3">
        <StrategistDecisionCard payload={payload} />
      </div>
    );
  }

  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
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
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
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
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const strategistDecisionCard = parseStrategyDecisionCard(payload);
  if (strategistDecisionCard) {
    return (
      <div className="mt-4">
        <StrategistDecisionCard payload={payload} />
      </div>
    );
  }

  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
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
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Proposed comment
          </p>
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
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
