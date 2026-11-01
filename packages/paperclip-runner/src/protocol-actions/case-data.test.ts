import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import { paperclipSemanticActionNamespace } from "../semantic-tools/paperclip-discovery.js";
import { createCaseAction, readCaseAction, updateCaseAction } from "./case-data.js";
import { createWorkflowAction, listWorkflowsAction, readWorkflowAction, updateWorkflowAction } from "./workflows.js";

const caseId = "00000000-0000-4000-8000-000000000001";
const actions = [readCaseAction, updateCaseAction];

describe("production case data contracts", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });

  it.each([listWorkflowsAction, readWorkflowAction, createWorkflowAction, updateWorkflowAction])(
    "$id has a strict company-scoped live and catalog contract", (action) => {
      for (const schema of [action.live.descriptor.inputSchema, paperclipSemanticAction(action.id)!.inputSchema]) {
        const validate = ajv.compile(schema);
        expect(validate(action.examples.call.input), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...action.examples.call.input, companyId: caseId })).toBe(false);
        if (action.id === "update_workflow") expect(validate({ workflowId: caseId, idempotencyKey: "empty" })).toBe(false);
        if (action.id === "read_workflow") {
          expect(validate({ workflowId: caseId, responseText: { offsetBytes: 0 } })).toBe(true);
          expect(validate({ workflowId: caseId, responseText: { offsetBytes: 8192 } })).toBe(false);
          expect(validate({ workflowId: caseId, snapshot: "a".repeat(64), responseText: { offsetBytes: 8192 } })).toBe(true);
          expect(validate({ workflowId: caseId, snapshot: "invalid" })).toBe(false);
        }
      }
    },
  );

  it.each(actions.map(action => [action.id, action] as const))(
    "%s accepts its primary-case default and validates explicit scope on both live projections",
    (operationId, action) => {
      const catalog = paperclipSemanticAction(operationId)!;
      expect(catalog.allowedModes).toEqual(["standard"]);
      expect(action.scenario).toBeNull();
      expect(action.canonical.realServiceBinding).not.toBe("unbound");
      for (const schema of [action.live.descriptor.inputSchema, catalog.inputSchema]) {
        const validate = ajv.compile(schema);
        const example = action.examples.call.input;
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...example, caseId }), JSON.stringify(validate.errors)).toBe(true);
        for (const forged of [{ caseId: "case-id" }, { companyId: caseId }, { sourceRunId: caseId }]) {
          expect(validate({ ...example, ...forged }), JSON.stringify(forged)).toBe(false);
        }
      }
    },
  );

  it("advertises bounded case JSON continuations without exposing arbitrary APIs", () => {
    for (const schema of [readCaseAction.live.descriptor.inputSchema, paperclipSemanticAction("read_case")!.inputSchema]) {
      const validate = ajv.compile(schema);
      expect(validate({ section: "fields", offsetBytes: 8192, limitBytes: 8192, snapshot: "a".repeat(64) }), JSON.stringify(validate.errors)).toBe(true);
      for (const input of [{ offsetBytes: 1 }, { limitBytes: 8193 }, { limitBytes: 3 }, { snapshot: "forged" },
        { section: "secrets" }, { operationId: "GET /api/assets/{id}" }]) expect(validate(input)).toBe(false);
    }
  });

  it("opens only explicitly selected case or linked-task documents through the bounded read contract", () => {
    for (const schema of [readCaseAction.live.descriptor.inputSchema, paperclipSemanticAction("read_case")!.inputSchema]) {
      const validate = ajv.compile(schema);
      expect(validate({ section: "document", documentKey: "Research:v1.notes" }), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ section: "document", documentKey: "workflow", documentIssueId: caseId }), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ section: "document", documentKey: "WORKFLOW", documentIssueId: caseId, offsetBytes: 8192,
        snapshot: "a".repeat(64) }), JSON.stringify(validate.errors)).toBe(true);
      for (const input of [{ section: "document" }, { documentKey: "workflow" }, { documentIssueId: caseId },
        { section: "case", documentKey: "workflow" }, { section: "fields", documentIssueId: caseId },
        { section: "document", documentKey: "../escape" }, { section: "document", documentKey: "workflow", documentIssueId: "foreign" },
        { section: "document", documentKey: "Research:v1", documentIssueId: caseId },
        { section: "document", documentKey: "a".repeat(65), documentIssueId: caseId },
        { section: "document", documentKey: "workflow", offsetBytes: 1 },
        { section: "document", documentKey: "workflow", url: "/api/issues/arbitrary/documents/secret" }]) {
        expect(validate(input), JSON.stringify(input)).toBe(false);
      }
    }
  });

  it("requires a nonempty, idempotent facts update and excludes workflow and access mutations", () => {
    const validate = ajv.compile(updateCaseAction.live.descriptor.inputSchema);
    expect(validate({ idempotencyKey: "save-facts" })).toBe(false);
    expect(validate({ fields: {} })).toBe(false);
    expect(validate({ idempotencyKey: "save-facts", summary: null })).toBe(true);
    expect(validate({ idempotencyKey: "save-facts", fields: {} })).toBe(true);
    for (const forbidden of ["status", "phase", "workIssueId", "projectId", "assigneeAgentId", "responsibleUserId", "creatorAgentId", "accessSources"]) {
      expect(validate({ ...updateCaseAction.examples.call.input, [forbidden]: caseId }), forbidden).toBe(false);
    }
    expect(validate({ idempotencyKey: "save-facts", title: "a".repeat(501) })).toBe(false);
    expect(validate({ idempotencyKey: "save-facts", summary: "a".repeat(8001) })).toBe(false);
  });

  it("requires complete kickoff routing and accepts bounded initial task documents", () => {
    for (const schema of [createCaseAction.live.descriptor.inputSchema, paperclipSemanticAction("create_case")!.inputSchema]) {
      const validate = ajv.compile(schema);
      const input = createCaseAction.examples.call.input;
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      const { kickoff, ...withoutKickoff } = input;
      expect(validate(withoutKickoff)).toBe(false);
      const { workflow_document_text: _workflow, ...withoutWorkflow } = input;
      expect(validate(withoutWorkflow)).toBe(false);
      expect(validate({ ...withoutWorkflow, workflowId: caseId })).toBe(true);
      expect(validate({ ...input, workflowId: caseId })).toBe(false);
      expect(validate({ ...input, workflow_document_text: "Implement and verify, then finish." })).toBe(true);
      expect(validate({ ...input, workflow_document_text: "# Workflow\n\n```mermaid\nstateDiagram-v2\n  triage --> implementation: ready\n```\n\nready: Triage saves validated facts and hands off to the implementation agent." })).toBe(true);
      const initialDocuments = [{ key: "brief", title: "Brief", body: "An objective" }];
      expect(validate({ ...input, initialDocuments }), JSON.stringify(validate.errors)).toBe(true);
      for (const extra of [{ kickoff: null }, { kickoff: { phase: "triage" } },
        { workflow_document_text: "" }, { workflow_document_text: " \t\n" }, { workflow_document_text: "x".repeat(200001) },
        { initialDocuments: [{ key: "workflow", title: "Wrong owner", body: "Do not overwrite the required workflow" }] },
        { kickoff, initialDocuments: [{ ...initialDocuments[0], key: "../brief" }] },
        { kickoff, initialDocuments: Array.from({ length: 21 }, (_, index) => ({ key: `brief-${index}`, title: "Brief", body: "" })) },
        { kickoff, initialDocuments: [{ ...initialDocuments[0], body: "a".repeat(524289) }] },
        { status: "done" }, { responsibleUserId: caseId }, { caseId }, { bindIssueId: caseId }]) {
        expect(validate({ ...input, ...extra }), JSON.stringify(extra).slice(0, 300)).toBe(false);
      }
    }
  });

  it("keeps case facts separate from ordinary task-document tools", () => {
    for (const operationId of ["create_case", "read_case", "update_case", "list_workflows", "read_workflow", "create_workflow", "update_workflow"] as const) expect(paperclipSemanticActionNamespace(operationId)).toBe("delegation");
    expect(paperclipSemanticAction("read_case")?.effect).toBe("read");
    expect(paperclipSemanticAction("update_case")?.effect).toBe("write");
    expect(paperclipSemanticAction("create_case")?.effect).toBe("write");
    expect(paperclipSemanticAction("read_case_document" as any)).toBeUndefined();
    expect(paperclipSemanticAction("write_case_document" as any)).toBeUndefined();
  });
});
