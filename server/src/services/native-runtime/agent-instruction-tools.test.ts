import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const binding = { companyId: "00000000-0000-4000-8000-000000000001", agentId: "00000000-0000-4000-8000-000000000002", issueId: "00000000-0000-4000-8000-000000000003", runId: "00000000-0000-4000-8000-000000000004" };

describe("dedicated canonical instruction tools", () => {
  it("advertises read, CAS update, history, and restore on ordinary native runs", () => {
    const authority = new PaperclipRunnerToolAuthority({} as Db, binding);
    const tools = authority.definitions();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "read_agent_instructions", "update_agent_instructions", "get_agent_instruction_history", "restore_agent_instructions",
    ]));
    for (const name of ["update_agent_instructions", "restore_agent_instructions"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.inputSchema).toMatchObject({ required: expect.arrayContaining(["baseRevisionId"]), additionalProperties: false });
      expect(tool.inputSchema).not.toHaveProperty("properties.responsibleUserId");
    }
  });
});
