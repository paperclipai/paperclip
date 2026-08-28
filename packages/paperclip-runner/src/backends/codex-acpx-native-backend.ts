import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import {
  CodexAcpxDriver,
  type CodexAcpxDriverOptions,
} from "../drivers/acpx/codex-acpx-driver.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import {
  nativeSystemInstructions,
  nativeTaskConstraints,
} from "./runtime-context.js";

export interface CodexAcpxNativeSessionBackendOptions extends Omit<
  CodexAcpxDriverOptions,
  "model" | "permissionMode" | "systemInstructions"
> {}

/**
 * Constructs the qualified Codex ACPX backend. Other ACPX agents remain
 * unavailable until their runtime, policy, and conformance slices ship.
 */
export function createCodexAcpxNativeSessionBackend(
  input: NativeExecutionInput,
  options: CodexAcpxNativeSessionBackendOptions,
): NativeSessionBackend {
  if (input.provider.kind !== "acpx" || input.provider.agent !== "codex") {
    throw new Error(
      "Codex ACPX backend requires provider kind acpx with agent codex",
    );
  }
  const qualifiedProfile = resolveQualifiedAcpxProfile(
    "codex",
    input.provider.model,
  );
  for (const field of [
    "driverKind",
    "protocolVersion",
    "acpxVersion",
    "agent",
    "agentProfileVersion",
    "agentServerPackage",
    "agentServerVersion",
    "agentRuntimePackage",
    "agentRuntimeVersion",
    "commandDigest",
  ] as const) {
    if (input.provider.profile[field] !== qualifiedProfile[field]) {
      throw new Error(
        `Persisted Codex ACPX profile does not match the qualified ${field}`,
      );
    }
  }

  const constraints = nativeTaskConstraints(input);
  const systemInstructions = [
    nativeSystemInstructions(input),
    "",
    "Paperclip Runner constraints:",
    ...constraints.map((constraint) => `- ${constraint}`),
  ].join("\n");

  return new HarnessDriverBackend(
    new CodexAcpxDriver({
      ...options,
      model: input.provider.model,
      permissionMode: input.provider.permissionMode ?? "approve-reads",
      systemInstructions,
    }),
  );
}
