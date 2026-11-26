/**
 * Cross-field rules for agent-facing tools whose advertised input schema is a
 * plain object (see `providerToolSchemaShapeIssues`). Each rule matches the
 * root oneOf/anyOf/allOf/if-then the schema used to carry, so an input is
 * accepted exactly when the previous strict schema accepted it. Callers run
 * this after the flat schema has accepted the input. A rejection names what is
 * wrong and how to send the call correctly.
 */
type Input = Record<string, unknown>;

const has = (input: Input, key: string) => Object.hasOwn(input, key);
const record = (value: unknown): Input | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Input : null;
const positiveInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1;
const list = (keys: readonly string[]) => keys.join(", ");
const TASK_DOCUMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DONE_ONLY_FORBIDDEN = ["toAgentId", "bindIssueId", "workflowId", "workflow_document_text", "initialDocuments"] as const;

function handoffCase(input: Input): string[] {
  const problems: string[] = [];
  const target = record(input.case);
  if (target) {
    if (has(target, "id") === has(target, "create")) {
      problems.push(has(target, "id")
        ? "case must contain only one of id or create, not both."
        : "case must contain id (an existing case) or create (a new case).");
    }
  }
  if (has(input, "to")) {
    const extra = DONE_ONLY_FORBIDDEN.filter(key => has(input, key));
    if (extra.length) problems.push(`to: "done" records intent to finish an existing case and does not accept ${list(extra)}. Remove ${list(extra)}, or omit to for an agent handoff.`);
    const missing = ["expectedHandoffVersion", "expectedIssueStatusVersion"].filter(key => !has(input, key));
    if (missing.length) problems.push(`to: "done" requires ${list(missing)}: the case handoffVersion and task statusVersion you last read.`);
    if (has(input, "phase") && input.phase !== "done") problems.push(`With to: "done", omit phase or send phase: "done".`);
    if (target && has(target, "create")) problems.push(`With to: "done", case must contain only id, the existing case ID; a new case cannot be finished.`);
    return problems;
  }
  const missing = ["toAgentId", "phase"].filter(key => !has(input, key));
  if (missing.length) problems.push(`An agent handoff requires ${list(missing)}. To finish an existing case instead, send to: "done" with expectedHandoffVersion and expectedIssueStatusVersion.`);
  if (has(input, "workflowId") && has(input, "workflow_document_text")) {
    problems.push("Send workflowId or workflow_document_text, not both.");
  } else if (target && has(target, "create") && !has(target, "id") && typeof input.workflowId !== "string" && !has(input, "workflow_document_text")) {
    problems.push("A new case (case.create) requires workflowId (an existing workflow ID) or workflow_document_text (the workflow Markdown).");
  }
  return problems;
}

function createCase(input: Input): string[] {
  const id = has(input, "workflowId");
  if (id === has(input, "workflow_document_text")) {
    return [id
      ? "Send workflowId or workflow_document_text, not both."
      : "create_case requires workflowId (an existing workflow ID) or workflow_document_text (the workflow Markdown)."];
  }
  return [];
}

function requireAny(tool: string, input: Input, keys: readonly string[]): string[] {
  return keys.some(key => has(input, key)) ? [] : [`${tool} changes nothing without at least one of ${list(keys)}. Send the field(s) to change.`];
}

function readCase(input: Input): string[] {
  const problems: string[] = [];
  if (positiveInteger(input.offsetBytes) && !has(input, "snapshot")) {
    problems.push("A nonzero offsetBytes continues an earlier read: also send the snapshot it returned, or restart at offsetBytes 0 without snapshot.");
  }
  if (input.section === "document") {
    if (!has(input, "documentKey")) problems.push("section: \"document\" requires documentKey.");
  } else {
    const selectors = ["documentKey", "documentIssueId"].filter(key => has(input, key));
    if (selectors.length) problems.push(`${list(selectors)} only apply with section: "document". Add section: "document" or remove ${list(selectors)}.`);
  }
  if (has(input, "documentIssueId") && typeof input.documentKey === "string"
    && (input.documentKey.length > 64 || !TASK_DOCUMENT_KEY.test(input.documentKey))) {
    problems.push("With documentIssueId, documentKey must be a task document key: at most 64 letters, numbers, underscores or hyphens, starting with a letter or number.");
  }
  return problems;
}

function readWorkflow(input: Input): string[] {
  const window = record(input.responseText);
  return window && positiveInteger(window.offsetBytes) && !has(input, "snapshot")
    ? ["A nonzero responseText.offsetBytes continues an earlier read: also send the snapshot it returned, or restart at offsetBytes 0 without snapshot."]
    : [];
}

/** Copyable payload shown in the correction; tests check that it is admitted. */
export const QUESTIONS_PAYLOAD_EXAMPLE = Object.freeze({
  questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "<id>", prompt: "<question>", required: true, answerMode: "text" }] },
});

/**
 * Every copyable JSON example a correction can show, with the tool and
 * argument it belongs to. Tests require each example in a message to be
 * listed here and to pass that tool's advertised schema and variant rules.
 */
export const TOOL_INPUT_CORRECTION_EXAMPLES: readonly { tool: string; argument: string; value: unknown }[] = Object.freeze([
  { tool: "request_human_input", argument: "payload", value: QUESTIONS_PAYLOAD_EXAMPLE },
]);

function requestHumanInput(input: Input): string[] {
  if (input.interactionKind !== "questions") return [];
  const payload = record(input.payload);
  if (payload && (has(payload, "questionSet") || has(payload, "questions"))) return [];
  return [`interactionKind: "questions" requires payload.questionSet: send payload: ${JSON.stringify(QUESTIONS_PAYLOAD_EXAMPLE)}${payload ? ", alongside the payload fields you already sent" : ""}.`];
}

function finish(input: Input): string[] {
  return input.reportedWorkDisposition !== "yielded" && has(input, "continuation") && input.continuation !== null
    ? ["continuation is only for reportedWorkDisposition: \"yielded\". Use continuation: null or omit it for done, completed, or needs_review."]
    : [];
}

const RULES: Readonly<Record<string, (input: Input) => string[]>> = {
  handoff_case: handoffCase,
  create_case: createCase,
  update_case: input => requireAny("update_case", input, ["title", "summary", "fields"]),
  update_workflow: input => requireAny("update_workflow", input, ["name", "prompt"]),
  read_case: readCase,
  read_workflow: readWorkflow,
  request_human_input: requestHumanInput,
  paperclip_finish: finish,
};

export const TOOL_INPUT_VARIANT_TOOLS: readonly string[] = Object.freeze(Object.keys(RULES));

/** Returns a named rejection, or null when the cross-field rules hold. */
export function toolInputVariantError(tool: string, input: unknown): string | null {
  const rule = Object.hasOwn(RULES, tool) ? RULES[tool] : undefined;
  const value = record(input);
  if (!rule || !value) return null;
  const problems = rule(value);
  return problems.length ? `Invalid tool input for ${tool}: ${problems.join(" ")}` : null;
}
