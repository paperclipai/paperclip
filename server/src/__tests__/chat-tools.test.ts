import { describe, expect, it } from "vitest";
import {
  CHAT_TOOLS,
  executeChatTool,
  getChatTool,
  listChatToolSpecs,
} from "../services/chat-tools.js";
import type { Db } from "@paperclipai/db";

function createDbStub(): Db {
  // The minimal pieces the read tools touch. Returning empty arrays everywhere
  // keeps the tests focused on the wiring/authz path rather than data shape.
  const stub = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([]);
            },
            limit() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
  return stub;
}

describe("chat-tools registry", () => {
  it("listChatToolSpecs returns one spec per tool", () => {
    const specs = listChatToolSpecs();
    expect(specs.length).toBe(CHAT_TOOLS.length);
    for (const spec of specs) {
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(spec.input_schema.type).toBe("object");
    }
  });

  it("read tools are not flagged mutating", () => {
    for (const name of [
      "list_companies",
      "get_company",
      "list_agents",
      "get_agent",
      "list_issues",
      "get_issue",
    ]) {
      const tool = getChatTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.mutating).toBe(false);
    }
  });

  it("mutating tools are flagged mutating", () => {
    for (const name of ["create_issue", "add_comment"]) {
      const tool = getChatTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.mutating).toBe(true);
    }
  });

  it("rejects unknown tool names", async () => {
    const result = await executeChatTool(
      "no_such_tool",
      {},
      { db: createDbStub(), actor: { userId: "u1", isInstanceAdmin: false, companyIds: [] }, defaultCompanyId: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown tool/);
  });

  it("rejects calls outside the actor's company scope", async () => {
    const result = await executeChatTool(
      "get_company",
      { companyId: "11111111-1111-1111-1111-111111111111" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: false, companyIds: ["other-id"] },
        defaultCompanyId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/access/i);
  });

  it("validates input via the per-tool zod schema", async () => {
    const result = await executeChatTool(
      "create_issue",
      { title: "" }, // empty title fails min(1)
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid input/);
  });

  it("set_secret tool result must never include the value (regression guard)", () => {
    // Our chat-tools registry intentionally does NOT include a set_secret tool yet
    // (deferred to a follow-up), so the registry should not surface the name.
    // If/when set_secret lands, this test should be tightened to assert that
    // the handler returns only { ok, name } and never echoes the value.
    expect(getChatTool("set_secret")).toBeUndefined();
  });
});
