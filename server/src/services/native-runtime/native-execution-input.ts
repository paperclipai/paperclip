import type {
  NativeExecutionInputV1,
  NativeInteractionResponseEnvelope,
  StrictCompletionContractInput,
} from "../../vendor/paperclip-runner/index.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Closed constructor: callers cannot spread legacy context or environment data. */
export function buildNativeExecutionInput(input: {
  companyId: string;
  runId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    workMode: string;
  };
  agentId: string;
  workspace: {
    id: string;
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  normalizedSessionId: string | null;
  interactionResponses?: NativeInteractionResponseEnvelope[];
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
}): NativeExecutionInputV1 {
  if (input.issue.workMode !== "standard") {
    throw new Error("native_execution_input_invalid: issue work mode must be standard");
  }
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: input.companyId,
      runId: input.runId,
      issueId: input.issue.id,
      agentId: input.agentId,
      executionWorkspaceId: input.workspace.id,
    },
    task: {
      identifier: input.issue.identifier ?? input.issue.id,
      title: input.issue.title,
      description: input.issue.description,
      workMode: "standard",
    },
    workspace: {
      cwd: input.workspace.cwd,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      branchName: input.workspace.branchName,
    },
    session: {
      normalizedSessionId: input.normalizedSessionId,
      driverKind: "codex_app_server",
      protocolVersion: 1,
    },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
  });
}
