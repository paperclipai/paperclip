import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import { AGENT_ROLES, type AdapterEnvironmentTestResult, type AgentPermissions } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Shield } from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import {
  AgentConfigForm,
  AdapterEnvironmentResult,
  AdapterLoginPanel,
  type AdapterLoginDescriptor,
  type CreateConfigValues,
} from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { buildFixedClaudeOAuthBinding } from "../components/environment-variables-editor/model";
import type { EnvBinding } from "@paperclipai/shared";
import { getUIAdapter } from "../adapters";
import {
  useAdapterRegistryLoaded,
  useDisabledAdaptersSync,
} from "../adapters/use-disabled-adapters";
import { isValidAdapterType } from "../adapters/metadata";
import { ReportsToPicker } from "../components/ReportsToPicker";
import { buildNewAgentHirePayload } from "../lib/new-agent-hire-payload";
import { TrustPresetSection } from "../components/TrustPresetSection";
import { buildPermissionsForTrustPreset, getTrustPreset } from "../lib/trust-policy-ui";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_AGY_LOCAL_MODEL } from "@paperclipai/adapter-agy-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, adapterType };
  if (adapterType === "codex_local") {
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "agy_local") {
    nextValues.model = DEFAULT_AGY_LOCAL_MODEL;
  } else if (adapterType === "gemini_local") {
    nextValues.model = DEFAULT_GEMINI_LOCAL_MODEL;
  } else if (adapterType === "kimi_local") {
    nextValues.model = DEFAULT_KIMI_LOCAL_MODEL;
  } else if (adapterType === "cursor") {
    nextValues.model = DEFAULT_CURSOR_LOCAL_MODEL;
  } else if (adapterType === "opencode_local") {
    nextValues.model = DEFAULT_OPENCODE_LOCAL_MODEL;
  }
  return nextValues;
}
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "New agent" },
    ]);
  }, [setBreadcrumbs]);
  return <NewAgentSetup />;
}
