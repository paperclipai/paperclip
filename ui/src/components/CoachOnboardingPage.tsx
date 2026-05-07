import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import {
  ONBOARDING_PROJECT_NAME,
  buildOnboardingIssuePayload,
} from "../lib/onboarding-launch";
import { getUIAdapter } from "../adapters";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { defaultCreateValues } from "./agent-config-defaults";
import {
  AdapterStepFields,
  resolveEffectiveAdapterCommand,
} from "./AdapterStepFields";
import { OnboardingChrome } from "./OnboardingChrome";
import { OnboardingStepTabs } from "./OnboardingStepTabs";
import { COACH_STEP_TABS } from "./onboarding-coach-steps";

const COACH_ISSUE_TITLE = "Welcome — let's figure out what your company should do";
const COACH_ISSUE_DESCRIPTION =
  "Your Coach will start the conversation here. Reply when you're ready.";

function buildCoachAdapterConfig(args: {
  adapterType: string;
  model: string;
  url: string;
  forceUnsetAnthropicApiKey: boolean;
}): Record<string, unknown> {
  const { adapterType, model, url, forceUnsetAnthropicApiKey } = args;
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
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
    url,
    dangerouslySkipPermissions:
      adapterType === "claude_local" || adapterType === "opencode_local",
    dangerouslyBypassSandbox:
      adapterType === "codex_local"
        ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
        : defaultCreateValues.dangerouslyBypassSandbox,
  });
  if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
    const env =
      typeof config.env === "object"
        && config.env !== null
        && !Array.isArray(config.env)
        ? { ...(config.env as Record<string, unknown>) }
        : {};
    env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
    config.env = env;
  }
  return config;
}

export function CoachOnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const [adapterType, setAdapterType] = useState<string>("claude_local");
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyPrefix, setCompanyPrefix] = useState<string | null>(null);
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset env test state when the adapter or its config changes — old result
  // no longer applies.
  const lastAdapterKeyRef = useRef(`${adapterType}|${model}|${url}`);
  useEffect(() => {
    const key = `${adapterType}|${model}|${url}`;
    if (lastAdapterKeyRef.current !== key) {
      lastAdapterKeyRef.current = key;
      setAdapterEnvResult(null);
      setAdapterEnvError(null);
    }
  }, [adapterType, model, url]);

  const effectiveAdapterCommand = resolveEffectiveAdapterCommand(adapterType, "");

  function handleAdapterTypeChange(nextType: string) {
    setAdapterType(nextType);
    setForceUnsetAnthropicApiKey(false);
    if (nextType === "codex_local") {
      if (!model) setModel(DEFAULT_CODEX_LOCAL_MODEL);
      return;
    }
    if (nextType === "opencode_local") {
      setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
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
    setModel("");
  }

  const testPassed =
    adapterEnvResult !== null && adapterEnvResult.status !== "fail";

  async function ensureCompany(): Promise<{ id: string; issuePrefix: string }> {
    if (companyId && companyPrefix) {
      return { id: companyId, issuePrefix: companyPrefix };
    }
    const company = await companiesApi.create({
      name: "Untitled",
      description: "Onboarding draft — your Coach is helping you shape this.",
    });
    setSelectedCompanyId(company.id);
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    await companiesApi.update(company.id, { status: "draft" });
    setCompanyId(company.id);
    setCompanyPrefix(company.issuePrefix);
    return { id: company.id, issuePrefix: company.issuePrefix };
  }

  async function runTest(
    adapterConfigOverride?: Record<string, unknown>,
  ): Promise<AdapterEnvironmentTestResult | null> {
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      const { id } = await ensureCompany();
      const adapterConfig =
        adapterConfigOverride
        ?? buildCoachAdapterConfig({
          adapterType,
          model,
          url,
          forceUnsetAnthropicApiKey,
        });
      const result = await agentsApi.testEnvironment(id, adapterType, {
        adapterConfig,
      });
      setAdapterEnvResult(result);
      return result;
    } catch (err) {
      setAdapterEnvError(
        err instanceof Error ? err.message : "Adapter environment test failed",
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);
    try {
      const configWithUnset = buildCoachAdapterConfig({
        adapterType,
        model,
        url,
        forceUnsetAnthropicApiKey: true,
      });
      const result = await runTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset, but the environment test is still failing.",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry.",
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  async function handleStart() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id, issuePrefix } = await ensureCompany();

      // Test must pass (or warn) before we commit to hiring. If the user
      // didn't run it explicitly, run it now.
      const result = adapterEnvResult ?? (await runTest());
      if (!result) {
        // runTest sets adapterEnvError; surface it on the Start button row too.
        if (!adapterEnvError) {
          setError("Couldn't reach the adapter to test it. Try again.");
        }
        return;
      }
      if (result.status === "fail") {
        setError(
          "Adapter environment test failed. Fix the issues above before continuing.",
        );
        return;
      }

      const adapterConfig = buildCoachAdapterConfig({
        adapterType,
        model,
        url,
        forceUnsetAnthropicApiKey,
      });
      const hire = await agentsApi.hire(id, {
        name: "Coach",
        role: "coach",
        adapterType,
        adapterConfig,
        runtimeConfig: buildNewAgentRuntimeConfig(),
      });
      const agentId = hire.agent.id;
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(id) });

      const project = await projectsApi.create(id, {
        name: ONBOARDING_PROJECT_NAME,
        status: "in_progress",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(id) });

      const issue = await issuesApi.create(
        id,
        buildOnboardingIssuePayload({
          title: COACH_ISSUE_TITLE,
          description: COACH_ISSUE_DESCRIPTION,
          assigneeAgentId: agentId,
          projectId: project.id,
          goalId: null,
        }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(id) });

      const issueRef =
        (issue as { identifier?: string; id: string }).identifier ?? issue.id;
      navigate(`/${issuePrefix}/onboarding/chat/${issueRef}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start onboarding");
    } finally {
      setSubmitting(false);
    }
  }

  const startDisabled = submitting || adapterEnvLoading;
  const startLabel = submitting
    ? "Starting…"
    : testPassed
      ? "Start with a Coach"
      : adapterEnvResult?.status === "fail"
        ? "Fix issues above"
        : "Test & start with a Coach";

  return (
    <OnboardingChrome showAnimation={true}>
      <div className="w-full max-w-md mx-auto my-auto px-8 py-12 space-y-4">
        <OnboardingStepTabs
          items={COACH_STEP_TABS.map((item) =>
            item.id === "chat" ? { ...item, disabled: true } : item,
          )}
          activeId="configure"
        />
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Talk to a Coach</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We'll spin up a Coach agent and start a conversation. The Coach helps you
            figure out what your company should focus on by asking a handful of questions,
            then proposes a name and mission you can accept or refine. When you're ready,
            the Coach becomes your CEO.
          </p>

          <div className="mt-5">
            <AdapterStepFields
              companyId={companyId}
              adapterType={adapterType}
              onAdapterTypeChange={handleAdapterTypeChange}
              model={model}
              onModelChange={setModel}
              url={url}
              onUrlChange={setUrl}
              envResult={adapterEnvResult}
              envError={adapterEnvError}
              envLoading={adapterEnvLoading}
              onRunProbe={() => {
                void runTest();
              }}
              forceUnsetAnthropicApiKey={forceUnsetAnthropicApiKey}
              unsetAnthropicLoading={unsetAnthropicLoading}
              onUnsetAnthropicApiKey={handleUnsetAnthropicApiKey}
              effectiveAdapterCommand={effectiveAdapterCommand}
              enabled={!submitting}
            />
            {!adapterEnvResult ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                We'll verify your adapter can reach a model before starting. Test
                runs automatically when you click Start, or trigger it now.
              </p>
            ) : null}
          </div>

          <div className="mt-5">
            <Button onClick={handleStart} disabled={startDisabled}>
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  {startLabel}
                </>
              ) : (
                startLabel
              )}
            </Button>
          </div>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </div>
        <p className="text-xs text-muted-foreground text-center">
          Want a form-based setup instead?{" "}
          <Link to="/onboarding/classic" className="underline">
            Switch to classic onboarding
          </Link>
          .
        </p>
      </div>
    </OnboardingChrome>
  );
}
