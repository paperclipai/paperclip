// LET-513 §1–§2 — First-run onboarding inside the canonical EAOS shell.
//
// Surface contract:
//   - Renders inside the `/eaos` shell (so the rail + topbar remain
//     consistent). Triggered when the user lands on `/eaos*` with no
//     companies — `EaosCommandCenterRoute` redirects to `/eaos/onboarding`
//     in that case.
//   - Step 1: User names the company and the bootstrap "Personal Assistant"
//     agent. Default agent name follows the rule: the company name if it
//     looks like a brand, otherwise the literal "Personal Assistant".
//   - Step 2: Calls `companiesApi.create()` via the canonical
//     CompanyContext. On success, the company auto-selects (existing
//     mutation behaviour) and the user is sent to `/eaos` with a "Next
//     steps" panel surfaced as an opt-in second-step on this same screen.
//   - Step 3 (always visible after the company exists): polished cards for
//     Slack connect, MCP server picker, and the "Personal CEO
//     recommendations" mission. These are clearly labeled as backend gaps
//     until the wiring lands in follow-up issues; no fake activity, no
//     destructive external calls, no raw secret inputs.
//
// Safety: this page never asks for, displays, or logs raw secrets. The
// Slack/MCP cards link out to the safe install-preview flow that will land
// in the follow-up issues; the cards on this page are advertisement +
// "Connect later" affordance.

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, Plug, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { ApiError } from "@/api/client";
import {
  eaosOnboardingApi,
  type SlackConnectionResponse,
  type SlackConnectionState,
  type SlackInstallPreviewResponse,
} from "@/api/eaosOnboarding";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import { redactSecretLikeText } from "../secret-redact";

const DEFAULT_ASSISTANT_LABEL = "Personal Assistant";

interface FormState {
  companyName: string;
  assistantName: string;
}

function deriveAssistantDefault(companyName: string): string {
  const trimmed = companyName.trim();
  if (!trimmed) return DEFAULT_ASSISTANT_LABEL;
  // If the company name looks like a brand (single token or PascalCase),
  // use it as the assistant name. Otherwise fall back to the canonical
  // "Personal Assistant" label. Matches the LET-513 §1 rule "use either
  // the company name where natural, or default to Personal Assistant".
  if (trimmed.length <= 32 && !/\s{2,}/.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_ASSISTANT_LABEL;
}

export function EaosOnboardingPage() {
  const { createCompany, companies, selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({
    companyName: "",
    assistantName: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasCompany = companies.length > 0;
  const effectiveAssistantName = form.assistantName.trim() || deriveAssistantDefault(form.companyName);
  const companyNameValid = form.companyName.trim().length > 0;

  // Whether to surface the post-create "next steps" panel. After a
  // successful create the CompanyContext mutation auto-selects the company,
  // so we can detect "ready for next steps" by checking that there is at
  // least one company AND the user just walked through onboarding (or
  // intentionally re-opened it).
  const showNextSteps = hasCompany;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!companyNameValid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createCompany({ name: form.companyName.trim() });
      // Refresh access + memberships so the new owner role propagates.
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not create company.";
      setError(redactSecretLikeText(message));
    } finally {
      setSubmitting(false);
    }
  };

  const goToDashboard = () => navigate("/eaos");

  return (
    <section
      aria-labelledby="eaos-onboarding-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-onboarding-page"
      data-eaos-onboarding-stage={showNextSteps ? "next-steps" : "create-company"}
    >
      <EaosPageHeader title="Get started" testId="eaos-onboarding-page-header" />
      <h1 id="eaos-onboarding-title" className="sr-only">
        Set up your Enterprise Agent OS workspace
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
        {!showNextSteps ? (
          <CreateCompanyCard
            form={form}
            setForm={setForm}
            effectiveAssistantName={effectiveAssistantName}
            companyNameValid={companyNameValid}
            submitting={submitting}
            error={error}
            onSubmit={handleSubmit}
          />
        ) : (
          <NextStepsPanel
            assistantName={effectiveAssistantName}
            onContinue={goToDashboard}
            companyId={selectedCompanyId}
          />
        )}
      </div>
    </section>
  );
}

function CreateCompanyCard({
  form,
  setForm,
  effectiveAssistantName,
  companyNameValid,
  submitting,
  error,
  onSubmit,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  effectiveAssistantName: string;
  companyNameValid: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      data-testid="eaos-onboarding-create-form"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 rounded-lg border border-border bg-card p-6"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Name your workspace</h2>
        <p className="text-sm text-muted-foreground">
          We&apos;ll create the workspace, install your first assistant, and prepare a
          short setup checklist. You can rename either later.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="eaos-onboarding-company-name"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Company / workspace name
        </label>
        <input
          id="eaos-onboarding-company-name"
          type="text"
          autoComplete="off"
          required
          disabled={submitting}
          data-testid="eaos-onboarding-company-name-input"
          value={form.companyName}
          onChange={(event) =>
            setForm({ ...form, companyName: event.target.value })
          }
          placeholder="Acme Robotics"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="eaos-onboarding-assistant-name"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Bootstrap assistant name
        </label>
        <input
          id="eaos-onboarding-assistant-name"
          type="text"
          autoComplete="off"
          disabled={submitting}
          data-testid="eaos-onboarding-assistant-name-input"
          value={form.assistantName}
          onChange={(event) =>
            setForm({ ...form, assistantName: event.target.value })
          }
          placeholder={effectiveAssistantName}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
        />
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="eaos-onboarding-assistant-name-preview"
        >
          Will be created as:{" "}
          <span className="font-medium text-foreground">{effectiveAssistantName}</span>
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="eaos-onboarding-error"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      ) : null}

      <div
        className="rounded-md border border-dashed border-border bg-background p-3 text-[11px] text-muted-foreground"
        data-testid="eaos-onboarding-bootstrap-note"
      >
        <p className="font-medium text-foreground">What happens on submit</p>
        <ul className="mt-1 list-inside list-disc space-y-0.5">
          <li>
            <span className="font-medium text-foreground">Workspace</span>{" "}
            created via the canonical company API — you become the owner.
          </li>
          <li>
            <span className="font-medium text-foreground">Bootstrap agent</span>{" "}
            wiring is queued through the canonical agent-hire flow. Until that
            backend hook lands you&apos;ll see a Connect card on the next step rather
            than a fake-success agent.
          </li>
          <li>
            <span className="font-medium text-foreground">No external calls</span>{" "}
            — no Slack, MCP, or vendor token is requested or sent. You&apos;ll be
            offered safe install previews after the workspace is live.
          </li>
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          data-testid="eaos-onboarding-submit"
          disabled={!companyNameValid || submitting}
        >
          {submitting ? "Creating workspace…" : "Create workspace"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          You can change this name later in Admin → Company settings.
        </span>
      </div>
    </form>
  );
}

interface NextStepCard {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof MessageSquare;
  readonly status: "pending-backend" | "queued-stub" | "preview-ready";
  readonly ctaLabel: string;
  readonly testId: string;
}

function NextStepsPanel({
  assistantName,
  onContinue,
  companyId,
}: {
  assistantName: string;
  onContinue: () => void;
  companyId: string | null;
}) {
  const cards = useMemo<readonly NextStepCard[]>(
    () => [
      {
        id: "slack-connect",
        title: "Connect Slack",
        description:
          "Give your assistant a place to listen and respond. We’ll run a safe install preview — no raw tokens enter the UI; the install is gated behind the canonical approval card.",
        icon: MessageSquare,
        status: "preview-ready",
        ctaLabel: "Preview Slack install",
        testId: "eaos-onboarding-next-step-slack",
      },
      {
        id: "mcp-picker",
        title: "Pick MCP servers",
        description:
          "Choose which capability bundles your assistant can use. Each pick is staged as a preview, allowlisted in the catalog, and only applied after an explicit approval.",
        icon: Plug,
        status: "pending-backend",
        ctaLabel: "Pick later",
        testId: "eaos-onboarding-next-step-mcp",
      },
      {
        id: "ceo-recommendations",
        title: "Start CEO recommendations",
        description:
          "Your assistant inspects the workspace and proposes projects, a starter team, preset skills, and a shared knowledge base. Each proposal is an approval card before any team is created.",
        icon: Sparkles,
        status: "queued-stub",
        ctaLabel: "Start later",
        testId: "eaos-onboarding-next-step-ceo",
      },
    ],
    [],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <section
        data-testid="eaos-onboarding-success"
        className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Workspace ready.</p>
          <p className="text-xs">
            Your assistant{" "}
            <span className="font-semibold">{redactSecretLikeText(assistantName)}</span>{" "}
            will pick up the next steps below. Each step is a preview — nothing
            external is touched until you confirm.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="eaos-onboarding-next-steps-title"
        data-testid="eaos-onboarding-next-steps"
        className="flex flex-col gap-3"
      >
        <header className="flex items-center justify-between gap-2">
          <h2
            id="eaos-onboarding-next-steps-title"
            className="text-sm font-semibold text-foreground"
          >
            Next steps
          </h2>
          <Button
            type="button"
            variant="default"
            onClick={onContinue}
            data-testid="eaos-onboarding-go-to-dashboard"
          >
            Go to dashboard →
          </Button>
        </header>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {cards.map((card) =>
            card.id === "slack-connect" ? (
              <SlackConnectCard key={card.id} card={card} companyId={companyId} />
            ) : (
              <NextStepCardItem key={card.id} card={card} />
            ),
          )}
        </ul>
        <p
          className="rounded-md border border-dashed border-border bg-background p-3 text-[11px] text-muted-foreground"
          data-testid="eaos-onboarding-backend-gap"
        >
          <span className="font-medium text-foreground">Backend gap:</span>{" "}
          Slack runs a fail-closed safe-install preview through the canonical
          approval card. MCP picker and the auto-created &quot;Personal CEO
          recommendations&quot; mission are tracked as follow-ups; each card
          stays preview-only with no destructive external side effects.
        </p>
      </section>
    </div>
  );
}

interface SlackStateBadge {
  readonly label: string;
  readonly icon: typeof CheckCircle2;
  readonly tone: "neutral" | "pending" | "success" | "danger";
  readonly testId: string;
}

function badgeForConnectionState(state: SlackConnectionState): SlackStateBadge {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        icon: CheckCircle2,
        tone: "success",
        testId: "eaos-onboarding-next-step-slack-badge-connected",
      };
    case "pending_approval":
      return {
        label: "Pending approval",
        icon: Loader2,
        tone: "pending",
        testId: "eaos-onboarding-next-step-slack-badge-pending",
      };
    case "applying":
      return {
        label: "Applying",
        icon: Loader2,
        tone: "pending",
        testId: "eaos-onboarding-next-step-slack-badge-applying",
      };
    case "partial":
      return {
        label: "Partially applied",
        icon: AlertTriangle,
        tone: "danger",
        testId: "eaos-onboarding-next-step-slack-badge-partial",
      };
    case "error":
      return {
        label: "Setup error",
        icon: AlertTriangle,
        tone: "danger",
        testId: "eaos-onboarding-next-step-slack-badge-error",
      };
    case "not_connected":
    default:
      return {
        label: "Not connected",
        icon: MessageSquare,
        tone: "neutral",
        testId: "eaos-onboarding-next-step-slack-badge-not-connected",
      };
  }
}

function badgeClassesByTone(tone: SlackStateBadge["tone"]): string {
  switch (tone) {
    case "success":
      return "border-green-200 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100";
    case "pending":
      return "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100";
    case "danger":
      return "border-red-200 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100";
    case "neutral":
    default:
      return "border-border bg-background text-muted-foreground";
  }
}

function ctaLabelForConnectionState(
  state: SlackConnectionState,
  hasPreview: boolean,
): string {
  switch (state) {
    case "connected":
      return "View connection";
    case "pending_approval":
      return "Open approval card →";
    case "applying":
      return "Open approval card →";
    case "partial":
      return "Resume setup";
    case "error":
      return "Try again";
    case "not_connected":
    default:
      return hasPreview ? "Refresh preview" : "Preview & connect";
  }
}

function SlackConnectCard({
  card,
  companyId,
}: {
  card: NextStepCard;
  companyId: string | null;
}) {
  const Icon = card.icon;
  const [preview, setPreview] = useState<SlackInstallPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Truthful, server-derived connection state. The "Connected" pill renders
  // ONLY when `state === "connected"`, which itself only happens when the
  // canonical capability_apply_plans pipeline reached `applied`. Fetching a
  // preview never flips this — preview is just the human-readable scope +
  // named-secret summary surfaced inside the card.
  const connectionQuery = useQuery<SlackConnectionResponse>({
    queryKey: ["eaos", "onboarding", "slack-connection", companyId],
    queryFn: () => eaosOnboardingApi.slackConnection(companyId as string),
    enabled: Boolean(companyId),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const previewMutation = useMutation({
    mutationFn: async (cid: string) => eaosOnboardingApi.slackInstallPreview(cid),
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
    },
    onError: (err: unknown) => {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not load Slack install preview.";
      setError(redactSecretLikeText(message));
    },
  });

  const handlePreview = () => {
    if (!companyId) return;
    previewMutation.mutate(companyId);
  };

  const connectionState: SlackConnectionState =
    connectionQuery.data?.state ?? "not_connected";
  const badge = badgeForConnectionState(connectionState);
  const BadgeIcon = badge.icon;
  const approvalCardPath =
    connectionQuery.data?.approvalCardPath ?? preview?.approvalCardPath ?? null;
  const ctaLabel = ctaLabelForConnectionState(connectionState, Boolean(preview));
  const showPreviewBody = Boolean(preview);

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid={card.testId}
      data-eaos-onboarding-card-status={card.status}
      data-eaos-onboarding-slack-state={connectionState}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{card.title}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClassesByTone(badge.tone)}`}
          data-testid={badge.testId}
          data-eaos-onboarding-slack-badge={connectionState}
        >
          <BadgeIcon
            className={`h-3 w-3${badge.tone === "pending" ? " animate-spin" : ""}`}
            aria-hidden="true"
          />
          {badge.label}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{card.description}</p>

      {showPreviewBody && preview ? (
        <div
          className="rounded-md border border-dashed border-border bg-background p-2 text-[11px] text-muted-foreground"
          data-testid="eaos-onboarding-next-step-slack-preview"
        >
          <p className="font-medium text-foreground">
            {redactSecretLikeText(preview.preview.displayName)} preview
          </p>
          <p className="mt-0.5">{redactSecretLikeText(preview.preview.summary)}</p>
          <p className="mt-1">
            <span className="font-medium text-foreground">Scopes:</span>{" "}
            {preview.preview.scopeSummary.join(", ")}
          </p>
          <p>
            <span className="font-medium text-foreground">Named secrets:</span>{" "}
            {preview.preview.requiredSecretNames.join(", ")}
          </p>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="eaos-onboarding-next-step-slack-error"
          className="rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span
          className={`inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClassesByTone(badge.tone)}`}
          data-testid={`${card.testId}-status`}
        >
          {badge.label}
        </span>
        <div className="flex items-center gap-2">
          {approvalCardPath ? (
            <Link
              to={approvalCardPath}
              data-testid="eaos-onboarding-next-step-slack-approval-link"
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Open approval card →
            </Link>
          ) : null}
          <Button
            type="button"
            variant={connectionState === "connected" ? "ghost" : "default"}
            size="sm"
            onClick={handlePreview}
            disabled={!companyId || previewMutation.isPending}
            data-testid={`${card.testId}-cta`}
            title={
              !companyId
                ? "Workspace not ready yet."
                : "Loads a safe Slack install preview — no tokens are submitted."
            }
          >
            {previewMutation.isPending ? "Loading preview…" : ctaLabel}
          </Button>
        </div>
      </div>
    </li>
  );
}

function NextStepCardItem({ card }: { card: NextStepCard }) {
  const Icon = card.icon;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid={card.testId}
      data-eaos-onboarding-card-status={card.status}
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground"
        />
        <p className="text-sm font-medium text-foreground">{card.title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{card.description}</p>
      <div className="flex items-center justify-between gap-2 pt-1">
        <span
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid={`${card.testId}-status`}
        >
          {card.status === "pending-backend" ? "Backend gap" : "Queued · preview"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-disabled="true"
          data-testid={`${card.testId}-cta`}
          title="Available once the backend connector lands."
        >
          {card.ctaLabel}
        </Button>
      </div>
    </li>
  );
}
