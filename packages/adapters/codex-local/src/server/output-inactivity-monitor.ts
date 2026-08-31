// The monitor itself is adapter-agnostic and now lives in adapter-utils so
// opencode-local can arm the same watchdog. This module keeps the Codex-named
// spelling its call sites and tests already use.
export {
  createOutputInactivityMonitor as createCodexOutputInactivityMonitor,
  DEFAULT_OUTPUT_INACTIVITY_TIMEOUT_MS as DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS,
  formatOutputInactivityMonitorErrorMessage,
  OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS as CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  resolveOutputInactivityTimeout as resolveCodexInactivityTimeout,
} from "@paperclipai/adapter-utils/output-inactivity-monitor";
export type {
  OutputInactivityMonitorHandle as CodexOutputInactivityMonitorHandle,
  OutputInactivityMonitorOptions as CodexOutputInactivityMonitorOptions,
  OutputInactivityMonitorResolution as CodexOutputInactivityMonitorResolution,
  OutputInactivityMonitorState as CodexOutputInactivityMonitorState,
} from "@paperclipai/adapter-utils/output-inactivity-monitor";
