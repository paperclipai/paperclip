// Inlined English strings for the Connections page.
//
// Rationale: the rest of the UI hardcodes English copy and there is no i18n
// loader in this repo. Keeping the strings centralised here means a future
// migration to a real i18n library only has to swap this module rather than
// touch the components. See also: docs/superpowers/plans/2026-05-09-oauth-backbone-plan.md
// (Task 39 — note about adapting the plan to the project's lack of i18n).

export const connectionsStrings = {
  title: "Connections",
  subtitle: "Authorize Paperclip agents to act in third-party services.",
  connect: "Connect",
  manage: "Manage",
  reconnect: "Reconnect",
  refreshNow: "Refresh now",
  disconnect: "Disconnect",
  stateConnected: "Connected",
  stateRevoked: "Revoked — reconnect to use",
  stateRefreshFailed: "Last refresh failed",
  memberCannotConnect: (provider: string) => `Ask an admin to connect ${provider}`,
  noProvidersTitle: "No providers configured",
  noProvidersBody:
    "An administrator must register OAuth client credentials before connections can be created.",
  toastConnected: (provider: string) => `Connected to ${provider}`,
  toastError: (error: string) => `Failed to connect: ${error}`,
} as const;
