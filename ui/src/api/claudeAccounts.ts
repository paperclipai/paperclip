import type { ClaudeAccountsUsageResponse } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Multi-account Claude subscription usage (TWX-1117). Board-gated instance routes.
 *
 * `usage()` returns the persisted per-profile snapshots without a network probe;
 * `usage({ refresh: true })` re-probes every profile on the host (rate-limited
 * server-side) before returning. Neither call changes the host's active auth.
 */
export const claudeAccountsApi = {
  usage: (opts?: { refresh?: boolean }) =>
    api.get<ClaudeAccountsUsageResponse>(
      `/instance/claude-accounts/usage${opts?.refresh ? "?refresh=1" : ""}`,
    ),
};
