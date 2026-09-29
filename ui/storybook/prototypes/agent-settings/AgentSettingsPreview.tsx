import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Star } from "lucide-react";
import {
  AgentOverview,
  PromptsTab,
  ConfigurationTab,
  KeysTab,
  AgentRevisionsTab,
  confirmAgentConfigNavigation,
} from "@/pages/AgentDetail";
import { AgentSkillsTab } from "@/pages/agent-skills/AgentSkillsTab";
import { AgentToolsTab } from "@/pages/AgentToolsTab";
import { AgentContextualSidebar } from "@/components/AgentContextualSidebar";
import { AgentActionButtons } from "@/components/AgentActionButtons";
import { PillGuy } from "@/components/onboarding/PillGuy";
import {
  AgentConfigForm,
  AdapterLoginPanel,
} from "@/components/AgentConfigForm";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  AGENT_DETAIL_NAVIGATION,
  parseAgentDetailView,
  type AgentLocalDetailView,
} from "@/pages/agent-detail-navigation";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { cn } from "@/lib/utils";
import { RuntimeTestCard } from "../RuntimeTestCard";
import { type TestOutcome } from "../new-agent-fixtures";
import { COMPANY, ID, REF, createSettingsFixtures, library } from "./fixtures";
import { storybookIssues } from "../../fixtures/paperclipData";
import "./settings.css";

const descriptions: Record<AgentLocalDetailView, string> = {
  overview: "A snapshot of Nova’s work, capabilities, and current setup.",
  instructions: "The files that guide how your agent thinks and works.",
  skills: "Choose the skills your agent brings to each task.",
  runtime:
    "Configure the harness, model, environment, and how your agent runs.",
  secrets:
    "Manage environment variables, secret bindings, and credentials your agent can access.",
  tools: "Manage installed connections, available tools, and access policies.",
  channels: "Manage the external chat connections dedicated to this agent.",
  permissions: "Set the agent’s trust level, authority, and boundaries.",
  "api-keys": "Manage the keys this agent uses to authenticate with Paperclip.",
  revisions:
    "Review past configuration changes and restore an earlier version.",
};
type Feedback = Parameters<
  NonNullable<ComponentProps<typeof AgentConfigForm>["onTestFeedbackChange"]>
>[0];

export function AgentSettingsPreview({
  initialTab = "overview",
  adapterType = "claude_local",
  testOutcome = "pass",
  saveFails = false,
}: {
  initialTab?: AgentLocalDetailView;
  adapterType?: string;
  testOutcome?: TestOutcome;
  saveFails?: boolean;
}) {
  const [fixtures] = useState(() =>
    createSettingsFixtures(adapterType, testOutcome, saveFails),
  );
  const [ready, setReady] = useState(false);
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const uninstall = fixtures.install();
    const fixtureQueryKeys = [
      queryKeys.agents.detail(ID),
      queryKeys.agents.detail(REF),
      queryKeys.agents.skills(ID),
      queryKeys.companySkills.list(COMPANY),
      queryKeys.agents.keys(ID),
      queryKeys.agents.configRevisions(ID),
      queryKeys.instance.experimentalSettings,
      queryKeys.instance.generalSettings,
      queryKeys.environments.list(COMPANY),
      queryKeys.secrets.list(COMPANY),
      ["tools", COMPANY],
      ["tools", "connection", "settings-github"],
    ];
    const clearFixtureQueries = () =>
      fixtureQueryKeys.forEach((queryKey) =>
        queryClient.removeQueries({ queryKey }),
      );
    clearFixtureQueries();
    queryClient.setQueryData(queryKeys.agents.detail(ID), fixtures.agent);
    setSelectedCompanyId(COMPANY);
    navigate(`/PAP/agents/${REF}/${initialTab}`, { replace: true });
    setReady(true);
    return () => {
      uninstall();
      clearFixtureQueries();
    };
  }, [fixtures, initialTab, queryClient, setSelectedCompanyId]);
  if (!ready || selectedCompanyId !== COMPANY) return null;
  return (
    <Routes>
      <Route
        path="/:companyPrefix/agents/:agentId/:tab?"
        element={<SettingsPage />}
      />
      <Route
        path="*"
        element={
          <div className="p-8 space-y-4">
            <h2 className="text-xl font-semibold">Linked page</h2>
            <p className="text-sm text-muted-foreground">
              This preview focuses on agent configuration. The existing
              destination is unchanged.
            </p>
            <Button onClick={() => navigate(`/PAP/agents/${REF}/overview`)}>
              Back to agent
            </Button>
          </div>
        }
      />
    </Routes>
  );
}

function SettingsPage() {
  const location = useLocation();
  const view = parseAgentDetailView(
    location.pathname.split("/").pop() ?? "overview",
  );
  const queryClient = useQueryClient();
  const { data: agent } = useQuery({
    queryKey: queryKeys.agents.detail(ID),
    queryFn: () => agentsApi.get(ID, COMPANY),
  });
  const { data: skills } = useQuery({
    queryKey: queryKeys.agents.skills(ID),
    queryFn: () => agentsApi.skills(ID, COMPANY),
    enabled: view === "overview",
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [starred, setStarred] = useState(false);
  const save = useRef<(() => void) | null>(null),
    cancel = useRef<(() => void) | null>(null),
    test = useRef<(() => void) | null>(null);
  const onSaveAction = useCallback((fn: (() => void) | null) => {
    save.current = fn;
  }, []);
  const onCancelAction = useCallback((fn: (() => void) | null) => {
    cancel.current = fn;
  }, []);
  const onTestAction = useCallback((fn: (() => void) | null) => {
    test.current = fn;
  }, []);
  const [testAction, setTestAction] = useState({
    disabled: false,
    pending: false,
  });
  const [feedback, setFeedback] = useState<Feedback>({
    errorMessage: null,
    result: null,
    login: null,
  });
  const onDirty = useCallback((value: boolean) => {
    setDirty(value);
    if (value) setSaved(false);
  }, []);
  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      agentsApi.update(ID, patch, COMPANY),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.agents.detail(ID), updated);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.configRevisions(ID),
      });
    },
  });
  const permissions = useMutation({
    mutationFn: (patch: Parameters<typeof agentsApi.updatePermissions>[1]) =>
      agentsApi.updatePermissions(ID, patch, COMPANY),
    onSuccess: (updated) =>
      queryClient.setQueryData(queryKeys.agents.detail(ID), updated),
  });
  useEffect(() => {
    setDirty(false);
    setSaved(false);
    setSaveError(null);
  }, [view]);
  if (!agent)
    return (
      <div className="p-8 text-sm text-muted-foreground">Loading agent…</div>
    );
  const title =
    view === "secrets"
      ? "Secrets & variables"
      : AGENT_DETAIL_NAVIGATION.flatMap((s) => s.items).find(
          (t) => t.value === view,
        )?.label;
  const display = getAdapterDisplay(agent.adapterType);
  const Icon = display.icon;
  const callbacks = {
    onDirtyChange: onDirty,
    onSaveActionChange: onSaveAction,
    onCancelActionChange: onCancelAction,
    onSavingChange: setSaving,
  };
  async function saveAgent(patch: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    try {
      await update.mutateAsync(patch);
      setSaved(true);
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save changes.",
      );
      throw error;
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-6 py-3 text-xs text-muted-foreground">
        <span>Agents</span>
        <ChevronRight className="size-3" />
        <span>{agent.name}</span>
        <ChevronRight className="size-3" />
        <span className="text-foreground">{title}</span>
      </div>
      <div className="flex min-h-screen">
        <div
          className="w-52 shrink-0"
          onClickCapture={(event) => {
            if (
              dirty &&
              (event.target as HTMLElement).closest("a") &&
              !confirmAgentConfigNavigation(true)
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <AgentContextualSidebar
            agentRef={REF}
            agentId={ID}
            agentName={agent.name}
            labels={{ secrets: "Secrets & variables" }}
          />
        </div>
        <main className="min-w-0 flex-1 px-6 py-8 lg:px-10">
          <div className="mx-auto max-w-5xl space-y-8">
            <header className="flex flex-wrap items-center justify-between gap-5 border-b border-border pb-6">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  role="img"
                  aria-label={`${agent.name} avatar`}
                  className="shrink-0"
                >
                  <PillGuy state="alive" className="size-12" />
                </div>
                <div className="space-y-1">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {agent.name}
                  </h1>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {agent.adapterType === "claude_local" ||
                    agent.adapterType === "codex_local" ? (
                      <img
                        src={`/brands/${agent.adapterType === "claude_local" ? "claude" : "codex"}-color.svg`}
                        className="size-4"
                        alt=""
                      />
                    ) : (
                      <Icon className="size-4" />
                    )}
                    <span>{display.label}</span>
                    <span>·</span>
                    <span>{agent.title || agent.role}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={starred ? "Unstar agent" : "Star agent"}
                  onClick={() => setStarred(!starred)}
                >
                  <Star className={cn("size-4", starred && "fill-current")} />
                </Button>
                <AgentActionButtons
                  agent={agent}
                  companyId={COMPANY}
                  assignLabel="Assign Task"
                  showRun={false}
                  showStatus={false}
                  onActionError={setSaveError}
                />
              </div>
            </header>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">
                {descriptions[view]}
              </p>
            </div>
            <div
              className={cn("agent-settings-content", `agent-settings-${view}`)}
              key={view}
            >
              {view === "overview" && (
                <AgentOverview
                  agent={agent}
                  runs={[]}
                  assignedIssues={storybookIssues.slice(0, 3)}
                  directReportCount={0}
                  skillNames={library
                    .filter((s) => skills?.desiredSkills.includes(s.key))
                    .map((s) => s.name)}
                  agentRouteId={REF}
                />
              )}
              {view === "instructions" && (
                <PromptsTab
                  agent={agent}
                  companyId={COMPANY}
                  showSaveNotice={false}
                  {...callbacks}
                />
              )}
              {view === "skills" && (
                <AgentSkillsTab agent={agent} companyId={COMPANY} />
              )}
              {(view === "runtime" || view === "secrets") && (
                <div className="space-y-6">
                  <div className="agent-settings-form">
                    <AgentConfigForm
                      mode="edit"
                      agent={agent}
                      onSave={saveAgent}
                      isSaving={saving}
                      hideInlineSave
                      hidePromptTemplate
                      hideInstructionsFile
                      content={view === "runtime" ? "configuration" : "secrets"}
                      environmentVariablesPlacement="secrets"
                      sectionLayout="cards"
                      canConfigureProviderTrace
                      sectionOrder={[
                        "adapter",
                        "permissions",
                        "environment",
                        "run-policy",
                        "identity",
                      ]}
                      sectionTitles={{
                        adapter: "Harness",
                        permissions: "Model & execution",
                        identity: "Agent identity",
                      }}
                      onDirtyChange={onDirty}
                      onSaveActionChange={onSaveAction}
                      onCancelActionChange={onCancelAction}
                      onTestActionChange={onTestAction}
                      onTestActionStateChange={setTestAction}
                      onTestFeedbackChange={setFeedback}
                    />
                  </div>
                  {view === "runtime" && (
                    <>
                      <RuntimeTestCard
                        state={
                          testAction.pending
                            ? "running"
                            : feedback.errorMessage ||
                                feedback.result?.status === "fail"
                              ? "fail"
                              : feedback.result?.status === "warn"
                                ? "warn"
                                : feedback.result
                                  ? "pass"
                                  : "idle"
                        }
                        result={feedback.result}
                        error={feedback.errorMessage}
                        disabled={testAction.disabled}
                        onTest={() => test.current?.()}
                      />
                      {feedback.login && (
                        <AdapterLoginPanel
                          {...feedback.login}
                          onStored={() => test.current?.()}
                          onApplyStored={() => test.current?.()}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
              {view === "permissions" && (
                <ConfigurationTab
                  agent={agent}
                  companyId={COMPANY}
                  {...callbacks}
                  updatePermissions={permissions}
                  content="permissions"
                />
              )}
              {view === "tools" && (
                <AgentToolsTab agent={agent} companyId={COMPANY} />
              )}
              {view === "api-keys" && (
                <KeysTab agentId={ID} companyId={COMPANY} />
              )}
              {view === "revisions" && (
                <AgentRevisionsTab agent={agent} companyId={COMPANY} />
              )}
            </div>
            {(saveError || permissions.error) && (
              <p role="alert" className="text-sm text-destructive">
                {saveError ?? String(permissions.error)}
              </p>
            )}
            {(["runtime", "secrets", "instructions"] as string[]).includes(
              view,
            ) && (
              <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-4">
                <p role="status" className="text-xs text-muted-foreground">
                  {saving
                    ? "Saving changes…"
                    : dirty
                      ? "You have unsaved changes."
                      : saved
                        ? "Changes saved."
                        : ""}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={!dirty || saving}
                    onClick={() => cancel.current?.()}
                  >
                    Discard
                  </Button>
                  <Button
                    disabled={!dirty || saving}
                    onClick={() => {
                      Promise.resolve(save.current?.()).catch(() => {});
                    }}
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </footer>
            )}
          </div>
        </main>
      </div>
      <NewIssueDialog />
    </div>
  );
}
