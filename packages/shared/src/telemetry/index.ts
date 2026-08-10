export { TelemetryClient } from "./client.js";
export { resolveTelemetryConfig, resolveCaps, TELEMETRY_DEFAULTS } from "./config.js";
export type { TelemetryConfigOverrides } from "./config.js";
export { loadOrCreateState } from "./state.js";
export {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
  trackProjectCreated,
  trackRoutineCreated,
  trackRoutineRun,
  trackGoalCreated,
  trackAgentCreated,
  trackSkillImported,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackErrorHandlerCrash,
  trackInteractionResolved,
} from "./events.js";
export type {
  TelemetryConfig,
  TelemetryBackoffConfig,
  TelemetryState,
  TelemetryEvent,
  TelemetryEventEnvelope,
  TelemetryDimensions,
  TelemetryDimensionValue,
  TelemetryEventDimensions,
  TelemetryEventName,
  RegisteredPluginEventName,
} from "./types.js";
export type {
  AnyPaperclipTelemetryEvent,
  EventDimensionsMap,
  PaperclipEventName,
} from "./generated/paperclip-telemetry.js";
export { EVENT_RETENTION_CLASS, RETENTION_DAYS } from "./retention.js";
export type { RetentionClass } from "./retention.js";
