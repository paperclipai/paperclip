import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { llmApiKeysApi } from "../api/llmApiKeys";
import { companyEmailApi } from "../api/company-email";
import { assetsApi } from "../api/assets";
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
  Monitor,
  X,
  Key,
  Mail,
  Upload,
  ImageIcon,
  Shield,
  CheckCircle2,
  XCircle,
  SkipForward
} from "lucide-react";
import { HermesIcon } from "./HermesIcon";

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type AdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "hermes_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "http"
  | "openclaw_gateway"
  | "lmstudio_local";

const LLM_PROVIDERS = [
  { value: "anthropic", label: "Anthropic (Claude)", icon: Sparkles },
  { value: "openai", label: "OpenAI (GPT)", icon: Bot },
  { value: "google", label: "Google (Gemini)", icon: Gem },
  { value: "mistral", label: "Mistral", icon: Terminal },
  { value: "cohere", label: "Cohere", icon: Code },
  { value: "groq", label: "Groq", icon: Rocket },
  { value: "other", label: "Other", icon: Key },
] as const;

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

  const [step, setStep] = useState<Step>(initialStep as Step);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1 — Company
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Step 2 — Agent
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

  // Step 3 — Task
  const [taskTitle, setTaskTitle] = useState(
    "Hire your first engineer and create a hiring plan"
  );
  const [taskDescription, setTaskDescription] = useState(
    DEFAULT_TASK_DESCRIPTION
  );

  // Step 4 — LLM API Key
  const [llmProvider, setLlmProvider] = useState("anthropic");
  const [llmKeyName, setLlmKeyName] = useState("Default API Key");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmKeySaved, setLlmKeySaved] = useState(false);
  const [llmKeyTesting, setLlmKeyTesting] = useState(false);
  const [llmKeyTestResult, setLlmKeyTestResult] = useState<"pass" | "fail" | null>(null);
  const [llmKeyTestError, setLlmKeyTestError] = useState<string | null>(null);

  // Step 5 — Email Setup
  const [agentmailApiKey, setAgentmailApiKey] = useState("");
  const [emailDisplayName, setEmailDisplayName] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailInboxCreated, setEmailInboxCreated] = useState(false);
  const [emailInboxAddress, setEmailInboxAddress] = useState<string | null>(null);
  const [emailSaving, setEmailSaving] = useState(false);

  // Auto-grow textarea for task description
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Created entity IDs
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

  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const cId = effectiveOnboardingOptions.companyId ?? null;
    setStep((effectiveOnboardingOptions.initialStep ?? 1) as Step);
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

  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

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
    setCompanyName("");
    setCompanyGoal("");
    setLogoFile(null);
    setLogoPreview(null);
    setLogoUploading(false);
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
    setLlmProvider("anthropic");
    setLlmKeyName("Default API Key");
    setLlmApiKey("");
    setLlmKeySaved(false);
    setLlmKeyTesting(false);
    setLlmKeyTestResult(null);
    setLlmKeyTestError(null);
    setAgentmailApiKey("");
    setEmailDisplayName("");
    setEmailSaved(false);
    setEmailInboxCreated(false);
    setEmailInboxAddress(null);
    setEmailSaving(false);
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

  // ── Logo handling ───────────────────────────────────────────────────

  function handleLogoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleLogoDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function uploadLogoIfNeeded(companyId: string) {
    if (!logoFile) return;
    setLogoUploading(true);
    try {
      await assetsApi.uploadCompanyLogo(companyId, logoFile);
    } catch {
      // Logo upload failure is non-blocking
    } finally {
      setLogoUploading(false);
    }
  }

  // ── Adapter config ──────────────────────────────────────────────────

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

  // ── Step handlers ───────────────────────────────────────────────────

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      // Upload logo in background
      if (logoFile) {
        uploadLogoIfNeeded(company.id);
      }

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

      if (isLocalAdapter) {
        const result = adapterEnvResult ?? (await runAdapterEnvironmentTest());
        if (!result) return;
      }

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

  // Step 4 — Save & Test LLM API Key
  async function handleSaveLlmKey() {
    if (!createdCompanyId || !llmApiKey.trim()) return;
    setLlmKeyTesting(true);
    setLlmKeyTestError(null);
    setLlmKeyTestResult(null);
    try {
      await llmApiKeysApi.create(createdCompanyId, {
        name: llmKeyName.trim() || "Default API Key",
        provider: llmProvider,
        apiKey: llmApiKey.trim(),
        isDefault: true,
      });
      setLlmKeySaved(true);
      setLlmKeyTestResult("pass");
    } catch (err) {
      setLlmKeyTestResult("fail");
      setLlmKeyTestError(
        err instanceof Error ? err.message : "Failed to save API key"
      );
    } finally {
      setLlmKeyTesting(false);
    }
  }

  async function handleStep4Next() {
    setError(null);
    setStep(5);
  }

  // Step 5 — Save AgentMail Settings & Create Inbox
  async function handleSaveEmail() {
    if (!createdCompanyId || !agentmailApiKey.trim()) return;
    setEmailSaving(true);
    setError(null);
    try {
      // Save settings
      await companyEmailApi.saveSettings(createdCompanyId, {
        agentmailApiKey: agentmailApiKey.trim(),
        agentmailDisplayName: emailDisplayName.trim() || companyName.trim() || undefined,
        enabled: true,
      });
      setEmailSaved(true);

      // Create inbox
      try {
        const inbox = await companyEmailApi.createInbox(createdCompanyId, {
          display_name: emailDisplayName.trim() || companyName.trim() || undefined,
        });
        setEmailInboxCreated(true);
        setEmailInboxAddress(inbox.email);
      } catch (inboxErr) {
        // If inbox already exists, try to list and use the first one
        try {
          const inboxes = await companyEmailApi.listInboxes(createdCompanyId);
          if (inboxes.length > 0) {
            setEmailInboxCreated(true);
            setEmailInboxAddress(inboxes[0].email);
          }
        } catch {
          // Non-blocking
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save email settings");
      setEmailSaved(false);
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleStep5Next() {
    setError(null);
    setStep(6);
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
      if (step === 1 && companyName.trim()) handleStep1Next();
      else if (step === 2 && agentName.trim()) handleStep2Next();
      else if (step === 3 && taskTitle.trim()) handleStep3Next();
      else if (step === 4) handleStep4Next();
      else if (step === 5) handleStep5Next();
      else if (step === 6) handleLaunch();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  // ── Step tabs config ────────────────────────────────────────────────

  const stepTabs: Array<{ step: Step; label: string; icon: typeof Building2 }> = [
    { step: 1, label: "Company", icon: Building2 },
    { step: 2, label: "Agent", icon: Bot },
    { step: 3, label: "Task", icon: ListTodo },
    { step: 4, label: "LLM Key", icon: Key },
    { step: 5, label: "Email", icon: Mail },
    { step: 6, label: "Launch", icon: Rocket },
  ];

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
            <div className="w-full max-w-lg mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress tabs */}
              <div className="flex items-center gap-0 mb-8 border-b border-border overflow-x-auto">
                {stepTabs.map(({ step: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium border-b-2 -mb-px transition-colors cursor-pointer whitespace-nowrap",
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

              {/* ──────────────── STEP 1: Company ──────────────── */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-start gap-3 mb-1">
                    {/* Logo upload area (top-left) */}
                    <div
                      className={cn(
                        "relative shrink-0 w-16 h-16 rounded-[4px] border-2 border-dashed flex items-center justify-center cursor-pointer transition-all group",
                        logoPreview
                          ? "border-[var(--primary)]/40 bg-[var(--primary)]/5"
                          : "border-border hover:border-[var(--primary)]/30 hover:bg-accent/30"
                      )}
                      onClick={() => logoInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleLogoDrop}
                      title="Upload company logo"
                    >
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                        className="hidden"
                        onChange={handleLogoSelect}
                      />
                      {logoPreview ? (
                        <img
                          src={logoPreview}
                          alt="Logo preview"
                          className="w-full h-full object-contain rounded-[3px]"
                        />
                      ) : logoUploading ? (
                        <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                      ) : (
                        <div className="flex flex-col items-center gap-0.5">
                          <ImageIcon className="h-5 w-5 text-muted-foreground/50 group-hover:text-[var(--primary)]/60 transition-colors" />
                          <span className="text-[8px] text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">LOGO</span>
                        </div>
                      )}
                      {logoPreview && (
                        <button
                          className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLogoFile(null);
                            setLogoPreview(null);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>

                    <div className="flex-1">
                      <h3 className="font-medium">Name your company</h3>
                      <p className="text-xs text-muted-foreground">
                        This is the organization your agents will work for. Upload a logo to brand it.
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

              {/* ──────────────── STEP 2: Agent ──────────────── */}
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
                            <span className="absolute -top-1.5 right-1.5 bg-[var(--status-active)] text-white text-[9px] font-[var(--font-mono)] font-semibold px-1.5 py-0.5 rounded-[2px] leading-none">
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
                            value: "lmstudio_local" as const,
                            label: "LM Studio",
                            icon: Monitor,
                            desc: "Local LLM via LM Studio"
                          },
                          {
                            value: "openclaw_gateway" as const,
                            label: "OpenClaw Gateway",
                            icon: Bot,
                            desc: "Invoke OpenClaw via gateway protocol"
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
                              {opt.desc}
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
                    adapterType === "cursor" ||
                    adapterType === "lmstudio_local") && (
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
                        <div className="flex items-center gap-2 rounded-[2px] border border-[var(--status-active)]/30 bg-[var(--status-active)]/10 px-3 py-2 text-xs text-[var(--status-active)] animate-in fade-in slide-in-from-bottom-1 duration-300">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">Passed</span>
                        </div>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-[2px] border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-[var(--status-warning)] leading-relaxed">
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

              {/* ──────────────── STEP 3: Task ──────────────── */}
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

              {/* ──────────────── STEP 4: LLM API Key ──────────────── */}
              {step === 4 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Key className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Configure LLM API Key</h3>
                      <p className="text-xs text-muted-foreground">
                        Add an API key for your preferred LLM provider. This key will be used by your agents to make AI requests.
                      </p>
                    </div>
                  </div>

                  {/* Provider selection */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      LLM Provider
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {LLM_PROVIDERS.map((p) => (
                        <button
                          key={p.value}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-md border p-2.5 text-xs transition-colors",
                            llmProvider === p.value
                              ? "border-[var(--primary)] bg-[var(--primary)]/5 text-foreground"
                              : "border-border hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => setLlmProvider(p.value)}
                          disabled={llmKeySaved}
                        >
                          <p.icon className="h-4 w-4" />
                          <span className="font-medium text-[11px]">{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Key name */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Key name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Default API Key"
                      value={llmKeyName}
                      onChange={(e) => setLlmKeyName(e.target.value)}
                      disabled={llmKeySaved}
                    />
                  </div>

                  {/* API Key input */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      API Key
                    </label>
                    <div className="relative">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 pr-10"
                        type="password"
                        placeholder={
                          llmProvider === "anthropic" ? "sk-ant-..." :
                          llmProvider === "openai" ? "sk-..." :
                          llmProvider === "google" ? "AIza..." :
                          "Enter your API key"
                        }
                        value={llmApiKey}
                        onChange={(e) => setLlmApiKey(e.target.value)}
                        disabled={llmKeySaved}
                        autoFocus
                      />
                      <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground/60">
                      Your key is encrypted with AES-256-CBC and stored securely.
                    </p>
                  </div>

                  {/* Save & Test button */}
                  {!llmKeySaved ? (
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={!llmApiKey.trim() || llmKeyTesting}
                      onClick={handleSaveLlmKey}
                    >
                      {llmKeyTesting ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Key className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {llmKeyTesting ? "Saving & Testing..." : "Save & Test Key"}
                    </Button>
                  ) : null}

                  {/* Test result */}
                  {llmKeyTestResult === "pass" && (
                    <div className="flex items-center gap-2 rounded-[2px] border border-[var(--status-active)]/30 bg-[var(--status-active)]/10 px-3 py-2.5 text-xs text-[var(--status-active)] animate-in fade-in slide-in-from-bottom-1 duration-300">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <div>
                        <span className="font-medium">API key saved successfully!</span>
                        <p className="text-[11px] mt-0.5 opacity-80">
                          Your {LLM_PROVIDERS.find(p => p.value === llmProvider)?.label} key has been encrypted and stored.
                        </p>
                      </div>
                    </div>
                  )}

                  {llmKeyTestResult === "fail" && (
                    <div className="flex items-center gap-2 rounded-[2px] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 px-3 py-2.5 text-xs text-[var(--status-error)] animate-in fade-in slide-in-from-bottom-1 duration-300">
                      <XCircle className="h-4 w-4 shrink-0" />
                      <div>
                        <span className="font-medium">Failed to save key</span>
                        {llmKeyTestError && (
                          <p className="text-[11px] mt-0.5 opacity-80">{llmKeyTestError}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ──────────────── STEP 5: Email Setup ──────────────── */}
              {step === 5 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Mail className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Set up Company Email</h3>
                      <p className="text-xs text-muted-foreground">
                        Configure AgentMail to give your company a real email address for the Communication Center.
                      </p>
                    </div>
                  </div>

                  {/* AgentMail API Key */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      AgentMail API Key
                    </label>
                    <div className="relative">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 pr-10"
                        type="password"
                        placeholder="am-..."
                        value={agentmailApiKey}
                        onChange={(e) => setAgentmailApiKey(e.target.value)}
                        disabled={emailSaved}
                        autoFocus
                      />
                      <Shield className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground/60">
                      Get your API key from{" "}
                      <a href="https://agentmail.to" target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] hover:underline">
                        agentmail.to
                      </a>
                    </p>
                  </div>

                  {/* Display name */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      Display Name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={companyName.trim() || "My Company"}
                      value={emailDisplayName}
                      onChange={(e) => setEmailDisplayName(e.target.value)}
                      disabled={emailSaved}
                    />
                  </div>

                  {/* Save & Create Inbox button */}
                  {!emailSaved ? (
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={!agentmailApiKey.trim() || emailSaving}
                      onClick={handleSaveEmail}
                    >
                      {emailSaving ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {emailSaving ? "Setting up..." : "Save & Create Inbox"}
                    </Button>
                  ) : null}

                  {/* Success result */}
                  {emailSaved && (
                    <div className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-300">
                      <div className="flex items-center gap-2 rounded-[2px] border border-[var(--status-active)]/30 bg-[var(--status-active)]/10 px-3 py-2.5 text-xs text-[var(--status-active)]">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <div>
                          <span className="font-medium">Email settings saved!</span>
                          <p className="text-[11px] mt-0.5 opacity-80">
                            AgentMail API key has been encrypted and stored.
                          </p>
                        </div>
                      </div>

                      {emailInboxCreated && emailInboxAddress && (
                        <div className="rounded-[2px] border border-[var(--primary)]/20 bg-[var(--primary)]/5 px-3 py-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            <Mail className="h-3.5 w-3.5 text-[var(--primary)] shrink-0" />
                            <div>
                              <span className="font-medium text-foreground">Inbox created</span>
                              <p className="font-mono text-[11px] text-[var(--primary)] mt-0.5">
                                {emailInboxAddress}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-1">
                                This email is now available in the Company Communication Center.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ──────────────── STEP 6: Launch ──────────────── */}
              {step === 6 && (
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
                  <div className="border border-border divide-y divide-border rounded-[2px]">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      {logoPreview ? (
                        <img src={logoPreview} alt="" className="h-5 w-5 rounded-[2px] object-contain" />
                      ) : (
                        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {companyName}
                        </p>
                        <p className="text-xs text-muted-foreground">Company</p>
                      </div>
                      <Check className="h-4 w-4 text-[var(--status-active)] shrink-0" />
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
                      <Check className="h-4 w-4 text-[var(--status-active)] shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <ListTodo className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {taskTitle}
                        </p>
                        <p className="text-xs text-muted-foreground">Task</p>
                      </div>
                      <Check className="h-4 w-4 text-[var(--status-active)] shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {llmKeySaved
                            ? `${LLM_PROVIDERS.find(p => p.value === llmProvider)?.label ?? llmProvider} Key`
                            : "No LLM key configured"}
                        </p>
                        <p className="text-xs text-muted-foreground">LLM API Key</p>
                      </div>
                      {llmKeySaved ? (
                        <Check className="h-4 w-4 text-[var(--status-active)] shrink-0" />
                      ) : (
                        <span className="text-[10px] text-muted-foreground font-[var(--font-mono)]">SKIPPED</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {emailInboxAddress ?? (emailSaved ? "Email configured" : "No email configured")}
                        </p>
                        <p className="text-xs text-muted-foreground">Company Email</p>
                      </div>
                      {emailSaved ? (
                        <Check className="h-4 w-4 text-[var(--status-active)] shrink-0" />
                      ) : (
                        <span className="text-[10px] text-muted-foreground font-[var(--font-mono)]">SKIPPED</span>
                      )}
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
                  {step === 1 && (
                    <Button
                      size="sm"
                      disabled={!companyName.trim() || loading}
                      onClick={handleStep1Next}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Next"}
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
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleStep4Next}
                        className="text-muted-foreground"
                      >
                        <SkipForward className="h-3.5 w-3.5 mr-1" />
                        {llmKeySaved ? "Next" : "Skip"}
                      </Button>
                      {llmKeySaved && (
                        <Button size="sm" onClick={handleStep4Next}>
                          <ArrowRight className="h-3.5 w-3.5 mr-1" />
                          Next
                        </Button>
                      )}
                    </>
                  )}
                  {step === 5 && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleStep5Next}
                        className="text-muted-foreground"
                      >
                        <SkipForward className="h-3.5 w-3.5 mr-1" />
                        {emailSaved ? "Next" : "Skip"}
                      </Button>
                      {emailSaved && (
                        <Button size="sm" onClick={handleStep5Next}>
                          <ArrowRight className="h-3.5 w-3.5 mr-1" />
                          Next
                        </Button>
                      )}
                    </>
                  )}
                  {step === 6 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Rocket className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Create & Launch"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile, only on step 1) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
              step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0"
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
      ? "text-[var(--status-active)] border-[var(--status-active)]/30 bg-[var(--status-active)]/10"
      : result.status === "warn"
      ? "text-[var(--status-warning)] border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10"
      : "text-[var(--status-error)] border-[var(--status-error)]/30 bg-[var(--status-error)]/10";

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
