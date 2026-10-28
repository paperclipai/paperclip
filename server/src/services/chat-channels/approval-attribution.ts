import { parseTelegramApprovalActor } from "./telegram/approval-attribution.js";

export function resolveIntegrationApprovalActor(value: unknown): string | null {
  return parseTelegramApprovalActor(value);
}
