import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { issueDocumentKeySchema } from "@paperclipai/shared";
import { documentService } from "../documents.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { RUNNER_BRIDGE_SCHEMAS, runnerBridgeDefinitions } from "./runner-bridge-tools.js";

const binding = {
  companyId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  issueId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  casesEnabled: true,
};
const trimWhitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const keys = [
  "reconciliation",
  "reconciliation.md",
  "a".repeat(64),
  "a".repeat(65),
  "Reconciliation",
  `${trimWhitespace}${"a".repeat(64)}${trimWhitespace}`,
  "K",
  "K".repeat(64),
  "K".repeat(65),
  " a-b_1 ",
  `\ufeff\u00a0\u2003${"a".repeat(64)}\r\n`,
  " ".repeat(56) + "a".repeat(64),
  "",
  " \ufeff",
  "../document",
  "a/b",
  "Research:v1.notes",
  "\u0085key\u0085",
  "_key",
  "-key",
  "a\u0000",
];
const operations = ["read_document", "write_document", "list_document_revisions"] as const;
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
const definitions = new PaperclipRunnerToolAuthority({} as Db, binding).definitions();
const bridgeDefinitions = runnerBridgeDefinitions({ workspace: false, skills: false, api: true, mode: "standard" });
const bridgeKeys = [...keys, " ".repeat(36) + "a".repeat(64), " ".repeat(37) + "a".repeat(64)];
function input(operation: string, key: string) {
  return operation === "write_document"
    ? { idempotencyKey: "synthetic", key, title: "Synthetic", body: "Synthetic", baseRevisionId: null }
    : { key };
}

describe("ordinary task-document key contract parity", () => {
  it.each(["read_task_document", "write_task_document"].flatMap(operation => bridgeKeys.map(key => [operation, key] as const)))(
    "%s advertises and validates the real service key contract for %j", async (operation, key) => {
      const validServiceKey = issueDocumentKeySchema.safeParse(key.trim().toLowerCase()).success;
      const expected = key.length <= 100 && validServiceKey;
      const args = operation === "read_task_document" ? { taskId: binding.issueId, key }
        : { taskId: binding.issueId, key, title: "Synthetic", body: "Synthetic", baseRevisionId: null };
      const tool = bridgeDefinitions.find(definition => definition.name === operation)!;
      expect(ajv.validate(tool.inputSchema as object, args), JSON.stringify(ajv.errors)).toBe(expected);
      expect(RUNNER_BRIDGE_SCHEMAS.get(operation)!.safeParse(args).success).toBe(expected);
      const select = vi.fn(() => { throw new Error("synthetic_database_boundary"); });
      const service = documentService({ select } as unknown as Db);
      const call = operation === "read_task_document" ? service.getIssueDocumentByKey(binding.issueId, key)
        : service.upsertIssueDocument({ issueId: binding.issueId, key, title: "Synthetic", format: "markdown", body: "Synthetic", baseRevisionId: null });
      await expect(call).rejects.toThrow(validServiceKey ? "synthetic_database_boundary" : "Invalid document key");
      expect(select).toHaveBeenCalledTimes(validServiceKey ? 1 : 0);
    },
  );
  it.each(operations.flatMap(operation => keys.map(key => [operation, key] as const)))(
    "%s matches real normalization for %j",
    async (operation, key) => {
      const expected = issueDocumentKeySchema.safeParse(key.trim().toLowerCase()).success;
      const tool = definitions.find(definition => definition.name === operation)!;
      expect(ajv.validate(tool.inputSchema as object, input(operation, key)), JSON.stringify(ajv.errors)).toBe(expected);
      const select = vi.fn(() => {
        throw new Error("synthetic_database_boundary");
      });
      const service = documentService({ select } as unknown as Db);
      const call = operation === "read_document"
        ? service.getIssueDocumentByKey(binding.issueId, key)
        : operation === "list_document_revisions"
          ? service.listIssueDocumentRevisions(binding.issueId, key)
          : service.upsertIssueDocument({
            issueId: binding.issueId,
            key,
            title: "Synthetic",
            format: "markdown",
            body: "Synthetic",
            baseRevisionId: null,
          });
      await expect(call).rejects.toThrow(expected ? "synthetic_database_boundary" : "Invalid document key");
      expect(select).toHaveBeenCalledTimes(expected ? 1 : 0);
    },
  );

  it.each(operations)("%s retains the existing raw-input cap independently of normalization", operation => {
    const key = " ".repeat(57) + "a".repeat(64);
    expect(issueDocumentKeySchema.safeParse(key.trim().toLowerCase()).success).toBe(true);
    const tool = definitions.find(definition => definition.name === operation)!;
    expect(ajv.validate(tool.inputSchema as object, input(operation, key))).toBe(false);
  });

  it("keeps historical case keys distinct from ordinary task-document keys", () => {
    const tool = definitions.find(definition => definition.name === "read_case")!;
    for (const documentKey of ["Research:v1.notes", "a".repeat(120)]) {
      expect(ajv.validate(tool.inputSchema as object, { section: "document", documentKey }), JSON.stringify(ajv.errors)).toBe(true);
    }
  });
});
