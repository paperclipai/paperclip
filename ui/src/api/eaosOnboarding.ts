// LET-514 — Typed client for the EAOS onboarding Slack safe install preview.
//
// Calls `POST /api/companies/:companyId/eaos/onboarding/slack-install-preview`.
// The endpoint is read-only on the server side; the body is intentionally
// empty so the client surface stays minimal and the UI cannot accidentally
// forward user-typed credentials.

import { api } from "./client";

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
}

export const eaosOnboardingApi = {
  slackInstallPreview: (companyId: string) =>
    api.post<SlackInstallPreviewResponse>(
      `/companies/${companyId}/eaos/onboarding/slack-install-preview`,
      {},
    ),
};
