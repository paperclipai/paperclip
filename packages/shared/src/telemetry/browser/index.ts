export { BrowserTelemetryClient } from "./client.js";
export { loadOrCreateBrowserState, saveBrowserState } from "./state.js";
export {
  setBrowserTelemetryTracker,
  getBrowserTelemetryTracker,
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
  trackProjectCreated,
  trackRoutineCreated,
  trackRoutineRun,
  trackTaskCreated,
  trackTaskStatusChanged,
  trackTaskCompleted,
  trackTaskBlocked,
  trackTaskReopened,
  trackProductFirstTaskCompleted,
  trackGoalCreated,
  trackAgentCreated,
  trackSkillImported,
  trackSkillInvoked,
  trackInteractionCreated,
  trackInteractionResolved,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackErrorHandlerCrash,
} from "./events.js";
export type { BrowserTelemetryTracker } from "./events.js";
export type {
  TelemetryConfig,
  TelemetryDimensions,
  TelemetryState,
  TelemetryEvent,
  TelemetryEventEnvelope,
  TelemetryEventName,
} from "../types.js";
