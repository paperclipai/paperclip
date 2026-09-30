import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import {
  CodexAcpxDriver,
  type CodexAcpxDriverOptions,
} from "../drivers/acpx/codex-acpx-driver.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { ACPX_CAPABILITY_PROFILES } from "../drivers/acpx/capability-profiles.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import {
  nativeSystemInstructions,
  nativeTaskConstraints,
} from "./runtime-context.js";

export interface CodexAcpxNativeSessionBackendOptions extends Omit<
  CodexAcpxDriverOptions,
  "model" | "permissionMode" | "systemInstructions" | "providerPolicy"
> {}

export type AcpxNativeSessionBackendOptions =
  CodexAcpxNativeSessionBackendOptions;

/**
 * Constructs a backend only after the persisted ACPX snapshot matches the
 * closed, package-owned qualification profile for its selected agent.
 */
export function createAcpxNativeSessionBackend(
  input: NativeExecutionInput,
  options: AcpxNativeSessionBackendOptions,
): NativeSessionBackend {
  if (input.provider.kind !== "acpx") {
    throw new Error("ACPX backend requires provider kind acpx");
  }
  const qualifiedProfile = resolveQualifiedAcpxProfile(
    input.provider.agent,
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
        `Persisted ${input.provider.agent} ACPX profile does not match the qualified ${field}`,
      );
    }
  }

  if (ACPX_CAPABILITY_PROFILES[input.provider.agent].qualification !== "qualified") {
    throw new Error("ACPX candidate direct execution requires completed qualification; use the host-controlled runnerd evaluation path");
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
      agent: input.provider.agent,
      model: input.provider.model,
      permissionMode: input.provider.permissionMode ?? "approve-reads",
      systemInstructions,
      providerPolicy: { readOnly: "executionMode" in input && input.executionMode === "plan" },
    }),
  );
}

/** Backward-compatible Codex-specific constructor. */
export function createCodexAcpxNativeSessionBackend(
  input: NativeExecutionInput,
  options: CodexAcpxNativeSessionBackendOptions,
): NativeSessionBackend {
  if (input.provider.kind !== "acpx" || input.provider.agent !== "codex") {
    throw new Error(
      "Codex ACPX backend requires provider kind acpx with agent codex",
    );
  }
  return createAcpxNativeSessionBackend(input, options);
}
