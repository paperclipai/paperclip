import type { LifecycleFailure } from "./ports.js";

// Only fixed text may leave this boundary. Provider errors can contain secrets.
const reasons = {
  harness_test_failed: "The execution test did not pass. Open Configuration and run the agent test to inspect the failed checks.",
  harness_auth_failed: "Authentication failed. Check the agent's AI connection or sign in to its execution tool, then retry.",
  harness_model_unavailable: "The selected model is unavailable. Choose a model supported by the agent's AI connection in Configuration, then retry.",
  harness_command_unavailable: "The execution command was not found. Check the command and its installation in the agent's environment, then retry.",
  harness_cwd_invalid: "The working directory is unavailable. Check the working directory in Configuration, then retry.",
  harness_probe_timed_out: "The execution test timed out. Paperclip will retry automatically. If this continues, run the agent test in Configuration.",
  harness_probe_unexpected_output: "The execution test did not return the expected response. Run the agent test in Configuration to inspect the failed checks.",
  test_environment_unavailable: "The test environment is unavailable. Check the agent's environment in Configuration. Paperclip will retry automatically.",
  required_plugin_unavailable: "A required plugin is unavailable. Check the plugin's status in Settings. Paperclip will retry automatically.",
  invalid_lifecycle_result: "A required plugin returned an invalid result. Check the plugin's status in Settings. Paperclip will retry automatically.",
} as const;

const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "40001", "40P01", "53300", "57P01"]);

export function lifecycleFailureCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return [candidate?.code, candidate?.cause?.code].find((code): code is string =>
    typeof code === "string" && (Object.hasOwn(reasons, code) || transientCodes.has(code)));
}

export function lifecycleFailureMessage(context: LifecycleFailure, error: unknown): string {
  const phases = {
    preparing: "Agent preparation", verifying: "Execution configuration check", pausing: "Stopping agent execution",
    resuming: "Starting agent resources", terminating: "Stopping agent execution", cleaning_up: "Agent resource cleanup",
  };
  const phase = context.phase && Object.hasOwn(phases, context.phase)
    ? phases[context.phase as keyof typeof phases] : "Agent setup";
  const step = context.stage === "plugin" ? `${phase}: required plugin step`
    : context.stage === "select_plugins" ? `${phase}: finding required plugins`
    : ["save_plugins", "complete_host", "complete_plugin", "transition"].includes(context.stage)
      ? `${phase}: saving progress` : phase;
  const code = lifecycleFailureCode(error);
  const reason = code && Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons]
    : "Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
  return `${step} failed. ${reason}`;
}
