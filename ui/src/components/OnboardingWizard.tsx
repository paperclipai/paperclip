import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { extractModelName, extractProviderIdWithFallback } from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { defaultCreateValues } from "./agent-config-defaults";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { ChoosePathButton } from "./PathInstructionsModal";
import { HintIcon } from "./agent-config-primitives";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import {
  Building2,
  Bot,
  Code,
  ListTodo,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Terminal,
  Sparkles,
  MousePointer2,
  Check,
  Loader2,
  FolderOpen,
  ChevronDown,
  X
} from "lucide-react";

type Step = 1 | 2 | 3 | 4;
type AdapterType =
  | "claude_local"
  | "codex_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "process"
  | "http"
  | "openclaw_gateway";

const DEFAULT_TASK_DESCRIPTION = `Setup yourself as the CEO. Use the ceo persona found here: [https://github.com/paperclipai/companies/blob/main/default/ceo/AGENTS.md](https://github.com/paperclipai/companies/blob/main/default/ceo/AGENTS.md)

Ensure you have a folder agents/ceo and then download this AGENTS.md as well as the sibling HEARTBEAT.md, SOUL.md, and TOOLS.md. and set that AGENTS.md as the path to your agents instruction file

And after you've finished that, hire yourself a Founding Engineer agent`;

export function OnboardingWizard() {
  const { t } = useTranslation();
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { selectedCompanyId, companies, setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const initialStep = onboardingOptions.initialStep ?? 1;
  const existingCompanyId = onboardingOptions.companyId;

  const [step, setStep] = useState<Step>(initialStep);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState("");
  const [companyGoal, setCompanyGoal] = useState("");

  // Step 2
  const [agentName, setAgentName] = useState("CEO");
  const [adapterType, setAdapterType] = useState<AdapterType>("claude_local");
  const [cwd, setCwd] = useState("");
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

  // Step 3
  const [taskTitle, setTaskTitle] = useState("Create your CEO HEARTBEAT.md");
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
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(null);

  // Sync step and company when onboarding opens with options.
  // Keep this independent from company-list refreshes so Step 1 completion
  // doesn't get reset after creating a company.
  useEffect(() => {
    if (!onboardingOpen) return;
    const cId = onboardingOptions.companyId ?? null;
    setStep(onboardingOptions.initialStep ?? 1);
    setCreatedCompanyId(cId);
    setCreatedCompanyPrefix(null);
  }, [
    onboardingOpen,
    onboardingOptions.companyId,
    onboardingOptions.initialStep
  ]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!onboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [onboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // Resize textarea when step 3 is shown or description changes
  useEffect(() => {
    if (step === 3) autoResizeTextarea();
  }, [step, taskDescription, autoResizeTextarea]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching,
  } = useQuery({
    queryKey:
      createdCompanyId
        ? queryKeys.agents.adapterModels(createdCompanyId, adapterType)
        : ["agents", "none", "adapter-models", adapterType],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType),
    enabled: Boolean(createdCompanyId) && onboardingOpen && step === 2
  });
  const isLocalAdapter =
    adapterType === "claude_local" || adapterType === "codex_local" || adapterType === "opencode_local" || adapterType === "cursor";
  const effectiveAdapterCommand =
    command.trim() ||
    (adapterType === "codex_local"
      ? "codex"
      : adapterType === "cursor"
        ? "agent"
        : adapterType === "opencode_local"
          ? "opencode"
          : "claude");

  useEffect(() => {
    if (step !== 2) return;
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
  }, [step, adapterType, cwd, model, command, args, url]);

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
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
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
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    setStep(1);
    setLoading(false);
    setError(null);
    setCompanyName("");
    setCompanyGoal("");
    setAgentName("CEO");
    setAdapterType("claude_local");
    setCwd("");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setTaskTitle("Create your CEO HEARTBEAT.md");
    setTaskDescription(DEFAULT_TASK_DESCRIPTION);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
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
      cwd,
      model:
        adapterType === "codex_local"
          ? model || DEFAULT_CODEX_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
          : model,
      command,
      args,
      url,
      dangerouslySkipPermissions: adapterType === "claude_local",
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
        t("onboarding.createOrSelectCompanyFirst")
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
        err instanceof Error ? err.message : t("onboarding.adapterEnvTestFailed")
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  async function handleStep1Next() {
    setLoading(true);
    setError(null);
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      setCreatedCompanyId(company.id);
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

      if (companyGoal.trim()) {
        await goalsApi.create(company.id, {
          title: companyGoal.trim(),
          level: "company",
          status: "active"
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(company.id)
        });
      }

      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("onboarding.failedToCreateCompany"));
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
          setError(t("onboarding.openCodeRequiresModel"));
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : t("onboarding.failedToLoadOpenCodeModels"),
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(t("onboarding.openCodeModelsLoading"));
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? t("onboarding.noOpenCodeModelsDiscovered")
              : t("onboarding.openCodeModelUnavailable", { model: selectedModelId }),
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
      setError(err instanceof Error ? err.message : t("onboarding.failedToCreateAgent"));
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
          t("onboarding.retriedUnsetStillFailing")
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("onboarding.failedToUnsetAndRetry")
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleStep3Next() {
    if (!createdCompanyId || !createdAgentId) return;
    setLoading(true);
    setError(null);
    try {
      const issue = await issuesApi.create(createdCompanyId, {
        title: taskTitle.trim(),
        ...(taskDescription.trim()
          ? { description: taskDescription.trim() }
          : {}),
        assigneeAgentId: createdAgentId,
        status: "todo"
      });
      setCreatedIssueRef(issue.identifier ?? issue.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(createdCompanyId)
      });
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("onboarding.failedToCreateTask"));
    } finally {
      setLoading(false);
    }
  }

  async function handleLaunch() {
    if (!createdAgentId) return;
    setLoading(true);
    setError(null);
    setLoading(false);
    reset();
    closeOnboarding();
    if (createdCompanyPrefix && createdIssueRef) {
      navigate(`/${createdCompanyPrefix}/issues/${createdIssueRef}`);
      return;
    }
    if (createdCompanyPrefix) {
      navigate(`/${createdCompanyPrefix}/dashboard`);
      return;
    }
    navigate("/dashboard");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (step === 1 && companyName.trim()) handleStep1Next();
      else if (step === 2 && agentName.trim()) handleStep2Next();
      else if (step === 3 && taskTitle.trim()) handleStep3Next();
      else if (step === 4) handleLaunch();
    }
  }

  if (!onboardingOpen) return null;

  return (
    <Dialog
      open={onboardingOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
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
            <span className="sr-only">{t("common.close")}</span>
          </button>

          {/* Left half — form */}
          <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
            <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
              {/* Progress indicators */}
              <div className="flex items-center gap-2 mb-8">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t("onboarding.getStarted")}</span>
                <span className="text-sm text-muted-foreground/60">
                  {t("onboarding.stepOf", { step, total: 4 })}
                </span>
                <div className="flex items-center gap-1.5 ml-auto">
                  {[1, 2, 3, 4].map((s) => (
                    <div
                      key={s}
                      className={cn(
                        "h-1.5 w-6 rounded-full transition-colors",
                        s < step
                          ? "bg-green-500"
                          : s === step
                            ? "bg-foreground"
                            : "bg-muted"
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Step content */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{t("onboarding.nameYourCompany")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.nameYourCompanyDesc")}
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.companyName")}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.companyNamePlaceholder")}
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.missionGoalOptional")}
                    </label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[60px]"
                      placeholder={t("onboarding.missionGoalPlaceholder")}
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
                      <h3 className="font-medium">{t("onboarding.createFirstAgent")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.createFirstAgentDesc")}
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.agentName")}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.agentNamePlaceholder")}
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  {/* Adapter type radio cards */}
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">
                      {t("onboarding.adapterType")}
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        {
                          value: "claude_local" as const,
                          label: t("onboarding.adapterClaudeCode"),
                          icon: Sparkles,
                          desc: t("onboarding.adapterClaudeCodeDesc"),
                          recommended: true
                        },
                        {
                          value: "codex_local" as const,
                          label: t("onboarding.adapterCodex"),
                          icon: Code,
                          desc: t("onboarding.adapterCodexDesc"),
                          recommended: true
                        },
                        {
                          value: "opencode_local" as const,
                          label: t("onboarding.adapterOpenCode"),
                          icon: OpenCodeLogoIcon,
                          desc: t("onboarding.adapterOpenCodeDesc")
                        },
                        {
                          value: "pi_local" as const,
                          label: t("onboarding.adapterPi"),
                          icon: Terminal,
                          desc: t("onboarding.adapterPiDesc")
                        },
                        {
                          value: "openclaw_gateway" as const,
                          label: t("onboarding.adapterOpenClawGateway"),
                          icon: Bot,
                          desc: t("onboarding.adapterOpenClawGatewayDesc"),
                          comingSoon: true,
                          disabledLabel: t("onboarding.configureOpenClawInApp")
                        },
                        {
                          value: "cursor" as const,
                          label: t("onboarding.adapterCursor"),
                          icon: MousePointer2,
                          desc: t("onboarding.adapterCursorDesc")
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
                            if (nextType === "codex_local" && !model) {
                              setModel(DEFAULT_CODEX_LOCAL_MODEL);
                            } else if (nextType === "cursor" && !model) {
                              setModel(DEFAULT_CURSOR_LOCAL_MODEL);
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
                          {opt.recommended && (
                            <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                              {t("common.recommended")}
                            </span>
                          )}
                          <opt.icon className="h-4 w-4" />
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {opt.comingSoon
                              ? (opt as { disabledLabel?: string }).disabledLabel ??
                                t("onboarding.comingSoon")
                              : opt.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Conditional adapter fields */}
                  {(adapterType === "claude_local" ||
                    adapterType === "codex_local" ||
                    adapterType === "opencode_local" ||
                    adapterType === "pi_local" ||
                    adapterType === "cursor") && (
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <label className="text-xs text-muted-foreground">
                            {t("onboarding.workingDirectory")}
                          </label>
                          <HintIcon text={t("onboarding.workingDirectoryHint")} />
                        </div>
                        <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <input
                            className="w-full bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/50"
                            placeholder={t("onboarding.workingDirectoryPlaceholder")}
                            value={cwd}
                            onChange={(e) => setCwd(e.target.value)}
                          />
                          <ChoosePathButton />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.model")}
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
                                      ? t("onboarding.selectModelRequired")
                                      : t("onboarding.default"))}
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
                              placeholder={t("onboarding.searchModels")}
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
                                  {t("onboarding.default")}
                                </button>
                            )}
                            <div className="max-h-[240px] overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div key={group.provider} className="mb-1 last:mb-0">
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
                                      <span className="block w-full text-left truncate" title={m.id}>
                                        {adapterType === "opencode_local" ? extractModelName(m.id) : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                {t("onboarding.noModelsDiscovered")}
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
                            {t("onboarding.adapterEnvCheck")}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {t("onboarding.adapterEnvCheckDesc")}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          disabled={adapterEnvLoading}
                          onClick={() => void runAdapterEnvironmentTest()}
                        >
                          {adapterEnvLoading ? t("onboarding.testing") : t("onboarding.testNow")}
                        </Button>
                      </div>

                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult && (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      )}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-[11px] text-amber-900/90 leading-relaxed">
                            {t("onboarding.claudeFailedApiKey")}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={adapterEnvLoading || unsetAnthropicLoading}
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading ? t("common.retrying") : t("onboarding.unsetAnthropicApiKey")}
                          </Button>
                        </div>
                      )}

                      <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px] space-y-1.5">
                        <p className="font-medium">{t("onboarding.manualDebug")}</p>
                        <p className="text-muted-foreground font-mono break-all">
                          {adapterType === "cursor"
                            ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                            : adapterType === "codex_local"
                            ? `${effectiveAdapterCommand} exec --json -`
                            : adapterType === "opencode_local"
                              ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                            : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                        </p>
                        <p className="text-muted-foreground">
                          {t("onboarding.prompt")}{" "}
                          <span className="font-mono">Respond with hello.</span>
                        </p>
                        {adapterType === "cursor" || adapterType === "codex_local" || adapterType === "opencode_local" ? (
                          <p className="text-muted-foreground">
                            {t("onboarding.ifAuthFailsSet")}{" "}
                            <span className="font-mono">
                              {adapterType === "cursor" ? "CURSOR_API_KEY" : "OPENAI_API_KEY"}
                            </span>{" "}
                            {t("onboarding.inEnvOrRun")}{" "}
                            <span className="font-mono">
                              {adapterType === "cursor"
                                ? "agent login"
                                : adapterType === "codex_local"
                                  ? "codex login"
                                  : "opencode auth login"}
                            </span>.
                          </p>
                        ) : (
                          <p className="text-muted-foreground">
                            {t("onboarding.ifLoginRequired")}{" "}
                            <span className="font-mono">claude login</span>{" "}
                            {t("onboarding.andRetry")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {adapterType === "process" && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.command")}
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder={t("onboarding.commandPlaceholder")}
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t("onboarding.argsCommaSeparated")}
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder={t("onboarding.argsPlaceholder")}
                          value={args}
                          onChange={(e) => setArgs(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {(adapterType === "http" || adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway" ? t("onboarding.gatewayUrl") : t("onboarding.webhookUrl")}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={adapterType === "openclaw_gateway" ? "ws://127.0.0.1:18789" : "https://..."}
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
                      <h3 className="font-medium">{t("onboarding.giveTask")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.giveTaskDesc")}
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.taskTitle")}
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder={t("onboarding.taskTitlePlaceholder")}
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {t("onboarding.descriptionOptional")}
                    </label>
                    <textarea
                      ref={textareaRef}
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-[120px] max-h-[300px] overflow-y-auto"
                      placeholder={t("onboarding.descriptionPlaceholder")}
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
                      <h3 className="font-medium">{t("onboarding.readyToLaunch")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.readyToLaunchDesc")}
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
                        <p className="text-xs text-muted-foreground">{t("onboarding.company")}</p>
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
                        <p className="text-xs text-muted-foreground">{t("onboarding.task")}</p>
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
                  {step > 1 && step > (onboardingOptions.initialStep ?? 1) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep((step - 1) as Step)}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      {t("common.back")}
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
                      {loading ? t("common.creating") : t("onboarding.next")}
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
                      {loading ? t("common.creating") : t("onboarding.next")}
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
                      {loading ? t("common.creating") : t("onboarding.next")}
                    </Button>
                  )}
                  {step === 4 && (
                    <Button size="sm" disabled={loading} onClick={handleLaunch}>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? t("onboarding.opening") : t("onboarding.openIssue")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right half — ASCII art (hidden on mobile) */}
          <div className="hidden md:block w-1/2 overflow-hidden">
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
  const { t } = useTranslation();
  const statusLabel =
    result.status === "pass"
      ? t("onboarding.passed")
      : result.status === "warn"
        ? t("onboarding.warnings")
        : t("common.failed");
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
                {t("onboarding.hint")}: {check.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
