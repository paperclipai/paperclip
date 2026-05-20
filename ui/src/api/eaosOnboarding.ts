// LET-514 — Typed client for the EAOS onboarding Slack endpoints.
//
//   - `slackInstallPreview` (POST): returns the read-only safe-install preview.
//     The endpoint is read-only on the server side; the body is intentionally
//     empty so the client surface stays minimal and the UI cannot accidentally
//     forward user-typed credentials.
//   - `slackConnection` (GET): returns the truthful, server-derived Slack
//     connection state for this company. The UI uses this as the source of
//     truth for the "Connected" / "Pending approval" / etc. badges — it never
//     fabricates a "connected" reading from a preview fetch alone.

import { api } from "./client";

export const SLACK_CONNECTION_STATES = [
  "not_connected",
  "pending_approval",
  "applying",
  "connected",
  "partial",
  "error",
] as const;

export type SlackConnectionState = (typeof SLACK_CONNECTION_STATES)[number];

export interface SlackInstallPreviewMcpChangeDto {
  readonly kind: "add";
  readonly serverId: string;
  readonly displayName: string;
  readonly catalogId: "verified/slack-app";
  readonly transport: "stdio" | "streamable_http" | "sse";
  readonly riskClass: "external-write";
  readonly requiredSecretNames: readonly string[];
  readonly readOnlyHint: false;
  readonly destructiveHint: false;
  readonly openWorldHint: true;
}

export interface SlackInstallPreviewDto {
  readonly catalogId: "verified/slack-app";
  readonly displayName: string;
  readonly summary: string;
  readonly scopeSummary: readonly string[];
  readonly requiredSecretNames: readonly string[];
  readonly missingRequiredSecretRefs: readonly string[];
  readonly riskClass: "external-write";
  readonly liveApply: false;
  readonly applyPath: "preview_only";
  readonly mcpServerChange: SlackInstallPreviewMcpChangeDto;
}

export interface SlackInstallPreviewResponse {
  readonly preview: SlackInstallPreviewDto;
  readonly allowlistedCatalogId: "verified/slack-app";
  readonly approvalCardPath: string | null;
  readonly approvalCardAgentId: string | null;
  readonly liveApplyEnabled: false;
  readonly connectionState: SlackConnectionState;
}

export interface SlackConnectionResponse {
  readonly state: SlackConnectionState;
  readonly planId: string | null;
  readonly approvalId: string | null;
  readonly lastUpdatedAt: string | null;
  readonly approvalCardPath: string | null;
  readonly approvalCardAgentId: string | null;
  readonly requiredSecretNames: readonly string[];
  readonly liveApplyEnabled: false;
}

export const eaosOnboardingApi = {
  slackInstallPreview: (companyId: string) =>
    api.post<SlackInstallPreviewResponse>(
      `/companies/${companyId}/eaos/onboarding/slack-install-preview`,
      {},
    ),
  slackConnection: (companyId: string) =>
    api.get<SlackConnectionResponse>(
      `/companies/${companyId}/eaos/onboarding/slack-connection`,
    ),
};
