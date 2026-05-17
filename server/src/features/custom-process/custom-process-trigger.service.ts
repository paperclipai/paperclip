import { isDevelopmentEnvironment } from "../development-environment.js";

export type CustomProcessTriggerEvent =
  | "manual"
  | "unauthenticated_session_started"
  | "primary_agent_unavailable"
  | "task_created"
  | "task_completed";

export interface CustomProcessTriggerConfig {
  event: CustomProcessTriggerEvent;
  enabled?: boolean;
  label?: string;
}

export interface CustomProcessInstructionConfig {
  enabled?: boolean;
  label?: string;
  instructions?: string;
  triggers?: CustomProcessTriggerConfig[];
}

export interface CustomProcessOrganizationConfig {
  customProcess?: CustomProcessInstructionConfig;
}

export interface CustomProcessTriggerInput {
  event: CustomProcessTriggerEvent;
  context?: Record<string, unknown>;
  organizationConfig?: CustomProcessOrganizationConfig | null;
}

export interface CustomProcessTriggerResult {
  triggered: boolean;
  reason: "disabled" | "missing_config" | "not_configured" | "triggered";
  instructions?: string;
}

export class CustomProcessTriggerService {
  async trigger(input: CustomProcessTriggerInput): Promise<CustomProcessTriggerResult> {
    if (!isDevelopmentEnvironment()) return { triggered: false, reason: "disabled" };
    const customProcess = input.organizationConfig?.customProcess;
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

export const customProcessTriggerService = new CustomProcessTriggerService();
