import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG, providerToolSchemaShapeIssues } from "../../vendor/paperclip-runner/index.js";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../connection-tool-definitions.js";
import { DOWNLOAD_ARTIFACT_DEFINITION } from "./artifact-transfer.js";
import { READ_CHAT_ATTACHMENT_TOOL_DEFINITION } from "./chat-attachment-read.js";
import { LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION, REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION } from "./chat-attachment-reuse.js";
import { READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION } from "./current-wake-comments.js";
import { GENERATE_IMAGE_DEFINITION } from "./generate-image-tool.js";
import { SKILL_LIBRARY_TOOL_DEFINITIONS } from "./native-skill-library-tools.js";
import { SessionAuthorityEpoch } from "./native-session-executor.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { runnerBridgeDefinitions } from "./runner-bridge-tools.js";
import { TASK_ATTACHMENT_DEFINITIONS } from "./runner-task-attachments.js";
import { READ_TOOL_RESULT_DEFINITION } from "./runner-tool-results.js";

const A = "00000000-0000-4000-8000-000000000101";
const binding = { companyId: A, agentId: A, issueId: A, runId: A, casesEnabled: true };

describe("agent-facing tool input schemas", () => {
  it("are plain objects with named top-level properties", () => {
    const tools: Array<{ name: unknown; inputSchema: unknown }> = [
      ...CAPABILITY_SEMANTIC_TOOL_CATALOG.map(tool => ({ name: tool.operationId, inputSchema: tool.inputSchema })),
      ...RUNTIME_CONNECTION_TOOL_DEFINITIONS, DOWNLOAD_ARTIFACT_DEFINITION, GENERATE_IMAGE_DEFINITION,
      READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION, LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION, REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION,
      READ_CHAT_ATTACHMENT_TOOL_DEFINITION, READ_TOOL_RESULT_DEFINITION, ...TASK_ATTACHMENT_DEFINITIONS, ...SKILL_LIBRARY_TOOL_DEFINITIONS,
      ...runnerBridgeDefinitions({ workspace: true, skills: true, api: true, mode: "standard" }),
    ];
    const offenders = tools.flatMap(tool => {
      const issues = providerToolSchemaShapeIssues(tool.inputSchema);
      return issues.length ? [`${String(tool.name)}: ${issues.join(", ")}`] : [];
    });
    expect(tools.length).toBeGreaterThan(70);
    expect(offenders).toEqual([]);
  });
});

describe("server-side tool input variants", () => {
  const authority = new PaperclipRunnerToolAuthority({} as Db, binding);
  const reject = (tool: string, args: unknown) => authority.execute({ tool, callId: "c", arguments: args }).then(() => null, (error: unknown) => error);

  it("refuses a handoff that matches neither variant with a named 422 before any dispatch", async () => {
    const error = await reject("handoff_case", { idempotencyKey: "k", case: { id: A }, instructions: "Next." });
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as HttpError).message).toBe('Invalid tool input for handoff_case: An agent handoff requires toAgentId, phase. To finish an existing case instead, send to: "done" with expectedHandoffVersion and expectedIssueStatusVersion.');
    const questions = await reject("request_human_input", { idempotencyKey: "k", interactionKind: "questions", title: "T", prompt: "P", continuationPolicy: "wake_assignee", payload: { version: 1 } });
    expect((questions as HttpError).message).toContain('interactionKind: "questions" requires payload.questionSet');
  });

  it("lets the repeated failure guard stop the third identical variant rejection", async () => {
    const epoch = new SessionAuthorityEpoch(A, authority);
    const args = { idempotencyKey: "k", caseType: "receipt", title: "T", kickoff: { toAgentId: A, phase: "triage", instructions: "Go." } };
    const messages: string[] = [];
    for (const callId of ["1", "2", "3"]) {
      messages.push(await epoch.execute({ tool: "create_case", callId, arguments: args }).then(() => "ran", (error: Error) => error.message));
    }
    expect(messages[0]).toMatch(/^Invalid tool input for create_case: create_case requires workflowId/);
    expect(messages[1]).toContain("This exact call has now failed 2 times with the same arguments.");
    expect(messages[2]).toMatch(/^This call was not run: create_case already failed 2 times/);
  });
});
