import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  BadgeCheck,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  PackageOpen,
  Puzzle,
  Rocket,
  ShieldCheck,
  Truck,
} from "lucide-react";
import {
  INITIAL_READY_AGENT_BLUEPRINTS,
  buildAgentProvisioningPreview,
  buildFinalDeliveryHistorySummary,
  buildLearningPostmortem,
  buildMcpInstallPreview,
  buildOrgPackageInstallPreview,
  buildProductionSafeRegressionPlan,
  normalizeMcpCatalogEntry,
  planFinalDeliveryCancel,
  planFinalDeliveryRetry,
  runAgentReadinessChecks,
  summarizeRegressionArtifactPolicy,
  type IssueFinalDeliveryDestination,
  type PaperclipOrgPackageManifest,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyCapabilityDefaultsCard } from "@/components/AgentCapabilitiesCard";
import { approvalsApi } from "@/api/approvals";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";

function joinList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function SurfaceCard({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Puzzle;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-xl border-border/80 bg-card/95">
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-border bg-muted/40 p-2 text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1 leading-5">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

type AgentOsApprovalAction = "mcp_install_preview" | "ready_agent_provision_preview" | "final_delivery_retry_preview";

const approvalRequestLabels: Record<AgentOsApprovalAction, string> = {
  mcp_install_preview: "Request MCP install approval",
  ready_agent_provision_preview: "Request ready-agent approval",
  final_delivery_retry_preview: "Request final_delivery retry approval",
};

export function buildAgentOsPreviewModel() {
  const marketplaceServer = normalizeMcpCatalogEntry({
    provider: "official_registry",
    id: "github-readonly",
    name: "github-readonly",
    title: "GitHub Readonly MCP",
    description: "Preview a source-control MCP connector before approval-gated install.",
    version: "0.1.0",
    transport: "stdio",
    command: "github-mcp --readonly",
    sourceUrl: "https://example.invalid/github-mcp",
    requiredEnv: [{ name: "GITHUB_TOKEN", required: true, description: "Named secret requirement only." }],
    tools: [
      { name: "repo.search", description: "Search repositories." },
      { name: "repo.read", description: "Read repository metadata." },
    ],
    trust: { verifiedPublisher: false, sourceAvailable: true, containerized: false },
  });
  const marketplacePreview = buildMcpInstallPreview(marketplaceServer);

  const packageManifest: PaperclipOrgPackageManifest = {
    version: 1,
    key: "agent-os-starter",
    name: "Agent OS Starter Pack",
    description: "Starter package tying together prompts, skills, MCP bundle references, and ready-agent templates.",
    provenance: {
      author: "Paperclip",
      source: "internal",
      sourceRef: "LET-137",
      trustLevel: "reviewed",
    },
    skills: [{ key: "paperclip-agent-operations", name: "Paperclip Agent Operations", version: "1" }],
    prompts: [{ key: "delivery-brief", title: "Delivery brief", body: "Summarize evidence, caveats, and approval gates." }],
    mcpBundles: [{ key: "mcp-marketplace-readonly", servers: [{ catalogId: "github-readonly", permissionProfile: "read_only" }] }],
    agentTemplates: [{ key: "delivery-operator", title: "Delivery Operator", promptRef: "delivery-brief", skillRefs: ["paperclip-agent-operations"], mcpBundleRefs: ["mcp-marketplace-readonly"] }],
    permissionPolicies: [{ key: "mcp.install", gate: "board", reason: "External MCP installs require explicit approval." }],
    requiredSecretInputs: [{ name: "GITHUB_TOKEN", scope: "mcp", required: true }],
  };
  const orgPackagePreview = buildOrgPackageInstallPreview(packageManifest, {
    existingPackageKeys: [],
    existingAgentTemplateKeys: [],
    existingSkillKeys: [],
  });

  const blueprint = INITIAL_READY_AGENT_BLUEPRINTS[0];
  const agentPreview = buildAgentProvisioningPreview(blueprint, {
    targetCompanyId: "company-preview",
    targetProjectId: null,
    existingAgentKeys: [],
    availableSkillKeys: blueprint.requiredSkillRefs,
    availableMcpBundleKeys: blueprint.mcpBundleRefs,
    providedSecretInputNames: blueprint.requiredSecretInputs,
  });
  const readiness = runAgentReadinessChecks(blueprint, {
    availableSkillKeys: blueprint.requiredSkillRefs,
    availableMcpBundleKeys: blueprint.mcpBundleRefs,
    providedSecretInputNames: blueprint.requiredSecretInputs,
    promptRendered: true,
    permissionPoliciesReviewed: false,
  });

  const finalDeliveryDestination: IssueFinalDeliveryDestination = {
    platform: "telegram",
    chatId: "demo-chat-0123",
    threadId: "demo-topic-0103",
    messageId: "demo-message-0456",
  };
  const finalDeliverySummary = buildFinalDeliveryHistorySummary({
    destination: finalDeliveryDestination,
    entries: [
      {
        id: "delivery-preview-1",
        createdAt: "2026-05-13T23:00:00.000Z",
        status: "resolved",
        result: { version: 1, outcome: "failed", terminal: false, retryable: true, error: "transient gateway timeout", attemptCount: 2 },
        artifactCount: 3,
      },
      {
        id: "delivery-preview-0",
        createdAt: "2026-05-13T22:30:00.000Z",
        status: "resolved",
        result: { version: 1, outcome: "delivered", terminal: true, retryable: false, externalMessageId: "910", attemptCount: 1 },
        artifactCount: 2,
      },
    ],
  });
  const retryPlan = planFinalDeliveryRetry({
    issueId: "LET-137",
    deliveryId: "delivery-preview-1",
    outcome: "failed",
    retryable: true,
    requestedBy: "operator-preview",
    nowIso: "2026-05-13T23:05:00.000Z",
  });
  const cancelPlan = planFinalDeliveryCancel({
    issueId: "LET-137",
    deliveryId: "delivery-preview-1",
    outcome: "failed",
    retryable: true,
    requestedBy: "operator-preview",
    nowIso: "2026-05-13T23:05:00.000Z",
  });

  const regressionPlan = buildProductionSafeRegressionPlan({
    target: "production",
    baseUrl: "https://paperclip.example.invalid",
    finalDeliveryQueue: { attemptable: 0, livePendingSending: 0 },
    liveExternalActionsEnabled: false,
    allowedArtifactFormats: ["pdf", "zip", "md", "json", "txt", "yaml"],
    checks: ["api_health", "db_backup", "final_delivery_queue", "secret_scan"],
  });

  const postmortem = buildLearningPostmortem({
    issue: { id: "LET-137", identifier: "LET-137", title: "Productize Agent OS frontend surfaces", status: "done" },
    outcome: "passed",
    commandEvidence: ["Reusable skill checklist and frontend workflow captured for review."],
    validatorVerdicts: ["PASS"],
    finalDelivery: { outcome: "delivered", attemptCount: 1 },
  });

  return {
    marketplacePreview,
    orgPackagePreview,
    readyAgent: { blueprint, preview: agentPreview, readiness },
    finalDelivery: { summary: finalDeliverySummary, retryPlan, cancelPlan },
    regression: { plan: regressionPlan, artifactPolicy: summarizeRegressionArtifactPolicy(regressionPlan) },
    learning: { postmortem, primaryCandidate: postmortem.candidates[0] },
  };
}

type AgentOsPreviewModel = ReturnType<typeof buildAgentOsPreviewModel>;

export function buildAgentOsApprovalPayload(model: AgentOsPreviewModel, action: AgentOsApprovalAction): Record<string, unknown> {
  const base = {
    version: 1,
    surface: "agent_os",
    action,
    approvalOnly: true,
    liveExecution: false,
    liveApply: false,
    liveExternalActions: false,
    safetyPosture: "Approval request only. Does not install MCP servers, provision agents, or mutate final_delivery outbox.",
  };

  if (action === "mcp_install_preview") {
    return {
      ...base,
      title: `Approve MCP marketplace install preview: ${model.marketplacePreview.server.title}`,
      approvalScope: "mcp_marketplace_install",
      server: {
        catalogId: model.marketplacePreview.server.catalogId,
        provider: model.marketplacePreview.server.provider,
        title: model.marketplacePreview.server.title,
        transport: model.marketplacePreview.server.transport,
        toolNames: model.marketplacePreview.server.toolNames,
        trust: model.marketplacePreview.server.trust,
      },
      blockers: model.marketplacePreview.blockers,
      requiredSecretNames: model.marketplacePreview.server.requiredSecretNames,
      requiredSecretPolicy: "Named secret requirements only; no secret values are accepted or stored by Agent OS.",
    };
  }

  if (action === "ready_agent_provision_preview") {
    return {
      ...base,
      approvalOnly: false,
      liveApply: true,
      safetyPosture: "Approval-gated live apply: provisions an internal ready-agent only after board approval; no external actions or secret values are executed.",
      title: `Approve ready-agent provisioning preview: ${model.readyAgent.blueprint.title}`,
      approvalScope: "ready_agent_provisioning",
      blueprint: {
        key: model.readyAgent.blueprint.key,
        title: model.readyAgent.blueprint.title,
        category: model.readyAgent.blueprint.category,
        requiredSkillRefs: model.readyAgent.blueprint.requiredSkillRefs,
        mcpBundleRefs: model.readyAgent.blueprint.mcpBundleRefs,
      },
      readiness: {
        ready: model.readyAgent.readiness.ready,
        checks: model.readyAgent.readiness.checks.map((check) => ({ key: check.key, status: check.status, message: check.message })),
      },
      requiredSecretNames: model.readyAgent.blueprint.requiredSecretInputs,
    };
  }

  return {
    ...base,
    title: "Approve final_delivery retry preview",
    approvalScope: "final_delivery_retry",
    destinationMasked: true,
    maskedDestination: model.finalDelivery.summary.destinationSummary,
    latestOutcome: model.finalDelivery.summary.latestOutcome,
    retryPlan: {
      operation: model.finalDelivery.retryPlan.operation,
      allowed: model.finalDelivery.retryPlan.allowed,
      reason: model.finalDelivery.retryPlan.reason,
      requiredApprovalGate: model.finalDelivery.retryPlan.requiredApprovalGate,
      mutatesOutbox: model.finalDelivery.retryPlan.mutatesOutbox,
      sendsImmediately: model.finalDelivery.retryPlan.sendsImmediately,
    },
    requiredSecretNames: [],
  };
}

export function AgentOs() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToastActions();
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const model = useMemo(() => buildAgentOsPreviewModel(), []);

  const approvalRequest = useMutation({
    mutationFn: (action: AgentOsApprovalAction) => {
      if (!selectedCompanyId) {
        throw new Error("Select a company before requesting approval.");
      }
      return approvalsApi.create(selectedCompanyId, {
        type: "request_board_approval",
        payload: buildAgentOsApprovalPayload(model, action),
      });
    },
    onSuccess: (approval) => {
      setPendingApprovalId(approval.id);
      pushToast({ title: "Approval request created", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Approval request failed",
        body: err instanceof Error ? err.message : "Unable to create approval request",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    const companyCrumb = selectedCompany ? [{ label: selectedCompany.name, href: "/dashboard" }] : [];
    setBreadcrumbs([...companyCrumb, { label: "Agent OS" }]);
  }, [selectedCompany, setBreadcrumbs]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
      <section className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-background via-card to-muted/40 p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <Badge variant="outline" className="bg-background/80">
              approval-gated live apply · ready-agent provisioning applies after board approval
            </Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Agent OS command center</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              A designed frontend cockpit for Sprint 6-11 trust-layer primitives: MCP marketplace, organization packages,
              ready-agent blueprints, final_delivery operations, production-safe regression gates, and learning loops.
            </p>
            <p className="text-sm font-medium text-foreground">
              Safety posture: no live MCP install/execution, no live Telegram resend/cancel, and no secret material storage from this surface.
            </p>
          </div>
          <div className="grid min-w-[320px] grid-cols-3 gap-3">
            <StatPill label="Blueprints" value={INITIAL_READY_AGENT_BLUEPRINTS.length} />
            <StatPill label="MCP tools" value={model.marketplacePreview.server.toolNames.length} />
            <StatPill label="Queue gate" value="internal apply" />
          </div>
        </div>
      </section>

      <Card className="rounded-2xl border-dashed border-border/80 bg-card/90">
        <CardHeader>
          <CardTitle className="text-base">Approval request queue</CardTitle>
          <CardDescription>
            Safe apply previews become internal board approval requests. Ready-agent approvals are executed by the Agent OS apply
            engine after approval; MCP installs and final_delivery retries stay preview-only in this slice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-3">
            {(Object.keys(approvalRequestLabels) as AgentOsApprovalAction[]).map((action) => (
              <Button
                key={action}
                type="button"
                variant="outline"
                className="h-auto justify-start whitespace-normal px-4 py-3 text-left"
                disabled={!selectedCompanyId || approvalRequest.isPending}
                onClick={() => approvalRequest.mutate(action)}
              >
                {approvalRequestLabels[action]}
              </Button>
            ))}
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">Approval-gated live apply status</div>
            <div>Ready-agent requests provision an internal Hermes agent after board approval; external MCP installs and final_delivery sends remain disabled here.</div>
            {pendingApprovalId ? <div className="mt-2 text-foreground">Pending approval: {pendingApprovalId}</div> : null}
          </div>
        </CardContent>
      </Card>

      <CompanyCapabilityDefaultsCard companyId={selectedCompanyId} />

      <div className="grid gap-4 xl:grid-cols-2">
        <SurfaceCard
          title="MCP marketplace"
          description="Preview registry entries, required named secrets, trust signals, and tool policies before install."
          icon={Puzzle}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{model.marketplacePreview.action}</Badge>
              <Badge variant="outline">approval: {model.marketplacePreview.requiresApproval ? "required" : "not required"}</Badge>
              <Badge variant="outline">transport: {model.marketplacePreview.server.transport}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <StatPill label="Required secrets" value={model.marketplacePreview.server.requiredSecretNames.length} />
              <StatPill label="Policy-reviewed tools" value={model.marketplacePreview.toolPolicies.length} />
            </div>
            <p className="text-muted-foreground">Blockers: {joinList(model.marketplacePreview.blockers)}</p>
            <p className="font-mono text-xs text-muted-foreground">
              Env keys: {joinList(Object.keys(model.marketplacePreview.envTemplate))}
            </p>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Organization packages"
          description="Show skills, prompts, MCP bundles, agent templates, provenance, conflicts, and approval requirements."
          icon={PackageOpen}
        >
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatPill label="Skills" value={model.orgPackagePreview.summary.skills} />
              <StatPill label="Prompts" value={model.orgPackagePreview.summary.prompts} />
              <StatPill label="MCP bundles" value={model.orgPackagePreview.summary.mcpBundles} />
              <StatPill label="Agents" value={model.orgPackagePreview.summary.agentTemplates} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{model.orgPackagePreview.action}</Badge>
              <Badge variant="outline">trust: {model.orgPackagePreview.provenance.trustLevel}</Badge>
              <Badge variant="outline">approval: {model.orgPackagePreview.requiresApproval ? "required" : "not required"}</Badge>
            </div>
            <p className="text-muted-foreground">Secret inputs: {model.orgPackagePreview.secretInputs.map((item) => item.name).join(", ")}</p>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Ready-agent pool"
          description="Browse blueprints, prompt previews, missing dependencies, readiness checks, and budgets before provisioning."
          icon={Rocket}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{model.readyAgent.blueprint.title}</Badge>
              <Badge variant="outline">{model.readyAgent.blueprint.category}</Badge>
              <Badge variant="outline">{model.readyAgent.preview.action}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatPill label="Runs/day" value={model.readyAgent.blueprint.budget.maxRunsPerDay} />
              <StatPill label="Spend/day" value={`$${(model.readyAgent.blueprint.budget.maxSpendCentsPerDay / 100).toFixed(0)}`} />
              <StatPill label="Ready" value={model.readyAgent.readiness.ready ? "yes" : "needs review"} />
            </div>
            <ul className="space-y-2 text-muted-foreground">
              {model.readyAgent.readiness.checks.map((check) => (
                <li key={check.key} className="flex gap-2">
                  <CheckCircle2 className={check.status === "pass" ? "mt-0.5 h-4 w-4 text-emerald-500" : "mt-0.5 h-4 w-4 text-amber-500"} />
                  <span>{check.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Final delivery ops"
          description="Expose delivery history, masked destination, retry/cancel preview plans, artifacts, and approval gate."
          icon={Truck}
        >
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs">
              {model.finalDelivery.summary.destinationSummary}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatPill label="Latest" value={model.finalDelivery.summary.latestOutcome ?? "none"} />
              <StatPill label="Retryable" value={model.finalDelivery.summary.retryableCount} />
              <StatPill label="Artifacts" value={model.finalDelivery.summary.artifactCount} />
            </div>
            <p className="text-muted-foreground">
              Retry requires {model.finalDelivery.retryPlan.requiredApprovalGate} approval; cancel allowed: {model.finalDelivery.cancelPlan.allowed ? "yes" : "no"}.
            </p>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Production-safe regression"
          description="Make smoke/visual gates visible before prod restarts or evidence delivery."
          icon={ShieldCheck}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant={model.regression.plan.ready ? "default" : "destructive"}>{model.regression.plan.ready ? "ready" : "blocked"}</Badge>
              <Badge variant="outline">target: {model.regression.plan.target}</Badge>
            </div>
            <ul className="space-y-2 text-muted-foreground">
              {model.regression.plan.requiredChecks.map((check) => (
                <li key={check} className="flex gap-2">
                  <ClipboardCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
                  <span>{check}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{model.regression.artifactPolicy}</p>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Learning loop"
          description="Review postmortem outcomes and learning candidates before manual promotion into skills/prompts/governance."
          icon={Brain}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{model.learning.postmortem.outcome}</Badge>
              <Badge variant="outline">{model.learning.primaryCandidate.status}</Badge>
              <Badge variant="outline">target: {model.learning.primaryCandidate.target}</Badge>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-2 font-medium">
                <BadgeCheck className="h-4 w-4 text-emerald-500" />
                {model.learning.primaryCandidate.title}
              </div>
              <p className="mt-2 text-muted-foreground">{model.learning.primaryCandidate.rationale}</p>
            </div>
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}
