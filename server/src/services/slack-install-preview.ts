// LET-514 — Slack safe install preview.
//
// Returns a server-built, fail-closed description of what installing the
// Slack MCP capability *would* look like, for the EAOS onboarding "Connect
// Slack" card.
//
// Safety:
//   - Read-only. No DB writes, no plan rows, no outbound network.
//   - Secret-blind. No raw tokens, OAuth codes, or signing values flow
//     through this code path. The preview surfaces only env-style secret
//     *names* and OAuth scope identifiers.
//   - Allowlist-gated. The catalog id (`verified/slack-app`) starts with the
//     `verified/` prefix that `DefaultCatalogAllowlist` (LET-402) accepts,
//     and is re-exported here so the route + UI agree on the contract. No
//     non-allowlisted catalog id can ever be returned from this builder.

export const SLACK_VERIFIED_CATALOG_ID = "verified/slack-app";

export const SLACK_REQUIRED_SECRET_NAMES = [
  "SLACK_APP_CLIENT_ID",
  "SLACK_APP_CLIENT_SECRET",
  "SLACK_APP_SIGNING_SECRET",
] as const;

export const SLACK_OAUTH_SCOPES = [
  "chat:write",
  "channels:read",
  "channels:history",
  "users:read",
] as const;

export interface SlackInstallPreviewMcpChange {
  readonly kind: "add";
  readonly serverId: string;
  readonly displayName: string;
  readonly catalogId: typeof SLACK_VERIFIED_CATALOG_ID;
  readonly transport: "stdio";
  readonly riskClass: "external-write";
  readonly requiredSecretNames: readonly string[];
  readonly readOnlyHint: false;
  readonly destructiveHint: false;
  readonly openWorldHint: true;
}

export interface SlackInstallPreview {
  readonly catalogId: typeof SLACK_VERIFIED_CATALOG_ID;
  readonly displayName: string;
  readonly summary: string;
  readonly scopeSummary: readonly string[];
  readonly requiredSecretNames: readonly string[];
  readonly riskClass: "external-write";
  readonly liveApply: false;
  readonly applyPath: "preview_only";
  readonly mcpServerChange: SlackInstallPreviewMcpChange;
}

/**
 * Build the customer-facing Slack install preview. Output is deterministic
 * and contains only allowlisted strings (catalog id, env-style secret names,
 * scope identifiers). No user input flows through this function — the EAOS
 * onboarding route does not accept any caller-provided fields beyond the
 * URL path companyId, which is authorization-checked separately.
 */
export function buildSlackInstallPreview(): SlackInstallPreview {
  return {
    catalogId: SLACK_VERIFIED_CATALOG_ID,
    displayName: "Slack",
    summary:
      "Preview only — installs the verified Slack capability. No tokens are collected here; the approval card resolves the named secret references from your vault before the install is applied.",
    scopeSummary: [...SLACK_OAUTH_SCOPES],
    requiredSecretNames: [...SLACK_REQUIRED_SECRET_NAMES],
    riskClass: "external-write",
    liveApply: false,
    applyPath: "preview_only",
    mcpServerChange: {
      kind: "add",
      serverId: "slack",
      displayName: "Slack",
      catalogId: SLACK_VERIFIED_CATALOG_ID,
      transport: "stdio",
      riskClass: "external-write",
      requiredSecretNames: [...SLACK_REQUIRED_SECRET_NAMES],
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  };
}
