import { z } from "zod";
import type { AiManagedConnectionSummary } from "./ai-connections.js";
import type { DecisionUsage } from "./decision-models.js";

export const PROMPT_INJECTION_DEFAULT_MODEL = "openai/gpt-oss-safeguard-20b";
export const PROMPT_INJECTION_DEADLINE_MS = 10_000;
export const PROMPT_INJECTION_MAX_REQUEST_BYTES = 256 * 1024;
export const PROMPT_INJECTION_MAX_OUTPUT_TOKENS = 4096;
export const PROMPT_INJECTION_POLICY_VERSION = "tool-result-v1";
export const promptInjectionFindingSchema = z.enum([
  "ignore_previous_instructions", "reveal_system_prompt", "instruction_hijack", "secret_exfiltration",
]);
export type PromptInjectionFinding = z.infer<typeof promptInjectionFindingSchema>;
export const promptInjectionVerdictSchema = z.object({
  violation: z.boolean(),
  findings: z.array(promptInjectionFindingSchema).max(4),
}).strict().refine(v => v.violation === (v.findings.length > 0) && new Set(v.findings).size === v.findings.length,
  { message: "Findings must be unique and agree with the verdict" });
export type PromptInjectionVerdict = z.infer<typeof promptInjectionVerdictSchema>;
export const updatePromptInjectionPreventionSchema = z.object({
  enabled: z.boolean(),
  connectionId: z.string().uuid().nullable(),
  grantId: z.string().uuid().nullable(),
  model: z.string().trim().min(1).max(256).refine(v => !v.startsWith("openrouter/"),
    { message: "Use an OpenRouter API model ID without the openrouter/ prefix" }),
}).strict().refine(v => Boolean(v.connectionId) === Boolean(v.grantId) && (!v.enabled || Boolean(v.connectionId)),
  { message: "Choose a shared OpenRouter connection before enabling model checks" });
export type UpdatePromptInjectionPrevention = z.infer<typeof updatePromptInjectionPreventionSchema>;
export interface PromptInjectionPreventionSettings extends UpdatePromptInjectionPrevention { companyId: string }
export interface PromptInjectionPreventionSettingsResponse {
  canManage: boolean;
  settings: PromptInjectionPreventionSettings | null;
  choices: AiManagedConnectionSummary[];
}
export type PromptInjectionFallbackReason =
  | "not_configured" | "disabled" | "access_denied" | "connection_unavailable" | "incompatible_connection"
  | "budget_blocked" | "input_too_large" | "input_redaction_mismatch" | "timeout" | "provider_auth_failed" | "provider_rate_limited"
  | "provider_failed" | "invalid_output" | "interrupted";
export type PromptInjectionModelOutcome =
  | { status: "classified"; violation: boolean; findings: PromptInjectionFinding[]; model: string; invocationId: string; policyVersion: string }
  | { status: "unavailable" | "failed"; reason: PromptInjectionFallbackReason; model?: string; invocationId?: string };
export interface PromptInjectionDetectorMetadata {
  detector: "model" | "regex";
  model?: string;
  invocationId?: string;
  policyVersion?: string;
  fallbackReason?: PromptInjectionFallbackReason;
}
export interface PromptInjectionTestSample {
  name: string;
  expectedViolation: boolean;
  actualViolation: boolean | null;
  passed: boolean;
  durationMs: number;
  invocationId?: string;
  usage?: DecisionUsage;
  reason?: PromptInjectionFallbackReason;
}
export interface PromptInjectionTestResult { passed: boolean; samples: PromptInjectionTestSample[] }
