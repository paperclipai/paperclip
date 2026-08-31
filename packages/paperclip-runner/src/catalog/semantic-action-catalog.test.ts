import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

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
  it("defines one immutable v1 declaration for each Codex-spine action", () => {
    const operationIds = PAPERCLIP_SEMANTIC_ACTION_CATALOG.map(
      (action) => action.operationId,
    );

    expect(operationIds).toHaveLength(27);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).not.toContain("generic_api_request");
    expect(Object.isFrozen(PAPERCLIP_SEMANTIC_ACTION_CATALOG)).toBe(true);
    expect(
      Object.isFrozen(paperclipSemanticAction("write_document")?.inputSchema),
    ).toBe(true);
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
});
