import {
  isExperimentalFeatureEnabled,
  isPaperclipExperimentalModeEnabled,
  type CompanyExperimentalFeaturesConfig,
} from "@paperclipai/shared";
import { isDevelopmentEnvironment } from "../development-environment.js";

export type CustomProcessTriggerEvent =
  | "manual"
  | "unauthenticated_session_started"
  | "primary_agent_unavailable"
  | "task_created"
  | "task_completed";

export interface CustomProcessInstructionConfig {
  enabled?: boolean;
  instructions?: string;
  triggers?: Array<{
    event: CustomProcessTriggerEvent;
    enabled?: boolean;
  }>;
}

export interface CustomProcessTriggerInput {
  event: CustomProcessTriggerEvent;
  companyExperimentalFeatures?: CompanyExperimentalFeaturesConfig | null;
  customProcess?: CustomProcessInstructionConfig | null;
  environmentExperimentalModeEnabled?: boolean;
  isDevelopmentEnvironment?: boolean;
}

export interface CustomProcessTriggerResult {
  triggered: boolean;
  reason: "disabled" | "missing_config" | "not_configured" | "triggered";
  instructions?: string;
}

function isCustomProcessTriggersEnabled(input: CustomProcessTriggerInput): boolean {
  return isExperimentalFeatureEnabled({
    feature: "custom_process_triggers",
    environmentExperimentalModeEnabled:
      input.environmentExperimentalModeEnabled ?? isPaperclipExperimentalModeEnabled(process.env),
    isDevelopmentEnvironment: input.isDevelopmentEnvironment ?? isDevelopmentEnvironment(),
    companyEnabledFeatures: input.companyExperimentalFeatures?.enabledFeatures,
  });
}

export class CustomProcessTriggerService {
  async trigger(input: CustomProcessTriggerInput): Promise<CustomProcessTriggerResult> {
    if (!isCustomProcessTriggersEnabled(input)) return { triggered: false, reason: "disabled" };
    const customProcess = input.customProcess;
    if (!customProcess) return { triggered: false, reason: "missing_config" };
    if (customProcess.enabled !== true) return { triggered: false, reason: "disabled" };

    const trigger = customProcess.triggers?.find((item) => item.event === input.event);
    if (customProcess.triggers && (!trigger || trigger.enabled === false)) {
      return { triggered: false, reason: "not_configured" };
    }

    return {
      triggered: true,
      reason: "triggered",
      instructions: customProcess.instructions,
    };
  }
}
