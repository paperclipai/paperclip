import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createTaskAction } from "../protocol-actions/create-task.js";
import { createProjectAction } from "../protocol-actions/create-project.js";
import { requestHumanInputAction } from "../protocol-actions/request-human-input.js";

import {
  PAPERCLIP_SEMANTIC_ACTION_CATALOG,
  canonicalPaperclipSemanticActionCatalog,
  paperclipSemanticAction,
} from "./semantic-action-catalog.js";

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("semantic action catalog", () => {
  it("advertises only icons accepted by the project API on both tool surfaces", async () => {
    const { PROJECT_ICON_NAMES } = await import("../../../shared/src/constants.js");
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    for (const schema of [createProjectAction.live.descriptor.inputSchema, paperclipSemanticAction("create_project")!.inputSchema]) {
      const validate = ajv.compile(schema);
      const input = { name: "Onboarding", idempotencyKey: "onboarding" };
      expect(schema).toMatchObject({ properties: { icon: { enum: [...PROJECT_ICON_NAMES, null] } } });
      for (const icon of [...PROJECT_ICON_NAMES, null]) expect(validate({ ...input, icon }), String(icon)).toBe(true);
      expect(validate({ ...input, icon: "users" })).toBe(false);
    }
  });

  it("limits project repository URLs to HTTPS GitHub repository paths on both tool surfaces", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    for (const schema of [createProjectAction.live.descriptor.inputSchema, paperclipSemanticAction("create_project")!.inputSchema]) {
      const validate = ajv.compile(schema);
      const input = { name: "Project", idempotencyKey: "create-project-1" };
      expect(validate({ ...input, repositoryUrls: ["https://github.com/org/repo", "https://github.com/org/other.git/"] })).toBe(true);
      for (const url of [
        "http://github.com/org/repo", "file:///etc/passwd", "data:text/plain,repo",
        "https://localhost/org/repo", "https://127.0.0.1/org/repo", "https://10.0.0.1/org/repo",
        "https://github.com.evil.test/org/repo", "https://token@github.com/org/repo",
        "https://github.com:8443/org/repo", "https://github.com/org/repo?token=secret",
        "https://github.com/org/repo#fragment", "https://github.com/org/repo/tree/main",
        "https://github.com/../repo", "https://github.com/org/..",
      ]) expect(validate({ ...input, repositoryUrls: [url] }), url).toBe(false);
    }
  });

  it("accepts project handoff receipts and preserves ordinary child task receipts", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    const validate = ajv.compile(createTaskAction.live.descriptor.outputSchema);
    const receipt = {
      commandId: "create-task-1", disposition: "applied", stateRevision: 1,
      entityRefs: ["task-1"], scheduledWakeIds: ["wake-1"],
      task: { id: "task-1", identifier: "CHAT-1", parentId: null, projectId: "project-1", status: "todo", assigneeActorId: "agent-1" },
    };
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    const { projectId: _projectId, ...childTask } = receipt.task;
    expect(validate({ ...receipt, task: { ...childTask, parentId: "parent-1" } })).toBe(true);
    expect(validate({ ...receipt, task: { ...receipt.task, projectId: 42 } })).toBe(false);
    expect(validate({ ...receipt, task: { ...receipt.task, parentId: "" } })).toBe(false);
  });

  it("defines one immutable v1 declaration for each Codex-spine action", () => {
    const operationIds = PAPERCLIP_SEMANTIC_ACTION_CATALOG.map(
      (action) => action.operationId,
    );

    expect(operationIds).toHaveLength(35);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).not.toContain("generic_api_request");
    expect(Object.isFrozen(PAPERCLIP_SEMANTIC_ACTION_CATALOG)).toBe(true);
    expect(
      Object.isFrozen(paperclipSemanticAction("write_document")?.inputSchema),
    ).toBe(true);
  });

  it("declares hire_agent as a native identity-only mutation", () => {
    const hire = paperclipSemanticAction("hire_agent");
    expect(hire).toMatchObject({
      effect: "write",
      requiredClaims: ["delegation:agents:create"],
      allowedModes: ["standard", "skill_test"],
    });
    expect(hire?.inputSchema.properties).not.toHaveProperty("adapterConfig");
    expect(hire?.inputSchema.properties).not.toHaveProperty("env");
  });

  it("compiles every operation input and output schema", () => {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
    });

    for (const action of PAPERCLIP_SEMANTIC_ACTION_CATALOG) {
      expect(
        () => ajv.compile(action.inputSchema),
        `${action.operationId} input`,
      ).not.toThrow();
      expect(
        () => ajv.compile(action.outputSchema),
        `${action.operationId} output`,
      ).not.toThrow();
    }
  });

  it("keeps bounded mutation inputs and rejects undeclared fields", () => {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
    });
    const writeDocument = paperclipSemanticAction("write_document");
    const taskContext = paperclipSemanticAction("get_task_context");
    expect(writeDocument).toBeDefined();
    expect(taskContext).toBeDefined();

    const validateWrite = ajv.compile(writeDocument!.inputSchema);
    expect(
      validateWrite({
        idempotencyKey: "write-1",
        key: "plan",
        title: "Plan",
        body: "A bounded body",
        baseRevisionId: null,
      }),
    ).toBe(true);
    expect(
      validateWrite({
        key: "plan",
        title: "Plan",
        body: "Body",
        baseRevisionId: null,
      }),
    ).toBe(false);

    const validateContext = ajv.compile(taskContext!.inputSchema);
    expect(validateContext({})).toBe(true);
    expect(validateContext({ companyId: "forged-company" })).toBe(false);
  });

  it("matches the checked-in generated inventory byte for byte", async () => {
    const generated = await readFile(
      resolve(packageRoot, "generated/semantic-action-catalog.json"),
      "utf8",
    );

    expect(generated).toBe(canonicalPaperclipSemanticActionCatalog());
  });

  it("does not carry executable authorization or binding hooks", () => {
    for (const action of PAPERCLIP_SEMANTIC_ACTION_CATALOG) {
      const keys = Object.keys(action);
      expect(keys).not.toContain("authorize");
      expect(keys).not.toContain("execute");
      expect(keys).not.toContain("binding");
    }
  });

  it("advertises an optional, nullable decision brief on request_human_input on every tool surface", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    const brief = {
      version: 1,
      whatIsHappening: "Integrating the payment gateway requested in CAT-50.",
      whyStopped: "Two providers meet the requirements; the choice changes cost.",
      whatWeNeed: "Pick Stripe or Adyen.",
    };
    const liveSchema = requestHumanInputAction.live.descriptor.inputSchema;
    const scenarioSchema = requestHumanInputAction.scenario.descriptor.inputSchema;
    const catalogSchema = paperclipSemanticAction("request_human_input")!.inputSchema;

    for (const schema of [liveSchema, scenarioSchema, catalogSchema]) {
      expect(schema.properties).toHaveProperty("brief");
      expect(schema.required).not.toContain("brief");
    }

    const validateLive = ajv.compile(liveSchema);
    const liveInput = { idempotencyKey: "brief-1", interactionKind: "confirmation", title: "Pick a provider", prompt: "Which provider?", continuationPolicy: "none" };
    expect(validateLive({ ...liveInput, brief }), JSON.stringify(validateLive.errors)).toBe(true);
    expect(validateLive({ ...liveInput, brief: null })).toBe(true);
    expect(validateLive(liveInput)).toBe(true);
    expect(validateLive({ ...liveInput, brief: { version: 1 } })).toBe(false);

    const validateScenario = ajv.compile(scenarioSchema);
    const scenarioInput = { interactionKind: "confirmation", title: "Pick a provider", prompt: "Which provider?", continuationPolicy: "none" };
    expect(validateScenario({ ...scenarioInput, brief }), JSON.stringify(validateScenario.errors)).toBe(true);
    expect(validateScenario({ ...scenarioInput, brief: null })).toBe(true);

    const validateCatalog = ajv.compile(catalogSchema);
    const catalogInput = { idempotencyKey: "brief-2", interactionKind: "confirmation", title: "Pick a provider", prompt: "Which provider?", continuationPolicy: "none" };
    expect(validateCatalog({ ...catalogInput, brief }), JSON.stringify(validateCatalog.errors)).toBe(true);
    expect(validateCatalog({ ...catalogInput, brief: null })).toBe(true);
  });

  it("advertises an optional task summary on create_task on every tool surface", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    const liveSchema = createTaskAction.live.descriptor.inputSchema;
    const scenarioSchema = createTaskAction.scenario.descriptor.inputSchema;
    const catalogSchema = paperclipSemanticAction("create_task")!.inputSchema;

    for (const schema of [liveSchema, scenarioSchema, catalogSchema]) {
      expect(schema.properties).toHaveProperty("summary");
      expect(schema.required).not.toContain("summary");
    }

    const summary = "This task integrates the payment gateway for checkout v2.";

    const validateLive = ajv.compile(liveSchema);
    expect(validateLive({ idempotencyKey: "task-1", title: "Task", summary }), JSON.stringify(validateLive.errors)).toBe(true);
    expect(validateLive({ idempotencyKey: "task-1", title: "Task", summary: null })).toBe(true);
    expect(validateLive({ idempotencyKey: "task-1", title: "Task" })).toBe(true);

    const validateScenario = ajv.compile(scenarioSchema);
    expect(validateScenario({ title: "Task", summary }), JSON.stringify(validateScenario.errors)).toBe(true);

    const validateCatalog = ajv.compile(catalogSchema);
    expect(validateCatalog({ idempotencyKey: "task-2", title: "Task", summary }), JSON.stringify(validateCatalog.errors)).toBe(true);
    expect(validateCatalog({ idempotencyKey: "task-2", title: "Task", summary: null })).toBe(true);
  });
});
