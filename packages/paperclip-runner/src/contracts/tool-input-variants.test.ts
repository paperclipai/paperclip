import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";
import { PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA } from "./completion-result.js";
import { QUESTIONS_PAYLOAD_EXAMPLE, TOOL_INPUT_CORRECTION_EXAMPLES, TOOL_INPUT_VARIANT_TOOLS, toolInputVariantError } from "./tool-input-variants.js";

// The strict input schemas the previous release advertised, with their root
// oneOf/anyOf/allOf/if-then. Calls and receipts saved under them must keep
// exactly the same acceptance after flattening.
const previous = JSON.parse(readFileSync(new URL("../../spec/fixtures/pre-flat-tool-input-schemas.json", import.meta.url), "utf8")) as {
  tools: Record<string, Record<string, unknown>>;
};
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const current = (tool: string) => tool === "paperclip_finish"
  ? PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA
  : CAPABILITY_SEMANTIC_TOOL_CATALOG.find(entry => entry.operationId === tool)!.inputSchema;

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const W = "00000000-0000-4000-8000-000000000003";
const agent = { idempotencyKey: "k", case: { id: A }, toAgentId: B, phase: "build", instructions: "Do it." };
const done = { to: "done", idempotencyKey: "k", case: { id: A }, instructions: "Finish.", expectedHandoffVersion: 1, expectedIssueStatusVersion: 2 };
const create = { create: { caseType: "receipt", title: "Check" } };
const kickoff = { toAgentId: B, phase: "triage", instructions: "Go." };
const caseBase = { idempotencyKey: "k", caseType: "receipt", title: "Check", kickoff };
const question = { id: "q", prompt: "Name?", required: true, answerMode: "text" };
const ask = { idempotencyKey: "k", interactionKind: "questions", title: "T", prompt: "P", continuationPolicy: "wake_assignee" };
const report = { summary: "s", completionClaim: { contractRevision: "r", objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [] };

const corpus: Record<string, unknown[]> = {
  handoff_case: [
    {}, agent, done, { ...agent, case: create, workflowId: W }, { ...agent, case: create, workflow_document_text: "# Flow" },
    { ...agent, case: create }, { ...agent, case: create, workflowId: null }, { ...agent, case: create, workflowId: null, workflow_document_text: "x" },
    { ...agent, workflowId: W, workflow_document_text: "x" }, { ...agent, workflowId: null }, { ...agent, workflowId: W },
    { ...agent, case: {} }, { ...agent, case: { id: A, ...create } }, { ...agent, toAgentId: undefined }, (({ phase: _, ...rest }) => rest)(agent),
    (({ toAgentId: _, ...rest }) => rest)(agent), { ...agent, to: "done" }, { ...done, phase: "done" }, { ...done, phase: "build" },
    (({ expectedHandoffVersion: _, ...rest }) => rest)(done), { ...done, case: create }, { ...done, workflowId: W },
    { ...done, bindIssueId: B }, { ...done, initialDocuments: [] }, { ...done, to: "later" }, { ...agent, bindIssueId: B, expectedIssueStatusVersion: 0 },
    { ...agent, case: create, workflow_document_text: "x", initialDocuments: [{ key: "notes", title: "N", body: "b" }] },
  ],
  create_case: [
    caseBase, { ...caseBase, workflowId: W }, { ...caseBase, workflow_document_text: "# Flow" },
    { ...caseBase, workflowId: W, workflow_document_text: "x" }, { ...caseBase, workflowId: W, summary: "s", fields: { a: 1 }, projectId: null },
  ],
  update_case: [{ idempotencyKey: "k" }, { idempotencyKey: "k", title: "T" }, { idempotencyKey: "k", summary: null }, { idempotencyKey: "k", fields: {} }, { idempotencyKey: "k", caseId: A }],
  update_workflow: [{ workflowId: W, idempotencyKey: "k" }, { workflowId: W, idempotencyKey: "k", name: "N" }, { workflowId: W, idempotencyKey: "k", prompt: "P" }],
  read_case: [
    {}, { offsetBytes: 0 }, { offsetBytes: 5 }, { offsetBytes: 5, snapshot: "a".repeat(64) }, { section: "document" },
    { section: "document", documentKey: "Plan.v1" }, { section: "document", documentKey: "plan", documentIssueId: A },
    { section: "document", documentKey: "Plan.v1", documentIssueId: A }, { section: "fields", documentKey: "plan" }, { documentIssueId: A },
    { section: "document", documentKey: "k".repeat(70), documentIssueId: A }, { section: "case" },
  ],
  read_workflow: [
    { workflowId: W }, { workflowId: W, responseText: { offsetBytes: 0 } }, { workflowId: W, responseText: { offsetBytes: 3 } },
    { workflowId: W, responseText: { offsetBytes: 3 }, snapshot: "b".repeat(64) }, { workflowId: W, responseText: { limitBytes: 100 } },
  ],
  request_human_input: [
    ask, { ...ask, payload: {} }, { ...ask, payload: { questionSet: { questions: [question] } } }, { ...ask, payload: { questions: [] } },
    { ...ask, interactionKind: "confirmation" }, { ...ask, interactionKind: "confirmation", payload: { version: 1 } },
  ],
  paperclip_finish: [
    { ...report, reportedWorkDisposition: "done" }, { ...report, reportedWorkDisposition: "done", continuation: null },
    { ...report, reportedWorkDisposition: "done", continuation: { kind: "response_wake", summary: "s", idempotencyKey: "k" } },
    { ...report, reportedWorkDisposition: "yielded" }, { ...report, reportedWorkDisposition: "yielded", continuation: null },
    { ...report, reportedWorkDisposition: "yielded", continuation: { kind: "response_wake", summary: "s", idempotencyKey: "k" } },
    { ...report, reportedWorkDisposition: "needs_review", continuation: null },
  ],
};

describe("flattened tool input keeps the previous release's acceptance", () => {
  test("every rewritten tool is covered", () => {
    expect(Object.keys(previous.tools).sort()).toEqual([...TOOL_INPUT_VARIANT_TOOLS].sort());
  });

  for (const tool of TOOL_INPUT_VARIANT_TOOLS) {
    test(tool, () => {
      const old = ajv.compile(previous.tools[tool]!);
      const flat = ajv.compile(current(tool) as Record<string, unknown>);
      const cases = corpus[tool]!.map(input => JSON.parse(JSON.stringify(input)) as unknown);
      let accepted = 0;
      for (const input of cases) {
        const accept = flat(input) && toolInputVariantError(tool, input) === null;
        expect({ input, accept }).toEqual({ input, accept: old(input) });
        if (accept) accepted += 1;
      }
      // Both outcomes are exercised for every tool.
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(cases.length);
    });
  }
});

test("rejections name what is wrong and how to send it", () => {
  expect(toolInputVariantError("handoff_case", { idempotencyKey: "k", case: { id: A }, instructions: "x" }))
    .toBe('Invalid tool input for handoff_case: An agent handoff requires toAgentId, phase. To finish an existing case instead, send to: "done" with expectedHandoffVersion and expectedIssueStatusVersion.');
  expect(toolInputVariantError("handoff_case", { ...agent, case: create }))
    .toContain("A new case (case.create) requires workflowId (an existing workflow ID) or workflow_document_text");
  expect(toolInputVariantError("handoff_case", { ...done, toAgentId: B }))
    .toContain('to: "done" records intent to finish an existing case and does not accept toAgentId. Remove toAgentId');
  expect(toolInputVariantError("request_human_input", { ...ask, payload: { version: 1 } }))
    .toContain('interactionKind: "questions" requires payload.questionSet');
  expect(toolInputVariantError("update_case", { idempotencyKey: "k" })).toContain("at least one of title, summary, fields");
  expect(toolInputVariantError("connections_search", {})).toBeNull();
  expect(toolInputVariantError("handoff_case", agent)).toBeNull();
});

test("the questions correction suggests a payload that is admitted", () => {
  const input = { ...ask, payload: structuredClone(QUESTIONS_PAYLOAD_EXAMPLE) };
  expect(ajv.compile(current("request_human_input") as Record<string, unknown>)(input)).toBe(true);
  expect(ajv.compile(previous.tools.request_human_input!)(input)).toBe(true);
  expect(toolInputVariantError("request_human_input", input)).toBeNull();
  expect(toolInputVariantError("request_human_input", { ...ask, payload: { version: 1 } })).toContain(JSON.stringify(QUESTIONS_PAYLOAD_EXAMPLE));
});

// Every JSON object embedded in a message, found by balanced braces.
function embeddedJson(message: string): unknown[] {
  const found: unknown[] = [];
  for (let start = message.indexOf("{"); start !== -1; start = message.indexOf("{", start + 1)) {
    let depth = 0;
    for (let end = start; end < message.length; end += 1) {
      if (message[end] === "{") depth += 1;
      else if (message[end] === "}" && --depth === 0) {
        try { found.push(JSON.parse(message.slice(start, end + 1))); start = end; } catch { /* prose braces */ }
        break;
      }
    }
  }
  return found;
}

test("every corrective example is registered and passes its tool's advertised schema", () => {
  const bases: Record<string, Record<string, unknown>> = { request_human_input: ask };
  for (const example of TOOL_INPUT_CORRECTION_EXAMPLES) {
    const input = { ...bases[example.tool], [example.argument]: structuredClone(example.value) };
    expect(ajv.compile(current(example.tool) as Record<string, unknown>)(input), example.tool).toBe(true);
    expect(toolInputVariantError(example.tool, input), example.tool).toBeNull();
  }
  let shown = 0;
  for (const tool of TOOL_INPUT_VARIANT_TOOLS) {
    for (const input of corpus[tool]!) {
      const message = toolInputVariantError(tool, JSON.parse(JSON.stringify(input)));
      for (const value of message ? embeddedJson(message) : []) {
        shown += 1;
        expect(TOOL_INPUT_CORRECTION_EXAMPLES.some(example => example.tool === tool && JSON.stringify(example.value) === JSON.stringify(value)),
          `${tool}: ${JSON.stringify(value)}`).toBe(true);
      }
    }
  }
  expect(shown).toBeGreaterThan(0);
});
