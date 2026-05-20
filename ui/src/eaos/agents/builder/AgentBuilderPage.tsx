// LET-504 — Manual agent builder at `/eaos/agents/new`.
//
// 6-step stepper (Identity → Model → Invocations → Tools → Skills →
// Knowledge) with a right-side sticky summary card. Single primary CTA
// `Create agent` only on the final step; earlier steps surface
// Back / Next only. Truthful labels for unavailable integrations: no
// fake-success controls.
//
// The existing operator path at `/agents/new` (NewAgent.tsx) is
// untouched — this is a parallel EAOS surface aimed at a non-operator
// flow with a calmer layout and no adapter-specific knobs.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Lock, Plug } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { agentsApi } from "@/api/agents";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { agentUrl } from "@/lib/utils";
import { redactSecretLikeText } from "../../secret-redact";
import {
  AGENT_BUILDER_STEPS,
  AGENT_THEMES,
  DEFAULT_AGENT_BUILDER_STATE,
  KNOWLEDGE_ACCESS_MODES,
  TRUST_PROFILE_OPTIONS,
  availabilityBadgeText,
  getInvocationChannelRows,
  getKnowledgeRows,
  getStepIndex,
  getToolGroupCards,
  isAvailabilityDisabled,
  isFinalStep,
  isFirstStep,
  nextStep,
  previousStep,
  summarizeAgentBuilder,
  type AgentBuilderState,
  type AgentBuilderStepId,
  type AgentThemeId,
  type InvocationAvailability,
  type KnowledgeAccessModeId,
  type TrustProfileId,
} from "./agent-builder-state";

interface AgentBuilderPageProps {
  // Tests inject the initial step so we can render any panel in
  // isolation; production always starts on Identity.
  initialStep?: AgentBuilderStepId;
}

export function AgentBuilderPage({ initialStep }: AgentBuilderPageProps = {}) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [currentStep, setCurrentStep] = useState<AgentBuilderStepId>(
    initialStep ?? AGENT_BUILDER_STEPS[0]!.id,
  );
  const [state, setState] = useState<AgentBuilderState>(DEFAULT_AGENT_BUILDER_STATE);
  const [formError, setFormError] = useState<string | null>(null);
  // Lifted "have we touched Name yet" flag — keeps the disabled-reason
  // and red inline error from shouting on a pristine pageload. Flips to
  // true on first edit/blur AND once we've already advanced past
  // Identity (since by then the user has either filled it or come back).
  const [nameTouched, setNameTouched] = useState(false);

  // Skills query — real backend data when a company is selected.
  const skillsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.companySkills.list(selectedCompanyId), "agent-builder"]
      : ["company-skills", "__no-company__", "agent-builder"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const availableSkills = useMemo(() => {
    const all = skillsQuery.data ?? [];
    // Built-in runtime skills are added automatically by the kernel;
    // the builder only surfaces optional pinnable skills.
    return all.filter((skill) => !skill.key.startsWith("paperclipai/paperclip/"));
  }, [skillsQuery.data]);

  const createAgent = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      agentsApi.hire(selectedCompanyId!, payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent.");
    },
  });

  const summary = useMemo(() => summarizeAgentBuilder(state), [state]);
  const stepIndex = getStepIndex(currentStep);
  const finalStep = isFinalStep(currentStep);
  const firstStep = isFirstStep(currentStep);

  // Per-step validation reason for the Next/Create button. The user
  // must finish each step's required fields before advancing — empty
  // Name on Identity should not silently let them walk to the end and
  // then encounter a disabled Create button with no explanation.
  // The footer reason waits for `nameTouched` so a pristine pageload
  // does not start out shouting "Name is required" at the user.
  const stepBlockedReason: string | null = (() => {
    switch (currentStep) {
      case "identity":
        return summary.nameError && nameTouched ? summary.nameError : null;
      case "model":
        return summary.modelError ? summary.modelError : null;
      default:
        return null;
    }
  })();
  // The button itself stays disabled until the field is filled — only
  // the explanatory reason waits for touch.
  const canAdvance = (() => {
    switch (currentStep) {
      case "identity":
        return !summary.nameError;
      case "model":
        return !summary.modelError;
      default:
        return true;
    }
  })();

  function patch(next: Partial<AgentBuilderState>) {
    setState((prev) => ({ ...prev, ...next }));
  }

  function markNameTouched() {
    if (!nameTouched) setNameTouched(true);
  }

  function goNext() {
    if (finalStep || !canAdvance) return;
    if (currentStep === "identity") markNameTouched();
    setCurrentStep((s) => nextStep(s));
  }

  function goBack() {
    if (firstStep) {
      navigate("/eaos/agents");
      return;
    }
    setCurrentStep((s) => previousStep(s));
  }

  function handleCreate() {
    if (!selectedCompanyId) {
      setFormError("Select a company scope before creating an agent.");
      return;
    }
    if (!summary.canCreate) {
      setFormError("Name and model are required before creating an agent.");
      return;
    }
    setFormError(null);
    const payload: Record<string, unknown> = {
      name: state.name.trim(),
      role: state.trustProfile,
      ...(state.description.trim()
        ? { title: state.description.trim().slice(0, 120) }
        : {}),
      adapterType: "claude_local",
      adapterConfig: {
        model: state.model.trim(),
        ...(state.extendedThinking ? { thinkingEffort: "high" } : {}),
      },
      runtimeConfig: {
        heartbeatEnabled: state.scheduledEnabled,
        intervalSec: state.heartbeatIntervalSec,
      },
      ...(state.selectedSkillKeys.length > 0
        ? { desiredSkills: state.selectedSkillKeys }
        : {}),
      budgetMonthlyCents: 0,
    };
    createAgent.mutate(payload);
  }

  return (
    <section
      aria-labelledby="eaos-agent-builder-title"
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="eaos-agent-builder-page"
      data-step={currentStep}
    >
      <header className="flex flex-col gap-1">
        <h1
          id="eaos-agent-builder-title"
          className="text-xl font-semibold tracking-tight text-foreground"
          data-testid="eaos-agent-builder-title"
        >
          New agent
        </h1>
        <p className="text-xs text-muted-foreground">
          Configure an agent identity, model, invocations, tools, skills, and knowledge.
        </p>
      </header>

      <Stepper currentStep={currentStep} onSelect={setCurrentStep} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="mx-auto w-full max-w-2xl">
            <StepPanel
              step={currentStep}
              state={state}
              patch={patch}
              skills={availableSkills}
              skillsLoading={Boolean(selectedCompanyId) && skillsQuery.isLoading}
              nameTouched={nameTouched}
              onMarkNameTouched={markNameTouched}
            />
            {formError ? (
              <div
                role="alert"
                data-testid="eaos-agent-builder-error"
                className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
              >
                {redactSecretLikeText(formError)}
              </div>
            ) : null}
            <StepperFooter
              stepIndex={stepIndex}
              finalStep={finalStep}
              firstStep={firstStep}
              canCreate={summary.canCreate}
              cannotCreateReason={summary.cannotCreateReason}
              canAdvance={canAdvance}
              stepBlockedReason={stepBlockedReason}
              isCreating={createAgent.isPending}
              onBack={goBack}
              onNext={goNext}
              onCreate={handleCreate}
            />
          </div>
        </div>

        <aside
          aria-label="Agent summary"
          data-testid="eaos-agent-builder-summary"
          className="lg:sticky lg:top-2 lg:self-start"
        >
          <SummaryCard state={state} />
        </aside>
      </div>
    </section>
  );
}

function Stepper({
  currentStep,
  onSelect,
}: {
  currentStep: AgentBuilderStepId;
  onSelect: (step: AgentBuilderStepId) => void;
}) {
  return (
    <ol
      data-testid="eaos-agent-builder-stepper"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
    >
      {AGENT_BUILDER_STEPS.map((step) => {
        const active = step.id === currentStep;
        return (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => onSelect(step.id)}
              data-testid={`eaos-agent-builder-step-${step.id}`}
              data-active={active ? "true" : "false"}
              aria-current={active ? "step" : undefined}
              className={
                "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background "
                + (active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground")
              }
            >
              <span className="font-mono tabular-nums text-[11px] opacity-70">{step.index}</span>
              <span>{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepperFooter({
  stepIndex,
  finalStep,
  firstStep,
  canCreate,
  cannotCreateReason,
  canAdvance,
  stepBlockedReason,
  isCreating,
  onBack,
  onNext,
  onCreate,
}: {
  stepIndex: number;
  finalStep: boolean;
  firstStep: boolean;
  canCreate: boolean;
  cannotCreateReason: string | null;
  canAdvance: boolean;
  stepBlockedReason: string | null;
  isCreating: boolean;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
}) {
  // Surface the exact reason a primary button is disabled. Reviewers
  // should never see a greyed-out "Create agent" with no explanation
  // for why it cannot fire.
  const buttonReason = finalStep ? (canCreate ? null : cannotCreateReason) : stepBlockedReason;
  return (
    <div
      data-testid="eaos-agent-builder-footer"
      className="sticky bottom-0 z-10 mt-6 flex flex-col gap-2 border-t border-border bg-background/95 pt-4 pb-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      {buttonReason ? (
        <p
          data-testid="eaos-agent-builder-disabled-reason"
          className="text-[11px] text-amber-700 dark:text-amber-300"
          role="status"
        >
          {buttonReason}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          data-testid="eaos-agent-builder-back"
        >
          <ArrowLeft className="mr-1 h-3 w-3" aria-hidden="true" />
          {firstStep ? "Cancel" : "Back"}
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            Step {stepIndex + 1} of {AGENT_BUILDER_STEPS.length}
          </span>
          {finalStep ? (
            <Button
              type="button"
              size="sm"
              onClick={onCreate}
              disabled={!canCreate || isCreating}
              data-testid="eaos-agent-builder-create"
              title={canCreate ? undefined : cannotCreateReason ?? undefined}
              aria-describedby={canCreate ? undefined : "eaos-agent-builder-disabled-reason"}
            >
              {isCreating ? "Creating…" : "Create agent"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={onNext}
              disabled={!canAdvance}
              data-testid="eaos-agent-builder-next"
              title={canAdvance ? undefined : stepBlockedReason ?? undefined}
              aria-describedby={canAdvance ? undefined : "eaos-agent-builder-disabled-reason"}
            >
              Next
              <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ state }: { state: AgentBuilderState }) {
  const summary = summarizeAgentBuilder(state);
  return (
    <div
      className="rounded-md border border-border bg-card p-4 text-sm"
      data-testid="eaos-agent-builder-summary-card"
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="h-10 w-10 flex-shrink-0 rounded-full"
          style={{ backgroundColor: summary.themeSwatch }}
          data-testid="eaos-agent-builder-summary-swatch"
        />
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold text-foreground"
            data-testid="eaos-agent-builder-summary-name"
          >
            {summary.displayName}
          </p>
          <p
            className="truncate text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-agent-builder-summary-role"
          >
            {summary.trustProfileLabel}
          </p>
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-[12px]">
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-model"
          label="Model"
          value={summary.modelLabel}
          hint={summary.thinkingLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-budget"
          label="Per-query budget"
          value={summary.budgetLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-invocations"
          label="Invocations"
          value={summary.invocationLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-integrations"
          label="Integrations"
          value={summary.integrationLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-tools"
          label="Tools"
          value={summary.toolLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-skills"
          label="Skills"
          value={summary.skillsLabel}
        />
        <SummaryRow
          dataTestId="eaos-agent-builder-summary-knowledge"
          label="Knowledge"
          value={summary.knowledgeLabel}
        />
      </dl>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  hint,
  dataTestId,
}: {
  label: string;
  value: string;
  hint?: string;
  dataTestId: string;
}) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2" data-testid={dataTestId}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <p className="truncate text-foreground">{value}</p>
        {hint ? <p className="truncate text-[11px] text-muted-foreground">{hint}</p> : null}
      </dd>
    </div>
  );
}

function StepPanel({
  step,
  state,
  patch,
  skills,
  skillsLoading,
  nameTouched,
  onMarkNameTouched,
}: {
  step: AgentBuilderStepId;
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
  skills: ReadonlyArray<{ id: string; key: string; name: string; description: string | null }>;
  skillsLoading: boolean;
  nameTouched: boolean;
  onMarkNameTouched: () => void;
}) {
  switch (step) {
    case "identity":
      return (
        <IdentityStep
          state={state}
          patch={patch}
          nameTouched={nameTouched}
          onMarkNameTouched={onMarkNameTouched}
        />
      );
    case "model":
      return <ModelStep state={state} patch={patch} />;
    case "invocations":
      return <InvocationsStep state={state} patch={patch} />;
    case "tools":
      return <ToolsStep state={state} patch={patch} />;
    case "skills":
      return <SkillsStep state={state} patch={patch} skills={skills} loading={skillsLoading} />;
    case "knowledge":
      return <KnowledgeStep state={state} patch={patch} />;
  }
}

function PanelShell({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="rounded-md border border-border bg-card p-4"
      data-testid={testId}
    >
      <div className="mb-3 flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[12px] text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[11px] uppercase tracking-wide text-muted-foreground"
    >
      {children}
    </label>
  );
}

function IdentityStep({
  state,
  patch,
  nameTouched,
  onMarkNameTouched,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
  nameTouched: boolean;
  onMarkNameTouched: () => void;
}) {
  // `nameTouched` is lifted into the parent so the footer disabled-
  // reason and the inline error both stay quiet on a pristine pageload.
  const nameMissing = state.name.trim().length === 0;
  const showNameError = nameTouched && nameMissing;
  return (
    <PanelShell
      title="Identity"
      description="What this agent is called and how it shows up."
      testId="eaos-agent-builder-panel-identity"
    >
      <div className="space-y-1">
        <FieldLabel htmlFor="agent-name">
          Name <span aria-hidden="true" className="text-red-600">*</span>
          <span className="sr-only"> (required)</span>
        </FieldLabel>
        <input
          id="agent-name"
          data-testid="eaos-agent-builder-name"
          value={state.name}
          onChange={(event) => {
            patch({ name: event.target.value });
            onMarkNameTouched();
          }}
          onBlur={onMarkNameTouched}
          className={
            "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring "
            + (showNameError ? "border-red-500" : "border-border")
          }
          placeholder="e.g. Research Analyst"
          maxLength={120}
          autoFocus
          aria-required="true"
          aria-invalid={showNameError ? "true" : undefined}
          aria-describedby={showNameError ? "agent-name-error" : "agent-name-help"}
        />
        {showNameError ? (
          <p
            id="agent-name-error"
            data-testid="eaos-agent-builder-name-error"
            className="text-[11px] text-red-600 dark:text-red-400"
          >
            Name is required to continue.
          </p>
        ) : (
          <p id="agent-name-help" className="text-[11px] text-muted-foreground">
            Shown in the agent list and on every comment this agent posts.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <FieldLabel htmlFor="agent-description">Description</FieldLabel>
        <textarea
          id="agent-description"
          data-testid="eaos-agent-builder-description"
          value={state.description}
          onChange={(event) => patch({ description: event.target.value })}
          rows={2}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="One line of what this agent does."
          maxLength={240}
        />
      </div>

      <div className="space-y-1">
        <FieldLabel>Trust profile</FieldLabel>
        <div
          role="radiogroup"
          aria-label="Trust profile"
          className="grid grid-cols-2 gap-2"
          data-testid="eaos-agent-builder-trust-profile"
        >
          {TRUST_PROFILE_OPTIONS.map((option) => {
            const active = state.trustProfile === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`eaos-agent-builder-trust-${option.id}`}
                onClick={() => patch({ trustProfile: option.id as TrustProfileId })}
                className={
                  "rounded-md border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
                  + (active
                    ? "border-foreground bg-accent/60 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-accent/40")
                }
              >
                <p className="text-sm font-medium text-foreground">{option.label}</p>
                <p className="text-[11px] text-muted-foreground">{option.tagline}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1">
        <FieldLabel>Icon theme</FieldLabel>
        <div
          role="radiogroup"
          aria-label="Icon theme"
          className="flex flex-wrap gap-2"
          data-testid="eaos-agent-builder-theme"
        >
          {AGENT_THEMES.map((theme) => {
            const active = state.themeId === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={theme.label}
                data-testid={`eaos-agent-builder-theme-${theme.id}`}
                onClick={() => patch({ themeId: theme.id as AgentThemeId })}
                className={
                  "flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
                  + (active ? "border-foreground" : "border-border")
                }
              >
                <span
                  aria-hidden="true"
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: theme.swatch }}
                />
                {theme.label}
              </button>
            );
          })}
        </div>
      </div>
    </PanelShell>
  );
}

function ModelStep({
  state,
  patch,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
}) {
  return (
    <PanelShell
      title="Model"
      description="Primary model, thinking, and subagent model for delegated work."
      testId="eaos-agent-builder-panel-model"
    >
      <div className="space-y-1">
        <FieldLabel htmlFor="agent-model">Primary model</FieldLabel>
        <input
          id="agent-model"
          data-testid="eaos-agent-builder-model"
          value={state.model}
          onChange={(event) => patch({ model: event.target.value })}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
          placeholder="claude-opus-4-7"
        />
        <p className="text-[11px] text-muted-foreground">
          Enter a provider model id, for example <code className="font-mono">claude-opus-4-7</code>.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm text-foreground">Extended thinking</p>
          <p className="text-[11px] text-muted-foreground">Allow the model to think before answering.</p>
        </div>
        <button
          type="button"
          aria-pressed={state.extendedThinking}
          data-testid="eaos-agent-builder-thinking"
          onClick={() => patch({ extendedThinking: !state.extendedThinking })}
          className={
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors "
            + (state.extendedThinking ? "bg-green-600" : "bg-muted")
          }
        >
          <span
            className={
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform "
              + (state.extendedThinking ? "translate-x-4.5" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      <div className="space-y-1">
        <FieldLabel htmlFor="agent-budget">Per-query budget (USD cents)</FieldLabel>
        <input
          id="agent-budget"
          type="number"
          min={0}
          step={5}
          data-testid="eaos-agent-builder-budget"
          value={state.perQueryBudgetCents}
          onChange={(event) => patch({ perQueryBudgetCents: Math.max(0, Number(event.target.value) || 0) })}
          className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono tabular-nums"
        />
        <p className="text-[11px] text-muted-foreground">
          Soft cap — the kernel still enforces monthly budget at the company level.
        </p>
      </div>

      <details className="rounded-md border border-border bg-background px-3 py-2">
        <summary className="cursor-pointer text-[12px] text-muted-foreground">
          Subagent model (advanced)
        </summary>
        <div className="mt-3 space-y-1">
          <FieldLabel htmlFor="agent-subagent-model">Subagent model</FieldLabel>
          <input
            id="agent-subagent-model"
            data-testid="eaos-agent-builder-subagent-model"
            value={state.subagentModel}
            onChange={(event) => patch({ subagentModel: event.target.value })}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
            placeholder="claude-haiku-4-5"
          />
          <p className="text-[11px] text-muted-foreground">
            Used for cheap delegated tool calls; defaults to a Haiku-class model.
          </p>
        </div>
      </details>
    </PanelShell>
  );
}

function InvocationsStep({
  state,
  patch,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
}) {
  const rows = useMemo(() => getInvocationChannelRows({ agentSaved: false }), []);
  return (
    <PanelShell
      title="Invocations"
      description="How this agent gets reached. Truthful labels for channels that need backend work."
      testId="eaos-agent-builder-panel-invocations"
    >
      <ul className="space-y-2" data-testid="eaos-agent-builder-invocations">
        {rows.map((row) => {
          const disabled = isAvailabilityDisabled(row.availability);
          return (
            <li
              key={row.id}
              data-testid={`eaos-agent-builder-invocation-${row.id}`}
              data-availability={row.availability.kind}
              className={
                "flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 "
                + (disabled ? "opacity-80" : "")
              }
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">{row.label}</p>
                <p className="truncate text-[11px] text-muted-foreground">{row.description}</p>
              </div>
              {row.id === "scheduled" ? (
                <ScheduledInvocationToggle
                  enabled={state.scheduledEnabled}
                  onChange={(value) => patch({ scheduledEnabled: value })}
                />
              ) : (
                <AvailabilityBadge availability={row.availability} />
              )}
            </li>
          );
        })}
      </ul>
    </PanelShell>
  );
}

function ScheduledInvocationToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={enabled}
      data-testid="eaos-agent-builder-scheduled-toggle"
      onClick={() => onChange(!enabled)}
      className={
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors "
        + (enabled ? "bg-green-600" : "bg-muted")
      }
    >
      <span
        className={
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform "
          + (enabled ? "translate-x-4.5" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function AvailabilityBadge({ availability }: { availability: InvocationAvailability }) {
  const Icon =
    availability.kind === "available"
      ? Check
      : availability.kind === "connect"
        ? Plug
        : availability.kind === "save-first"
          ? Lock
          : CircleAlert;
  const tone =
    availability.kind === "available"
      ? "border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
      : availability.kind === "connect"
        ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100"
        : availability.kind === "save-first"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
  return (
    <span
      data-testid="eaos-agent-builder-availability"
      data-availability={availability.kind}
      title={availability.kind === "available" ? "Available" : availability.reason}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium "
        + tone
      }
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {availabilityBadgeText(availability)}
    </span>
  );
}

function ToolsStep({
  state,
  patch,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
}) {
  const cards = useMemo(() => getToolGroupCards({ agentSaved: false }), []);
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof cards[number][]>();
    for (const card of cards) {
      const list = byGroup.get(card.group) ?? [];
      list.push(card);
      byGroup.set(card.group, list);
    }
    return byGroup;
  }, [cards]);

  function toggleTool(id: string) {
    const selected = state.selectedToolIds.includes(id);
    patch({
      selectedToolIds: selected
        ? state.selectedToolIds.filter((value) => value !== id)
        : [...state.selectedToolIds, id],
    });
  }

  return (
    <PanelShell
      title="Tools"
      description="Choose the tools this agent can use."
      testId="eaos-agent-builder-panel-tools"
    >
      <div
        className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-[12px] text-muted-foreground"
        data-testid="eaos-agent-builder-integrations-gap"
      >
        Workspace integrations are managed in Admin → Integrations.
      </div>
      {(["execution", "research", "data"] as const).map((groupId) => {
        const list = groups.get(groupId) ?? [];
        const title = groupId === "execution" ? "Execution" : groupId === "research" ? "Research" : "Data";
        return (
          <div key={groupId} className="space-y-2" data-testid={`eaos-agent-builder-tool-group-${groupId}`}>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((card) => {
                const selected = state.selectedToolIds.includes(card.id);
                const disabled = isAvailabilityDisabled(card.availability);
                return (
                  <li key={card.id}>
                    <button
                      type="button"
                      data-testid={`eaos-agent-builder-tool-${card.id}`}
                      data-availability={card.availability.kind}
                      data-selected={selected ? "true" : "false"}
                      disabled={disabled}
                      onClick={() => !disabled && toggleTool(card.id)}
                      className={
                        "flex w-full flex-col gap-1 rounded-md border bg-background px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
                        + (disabled
                          ? "cursor-not-allowed border-border opacity-70"
                          : selected
                            ? "border-foreground bg-accent/40"
                            : "border-border hover:bg-accent/30")
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{card.title}</span>
                        <AvailabilityBadge availability={card.availability} />
                      </div>
                      <p className="text-[11px] text-muted-foreground">{card.description}</p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </PanelShell>
  );
}

function SkillsStep({
  state,
  patch,
  skills,
  loading,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
  skills: ReadonlyArray<{ id: string; key: string; name: string; description: string | null }>;
  loading: boolean;
}) {
  function toggleSkill(key: string) {
    const selected = state.selectedSkillKeys.includes(key);
    patch({
      selectedSkillKeys: selected
        ? state.selectedSkillKeys.filter((value) => value !== key)
        : [...state.selectedSkillKeys, key],
    });
  }

  return (
    <PanelShell
      title="Skills"
      description="Optional skills the agent should pin. Built-in skills are added automatically."
      testId="eaos-agent-builder-panel-skills"
    >
      <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm text-foreground">Skill discovery</p>
          <p className="text-[11px] text-muted-foreground">
            Auto-attach matching skills when this agent runs, based on the task.
          </p>
        </div>
        <button
          type="button"
          aria-pressed={state.skillDiscoveryEnabled}
          data-testid="eaos-agent-builder-skill-discovery"
          onClick={() => patch({ skillDiscoveryEnabled: !state.skillDiscoveryEnabled })}
          className={
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors "
            + (state.skillDiscoveryEnabled ? "bg-green-600" : "bg-muted")
          }
        >
          <span
            className={
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform "
              + (state.skillDiscoveryEnabled ? "translate-x-4.5" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      <div data-testid="eaos-agent-builder-skills-list">
        {loading ? (
          <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Loading skills…
          </p>
        ) : skills.length === 0 ? (
          <p
            data-testid="eaos-agent-builder-skills-empty"
            className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground"
          >
            No optional company skills installed yet. Install skills from Admin → Library.
          </p>
        ) : (
          <ul className="space-y-2">
            {skills.map((skill) => {
              const selected = state.selectedSkillKeys.includes(skill.key);
              return (
                <li key={skill.id}>
                  <button
                    type="button"
                    data-testid={`eaos-agent-builder-skill-${skill.id}`}
                    data-selected={selected ? "true" : "false"}
                    onClick={() => toggleSkill(skill.key)}
                    className={
                      "flex w-full items-start gap-3 rounded-md border bg-background px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
                      + (selected ? "border-foreground bg-accent/40" : "border-border hover:bg-accent/30")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border "
                        + (selected ? "border-foreground bg-foreground text-background" : "border-border")
                      }
                    >
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{skill.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {skill.description ?? skill.key}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PanelShell>
  );
}

function KnowledgeStep({
  state,
  patch,
}: {
  state: AgentBuilderState;
  patch: (next: Partial<AgentBuilderState>) => void;
}) {
  const rows = getKnowledgeRows();
  return (
    <PanelShell
      title="Knowledge"
      description="How this agent reads memory and library packs."
      testId="eaos-agent-builder-panel-knowledge"
    >
      <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm text-foreground">Knowledge discovery</p>
          <p className="text-[11px] text-muted-foreground">
            Search the configured knowledge sources when this agent runs.
          </p>
        </div>
        <button
          type="button"
          aria-pressed={state.knowledgeDiscoveryEnabled}
          data-testid="eaos-agent-builder-knowledge-discovery"
          onClick={() =>
            patch({ knowledgeDiscoveryEnabled: !state.knowledgeDiscoveryEnabled })
          }
          className={
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors "
            + (state.knowledgeDiscoveryEnabled ? "bg-green-600" : "bg-muted")
          }
        >
          <span
            className={
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform "
              + (state.knowledgeDiscoveryEnabled ? "translate-x-4.5" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      <div
        role="radiogroup"
        aria-label="Knowledge access mode"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        data-testid="eaos-agent-builder-knowledge-modes"
      >
        {KNOWLEDGE_ACCESS_MODES.map((mode) => {
          const active = state.knowledgeMode === mode.id;
          const ready = mode.backendReady;
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`eaos-agent-builder-knowledge-mode-${mode.id}`}
              data-backend-ready={ready ? "true" : "false"}
              disabled={!ready}
              onClick={() => ready && patch({ knowledgeMode: mode.id as KnowledgeAccessModeId })}
              className={
                "rounded-md border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
                + (!ready
                  ? "cursor-not-allowed border-border opacity-70"
                  : active
                    ? "border-foreground bg-accent/60"
                    : "border-border bg-background hover:bg-accent/40")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{mode.label}</p>
                {!ready ? (
                  <AvailabilityBadge
                    availability={{
                      kind: "backend-gap",
                      reason: mode.backendGapReason ?? "Coming soon.",
                    }}
                  />
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">{mode.tagline}</p>
            </button>
          );
        })}
      </div>

      <details
        className="rounded-md border border-border bg-background px-3 py-2"
        data-testid="eaos-agent-builder-knowledge-advanced"
      >
        <summary className="cursor-pointer text-[12px] text-muted-foreground">
          Sources and labels
        </summary>
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid={`eaos-agent-builder-knowledge-row-${row.id}`}
              className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">{row.label}</p>
                <p className="truncate text-[11px] text-muted-foreground">{row.description}</p>
              </div>
              <AvailabilityBadge availability={row.availability} />
            </li>
          ))}
        </ul>
      </details>
    </PanelShell>
  );
}
