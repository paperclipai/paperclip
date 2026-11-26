import type { Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { museExternalAgents } from "./muse.js";

export type ExternalRunAuthorizingUser =
  | { status: "none" }
  | { status: "authorized"; userId: string }
  | { status: "unavailable" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Resolve the pinned external authorizer for an external-agent run, failing closed if missing or revoked. */
export async function resolveExternalRunAuthorizingUser(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    driverKind?: string | null;
    runnerProfileJson?: unknown;
  },
): Promise<ExternalRunAuthorizingUser> {
  const execution = record(record(input.runnerProfileJson).nativeExecutionInput);
  const provider = record(execution.provider);
  const isMuse = input.driverKind === "muse_external"
    || execution.schema === "paperclip.native-execution-input.v8"
    || provider.kind === "muse";
  if (!isMuse) return { status: "none" };
  const binding = record(provider.binding);
  if (
    binding.companyId !== input.companyId ||
    binding.agentId !== input.agentId ||
    typeof binding.bindingId !== "string" ||
    typeof binding.bindingGeneration !== "number"
  ) {
    return { status: "unavailable" };
  }
  try {
    const userId = await museExternalAgents(db).authorizingUserIdForBinding({
      companyId: binding.companyId,
      agentId: binding.agentId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
    });
    return { status: "authorized", userId };
  } catch (error) {
    if (error instanceof HttpError) return { status: "unavailable" };
    throw error;
  }
}
