import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const TASK_TITLE_BUDGET_CENTS = 500;
export const TASK_TITLE_EARLY_CALL_LIMIT = 5;
export const taskTitleDefinitionDigest = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");

// Deliberately no title/tool/API instructions: production guidance must cause naming.
export function taskTitlePrompt(nonce: string) {
  return [
    "I am preparing a short internal handover for a teammate who is taking over a routine maintenance job tomorrow. Keep the answer practical and brief.",
    "Give me a three-item checklist for safely rotating an expired API key: create its replacement, update the consuming service, and verify access before revoking the old key.",
    `Include receipt CHECKLIST-${nonce} in your answer. This is writing only; do not access a real account, change credentials, or create files.`,
  ].join("\n\n");
}

export const taskTitleTasks: readonly RunnerTaskFixture[] = ([
  ["prompt-title-standard", "Name a prompt-only task", "standard"],
  ["prompt-title-ask", "Name a prompt-only Ask task", "ask"],
  ["preserve-explicit-title", "Preserve the user's title", "standard"],
] as const).map(([id, label, workMode]) => ({
  id, label, groups: [], workMode,
  flow: "single_turn", expectedRunCount: 1,
  attemptTimeoutMs: { local: 6 * 60_000, daytona: 6 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => id === "preserve-explicit-title" ? `Teammate handover ${nonce}` : "",
  buildPrompt: taskTitlePrompt,
  buildVisibleMarker: nonce => `CHECKLIST-${nonce}`,
  buildMatchers: (nonce, execution) => [
    { kind: "message_contains", expected: `CHECKLIST-${nonce}` },
    { kind: "issue_status", expected: "done" },
    { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: execution.profile.expectedRuntimeMode },
    { kind: "environment", expected: execution.environment.id },
  ],
}));

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export interface TaskTitleEvidenceInput {
  initial: unknown;
  final: unknown;
  submitted: unknown;
  prompt: string;
  explicitTitle: string;
  agentId: string;
  runId: string;
  events: readonly { eventType?: string; payload?: unknown }[];
  activity: readonly unknown[];
}

/** Grade real call/result/receipt evidence and persisted state, never model prose. */
export function gradeTaskTitle(input: TaskTitleEvidenceInput) {
  const initial = record(input.initial), final = record(input.final), submitted = record(input.submitted);
  const provisional = input.prompt.trim().replace(/\s+/g, " ").slice(0, 120);
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const starts = new Map<string, { name: string; input: Record<string, unknown>; position: number; index: number }>();
  const results = new Map<string, Record<string, unknown>>();
  const completions = new Map<string, number>();
  let position = 0;
  input.events.forEach((event, index) => {
    const payload = record(record(record(event.payload).prpEvent).payload);
    const item = record(payload.item);
    if (event.eventType === "tool.execution.started" && typeof payload.executionId === "string" && !starts.has(payload.executionId)) {
      starts.set(payload.executionId, { name: String(payload.name ?? ""), input: {}, position: ++position, index });
    }
    if (event.eventType === "item.started" && item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
      const prior = starts.get(item.id);
      starts.set(item.id, { name: item.name, input: record(item.input), position: prior?.position ?? ++position, index: prior?.index ?? index });
    }
    if (event.eventType === "item.completed" && item.type === "tool_result" && typeof item.id === "string"
      && (item.tool_use_id === undefined || item.tool_use_id === item.id)) results.set(item.id, record(item.result));
    if (event.eventType === "tool.execution.completed" && payload.name === "set_task_title" && payload.status === "completed" && typeof payload.executionId === "string") {
      completions.set(payload.executionId, index);
    }
  });
  const calls = [...starts].filter(([, call]) => call.name === "set_task_title");
  const titleWrites = input.activity.map(record).filter(row => row.action === "issue.updated"
    && row.entityType === "issue" && row.entityId === initial.id && typeof record(row.details).title === "string");
  check("creation-request", submitted.description === input.prompt
    && (input.explicitTitle ? submitted.title === input.explicitTitle : !Object.hasOwn(submitted, "title")), "Browser submitted the full prompt with the requested title, or omitted the title entirely.");
  check("provider-tool-evidence", starts.size > 0 && Boolean(input.runId), "Provider tool evidence from the initial run is present; narration alone is insufficient.");
  check("initial-title", initial.title === (input.explicitTitle || provisional)
    && initial.titleNeedsGeneration === !Boolean(input.explicitTitle), "Creation response proves the initial title and server-owned generation marker before the agent runs.");
  check("same-task-and-description", typeof initial.id === "string" && final.id === initial.id
    && initial.description === input.prompt && final.description === input.prompt
    && final.assigneeAgentId === input.agentId, "The original task, assignment, and complete prompt survive naming.");
  check("generation-settled", final.titleNeedsGeneration === false, "The stored task no longer needs a generated title.");
  if (input.explicitTitle) {
    check("explicit-title-preserved", final.title === input.explicitTitle && titleWrites.length === 0
      && calls.every(([id]) => results.get(id)?.changed === false), "No title-changing audit or tool result may overwrite a supplied title, even temporarily.");
  } else {
    const title = typeof final.title === "string" ? final.title : "";
    check("descriptive-title", title.trim() === title && title.length >= 8 && title.length <= 120
      && title !== provisional && !input.prompt.startsWith(title) && !title.includes("CHECKLIST-")
      && /(rotat|replac|renew|expir)/i.test(title) && /\b(api|keys?|credentials?)\b/i.test(title), "A concise title describes the key-rotation request instead of copying the prompt prefix or answer receipt.");
    const terminalIndex = input.events.findIndex(event => event.eventType === "run.terminal");
    const finishIndex = Math.min(
      [...starts.values()].find(call => ["paperclip_finish", "finish_task"].includes(call.name))?.index ?? input.events.length,
      terminalIndex < 0 ? input.events.length : terminalIndex,
    );
    const proven = calls.filter(([id, call]) => {
      const result = results.get(id);
      const completedAt = completions.get(id);
      return result !== undefined && call.position <= TASK_TITLE_EARLY_CALL_LIMIT && call.input.onlyIfProvisional === true
        && typeof call.input.idempotencyKey === "string" && call.input.idempotencyKey.trim().length > 0
        && call.input.title === title && result.id === initial.id && result.title === title
        && result.changed === true && result.titleNeedsGeneration === false
        && completedAt !== undefined && completedAt > call.index && completedAt < finishIndex;
    });
    check("early-title-tool", proven.length > 0, `A correlated set_task_title call must succeed among the first ${TASK_TITLE_EARLY_CALL_LIMIT} tools of the initial run, before completion.`);
    check("agent-title-audit", titleWrites.length === 1 && titleWrites[0]?.actorType === "agent"
      && titleWrites[0]?.actorId === input.agentId && titleWrites[0]?.runId === input.runId
      && record(titleWrites[0]?.details).title === title
      && record(record(titleWrites[0]?.details).previous).title === provisional, "The same assigned agent and initial run must own the single persisted title mutation.");
  }
  return {
    schema: "paperclip.task-title-eval.v1", passed: checks.every(entry => entry.passed), checks,
    initialTitle: initial.title, finalTitle: final.title,
    titleCalls: calls.map(([id, call]) => ({ id, position: call.position, completed: completions.has(id), result: results.get(id) ?? null })),
    titleWrites,
  };
}
