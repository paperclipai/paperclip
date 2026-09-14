const messages = {
  registration_unavailable: "This provider cannot verify an existing process for managed relaunch yet. Start new services with services_start.",
  process_ownership_unverified: "Paperclip could not verify this PID as the active run’s original command process-group leader. Use the OS PID of the start command, not a child listener or an opaque session ID. Leave the original start command running and retry registration. Otherwise stop that command yourself and use services_start. The original process was not changed.",
  process_handoff_unverified: "Paperclip could not confirm a safe stop of the original command. Its process identity or group changed. Inspect the original run, stop its command, and retry Stop before starting the managed service. The retained files are unchanged.",
  supervisor_lost: "The service supervisor's identity record is missing. Repair the retained environment before restarting; Paperclip cannot safely identify the old process.",
  unsupported_platform: "Managed local services require a POSIX execution host.",
  port_in_use: "The requested port is already in use. Stop the conflicting listener or choose another service port.",
  launch_unavailable: "The service working directory or executable is unavailable. Check its retained files and launch command before retrying.",
  credentials_unavailable: "The service's launch credentials are unavailable or no longer authorized. Update its environment bindings before retrying.",
  retention_unavailable: "Service data retention could not be verified. Check the provider connection before starting the service.",
  provider_connection_changed: "The provider connection changed while this service's allocation was pending. Restore the original connection before retrying so Paperclip can recover that sandbox.",
  resource_configuration_mismatch: "The sandbox's CPU, memory, disk, or GPU allocation could not be verified against its environment settings. Check the configured image or snapshot size and provider support before starting again. Retained files remain protected.",
} as const;

/** Only allowlisted product messages cross from provider failures to the UI. */
export class RuntimeServiceFault extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); }
}

export function runtimeServiceFailureMessage(error: unknown): string {
  if (error instanceof RuntimeServiceFault) return error.message;
  const failure = error as { code?: unknown; status?: unknown } | null;
  if (failure?.code === "EADDRINUSE") return messages.port_in_use;
  if (failure?.code === "ENOENT") return messages.launch_unavailable;
  if (failure?.status === 401 || failure?.status === 403) return messages.credentials_unavailable;
  return "Service operation failed. Inspect its logs and retry the action.";
}
