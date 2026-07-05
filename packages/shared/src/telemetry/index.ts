export { TelemetryClient } from "./client.js";
export { resolveTelemetryConfig } from "./config.js";
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
