import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdapterEnvironmentTestResult,
  OnboardingApplyRequest,
  OnboardingAdapterOptionsResponse,
  OnboardingRecommendationResponse,
  OnboardingScanResponse
} from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { onboardingApi } from "../api/onboarding";
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
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId
} from "../lib/onboarding-launch";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import { resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import {
  Building2,
  Bot,
  ListTodo,
  Rocket,
  FolderSearch,
  FolderOpen,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ChevronDown,
  ClipboardCheck,
  X
} from "lucide-react";


type Step = 0 | 1 | 2 | 3 | 4;
type AdapterType = string;
type ReviewSquad = OnboardingRecommendationResponse["proposedSquads"][number];
const DEFAULT_AGY_LOCAL_MODEL = "gemini-3.5-flash";

const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

export function OnboardingWizard() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const [routeDismissed, setRouteDismissed] = useState(false);

  // Sync disabled adapter types from server so adapter grid filters them out
  const disabledTypes = useDisabledAdaptersSync();

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

  const initialStep = effectiveOnboardingOptions.initialStep ?? 0;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 0
  const [scanPath, setScanPath] = useState("");
  const [setupIntent, setSetupIntent] = useState("");
  const [scanResult, setScanResult] = useState<OnboardingScanResponse | null>(null);
  const [onboardingRecommendation, setOnboardingRecommendation] =
    useState<OnboardingRecommendationResponse | null>(null);
  const [reviewSquads, setReviewSquads] = useState<ReviewSquad[]>([]);

  // Step 1
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

  // Step 3
  const [taskTitle, setTaskTitle] = useState(
    "Hire your first engineer and create a hiring plan"
  );
  const [taskDescription, setTaskDescription] = useState(
    DEFAULT_TASK_DESCRIPTION
  );

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
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  // Sync step and company when onboarding opens with options.
  // Keep this independent from company-list refreshes so Step 1 completion
  // doesn't get reset after creating a company.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.companyId ?? null;
    setStep(effectiveOnboardingOptions.initialStep ?? 0);
    setScanResult(null);
    setOnboardingRecommendation(null);
    setReviewSquads([]);
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

  const { data: adapterModels } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Paperclip host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 2
  });
  const { data: onboardingAdapterOptions } = useQuery({
    queryKey: ["onboarding", "adapter-options"],
    queryFn: () => onboardingApi.adapterOptions(),
    enabled: effectiveOnboardingOpen && initialStep === 0,
    staleTime: 5 * 60 * 1000,
  });
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);
  const isLocalAdapter = adapterCaps.supportsInstructionsBundle || adapterCaps.supportsSkills || adapterCaps.supportsLocalAgentJwt;

  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);
    const all = listUIAdapters()
      .filter((a) =>
        !SYSTEM_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);
  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    agy_local: "agy",
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));

  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const recommendedSetupActive = initialStep === 0 && onboardingRecommendation !== null;
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
  const effectiveOnboardingAdapterOptions = useMemo<OnboardingAdapterOptionsResponse["adapters"]>(() => {
    if (onboardingRecommendation?.adapterOptions.length) return onboardingRecommendation.adapterOptions;
    return onboardingAdapterOptions?.adapters ?? [];
  }, [onboardingRecommendation, onboardingAdapterOptions]);
  const onboardingAdapterOptionByType = useMemo(() => {
    return new Map(effectiveOnboardingAdapterOptions.map((entry) => [entry.adapterType, entry]));
  }, [effectiveOnboardingAdapterOptions]);

  function updateReviewSquad(index: number, patch: Partial<ReviewSquad>) {
    setReviewSquads((current) =>
      current.map((squad, i) => (i === index ? { ...squad, ...patch } : squad))
    );
  }

  function handleReviewSquadAdapterChange(index: number, nextAdapterType: ReviewSquad["adapterType"]) {
    const option = onboardingAdapterOptionByType.get(nextAdapterType);
    const nextModel =
      option?.lockedModel ??
      option?.models[0]?.id ??
      (nextAdapterType === "agy_local"
        ? DEFAULT_AGY_LOCAL_MODEL
        : nextAdapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_MODEL
          : null);
    updateReviewSquad(index, {
      adapterType: nextAdapterType,
      model: nextModel,
    });
  }

  function reset() {
    setStep(0);
    setLoading(false);
    setBrowseLoading(false);
    setError(null);
    setScanPath("");
    setSetupIntent("");
    setScanResult(null);
    setOnboardingRecommendation(null);
    setReviewSquads([]);
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
    setTaskTitle("Hire your first engineer and create a hiring plan");
    setTaskDescription(DEFAULT_TASK_DESCRIPTION);
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
          : adapterType === "agy_local"
            ? DEFAULT_AGY_LOCAL_MODEL
          : adapterType === "gemini_local"
            ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local" || adapterType === "agy_local",
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

  async function handleScanNext() {
    if (!scanPath.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await onboardingApi.scan({
        path: scanPath.trim(),
        maxDepth: 3,
        includeManifests: true,
      });
      setScanResult(result);
      setOnboardingRecommendation(null);
      if (result.repoKind === "restricted") {
        setError("This directory cannot be scanned. Use a different path or skip to manual setup.");
        return;
      }
      const recommendation = await onboardingApi.recommend({
        scanSummary: result,
        userGoals: setupIntent.trim(),
      });
      setOnboardingRecommendation(recommendation);
      setReviewSquads(recommendation.proposedSquads);
      setCompanyName(recommendation.proposedCompany.name);
      setCompanyGoal(setupIntent.trim() || (recommendation.proposedCompany.description ?? ""));
      setTaskTitle(recommendation.proposedStarterIssue.title);
      setTaskDescription(recommendation.proposedStarterIssue.description);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Directory scan failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleBrowseDirectory() {
    if (browseLoading) return;
    setBrowseLoading(true);
    setError(null);
    try {
      const result = await onboardingApi.pickDirectory();
      if (result.cancelled || !result.path) return;
      setScanPath(result.path);
      setScanResult(null);
      setOnboardingRecommendation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder picker failed");
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleStep1Next() {
    if (recommendedSetupActive) {
      await handleApplyRecommendedSetup();
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

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  function buildRecommendedApplyPayload(): OnboardingApplyRequest | null {
    if (!onboardingRecommendation) return null;
    return {
      proposedCompany: {
        name: companyName.trim() || onboardingRecommendation.proposedCompany.name,
        description: companyGoal.trim() || onboardingRecommendation.proposedCompany.description,
      },
      proposedSquads: reviewSquads.length > 0 ? reviewSquads : onboardingRecommendation.proposedSquads,
      proposedProjectWorkspace: onboardingRecommendation.proposedProjectWorkspace,
      proposedStarterIssue: {
        ...onboardingRecommendation.proposedStarterIssue,
        title: taskTitle.trim() || onboardingRecommendation.proposedStarterIssue.title,
        description: taskDescription.trim() || onboardingRecommendation.proposedStarterIssue.description,
      },
    };
  }

  async function handleApplyRecommendedSetup() {
    const payload = buildRecommendedApplyPayload();
    if (!payload) return;
    setLoading(true);
    setError(null);
    try {
      const result = await onboardingApi.apply(payload);
      setCreatedCompanyId(result.company.id);
      setCreatedCompanyPrefix(result.company.issuePrefix);
      setCreatedCompanyGoalId(result.goal.id);
      setCreatedAgentId(result.starterIssue.assigneeAgentId);
      setCreatedProjectId(result.project.id);
      setCreatedIssueRef(result.starterIssue.identifier);
      setSelectedCompanyId(result.company.id);

      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(result.company.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(result.company.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(result.company.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(result.company.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.environments.list(result.company.id) });

      reset();
      closeOnboarding();
      navigate(`/${result.company.issuePrefix}/issues/${result.starterIssue.identifier}?onboarding=applied&deferredSetup=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create onboarding setup");
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2Next() {
    if (!createdCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      if (adapterType === "opencode_local") {
        if (!isValidOpenCodeModelId(model)) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
      }

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

      const hire = await agentsApi.hire(createdCompanyId, {
        name: agentName.trim(),
        role: "ceo",
        adapterType,
        adapterConfig: buildAdapterConfig(),
        runtimeConfig: buildNewAgentRuntimeConfig()
      });
      if (hire.approval) {
        await approvalsApi.approve(
          hire.approval.id,
          "Approved during onboarding first-agent setup."
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(createdCompanyId)
        });
      }
      const agent = hire.agent;
      setCreatedAgentId(agent.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      setStep(3);
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

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setError(null);
    setStep(4);
  }

  async function handleLaunch() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const project = await projectsApi.create(
          createdCompanyId,
          buildOnboardingProjectPayload(goalId)
        );
        projectId = project.id;
        setCreatedProjectId(projectId);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.list(createdCompanyId)
        });
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
      if (step === 0 && scanPath.trim()) handleScanNext();
      else if (step === 1 && companyName.trim()) handleStep1Next();
      else if (step === 2 && agentName.trim()) handleStep2Next();
      else if (step === 3 && taskTitle.trim()) handleStep3Next();
      else if (step === 4) handleLaunch();
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
              step === 1 && !recommendedSetupActive ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div
              className={cn(
                "w-full mx-auto my-auto px-8 py-12 shrink-0",
                recommendedSetupActive ? "max-w-3xl" : "max-w-md"
              )}
            >
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border">
                {(
                  [
                    ...(initialStep === 0
                      ? [{ step: 0 as Step, label: "Scan", icon: FolderSearch }]
                      : []),
                    ...(recommendedSetupActive
                      ? [{ step: 1 as Step, label: "Review", icon: ClipboardCheck }]
                      : [
                          { step: 1 as Step, label: "Company", icon: Building2 },
                          { step: 2 as Step, label: "Agent", icon: Bot },
                          { step: 3 as Step, label: "Task", icon: ListTodo },
                          { step: 4 as Step, label: "Launch", icon: Rocket }
                        ])
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
              {step === 0 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <FolderSearch className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Choose a project folder</h3>
                      <p className="text-xs text-muted-foreground">
                        Paperclip will scan names and safe manifests only.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label
                      htmlFor="onboarding-scan-path"
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        scanPath.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Absolute folder path
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="onboarding-scan-path"
                        className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder="/Users/you/projects/my-app"
                        value={scanPath}
                        onChange={(e) => {
                          setScanPath(e.target.value);
                          setScanResult(null);
                          setOnboardingRecommendation(null);
                        }}
                        autoFocus
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-[38px] shrink-0 px-2.5"
                        disabled={browseLoading || loading}
                        onClick={() => void handleBrowseDirectory()}
                      >
                        {browseLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FolderOpen className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1.5">Browse</span>
                      </Button>
                    </div>
                  </div>
                  <div className="group">
                    <label
                      htmlFor="onboarding-setup-focus"
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        setupIntent.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Setup focus (optional)
                    </label>
                    <textarea
                      id="onboarding-setup-focus"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[72px]"
                      placeholder="Add a goal if you have one. The onboarding assistant can help shape this after the scan."
                      value={setupIntent}
                      onChange={(e) => setSetupIntent(e.target.value)}
                    />
                  </div>
                  {scanResult && (
                    <div className="space-y-3 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium truncate">
                            {scanResult.displayPath}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {scanResult.repoKind === "brownfield"
                              ? "Existing codebase detected"
                              : scanResult.repoKind === "empty"
                              ? "Empty or readme-only folder"
                              : scanResult.repoKind === "too_large"
                              ? "Large project sampled"
                              : "Restricted folder"}
                          </p>
                        </div>
                        <span className="rounded-sm border border-border px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                          {scanResult.repoKind === "too_large" ? "partial scan" : scanResult.repoKind}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-sm bg-muted/40 px-2 py-1.5">
                          <p className="font-medium">{scanResult.counts.files}</p>
                          <p className="text-[10px] text-muted-foreground">files</p>
                        </div>
                        <div className="rounded-sm bg-muted/40 px-2 py-1.5">
                          <p className="font-medium">{scanResult.counts.directories}</p>
                          <p className="text-[10px] text-muted-foreground">dirs</p>
                        </div>
                        <div className="rounded-sm bg-muted/40 px-2 py-1.5">
                          <p className="font-medium">{scanResult.counts.ignoredDirectories}</p>
                          <p className="text-[10px] text-muted-foreground">ignored</p>
                        </div>
                      </div>
                      {scanResult.detectedStacks.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {scanResult.detectedStacks.map((stack) => (
                            <span
                              key={stack}
                              className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px]"
                            >
                              {stack}
                            </span>
                          ))}
                        </div>
                      )}
                      {scanResult.warnings.length > 0 && (
                        <div className="space-y-1.5">
                          {scanResult.warnings.slice(0, 3).map((warning, index) => (
                            <p
                              key={`${warning.code}-${index}`}
                              className="rounded-sm border border-amber-300/60 bg-amber-50/40 px-2 py-1.5 text-[11px] text-amber-900/90"
                            >
                              {warning.message}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => {
                      setOnboardingRecommendation(null);
                      setStep(1);
                    }}
                  >
                    Skip to manual configuration
                  </button>
                </div>
              )}

              {step === 1 && recommendedSetupActive && onboardingRecommendation && (
                <div className="space-y-6">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Review recommended setup</h3>
                      <p className="text-xs text-muted-foreground">
                        Confirm the company, squad, workspace, and starter issue before creating anything.
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Recommendation source:{" "}
                        <span className="font-mono">
                          {onboardingRecommendation.recommendationSource === "ai" ? "local Codex" : "deterministic"}
                        </span>
                      </p>
                    </div>
                  </div>
                  {onboardingRecommendation.recommendationWarnings.length > 0 && (
                    <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-900/90">
                      {onboardingRecommendation.recommendationWarnings[0]}
                    </div>
                  )}
                  {scanResult?.warnings.length ? (
                    <div className="space-y-1.5 rounded-md border border-amber-300/60 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-900/90">
                      {scanResult.warnings.slice(0, 3).map((warning, index) => (
                        <p key={`${warning.code}-${index}`}>{warning.message}</p>
                      ))}
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.82fr)]">
                    <div className="space-y-4">
                      <div className="space-y-3 rounded-md border border-border p-3">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Company</h4>
                        </div>
                        <div>
                          <label htmlFor="onboarding-review-company-name" className="text-xs text-muted-foreground mb-1 block">
                            Company name
                          </label>
                          <input
                            id="onboarding-review-company-name"
                            data-testid="onboarding-review-company-name"
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                            value={companyName}
                            onChange={(e) => setCompanyName(e.target.value)}
                            autoFocus
                          />
                        </div>
                        <div>
                          <label htmlFor="onboarding-review-operating-focus" className="text-xs text-muted-foreground mb-1 block">
                            Operating focus
                          </label>
                          <textarea
                            id="onboarding-review-operating-focus"
                            data-testid="onboarding-review-operating-focus"
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[76px]"
                            value={companyGoal}
                            onChange={(e) => setCompanyGoal(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="space-y-3 rounded-md border border-border p-3">
                        <div className="flex items-center gap-2">
                          <ListTodo className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Starter issue</h4>
                        </div>
                        <div>
                          <label htmlFor="onboarding-review-starter-title" className="text-xs text-muted-foreground mb-1 block">
                            Title
                          </label>
                          <input
                            id="onboarding-review-starter-title"
                            aria-label="Starter issue title"
                            data-testid="onboarding-review-starter-title"
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                            value={taskTitle}
                            onChange={(e) => setTaskTitle(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="onboarding-review-starter-description" className="text-xs text-muted-foreground mb-1 block">
                            Description
                          </label>
                          <textarea
                            id="onboarding-review-starter-description"
                            aria-label="Starter issue description"
                            data-testid="onboarding-review-starter-description"
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[132px]"
                            value={taskDescription}
                            onChange={(e) => setTaskDescription(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-md border border-border p-3">
                        <div className="flex items-center gap-2 mb-3">
                          <Bot className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Agent squad</h4>
                        </div>
                        <div className="space-y-2">
                          {(reviewSquads.length > 0 ? reviewSquads : onboardingRecommendation.proposedSquads).map((squad, index) => {
                            const selectedOption = onboardingAdapterOptionByType.get(squad.adapterType);
                            const modelOptions = selectedOption?.models ?? [];
                            return (
                            <div
                              key={`${squad.adapterType}-${squad.role}`}
                              className="space-y-2 rounded-sm bg-muted/35 px-2.5 py-2"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">{squad.name}</p>
                                  <p className="text-[11px] text-muted-foreground">
                                    {squad.role}
                                  </p>
                                </div>
                                <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  xAgent
                                </span>
                              </div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <label className="space-y-1">
                                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Provider
                                  </span>
                                  <select
                                    aria-label={`${squad.name} provider`}
                                    data-testid={`onboarding-review-squad-${index}-provider`}
                                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                                    value={squad.adapterType}
                                    onChange={(e) =>
                                      handleReviewSquadAdapterChange(
                                        index,
                                        e.target.value as ReviewSquad["adapterType"],
                                      )}
                                  >
                                    {effectiveOnboardingAdapterOptions.map((option) => (
                                      <option key={option.adapterType} value={option.adapterType}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="space-y-1">
                                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Model
                                  </span>
                                  <select
                                    aria-label={`${squad.name} model`}
                                    data-testid={`onboarding-review-squad-${index}-model`}
                                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                                    value={squad.model ?? ""}
                                    disabled={selectedOption?.lockedModel != null || modelOptions.length <= 1}
                                    onChange={(e) =>
                                      updateReviewSquad(index, { model: e.target.value || null })}
                                  >
                                    {squad.adapterType === "claude_local" && (
                                      <option value="">Adapter default</option>
                                    )}
                                    {modelOptions.map((modelOption) => (
                                      <option key={modelOption.id} value={modelOption.id}>
                                        {modelOption.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            </div>
                          )})}
                        </div>
                      </div>

                      <div className="rounded-md border border-border p-3">
                        <div className="flex items-center gap-2 mb-3">
                          <FolderSearch className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium">Workspace</h4>
                        </div>
                        <p className="font-mono text-xs break-all">
                          {onboardingRecommendation.proposedProjectWorkspace.cwd}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {onboardingRecommendation.proposedProjectWorkspace.name}
                        </p>
                      </div>

                      {(onboardingRecommendation.proposedMcps.length > 0 ||
                        onboardingRecommendation.proposedRequiredSecrets.length > 0 ||
                        onboardingRecommendation.proposedOptionalSecrets.length > 0 ||
                        onboardingRecommendation.proposedLocalAuthChecks.length > 0) && (
                        <div className="rounded-md border border-border p-3">
                          <h4 className="text-sm font-medium">Connections</h4>
                          {onboardingRecommendation.proposedLocalAuthChecks.length > 0 && (
                            <div className="mt-2 space-y-1.5">
                              {onboardingRecommendation.proposedLocalAuthChecks.map((check) => (
                                <div
                                  key={check.adapterType}
                                  className="rounded-sm bg-muted/35 px-2 py-1.5 text-[11px]"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{check.label}</span>
                                    <span className="font-mono text-muted-foreground">
                                      {onboardingAdapterOptionByType.get(check.adapterType)?.authLabel ?? "Use existing login"}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 leading-relaxed text-muted-foreground">
                                    {check.quotaPolicy === "warn_unknown"
                                      ? "Quota unknown; Paperclip warns but does not block."
                                      : "Quota windows can be checked from the local session."}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                          {onboardingRecommendation.proposedOptionalSecrets.length > 0 && (
                            <div className="mt-3 border-t border-border pt-3">
                              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                                Optional secrets can be configured after setup
                              </p>
                              <div className="space-y-1.5">
                                {onboardingRecommendation.proposedOptionalSecrets.map((secret) => (
                                  <div
                                    key={secret.key}
                                    className="rounded-sm bg-muted/35 px-2 py-1.5 text-[11px]"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium">{secret.label}</span>
                                      <span className="font-mono text-muted-foreground">
                                        {secret.key}
                                      </span>
                                    </div>
                                    <p className="mt-0.5 leading-relaxed text-muted-foreground">
                                      {secret.reason}
                                    </p>
                                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                                      {secret.storageProvider} / {secret.status}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {onboardingRecommendation.proposedMcps.length > 0 && (
                            <div className="mt-3 border-t border-border pt-3">
                              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                                MCPs can be configured later
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                              {onboardingRecommendation.proposedMcps.map((mcp) => (
                                <span
                                  key={mcp.name}
                                  className="rounded-sm border border-border px-1.5 py-0.5 text-[11px]"
                                >
                                  {mcp.name}
                                </span>
                              ))}
                              </div>
                            </div>
                          )}
                          {onboardingRecommendation.proposedRequiredSecrets.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {onboardingRecommendation.proposedRequiredSecrets.map((secret) => (
                                <span
                                  key={secret}
                                  className="rounded-sm bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                                >
                                  {secret}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {step === 1 && !recommendedSetupActive && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Name your company</h3>
                      <p className="text-xs text-muted-foreground">
                        This is the organization your agents will work for.
                      </p>
                    </div>
                  </div>
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
                </div>
              )}

              {step === 2 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Create your first agent</h3>
                      <p className="text-xs text-muted-foreground">
                        Choose how this agent will run tasks.
                      </p>
                    </div>
                  </div>
                  <div>
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
                  </div>

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      Adapter type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {recommendedAdapters.map((opt) => (
                        <button
                          key={opt.type}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                            adapterType === opt.type
                              ? "border-foreground bg-accent"
                              : "border-border hover:bg-accent/50"
                          )}
                          onClick={() => {
                            const nextType = opt.type;
                            setAdapterType(nextType);
                            if (nextType === "codex_local") {
                              if (!model) {
                                setModel(DEFAULT_CODEX_LOCAL_MODEL);
                              }
                              return;
                            }
                            if (nextType === "agy_local") {
                              setModel(DEFAULT_AGY_LOCAL_MODEL);
                              return;
                            }
                            if (nextType === "opencode_local") {
                              setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                              return;
                            }
                            setModel("");
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
                            {opt.description}
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
                        {moreAdapters.map((opt) => (
                           <button
                             key={opt.type}
                             disabled={!!opt.comingSoon}
                             className={cn(
                               "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                               opt.comingSoon
                                 ? "border-border opacity-40 cursor-not-allowed"
                                 : adapterType === opt.type
                                 ? "border-foreground bg-accent"
                                 : "border-border hover:bg-accent/50"
                             )}
                             onClick={() => {
                               if (opt.comingSoon) return;
                              const nextType = opt.type;
                              setAdapterType(nextType);
                              if (nextType === "agy_local") {
                                setModel(DEFAULT_AGY_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "gemini_local" && !model) {
                                setModel(DEFAULT_GEMINI_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "cursor" && !model) {
                                setModel(DEFAULT_CURSOR_LOCAL_MODEL);
                                return;
                              }
                              if (nextType === "opencode_local") {
                                setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                                return;
                              }
                              setModel("");
                            }}
                          >
                            <opt.icon className="h-4 w-4" />
                            <span className="font-medium">{opt.label}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {opt.comingSoon
                                ? opt.disabledLabel ?? "Coming soon"
                                : opt.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Conditional adapter fields */}
                  {isLocalAdapter && (
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
                          onClick={() => void runAdapterEnvironmentTest()}
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
                              : adapterType === "agy_local"
                              ? `${effectiveAdapterCommand} --print "Respond with hello."`
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
                          {adapterType === "agy_local" ? (
                            <p className="text-muted-foreground">
                              If Google sign-in is required, run{" "}
                              <span className="font-mono">agy</span> once in a
                              terminal and complete the browser OAuth flow.
                            </p>
                          ) : adapterType === "cursor" ||
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
                      <ListTodo className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Give it something to do</h3>
                      <p className="text-xs text-muted-foreground">
                        Give your agent a small task to start with — a bug fix,
                        a research question, writing a script.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Task title
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Research competitor pricing"
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Description (optional)
                    </label>
                    <textarea
                      ref={textareaRef}
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[120px] max-h-[300px] overflow-y-auto"
                      placeholder="Add more detail about what the agent should do..."
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Rocket className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Ready to launch</h3>
                      <p className="text-xs text-muted-foreground">
                        Everything is set up. Launching now will create the
                        starter task, wake the agent, and open the issue.
                      </p>
                    </div>
                  </div>
                  <div className="border border-border divide-y divide-border">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {companyName}
                        </p>
                        <p className="text-xs text-muted-foreground">Company</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {agentName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {getUIAdapter(adapterType).label}
                        </p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {taskTitle}
                        </p>
                        <p className="text-xs text-muted-foreground">Task</p>
                      </div>
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                    </div>
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
                  {step > initialStep && (
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
                  {step === 0 && (
                    <Button
                      size="sm"
                      disabled={!scanPath.trim() || loading}
                      onClick={handleScanNext}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Scanning..." : "Scan folder"}
                    </Button>
                  )}
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={
                        !companyName.trim() ||
                        (recommendedSetupActive && !taskTitle.trim()) ||
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
                        ? recommendedSetupActive
                          ? "Creating setup..."
                          : "Creating..."
                        : recommendedSetupActive
                          ? "Create setup"
                          : "Next"}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() || loading || adapterEnvLoading
                      }
                      onClick={handleStep2Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!taskTitle.trim() || loading}
                      onClick={handleStep3Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
                    </Button>
                  )}
                  {step === 4 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Create & Open Issue"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
              step === 1 && !recommendedSetupActive ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
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
