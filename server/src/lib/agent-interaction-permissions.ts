import { isDeepStrictEqual } from "node:util";
import { forbidden } from "../errors.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const message = "Use PATCH /api/agents/:id/interaction-permissions to change interaction permissions";

export function preserveAgentInteractionPermissions(existing: unknown, incoming: unknown): Record<string, unknown> {
  const previous = record(existing), next = { ...record(incoming) };
  if (Object.hasOwn(next, "interactions") && !isDeepStrictEqual(next.interactions, previous.interactions)) {
    throw forbidden(message, { code: "agent_interaction_permissions_separate_endpoint" });
  }
  if (Object.hasOwn(previous, "interactions")) next.interactions = previous.interactions;
  else delete next.interactions;
  return next;
}

export function assertNoInitialAgentInteractionPermissions(permissions: unknown) {
  if (Object.hasOwn(record(permissions), "interactions")) {
    throw forbidden(message, { code: "agent_interaction_permissions_separate_endpoint" });
  }
}
