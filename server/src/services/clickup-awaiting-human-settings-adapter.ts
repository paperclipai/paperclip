import { unprocessable } from "../errors.js";

export interface ClickUpAwaitingHumanProviderConfigInput {
  workspaceId: string | null;
  channelId: string | null;
}

function trimNullable(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeClickUpAwaitingHumanProviderConfig(
  input: ClickUpAwaitingHumanProviderConfigInput | null | undefined,
): ClickUpAwaitingHumanProviderConfigInput | null {
  if (!input) return null;
  return {
    workspaceId: trimNullable(input.workspaceId),
    channelId: trimNullable(input.channelId),
  };
}

export function validateClickUpAwaitingHumanProviderConfig(input: {
  enabled: boolean;
  providerConfig: ClickUpAwaitingHumanProviderConfigInput | null;
}) {
  if (!input.enabled) return;
  const config = normalizeClickUpAwaitingHumanProviderConfig(input.providerConfig);
  if (!config?.workspaceId) {
    throw unprocessable("ClickUp awaiting-human settings require a workspace ID when enabled");
  }
  if (!config.channelId) {
    throw unprocessable("ClickUp awaiting-human settings require a channel ID when enabled");
  }
}
