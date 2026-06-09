import { unprocessable } from "../errors.js";

export interface ClickUpAwaitingHumanProviderConfigInput {
  workspaceId: string | null;
  channelId: string | null;
  attachmentTaskId: string | null;
  primaryReviewerUserId?: string | null;
  secondaryReviewerUserId?: string | null;
}

function trimNullable(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeClickUpAttachmentTaskId(value: string | null | undefined): string | null {
  const trimmed = trimNullable(value);
  if (!trimmed) return null;
  if (!trimmed.includes("clickup.com") && !trimmed.startsWith("http")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const taskMarkerIndex = parts.indexOf("t");
    if (taskMarkerIndex >= 0) {
      const taskId = parts.at(-1)?.trim();
      if (taskId) return taskId;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function normalizeClickUpAwaitingHumanProviderConfig(
  input: ClickUpAwaitingHumanProviderConfigInput | null | undefined,
): ClickUpAwaitingHumanProviderConfigInput | null {
  if (!input) return null;
  return {
    workspaceId: trimNullable(input.workspaceId),
    channelId: trimNullable(input.channelId),
    attachmentTaskId: normalizeClickUpAttachmentTaskId(input.attachmentTaskId),
    primaryReviewerUserId: trimNullable(input.primaryReviewerUserId ?? null),
    secondaryReviewerUserId: trimNullable(input.secondaryReviewerUserId ?? null),
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
}
