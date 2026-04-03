import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult, CompanyPortabilityPreviewResult, CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { readZipArchive } from "../lib/zip";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import type { OrgNode } from "../api/agents";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { workspaceApi, type WorkspaceScanResult } from "../api/workspace";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  buildContextualTaskDescription,
  selectDefaultCompanyGoalId
} from "../lib/onboarding-launch";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { OrgTreeView } from "./OrgTreeView";
import { FolderPicker } from "./FolderPicker";
import {
  Building2,
  Bot,
  Code,
  Gem,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Terminal,
  Sparkles,
  MousePointer2,
  Check,
  Loader2,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Network,
  Download,
  Upload,
  X
} from "lucide-react";
import { HermesIcon } from "./HermesIcon";

type Step = 1 | 2 | 3 | 4 | 5;
type SetupMode = "fresh" | "import";

// Kept for backward compatibility — upstream code may reference this.
// The contextual builder in onboarding-launch.ts falls back to the
// same text when no workspace scan is available.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

type AdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "hermes_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "http"
  | "openclaw_gateway";

export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const [routeDismissed, setRouteDismissed] = useState(false);

  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  const initialStep = effectiveOnboardingOptions.initialStep ?? 1;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [setupMode, setSetupMode] = useState<SetupMode>("fresh");
  const [importSourceMode, setImportSourceMode] = useState<"github" | "local">("github");
  const [importUrl, setImportUrl] = useState("");
  const [localPackage, setLocalPackage] = useState<{
    name: string;
    rootPath: string | null;
    files: Record<string, CompanyPortabilityFileEntry>;
  } | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const [importPreview, setImportPreview] = useState<CompanyPortabilityPreviewResult | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");

  // Step 2
  const [agentName, setAgentName] = useState("CEO");
  const [adapterType, setAdapterType] = useState<AdapterType>("claude_local");
  const [model, setModel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);

  // Step 3 — Workspace
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceScan, setWorkspaceScan] = useState<WorkspaceScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  // Step 5 — Task (was step 3)
  const contextual = useMemo(() => buildContextualTaskDescription(workspaceScan), [workspaceScan]);
  const [taskTitle, setTaskTitle] = useState(contextual.title);
  const [taskDescription, setTaskDescription] = useState(contextual.description);
  const [taskTouched, setTaskTouched] = useState(false);

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >(null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    null
  );
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [importedAgents, setImportedAgents] = useState(false);
  const [importedAgentList, setImportedAgentList] = useState<Array<{ id: string; slug: string; name: string; role: string; title: string | null }>>([]);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, { adapterType?: AdapterType; model?: string }>>({});
  const [expandedAgentSlug, setExpandedAgentSlug] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Check which integrations are available on the server
  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.ok ? r.json() : {})
      .then((data: Record<string, unknown>) => setLinearAvailable(!!data.linear))
      .catch(() => setLinearAvailable(false));
  }, []);

  // Sync step and company when onboarding opens with options.
  // Keep this independent from company-list refreshes so Step 1 completion
  // doesn't get reset after creating a company.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.companyId ?? null;
    setStep(effectiveOnboardingOptions.initialStep ?? 1);
    setCreatedCompanyId(cId);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedAgentId(null);
    setCreatedIssueRef(null);
  }, [
    effectiveOnboardingOpen,
    effectiveOnboardingOptions.companyId,
    effectiveOnboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Resize textarea when step 3 is shown or description changes
  useEffect(() => {
    if (step === 3) autoResizeTextarea();
  }, [step, taskDescription, autoResizeTextarea]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType)
      : ["agents", "none", "adapter-models", adapterType],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });

  // Models for the expanded agent's override adapter (when different from default)
  const expandedOverrideAdapter = expandedAgentSlug
    ? agentOverrides[expandedAgentSlug]?.adapterType
    : undefined;
  const overrideAdapterForQuery = expandedOverrideAdapter && expandedOverrideAdapter !== adapterType
    ? expandedOverrideAdapter
    : null;
  const { data: overrideAdapterModels } = useQuery({
    queryKey: createdCompanyId && overrideAdapterForQuery
      ? queryKeys.agents.adapterModels(createdCompanyId, overrideAdapterForQuery)
      : ["agents", "none", "override-adapter-models"],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, overrideAdapterForQuery!),
    enabled: Boolean(createdCompanyId) && Boolean(overrideAdapterForQuery) && step === 2
  });

  const isLocalAdapter =
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "gemini_local" ||
    adapterType === "hermes_local" ||
    adapterType === "opencode_local" ||
    adapterType === "pi_local" ||
    adapterType === "cursor";
  const effectiveAdapterCommand =
    command.trim() ||
    (adapterType === "codex_local"
      ? "codex"
      : adapterType === "gemini_local"
        ? "gemini"
      : adapterType === "hermes_local"
        ? "hermes"
      : adapterType === "pi_local"
      ? "pi"
      : adapterType === "cursor"
      ? "agent"
      : adapterType === "opencode_local"
      ? "opencode"
      : "claude");

  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setSetupMode("fresh");
    setImportSourceMode("github");
    setImportUrl("");
    setLocalPackage(null);
    setImportPreview(null);
    setImportLoading(false);
    setImportedAgents(false);
    setImportedAgentList([]);
    setAgentOverrides({});
    setExpandedAgentSlug(null);
    setCompanyName("");
    setCompanyGoal("");
    setAgentName("CEO");
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setWorkspacePath("");
    setWorkspaceScan(null);
    setScanLoading(false);
    setScanError(null);
    setFolderPickerOpen(false);
    const defaults = buildContextualTaskDescription(null);
    setTaskTitle(defaults.title);
    setTaskDescription(defaults.description);
    setTaskTouched(false);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedCompanyGoalId(null);
    setCreatedAgentId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
  }

  function buildAdapterConfig(): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      model:
        adapterType === "codex_local"
          ? model || DEFAULT_CODEX_LOCAL_MODEL
          : adapterType === "gemini_local"
            ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "cursor"
          ? model || DEFAULT_CURSOR_LOCAL_MODEL
          : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    return config;
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select a company before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig: adapterConfigOverride ?? buildAdapterConfig()
        }
      );
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed"
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  const [linearAvailable, setLinearAvailable] = useState(false);
  const [showLinearConnect, setShowLinearConnect] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  const [linearIssueCount, setLinearIssueCount] = useState<number | null>(null);
  const [linearTeamKey, setLinearTeamKey] = useState<string | null>(null);
  const [linearHighestNumber, setLinearHighestNumber] = useState<number | null>(null);
  const [importingIssues, setImportingIssues] = useState(false);
  const [importPhase, setImportPhase] = useState<"config" | "projects" | "issues" | "labels" | "sync" | "done">("config");
  const [importResult, setImportResult] = useState<{ imported: number; projects: number; labels: number } | null>(null);
  const [importDone, setImportDone] = useState(false);
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [customPrefix, setCustomPrefix] = useState("");
  const [startFromOne, setStartFromOne] = useState(true);

  function handleConnectLinear() {
    if (!createdCompanyId) return;
    const url = `/api/auth/linear/start?companyId=${createdCompanyId}`;
    const popup = window.open(url, "linear-oauth", "width=600,height=700");
    const poll = setInterval(() => {
      if (popup?.closed) {
        clearInterval(poll);
        fetch(`/api/auth/linear/status?companyId=${createdCompanyId}`)
          .then((r) => r.json())
          .then((data) => {
            if (data.connected) {
              setLinearConnected(true);
              setLinearIssueCount(data.openIssueCount);
              setLinearTeamKey(data.teamKey);
              setLinearHighestNumber(data.highestIssueNumber);
            }
          })
          .catch(() => {});
      }
    }, 500);
  }

  async function handleSaveConfig() {
    if (!createdCompanyId) return;
    const body: Record<string, unknown> = {};
    if (customPrefix.trim()) body.prefix = customPrefix.trim();
    if (startFromOne) body.startAt = 0;
    if (Object.keys(body).length > 0) {
      await fetch(`/api/auth/linear/configure?companyId=${createdCompanyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  }

  async function handleImportLinearIssues() {
    if (!createdCompanyId) return;
    setImportingIssues(true);
    setImportPhase("config");
    try {
      await handleSaveConfig();
      setImportPhase("projects");

      // Phase progression: the backend syncs projects → issues → labels in one call.
      // Advance the UI phases on a timer so the user sees progress.
      const phaseTimer = setTimeout(() => setImportPhase("issues"), 2000);
      const labelTimer = setTimeout(() => setImportPhase("labels"), 5000);

      const res = await fetch(`/api/auth/linear/import?companyId=${createdCompanyId}`, {
        method: "POST",
      });
      clearTimeout(phaseTimer);
      clearTimeout(labelTimer);

      if (res.ok) {
        const data = await res.json();
        setImportResult({ imported: data.imported ?? 0, projects: data.projects ?? 0, labels: data.labels ?? 0 });
      }

      // Auto-trigger full sync to catch anything import missed (completed/cancelled issues, extra labels)
      setImportPhase("sync");
      await fetch(`/api/auth/linear/sync?companyId=${createdCompanyId}`, {
        method: "POST",
      });

      setImportPhase("done");
      setImportDone(true);
    } catch {
      // Best effort
    } finally {
      setImportingIssues(false);
    }
  }

  function buildImportSource() {
    if (importSourceMode === "local" && localPackage) {
      return { type: "inline" as const, rootPath: localPackage.rootPath, files: localPackage.files };
    }
    if (importSourceMode === "github" && importUrl.trim()) {
      return { type: "github" as const, url: importUrl.trim() };
    }
    return null;
  }

  async function handleZipUpload(fileList: FileList | null) {
    if (!fileList?.length) return;
    const file = fileList[0]!;
    if (!/\.zip$/i.test(file.name)) {
      setError("Please select a .zip file.");
      return;
    }
    setImportLoading(true);
    setError(null);
    try {
      const archive = await readZipArchive(await file.arrayBuffer());
      if (Object.keys(archive.files).length === 0) {
        throw new Error("No package files found in zip.");
      }
      setLocalPackage({ name: file.name, rootPath: archive.rootPath, files: archive.files });
      setImportPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read zip");
    } finally {
      setImportLoading(false);
    }
  }

  async function handleImportPreview() {
    const source = buildImportSource();
    if (!source) return;
    setImportLoading(true);
    setError(null);
    try {
      const preview = await companiesApi.importPreview({
        source,
        target: { mode: "new_company" },
      });
      setImportPreview(preview);
      // Pre-fill company name and goal from manifest
      const manifestName = preview.targetCompanyName ?? preview.manifest.company?.name;
      if (manifestName && !companyName) setCompanyName(manifestName);
      const manifestDesc = preview.manifest.company?.description;
      if (manifestDesc && !companyGoal) setCompanyGoal(manifestDesc);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview import");
    } finally {
      setImportLoading(false);
    }
  }

  async function handleImportApply() {
    const source = buildImportSource();
    if (!source) return;
    setLoading(true);
    setError(null);
    try {
      const result = await companiesApi.importBundle({
        source,
        target: {
          mode: "new_company",
          ...(companyName.trim() ? { newCompanyName: companyName.trim() } : {}),
        },
        collisionStrategy: "rename",
      });
      setCreatedCompanyId(result.company.id);
      setCreatedCompanyPrefix(null); // will be backfilled
      setSelectedCompanyId(result.company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      // Create goal if provided (same as fresh flow)
      if (companyGoal.trim()) {
        const parsedGoal = parseOnboardingGoalInput(companyGoal);
        await goalsApi.create(result.company.id, {
          title: parsedGoal.title,
          ...(parsedGoal.description ? { description: parsedGoal.description } : {}),
        });
      }

      // If agents were imported, use the first CEO agent or first agent
      const createdAgents = result.agents.filter((a) => a.action === "created");
      const ceoAgent = createdAgents.find((a) => a.name.toLowerCase().includes("ceo"));
      const firstAgent = createdAgents[0];
      if (ceoAgent?.id) setCreatedAgentId(ceoAgent.id);
      else if (firstAgent?.id) setCreatedAgentId(firstAgent.id);
      setImportedAgents(createdAgents.length > 0);
      // Build agent list with roles from the manifest
      const manifestAgents = importPreview?.manifest.agents ?? [];
      setImportedAgentList(
        createdAgents
          .filter((a) => a.id)
          .map((a) => {
            const ma = manifestAgents.find((m) => m.slug === a.slug);
            return { id: a.id!, slug: a.slug, name: a.name, role: ma?.role ?? "employee", title: ma?.title ?? null };
          })
      );

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import company");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep1Next() {
    if (setupMode === "import") {
      await handleImportApply();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      if (companyGoal.trim()) {
        const parsedGoal = parseOnboardingGoalInput(companyGoal);
        const goal = await goalsApi.create(company.id, {
          title: parsedGoal.title,
          ...(parsedGoal.description
            ? { description: parsedGoal.description }
            : {}),
          level: "company",
          status: "active"
        });
        setCreatedCompanyGoalId(goal.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(company.id)
        });
      } else {
        setCreatedCompanyGoalId(null);
      }

      // Linear integration is now handled by the plugin settings page
      setStep(2);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
      setLoading(false);
    }
  }

  function handleStep1Continue() {
    setShowLinearConnect(false);
    setStep(2);
  }

  async function handleStep2Next() {
    if (!createdCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!selectedModelId) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models."
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(
            "OpenCode models are still loading. Please wait and try again."
          );
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`
          );
          return;
        }
      }

      if (importedAgents) {
        // Test all unique adapter types used across agents
        const uniqueAdapters = new Set<string>([adapterType]);
        for (const o of Object.values(agentOverrides)) {
          if (o.adapterType) uniqueAdapters.add(o.adapterType);
        }
        for (const at of uniqueAdapters) {
          const localTypes = ["claude_local", "codex_local", "gemini_local", "hermes_local", "opencode_local", "pi_local", "cursor"];
          if (!localTypes.includes(at)) continue;
          if (at === adapterType && adapterEnvResult) continue; // already tested
          const result = await agentsApi.testEnvironment(createdCompanyId, at, { adapterConfig: {} });
          if (result.status === "fail") {
            setError(`Adapter environment check failed for ${at}: ${result.checks?.map((c) => c.message).join(", ") ?? "unknown error"}`);
            return;
          }
        }
      } else if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      if (importedAgents) {
        // Update all imported agents — apply default adapter/model,
        // then per-agent adapter + model overrides
        const defaultConfig = buildAdapterConfig();
        await Promise.all(
          importedAgentList.map((a) => {
            const override = agentOverrides[a.slug];
            const agentAdapter = override?.adapterType ?? adapterType;
            const agentModel = override?.model;
            // Build config for this agent's adapter type
            let config: Record<string, unknown>;
            if (override?.adapterType && override.adapterType !== adapterType) {
              // Different adapter — build a fresh config for that adapter
              config = agentModel ? { model: agentModel } : {};
            } else {
              // Same adapter as default — use default config with optional model override
              config = agentModel ? { ...defaultConfig, model: agentModel } : defaultConfig;
            }
            return agentsApi.update(a.id, {
              adapterType: agentAdapter,
              adapterConfig: config,
            }, createdCompanyId!);
          })
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
        setStep(3);
      } else {
        const agent = await agentsApi.create(createdCompanyId, {
          name: agentName.trim(),
          role: "ceo",
          adapterType,
          adapterConfig: buildAdapterConfig(),
          runtimeConfig: {
            heartbeat: {
              enabled: true,
              intervalSec: 3600,
              wakeOnDemand: true,
              cooldownSec: 10,
              maxConcurrentRuns: 1
            }
          }
        });
        setCreatedAgentId(agent.id);
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
        setStep(3);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleScanWorkspace(pathOverride?: string) {
    const scanPath = pathOverride ?? workspacePath.trim();
    if (!scanPath) return;
    setScanLoading(true);
    setScanError(null);
    try {
      const result = await workspaceApi.scan(scanPath);
      setWorkspaceScan(result);
      // Update task description with workspace context if user hasn't edited it
      if (!taskTouched) {
        const ctx = buildContextualTaskDescription(result);
        setTaskTitle(ctx.title);
        setTaskDescription(ctx.description);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Failed to scan workspace");
    } finally {
      setScanLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId) return;
    // Guard against duplicate project creation on back-navigation
    if (createdProjectId) {
      setStep(4);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Create project with workspace
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      const projectName = workspaceScan?.projectName ?? "Main";
      const project = await projectsApi.create(
        createdCompanyId,
        {
          ...buildOnboardingProjectPayload(goalId),
          name: projectName,
        }
      );
      setCreatedProjectId(project.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(createdCompanyId)
      });

      // Create workspace linked to the project if path was provided
      if (workspacePath.trim()) {
        await projectsApi.createWorkspace(project.id, {
          name: projectName,
          cwd: workspaceScan?.cwd ?? workspacePath.trim(),
          repoUrl: workspaceScan?.gitRemoteUrl?.startsWith("http") ? workspaceScan.gitRemoteUrl : undefined,
          repoRef: workspaceScan?.gitDefaultBranch ?? undefined,
          isPrimary: true,
        }, createdCompanyId);
      }

      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setLoading(false);
    }
  }

  function handleStep4Next() {
    setStep(5);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      const goalId = createdCompanyGoalId;
      const projectId = createdProjectId;

      // Project should already be created in step 3
      if (!projectId) {
        setError("No project found. Please go back to the workspace step.");
        setLoading(false);
        return;
      }

      let issueRef = createdIssueRef;
      if (!issueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: taskTitle,
            description: taskDescription,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
          })
        );
        issueRef = issue.identifier ?? issue.id;
        setCreatedIssueRef(issueRef);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      setSelectedCompanyId(createdCompanyId);
      reset();
      closeOnboarding();
      navigate(
        createdCompanyPrefix
          ? `/${createdCompanyPrefix}/issues/${issueRef}`
          : `/issues/${issueRef}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && showLinearConnect && !importingIssues) handleStep1Continue();
      else if (step === 1 && setupMode === "fresh" && companyName.trim()) handleStep1Next();
      else if (step === 1 && setupMode === "import" && importPreview) handleStep1Next();
      else if (step === 2 && (importedAgents || agentName.trim())) handleStep2Next();
      else if (step === 3) handleStep3Next();
      else if (step === 4) handleStep4Next();
      else if (step === 5) handleLaunch();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          setRouteDismissed(true);
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Left half — form */}
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
              step === 1 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border">
                {(
                  [
                    { step: 1 as Step, label: "Company", icon: Building2 },
                    { step: 2 as Step, label: "Agent", icon: Bot },
                    { step: 3 as Step, label: "Workspace", icon: FolderOpen },
                    { step: 4 as Step, label: "Team", icon: Network },
                    { step: 5 as Step, label: "Launch", icon: Rocket }
                  ] as const
                ).map(({ step: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      s === step
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Step content */}
              {step === 1 && !showLinearConnect && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Set up your company</h3>
                      <p className="text-xs text-muted-foreground">
                        Create a new company or import one from a package.
                      </p>
                    </div>
                  </div>

                  {/* Setup mode toggle */}
                  <div className="flex gap-2">
                    <button
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 rounded-md border p-2.5 text-xs transition-colors",
                        setupMode === "fresh"
                          ? "border-foreground bg-accent"
                          : "border-border hover:bg-accent/50"
                      )}
                      onClick={() => setSetupMode("fresh")}
                    >
                      <Building2 className="h-3.5 w-3.5" />
                      Start fresh
                    </button>
                    <button
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 rounded-md border p-2.5 text-xs transition-colors",
                        setupMode === "import"
                          ? "border-foreground bg-accent"
                          : "border-border hover:bg-accent/50"
                      )}
                      onClick={() => setSetupMode("import")}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Import package
                    </button>
                  </div>

                  {setupMode === "fresh" && (
                    <>
                      <div className="mt-3 group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyName.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Company name
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="Acme Corp"
                          value={companyName}
                          onChange={(e) => setCompanyName(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission / goal (optional)
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
                          placeholder="What is this company trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  {setupMode === "import" && (
                    <>
                      {/* Source mode toggle */}
                      <div className="flex rounded-md border border-border overflow-hidden">
                        <button
                          className={cn(
                            "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm transition-colors",
                            importSourceMode === "github"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => {
                            setImportSourceMode("github");
                            setLocalPackage(null);
                            setImportPreview(null);
                          }}
                        >
                          <GitBranch className="h-3.5 w-3.5" />
                          GitHub repo
                        </button>
                        <button
                          className={cn(
                            "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm transition-colors border-l border-border",
                            importSourceMode === "local"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => {
                            setImportSourceMode("local");
                            setImportUrl("");
                            setImportPreview(null);
                          }}
                        >
                          <Upload className="h-3.5 w-3.5" />
                          Local zip
                        </button>
                      </div>

                      {/* GitHub URL input */}
                      {importSourceMode === "github" && (
                        <div className="group">
                          <label className="text-xs text-muted-foreground mb-1 block">
                            GitHub URL or companies.sh package
                          </label>
                          <input
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                            placeholder="https://github.com/org/company-package"
                            value={importUrl}
                            onChange={(e) => {
                              setImportUrl(e.target.value);
                              setImportPreview(null);
                            }}
                            autoFocus
                          />
                        </div>
                      )}

                      {/* Local zip upload */}
                      {importSourceMode === "local" && (
                        <div className="group">
                          <input
                            ref={zipInputRef}
                            type="file"
                            accept=".zip,application/zip"
                            className="hidden"
                            onChange={(e) => handleZipUpload(e.target.files)}
                          />
                          {!localPackage ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full"
                              onClick={() => zipInputRef.current?.click()}
                              disabled={importLoading}
                            >
                              {importLoading ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : (
                                <Upload className="h-3.5 w-3.5 mr-1" />
                              )}
                              {importLoading ? "Reading..." : "Choose zip file"}
                            </Button>
                          ) : (
                            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                              <Upload className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="text-sm truncate flex-1">{localPackage.name}</span>
                              <button
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  setLocalPackage(null);
                                  setImportPreview(null);
                                  if (zipInputRef.current) zipInputRef.current.value = "";
                                }}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Preview button */}
                      {!importPreview && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            (importSourceMode === "github" && !importUrl.trim()) ||
                            (importSourceMode === "local" && !localPackage) ||
                            importLoading
                          }
                          onClick={handleImportPreview}
                        >
                          {importLoading ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          ) : (
                            <GitBranch className="h-3.5 w-3.5 mr-1" />
                          )}
                          {importLoading ? "Loading..." : "Preview"}
                        </Button>
                      )}

                      {/* Preview result + name/goal */}
                      {importPreview && (
                        <>
                          <div className="rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <Check className="h-4 w-4 text-green-500" />
                              <span className="text-sm font-medium">
                                {importPreview.targetCompanyName ?? "Company package"}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground space-y-0.5">
                              <p>{importPreview.plan.agentPlans.length} agent{importPreview.plan.agentPlans.length !== 1 ? "s" : ""}</p>
                              {importPreview.plan.projectPlans.length > 0 && (
                                <p>{importPreview.plan.projectPlans.length} project{importPreview.plan.projectPlans.length !== 1 ? "s" : ""}</p>
                              )}
                              {importPreview.plan.issuePlans.length > 0 && (
                                <p>{importPreview.plan.issuePlans.length} task{importPreview.plan.issuePlans.length !== 1 ? "s" : ""}</p>
                              )}
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Company name</label>
                            <input
                              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                              placeholder="Company name"
                              value={companyName}
                              onChange={(e) => setCompanyName(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Mission / goal (optional)</label>
                            <textarea
                              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none"
                              rows={2}
                              placeholder="What is this company trying to achieve?"
                              value={companyGoal}
                              onChange={(e) => setCompanyGoal(e.target.value)}
                            />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {step === 1 && showLinearConnect && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <ListTodo className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Connect Linear</h3>
                      <p className="text-xs text-muted-foreground">
                        Link your Linear workspace so agents can manage issues.
                      </p>
                    </div>
                  </div>

                  {linearConnected ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3">
                        <Check className="h-4 w-4 text-green-500" />
                        <span className="text-sm text-green-400">
                          Linear connected{linearTeamKey ? ` (${linearTeamKey})` : ""}
                        </span>
                      </div>

                      {linearIssueCount !== null && linearIssueCount > 0 && !importDone && (
                        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 space-y-3">
                          <p className="text-sm">
                            Found <span className="font-medium text-foreground">{linearIssueCount} open issues</span> in Linear{linearTeamKey ? ` (${linearTeamKey})` : ""}.
                          </p>

                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => setShowAdvancedConfig(!showAdvancedConfig)}
                          >
                            {showAdvancedConfig ? "▾" : "▸"} Advanced configuration
                          </button>

                          {showAdvancedConfig && (
                            <div className="space-y-3 pl-3 border-l-2 border-border">
                              <div>
                                <label className="text-xs text-muted-foreground block mb-1">
                                  Issue prefix
                                </label>
                                <input
                                  className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 uppercase"
                                  placeholder={linearTeamKey || "LUC"}
                                  value={customPrefix}
                                  onChange={(e) => setCustomPrefix(e.target.value.toUpperCase())}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-muted-foreground block mb-1">
                                  Next issue number
                                </label>
                                <div className="flex items-center gap-2">
                                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                                    <input
                                      type="radio"
                                      name="startNumber"
                                      checked={!startFromOne}
                                      onChange={() => setStartFromOne(false)}
                                      className="accent-primary"
                                    />
                                    <span className={!startFromOne ? "text-foreground" : "text-muted-foreground"}>
                                      {customPrefix || linearTeamKey || "LUC"}-{(linearHighestNumber ?? 0) + 1}
                                    </span>
                                    <span className="text-muted-foreground/60">
                                      (continue from Linear)
                                    </span>
                                  </label>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                                    <input
                                      type="radio"
                                      name="startNumber"
                                      checked={startFromOne}
                                      onChange={() => setStartFromOne(true)}
                                      className="accent-primary"
                                    />
                                    <span className={startFromOne ? "text-foreground" : "text-muted-foreground"}>
                                      {customPrefix || linearTeamKey || "LUC"}-1
                                    </span>
                                    <span className="text-muted-foreground/60">
                                      (start fresh)
                                    </span>
                                  </label>
                                </div>
                              </div>
                            </div>
                          )}

                          {!importingIssues && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleImportLinearIssues}
                            >
                              <ArrowRight className="h-3.5 w-3.5 mr-1" />
                              Import issues
                            </Button>
                          )}

                          {importingIssues && (
                            <div className="space-y-2 pt-1">
                              {[
                                { key: "config", label: "Saving configuration" },
                                { key: "projects", label: "Syncing projects" },
                                { key: "issues", label: "Importing issues" },
                                { key: "labels", label: "Linking labels" },
                                { key: "sync", label: "Full sync from Linear" },
                              ].map((step) => {
                                const phases = ["config", "projects", "issues", "labels", "sync", "done"];
                                const stepIdx = phases.indexOf(step.key);
                                const currentIdx = phases.indexOf(importPhase);
                                const isDone = currentIdx > stepIdx;
                                const isActive = currentIdx === stepIdx;
                                return (
                                  <div key={step.key} className="flex items-center gap-2">
                                    {isDone ? (
                                      <Check className="h-3 w-3 text-green-500 shrink-0" />
                                    ) : isActive ? (
                                      <Loader2 className="h-3 w-3 animate-spin text-foreground shrink-0" />
                                    ) : (
                                      <div className="h-3 w-3 rounded-full border border-border shrink-0" />
                                    )}
                                    <span className={cn(
                                      "text-xs transition-colors",
                                      isDone ? "text-muted-foreground" : isActive ? "text-foreground" : "text-muted-foreground/50"
                                    )}>
                                      {step.label}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {importDone && (
                        <div className="rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3 space-y-1">
                          <div className="flex items-center gap-2">
                            <Check className="h-3.5 w-3.5 text-green-500" />
                            <span className="text-xs text-green-400 font-medium">Import complete</span>
                          </div>
                          {importResult && (
                            <p className="text-xs text-muted-foreground pl-5.5">
                              {importResult.imported} issues{importResult.projects > 0 ? `, ${importResult.projects} projects` : ""}{importResult.labels > 0 ? `, ${importResult.labels} labels` : ""}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full justify-center gap-2"
                      onClick={handleConnectLinear}
                    >
                      <svg viewBox="0 0 100 100" className="h-4 w-4" fill="currentColor">
                        <path d="M1.22541 61.5228c-.97437-2.7004-.97437-5.6961 0-8.3965L16.3262 10.3963C19.094 2.6584 26.8267 -1.80816 34.9157.614964c8.0889 2.423814 12.7709 10.917336 10.347 18.654936L30.1619 61.9999 45.2627 14.2691"/>
                      </svg>
                      Connect Linear
                    </Button>
                  )}

                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      disabled={importingIssues}
                      onClick={handleStep1Continue}
                    >
                      {linearConnected ? "Skip import" : "Skip for now"}
                    </Button>
                    {linearConnected && (
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={importingIssues}
                        onClick={handleStep1Continue}
                      >
                        Continue
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{importedAgents ? "Configure your agents" : "Create your first agent"}</h3>
                      <p className="text-xs text-muted-foreground">
                        {importedAgents ? "Choose the adapter and model for your agents." : "Choose how this agent will run tasks."}
                      </p>
                    </div>
                  </div>
                  {!importedAgents && (<div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Agent name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="CEO"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>)}

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      {importedAgents ? "Default adapter type" : "Adapter type"}
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          value: "claude_local" as const,
                          label: "Claude Code",
                          icon: Sparkles,
                          desc: "Local Claude agent",
                          recommended: true
                        },
                        {
                          value: "codex_local" as const,
                          label: "Codex",
                          icon: Code,
                          desc: "Local Codex agent",
                          recommended: true
                        }
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.value
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.value as AdapterType;
                            setAdapterType(nextType);
                            if (nextType === "codex_local" && !model) {
                              setModel(DEFAULT_CODEX_LOCAL_MODEL);
                            }
                            if (nextType !== "codex_local") {
                              setModel("");
                            }
                          }}
                        >
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              Recommended
                            </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.desc}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowMoreAdapters((v) => !v)}
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showMoreAdapters ? "rotate-0" : "-rotate-90"
                        )}
                      />
                      More Agent Adapter Types
                    </button>

                    {showMoreAdapters && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {[
                          {
                            value: "gemini_local" as const,
                            label: "Gemini CLI",
                            icon: Gem,
                            desc: "Local Gemini agent"
                          },
                          {
                            value: "opencode_local" as const,
                            label: "OpenCode",
                            icon: OpenCodeLogoIcon,
                            desc: "Local multi-provider agent"
                          },
                          {
                            value: "pi_local" as const,
                            label: "Pi",
                            icon: Terminal,
                            desc: "Local Pi agent"
                          },
                          {
                            value: "cursor" as const,
                            label: "Cursor",
                            icon: MousePointer2,
                            desc: "Local Cursor agent"
                          },
                          {
                            value: "hermes_local" as const,
                            label: "Hermes Agent",
                            icon: HermesIcon,
                            desc: "Local multi-provider agent"
                          },
                          {
                            value: "openclaw_gateway" as const,
                            label: "OpenClaw Gateway",
                            icon: Bot,
                            desc: "Invoke OpenClaw via gateway protocol",
                            comingSoon: true,
                            disabledLabel: "Configure OpenClaw within the App"
                          }
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            disabled={!!opt.comingSoon}
                            className={cn(
                              "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                              opt.comingSoon
                                ? "border-border opacity-40 cursor-not-allowed"
                                : adapterType === opt.value
                                ? "border-foreground bg-accent"
                                : "border-border hover:bg-accent/50"
                            )}
                            onClick={() => {
                              if (opt.comingSoon) return;
                              const nextType = opt.value as AdapterType;
                              setAdapterType(nextType);
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                if (!model.includes("/")) {
                                  setModel("");
                                }
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? (opt as { disabledLabel?: string })
                                    .disabledLabel ?? "Coming soon"
                                : opt.desc}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {(adapterType === "claude_local" ||
                    adapterType === "codex_local" ||
                    adapterType === "gemini_local" ||
                    adapterType === "hermes_local" ||
                    adapterType === "opencode_local" ||
                    adapterType === "pi_local" ||
                    adapterType === "cursor") && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-[var(--radix-popover-trigger-width)] p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-[240px] overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {/* Per-agent overrides (import mode only) */}
                  {importedAgents && importedAgentList.length > 0 && (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground block">
                        Per-agent configuration
                      </label>
                      <div className="rounded-md border border-border divide-y divide-border">
                        {importedAgentList.map((agent) => {
                          const isExpanded = expandedAgentSlug === agent.slug;
                          const override = agentOverrides[agent.slug];
                          const effectiveAdapter = override?.adapterType ?? adapterType;
                          const effectiveModel = override?.model;
                          const adapterLabel: Record<string, string> = {
                            claude_local: "Claude", codex_local: "Codex", gemini_local: "Gemini",
                            opencode_local: "OpenCode", pi_local: "Pi", cursor: "Cursor",
                            hermes_local: "Hermes", openclaw_gateway: "OpenClaw",
                          };
                          const summaryParts: string[] = [];
                          if (override?.adapterType) summaryParts.push(adapterLabel[override.adapterType] ?? override.adapterType);
                          if (effectiveModel) summaryParts.push(effectiveModel);
                          const summary = summaryParts.length > 0 ? summaryParts.join(" · ") : "Default";
                          // Models for this agent's adapter
                          const agentModels = override?.adapterType && override.adapterType !== adapterType
                            ? (overrideAdapterModels ?? [])
                            : filteredModels;

                          return (
                            <div key={agent.slug}>
                              <button
                                className="flex items-center w-full px-3 py-2 gap-2.5 hover:bg-accent/30 transition-colors text-left"
                                onClick={() => setExpandedAgentSlug(isExpanded ? null : agent.slug)}
                              >
                                <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform shrink-0", !isExpanded && "-rotate-90")} />
                                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
                                  <Bot className="h-3 w-3 text-foreground/70" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <span className="text-xs font-medium">{agent.name}</span>
                                  {agent.title && (
                                    <span className="text-[10px] text-muted-foreground ml-1.5">{agent.title}</span>
                                  )}
                                </div>
                                <span className="text-[10px] text-muted-foreground shrink-0 max-w-[120px] truncate">
                                  {summary}
                                </span>
                              </button>
                              {isExpanded && (
                                <div className="px-3 pb-3 pt-1 space-y-2.5">
                                  {/* Adapter type */}
                                  <div>
                                    <label className="text-[10px] text-muted-foreground mb-1 block">Adapter</label>
                                    <select
                                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                                      value={override?.adapterType ?? ""}
                                      onChange={(e) => {
                                        const val = e.target.value as AdapterType | "";
                                        setAgentOverrides((prev) => {
                                          const next = { ...prev };
                                          if (val) {
                                            next[agent.slug] = { ...next[agent.slug], adapterType: val as AdapterType, model: undefined };
                                          } else {
                                            if (next[agent.slug]) {
                                              delete next[agent.slug].adapterType;
                                              delete next[agent.slug].model;
                                              if (Object.keys(next[agent.slug]).length === 0) delete next[agent.slug];
                                            }
                                          }
                                          return next;
                                        });
                                      }}
                                    >
                                      <option value="">Default ({adapterLabel[adapterType] ?? adapterType})</option>
                                      <option value="claude_local">Claude Code</option>
                                      <option value="codex_local">Codex</option>
                                      <option value="gemini_local">Gemini CLI</option>
                                      <option value="opencode_local">OpenCode</option>
                                      <option value="pi_local">Pi</option>
                                      <option value="cursor">Cursor</option>
                                      <option value="hermes_local">Hermes</option>
                                    </select>
                                  </div>
                                  {/* Model */}
                                  <div>
                                    <label className="text-[10px] text-muted-foreground mb-1 block">Model</label>
                                    <select
                                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                                      value={effectiveModel ?? ""}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setAgentOverrides((prev) => {
                                          const next = { ...prev };
                                          if (val) {
                                            next[agent.slug] = { ...next[agent.slug], model: val };
                                          } else {
                                            if (next[agent.slug]) {
                                              delete next[agent.slug].model;
                                              if (Object.keys(next[agent.slug]).length === 0) delete next[agent.slug];
                                            }
                                          }
                                          return next;
                                        });
                                      }}
                                    >
                                      <option value="">Default</option>
                                      {agentModels.map((m) => (
                                        <option key={m.id} value={m.id}>{m.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium">
                            Adapter environment check
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Runs a live probe that asks the adapter CLI to
                            respond with hello.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={async () => {
                            if (importedAgents) {
                              // Test all unique adapters
                              const uniqueAdapters = new Set<string>([adapterType]);
                              for (const o of Object.values(agentOverrides)) {
                                if (o.adapterType) uniqueAdapters.add(o.adapterType);
                              }
                              setAdapterEnvLoading(true);
                              setAdapterEnvError(null);
                              try {
                                const results: AdapterEnvironmentTestResult[] = [];
                                for (const at of uniqueAdapters) {
                                  const r = await agentsApi.testEnvironment(createdCompanyId!, at, { adapterConfig: {} });
                                  results.push(r);
                                }
                                // Show worst result
                                const worst = results.find((r) => r.status === "fail") ?? results.find((r) => r.status === "warn") ?? results[0];
                                if (worst) setAdapterEnvResult(worst);
                                // Report any failures
                                const failed = results.filter((r) => r.status === "fail");
                                if (failed.length > 0) {
                                  setAdapterEnvError(`${failed.length} adapter(s) failed environment check`);
                                }
                              } catch (err) {
                                setAdapterEnvError(err instanceof Error ? err.message : "Test failed");
                              } finally {
                                setAdapterEnvLoading(false);
                              }
                            } else {
                              void runAdapterEnvironmentTest();
                            }
                          }}
                        >
                          {adapterEnvLoading ? "Testing..." : "Test now"}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult &&
                      adapterEnvResult.status === "pass" ? (
                        <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this CEO adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <FolderOpen className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Link a workspace</h3>
                      <p className="text-xs text-muted-foreground">
                        Point to a local project folder so agents have real context.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Project folder path
                    </label>
                    <div className="flex gap-2">
                      <input
                        className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder="~/projects/my-app"
                        value={workspacePath}
                        onChange={(e) => {
                          setWorkspacePath(e.target.value);
                          setWorkspaceScan(null);
                          setScanError(null);
                        }}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setFolderPickerOpen(true)}
                        title="Browse folders"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!workspacePath.trim() || scanLoading}
                        onClick={() => handleScanWorkspace()}
                      >
                        {scanLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          "Scan"
                        )}
                      </Button>
                    </div>
                  </div>

                  <FolderPicker
                    open={folderPickerOpen}
                    onOpenChange={setFolderPickerOpen}
                    onSelect={(path) => {
                      setWorkspacePath(path);
                      setWorkspaceScan(null);
                      setScanError(null);
                      void handleScanWorkspace(path);
                    }}
                  />

                  {scanError && (
                    <p className="text-xs text-destructive">{scanError}</p>
                  )}

                  {workspaceScan && (
                    <div className="rounded-md border border-border bg-muted/20 px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-green-500 shrink-0" />
                        <span className="text-sm font-medium">
                          {workspaceScan.projectName ?? "Project detected"}
                        </span>
                      </div>
                      {workspaceScan.languages.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Languages: {workspaceScan.languages.join(", ")}
                        </p>
                      )}
                      {workspaceScan.configFiles.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Config: {workspaceScan.configFiles.join(", ")}
                        </p>
                      )}
                      {workspaceScan.gitRemoteUrl && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <GitBranch className="h-3 w-3" />
                          <span className="font-mono truncate">{workspaceScan.gitRemoteUrl}</span>
                        </div>
                      )}
                      {workspaceScan.readmeExcerpt && (
                        <details className="text-xs">
                          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                            README preview
                          </summary>
                          <pre className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-[120px] overflow-y-auto">
                            {workspaceScan.readmeExcerpt.slice(0, 500)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground">
                    Agents will work in this directory. You can skip this step to use a default workspace.
                  </p>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Network className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Review your team</h3>
                      <p className="text-xs text-muted-foreground">
                        Confirm the org structure before agents start working.
                      </p>
                    </div>
                  </div>

                  {createdCompanyId && (
                    <OrgChartPreview companyId={createdCompanyId} />
                  )}
                </div>
              )}

              {step === 5 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Rocket className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Launch with a task</h3>
                      <p className="text-xs text-muted-foreground">
                        Give your CEO agent a grounded task to start with.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Task title
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Review the codebase and create a roadmap"
                      value={taskTitle}
                      onChange={(e) => {
                        setTaskTitle(e.target.value);
                        setTaskTouched(true);
                      }}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Description
                    </label>
                    <textarea
                      ref={textareaRef}
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[120px] max-h-[300px] overflow-y-auto"
                      placeholder="Add more detail about what the agent should do..."
                      value={taskDescription}
                      onChange={(e) => {
                        setTaskDescription(e.target.value);
                        setTaskTouched(true);
                      }}
                    />
                  </div>

                  {/* Summary */}
                  <div className="border border-border divide-y divide-border text-xs">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{companyName || importPreview?.targetCompanyName || "Company"}</span>
                      <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{agentName} ({getUIAdapter(adapterType).label})</span>
                      <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    </div>
                    {workspaceScan && (
                      <div className="flex items-center gap-2 px-3 py-2">
                        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="flex-1 truncate font-mono">{workspaceScan.projectName ?? workspaceScan.cwd}</span>
                        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Footer navigation */}
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && step > (onboardingOptions.initialStep ?? 1) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 1 && !showLinearConnect && (
                    <Button
                      size="sm"
                      disabled={
                        (setupMode === "fresh" && !companyName.trim()) ||
                        (setupMode === "import" && !importPreview) ||
                        loading
                      }
                      onClick={handleStep1Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading
                        ? setupMode === "import" ? "Importing..." : "Creating..."
                        : "Next"}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={
                        (!importedAgents && !agentName.trim()) || loading || adapterEnvLoading
                      }
                      onClick={handleStep2Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? (importedAgents ? "Configuring..." : "Creating...") : "Next"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={loading}
                      onClick={handleStep3Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : workspacePath.trim() ? "Next" : "Skip"}
                    </Button>
                  )}
                  {step === 4 && (
                    <Button
                      size="sm"
                      onClick={handleStep4Next}
                    >
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      Next
                    </Button>
                  )}
                  {step === 5 && (
                    <Button size="sm" disabled={!taskTitle.trim() || loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Rocket className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Launching..." : "Launch"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — org preview or ASCII art (hidden on mobile) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out relative",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
            {setupMode === "import" && importPreview && (
              <div className="absolute inset-0 flex flex-col bg-gradient-to-b from-[#1d1d1d]/80 via-transparent to-[#1d1d1d]/60 z-10">
                <div className="text-center pt-6 pb-2 space-y-1 shrink-0">
                  <Network className="h-5 w-5 text-white/90 mx-auto" />
                  <h3 className="text-sm font-semibold text-white">
                    {importPreview.targetCompanyName ?? importPreview.manifest.company?.name ?? "Company"}
                  </h3>
                  <p className="text-xs text-white/60">
                    {importPreview.plan.agentPlans.length} agent{importPreview.plan.agentPlans.length !== 1 ? "s" : ""}
                    {importPreview.manifest.skills.length > 0 &&
                      ` · ${importPreview.manifest.skills.length} skill${importPreview.manifest.skills.length !== 1 ? "s" : ""}`}
                    {importPreview.plan.projectPlans.length > 0 &&
                      ` · ${importPreview.plan.projectPlans.length} project${importPreview.plan.projectPlans.length !== 1 ? "s" : ""}`}
                  </p>
                </div>
                <div className="flex-1 min-h-0">
                  <ImportOrgChartPreview
                    roots={buildPreviewOrgTree(importPreview.manifest)}
                    manifest={importPreview.manifest}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function buildPreviewOrgTree(
  manifest: CompanyPortabilityPreviewResult["manifest"]
): OrgNode[] {
  const agents = manifest.agents;
  const nodeMap = new Map<string, OrgNode>();
  for (const a of agents) {
    nodeMap.set(a.slug, {
      id: a.slug,
      name: a.name,
      role: a.role ?? "employee",
      status: "idle",
      reports: [],
    });
  }
  const roots: OrgNode[] = [];
  for (const a of agents) {
    const node = nodeMap.get(a.slug)!;
    if (a.reportsToSlug && nodeMap.has(a.reportsToSlug)) {
      nodeMap.get(a.reportsToSlug)!.reports.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── Mini org chart (same card style as /org page) ────────────────────────

const PREVIEW_CARD_W = 160;
const PREVIEW_CARD_H = 56;
const PREVIEW_GAP_X = 20;
const PREVIEW_GAP_Y = 48;
const PREVIEW_PAD = 20;

interface PreviewLayoutNode {
  id: string; name: string; role: string; title: string | null;
  x: number; y: number; children: PreviewLayoutNode[];
}

function previewSubtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return PREVIEW_CARD_W;
  const cw = node.reports.reduce((s, c) => s + previewSubtreeWidth(c), 0);
  return Math.max(PREVIEW_CARD_W, cw + (node.reports.length - 1) * PREVIEW_GAP_X);
}

function previewLayoutTree(node: OrgNode, x: number, y: number, titleMap: Map<string, string | null>): PreviewLayoutNode {
  const totalW = previewSubtreeWidth(node);
  const children: PreviewLayoutNode[] = [];
  if (node.reports.length > 0) {
    const cw = node.reports.reduce((s, c) => s + previewSubtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * PREVIEW_GAP_X;
    let cx = x + (totalW - cw - gaps) / 2;
    for (const child of node.reports) {
      const w = previewSubtreeWidth(child);
      children.push(previewLayoutTree(child, cx, y + PREVIEW_CARD_H + PREVIEW_GAP_Y, titleMap));
      cx += w + PREVIEW_GAP_X;
    }
  }
  return { id: node.id, name: node.name, role: node.role, title: titleMap.get(node.id) ?? null, x: x + (totalW - PREVIEW_CARD_W) / 2, y, children };
}

function previewLayoutForest(roots: OrgNode[], titleMap: Map<string, string | null>): PreviewLayoutNode[] {
  let x = PREVIEW_PAD;
  return roots.map((r) => {
    const w = previewSubtreeWidth(r);
    const node = previewLayoutTree(r, x, PREVIEW_PAD, titleMap);
    x += w + PREVIEW_GAP_X;
    return node;
  });
}

function flattenPreview(nodes: PreviewLayoutNode[]): PreviewLayoutNode[] {
  const out: PreviewLayoutNode[] = [];
  function walk(n: PreviewLayoutNode) { out.push(n); n.children.forEach(walk); }
  nodes.forEach(walk);
  return out;
}

function collectPreviewEdges(nodes: PreviewLayoutNode[]) {
  const edges: Array<{ parent: PreviewLayoutNode; child: PreviewLayoutNode }> = [];
  function walk(n: PreviewLayoutNode) { for (const c of n.children) { edges.push({ parent: n, child: c }); walk(c); } }
  nodes.forEach(walk);
  return edges;
}

function ImportOrgChartPreview({ roots, manifest }: { roots: OrgNode[]; manifest: CompanyPortabilityPreviewResult["manifest"] }) {
  const titleMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of manifest.agents) m.set(a.slug, a.title);
    return m;
  }, [manifest]);

  const layout = useMemo(() => previewLayoutForest(roots, titleMap), [roots, titleMap]);
  const allNodes = useMemo(() => flattenPreview(layout), [layout]);
  const edges = useMemo(() => collectPreviewEdges(layout), [layout]);

  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 400, height: 300 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + PREVIEW_CARD_W);
      maxY = Math.max(maxY, n.y + PREVIEW_CARD_H);
    }
    return { width: maxX + PREVIEW_PAD, height: maxY + PREVIEW_PAD };
  }, [allNodes]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || allNodes.length === 0) return;
    const sx = el.clientWidth / bounds.width;
    const sy = el.clientHeight / bounds.height;
    setScale(Math.min(sx, sy, 1));
  }, [allNodes, bounds]);

  if (allNodes.length === 0) return null;

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      <div
        className="absolute inset-0 flex items-center justify-center"
      >
        <div className="relative" style={{ width: bounds.width * scale, height: bounds.height * scale }}>
          <svg className="absolute inset-0 pointer-events-none" width="100%" height="100%">
            <g transform={`scale(${scale})`}>
              {edges.map(({ parent, child }) => {
                const x1 = parent.x + PREVIEW_CARD_W / 2;
                const y1 = parent.y + PREVIEW_CARD_H;
                const x2 = child.x + PREVIEW_CARD_W / 2;
                const y2 = child.y;
                const midY = (y1 + y2) / 2;
                return (
                  <path
                    key={`${parent.id}-${child.id}`}
                    d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                    fill="none"
                    stroke="rgba(161,161,170,0.4)"
                    strokeWidth={1.5}
                  />
                );
              })}
            </g>
          </svg>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
            {allNodes.map((node) => (
              <div
                key={node.id}
                className="absolute bg-zinc-800/90 border border-zinc-600/50 rounded-lg shadow-md select-none"
                style={{ left: node.x, top: node.y, width: PREVIEW_CARD_W, minHeight: PREVIEW_CARD_H }}
              >
                <div className="flex items-center px-3 py-2 gap-2.5">
                  <div className="relative shrink-0">
                    <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center">
                      <Bot className="h-3.5 w-3.5 text-zinc-300" />
                    </div>
                  </div>
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-xs font-semibold text-zinc-100 leading-tight">{node.name}</span>
                    {node.title && (
                      <span className="text-[10px] text-zinc-400 leading-tight mt-0.5 truncate max-w-full">{node.title}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function OrgChartPreview({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.org(companyId),
    queryFn: () => agentsApi.org(companyId),
    enabled: !!companyId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading team...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded-md border border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          No agents found. You can add more agents after onboarding.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border py-1">
      <OrgTreeView nodes={data} compact />
    </div>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <div
            key={`${check.code}-${idx}`}
            className="leading-relaxed break-words"
          >
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && (
              <span className="block opacity-75 break-all">
                ({check.detail})
              </span>
            )}
            {check.hint && (
              <span className="block opacity-90 break-words">
                Hint: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
