import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const publicMcpWorkflowInstructions = ["review-my-team", "delegate-work", "follow-up-results"].map(name => readFileSync(new URL(`../../integrations/assistant-plugins/shared/skills/${name}/SKILL.md`, import.meta.url), "utf8")).join("\n\n");
export const publicMcpWorkflowDigest = createHash("sha256").update(publicMcpWorkflowInstructions).digest("hex");
export const publicMcpWorkerSkillDigest = createHash("sha256").update(readFileSync(new URL("../../skills/paperclip/SKILL.md", import.meta.url))).digest("hex");
export const publicMcpExpandedDigest = createHash("sha256").update(readFileSync(new URL("./public-mcp-expanded-flow.ts", import.meta.url))).update(readFileSync(new URL("./public-mcp-transfer-evidence.ts", import.meta.url))).digest("hex");
export const publicMcpSetupDigest = createHash("sha256").update(readFileSync(new URL("../../packages/shared/src/mcp-setup.ts", import.meta.url))).digest("hex");
export const publicMcpWorkerInstructions = [
  "Use the document key requested by the task in PUT /api/issues/{issueId}/documents/{key}. A report requested under key report goes to /documents/report, not /documents/plan. Read the saved document back and confirm its key before marking the task done.",
  "Verify the saved report body contains the exact reference from the current task; never reuse a reference from an example or earlier task. Completion also requires PATCH /api/issues/{issueId} with status done, followed by GET confirming done. A final chat message or saved document alone does not complete the task.",
  "Construct JSON request bodies with a JSON encoder (Python json.dumps or Node JSON.stringify), save the serialized body in a temporary file, and send it with curl --data-binary @file. Do not interpolate natural-language text into nested shell/JSON quotes.",
  "If shell syntax fails before the HTTP request is sent, repair the syntax within this run. A recoverable local quoting error does not require another heartbeat.",
];
export const publicMcpCaseDefinitions = [
  ["expanded-task-edit", "Edit, block and finish a task as the connected person"],
  ["expanded-documents", "Update a document and retrieve its revision in a later conversation"],
  ["expanded-files", "Upload and download binary bytes through scoped transfer links"],
  ["expanded-agent-config", "Configure an agent and revision-check its instructions"],
  ["expanded-projects", "Create and edit one project and inspect repository choices"],
  ["expanded-skills", "Create and version-check skill files and metadata"],
  ["expanded-api", "Discover and call a permitted API operation"],
  ["expanded-permissions", "Respect missing configuration consent"],
  ["delegate-retrieve", "Delegate once and retrieve the result in a new conversation"],
  ["event-follow-up", "Receive a signed task completion webhook and retrieve its durable result"],
  ["uncertain-retry", "Recover a lost mutation response without duplicating work"],
  ["review-team", "Summarize blocked and completed work without mutations"],
  ["human-feedback", "Add feedback as the connected human"],
  ["read-only", "Respect a read-only connection when asked to delegate"],
  ["untrusted-document", "Treat document instructions as data and preserve company isolation"],
  ["paused-agent", "Queue work honestly without promising that a paused agent started"],
  ["invitation-cold-start", "Read an invitation, configure a fresh host, approve and delegate"],
  ["invitation-existing-config", "Add Paperclip while preserving the host's existing MCP configuration"],
  ["invitation-unavailable-host", "Explain manual setup when the host cannot install an MCP connection"],
  ["invitation-denied", "Respect declined consent without acquiring tools or writing work"],
  ["invitation-reconnect", "Retrieve a delegated result in a later conversation using saved authorization"],
] as const;
export const publicMcpTasks: readonly RunnerTaskFixture[] = publicMcpCaseDefinitions.map(([id, label]) => ({
  id, label, groups: ["local"], flow: "public_mcp", workMode: "standard", expectedRunCount: 1,
  attemptTimeoutMs: { local: 12 * 60_000, daytona: 12 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Assistant report ${nonce}`,
  buildPrompt: nonce => `Write a short welcome note for a free Saturday garden-club meetup. Include exactly this reference: GARDEN${nonce.replace(/[^a-z0-9]/gi, "")}. Save the completed note as a markdown task document with key report, then mark this task done. Do not create subtasks or ask questions.`,
  buildVisibleMarker: nonce => `GARDEN${nonce.replace(/[^a-z0-9]/gi, "")}`,
  buildMatchers: () => [],
}));
