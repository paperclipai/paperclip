import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent } from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { InlineBanner } from "@/components/InlineBanner";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { BuiltInLifecycleChip } from "@/components/BuiltInAgentBadges";
import { ConfigureBuiltInAgentModal } from "@/components/ConfigureBuiltInAgentModal";
import { BuiltInBundlePanel } from "@/components/BuiltInBundlePanel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BuiltInAgentState, BuiltInManagedResourceState } from "@/api/builtInAgents";
import { Bot, Clock3 } from "lucide-react";

const briefsAgent: Agent = {
  id: "agent-briefs",
  companyId: "company-storybook",
  name: "Briefs Agent",
  urlKey: "briefs-agent",
  role: "general",
  title: null,
  icon: "sparkles",
  status: "idle",
  reportsTo: null,
  capabilities: "Prepares concise operational briefs for the board and agent company.",
  adapterType: "codex_local",
  adapterConfig: { model: "gpt-5" },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: { paperclipBuiltInAgent: { key: "briefs", featureKeys: ["briefs"] } },
  createdAt: new Date("2026-06-01T09:00:00.000Z"),
  updatedAt: new Date("2026-07-01T09:00:00.000Z"),
};

const definition = {
  key: "briefs",
  displayName: "Briefs Agent",
  featureKeys: ["briefs"],
  shortPurpose: "Prepares concise operational briefs for the board and agent company.",
  defaultInstructions: "You are Paperclip's built-in Briefs agent.",
  defaultRole: "general",
  allowedAdapterTypes: ["codex_local", "claude_local", "gemini_local", "opencode_local", "process"],
  defaultBudgetMonthlyCents: 0,
};

const notProvisionedState: BuiltInAgentState = {
  definition,
  status: "not_provisioned",
  agentId: null,
  agent: null,
  pauseReason: null,
};

/**
 * Mirrors Agents.tsx renderAgentRow: the built-in cluster sits inline in `meta`
 * at xl and drops to a full-width `secondaryRow` beneath the name below xl, with
 * `titlePriority` giving the name a floor so it never collapses (PAP-12988).
 */
function RosterRow({
  name,
  lifecycle,
  status,
}: {
  name: string;
  lifecycle?: "needs_setup" | "pending_approval";
  status: string;
}) {
  const cluster = lifecycle ? (
    <>
      <BuiltInLifecycleChip status={lifecycle} />
      {lifecycle === "needs_setup" && (
        <Button size="xs" variant="outline">Set up</Button>
      )}
    </>
  ) : null;
  return (
    <EntityRow
      title={name}
      titleClassName="w-56"
      titlePriority
      subtitle="General"
      secondaryRow={cluster ? <div className="xl:hidden flex flex-wrap items-center gap-1.5">{cluster}</div> : undefined}
      meta={cluster ? <div className="hidden xl:flex items-center gap-1.5">{cluster}</div> : undefined}
      trailing={<AgentStatusBadge status={status} />}
    />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

const meta: Meta = {
  title: "Product/Built-in Agents",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

/** Boards 1, 2, 4, 5 — all presentational states in one gallery. */
export const SurfaceGallery: Story = {
  render: () => (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div className="space-y-3">
        <SectionLabel>Board 1 — Roster rows</SectionLabel>
        <div className="rounded-lg border border-border divide-y divide-border">
          <RosterRow name="Briefs Agent" lifecycle="needs_setup" status="idle" />
          <RosterRow name="Learning Agent" status="active" />
          <RosterRow name="Briefs Agent" lifecycle="pending_approval" status="idle" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Resize below the <code>xl</code> breakpoint to see the lifecycle/action
          cluster drop to a second line so the agent name never collapses
          (PAP-12988).
        </p>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 2 — Agent detail provenance banner</SectionLabel>
        <InlineBanner
          tone="info"
          title="Built-in agent"
          actions={<Button variant="outline" size="sm">Reset to defaults</Button>}
        >
          Ships with Paperclip and powers <strong>Briefs</strong>. Configure it like any agent —
          model, instructions, budget. It can be paused but not deleted; pausing it pauses Briefs.
        </InlineBanner>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 4A — Feature gate: setup empty-state</SectionLabel>
        <div className="rounded-lg border border-border">
          <EmptyState
            icon={Bot}
            title="Set up the Briefs Agent"
            message="Briefs is generated by a built-in agent. Configure its model to enable the feature."
            action="Set up Briefs Agent"
            onAction={() => {}}
            hideActionIcon
          />
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 4 — Feature gate: pending approval</SectionLabel>
        <div className="rounded-lg border border-border">
          <EmptyState
            icon={Clock3}
            title="Briefs Agent is pending approval"
            message="Briefs will be available after the board approves this built-in agent hire."
          />
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 4B — Feature gate: paused banner over stale content</SectionLabel>
        <div className="space-y-4">
          <InlineBanner
            tone="warning"
            title="Briefs is paused."
            actions={
              <>
                <Button variant="ghost" size="sm">View agent</Button>
                <Button size="sm">Resume agent</Button>
              </>
            }
          >
            Its built-in agent was paused 2 days ago, so new briefs aren't being generated.
          </InlineBanner>
          <div className="opacity-70 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            Previously generated briefs stay readable while the agent is paused.
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 5 — Sidebar treatment</SectionLabel>
        <div className="w-64 rounded-lg border border-border p-2 space-y-1">
          <div className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="min-w-0 truncate">Briefs Agent</span>
            <span className="ml-1 flex items-center gap-1">
              <BuiltInLifecycleChip status="needs_setup" compact />
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="min-w-0 truncate">Learning Agent</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Board 5 — Use-while-paused toast</SectionLabel>
        <div className="w-80 rounded-lg border border-[#F59E0B]/50 bg-[#FEF3C7]/60 p-3 text-sm text-[#B45309] dark:bg-[#f59e0b12] dark:text-[#F59E0B]">
          <p className="font-medium">Briefs Agent is paused</p>
          <p className="opacity-90">Resume the agent to generate this brief.</p>
          <a href="#" className="mt-1 inline-block text-xs font-medium underline">View agent</a>
        </div>
      </div>
    </div>
  ),
};

/** Board 3 — configure-on-first-use modal (open). */
export const ConfigureModal: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="p-6">
        <Button onClick={() => setOpen(true)}>Open configure modal</Button>
        <ConfigureBuiltInAgentModal
          companyId="company-storybook"
          state={notProvisionedState}
          open={open}
          onOpenChange={setOpen}
        />
      </div>
    );
  },
};

/** Board 2 — pause confirmation dialog with dependency warning. */
export const PauseConfirmDialog: Story = {
  render: () => (
    <div className="p-6">
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause the Briefs Agent?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                Briefs depends on this agent. While paused, briefs generation is skipped and the
                Briefs page shows a warning.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Pause anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Reflection Coach bundle status panel (PAP-13099).
// ---------------------------------------------------------------------------

const reflectionBundle = {
  stockVersion: "2026-07-08",
  instructions: { entryFile: "AGENTS.md", files: ["AGENTS.md"] },
  skill: {
    skillKey: "reflection-coach",
    displayName: "reflection-coach",
    slug: "reflection-coach",
    canonicalKey: "paperclipai/bundled/paperclip-operations/reflection-coach",
    files: ["reflection-coach/SKILL.md"],
  },
  routine: {
    routineKey: "recent-agent-reflection",
    title: "Recent agent reflection",
    status: "paused" as const,
    triggerCount: 1,
  },
};

const reflectionDefinition = {
  key: "reflection-coach",
  displayName: "Reflection Coach",
  featureKeys: ["reflection"],
  shortPurpose: "Reviews recent agents and coaches them.",
  defaultInstructions: "You are Paperclip's built-in Reflection Coach.",
  defaultRole: "general",
  allowedAdapterTypes: ["codex_local", "claude_local"],
  defaultBudgetMonthlyCents: 0,
  bundle: reflectionBundle,
};

function bundleResource(
  resourceKind: BuiltInManagedResourceState["resourceKind"],
  stockStatus: BuiltInManagedResourceState["stockStatus"],
): BuiltInManagedResourceState {
  return {
    resourceKind,
    resourceKey:
      resourceKind === "skill"
        ? "reflection-coach"
        : resourceKind === "routine"
          ? "recent-agent-reflection"
          : "AGENTS.md",
    resourceId: "res-1",
    stockVersion: "2026-07-08",
    stockHash: "aaaa",
    currentHash: stockStatus === "missing" ? null : stockStatus === "stock_current" ? "aaaa" : "bbbb",
    stockStatus,
    updateAvailable: stockStatus === "stock_update_available" || stockStatus === "operator_modified",
    resetAvailable: stockStatus !== "stock_current",
  };
}

function bundleState(
  status: BuiltInAgentState["status"],
  resources: BuiltInManagedResourceState[],
): BuiltInAgentState {
  return {
    definition: reflectionDefinition,
    status,
    agentId: "agent-reflection",
    agent: null,
    pauseReason: null,
    resources,
  };
}

const READY = [
  bundleResource("skill", "stock_current"),
  bundleResource("instructions", "stock_current"),
  bundleResource("routine", "stock_current"),
];

function BundleCase({ title, state }: { title: string; state: BuiltInAgentState }) {
  return (
    <div className="space-y-2">
      <p className="text-(length:--text-micro) font-medium text-muted-foreground">{title}</p>
      <BuiltInBundlePanel
        state={state}
        agentRef="reflectioncoach"
        onConfigure={() => {}}
        onResetResource={() => {}}
        onRunRoutine={() => {}}
        onEnableSchedule={() => {}}
        onDisableSchedule={() => {}}
      />
    </div>
  );
}

/**
 * Board — Reflection Coach bundle status panel across the ux-spec states
 * (§5a needs-adapter, §5b all-ready, §5c update available, §5d drifted,
 * §5f missing). Light + dark are captured by the screenshot recipe.
 */
export const BundleStatusPanel: Story = {
  render: () => (
    <div className="mx-auto grid max-w-3xl gap-8 p-6">
      <BundleCase title="§5a — needs adapter (nothing runs yet)" state={bundleState("needs_setup", READY)} />
      <BundleCase title="§5b — all ready, schedule off (healthy default)" state={bundleState("ready", READY)} />
      <BundleCase
        title="§5c — update available (unedited stock, newer default shipped)"
        state={bundleState("ready", [
          bundleResource("skill", "stock_current"),
          bundleResource("instructions", "stock_update_available"),
          bundleResource("routine", "stock_current"),
        ])}
      />
      <BundleCase
        title="§5d — drifted (operator-modified, edits preserved)"
        state={bundleState("ready", [
          bundleResource("skill", "operator_modified"),
          bundleResource("instructions", "stock_current"),
          bundleResource("routine", "stock_current"),
        ])}
      />
      <BundleCase
        title="§5f — missing resource (reconcile recreates it)"
        state={bundleState("ready", [
          bundleResource("skill", "missing"),
          bundleResource("instructions", "stock_current"),
          bundleResource("routine", "stock_current"),
        ])}
      />
    </div>
  ),
};

void briefsAgent;
