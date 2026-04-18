import { describe, it, expect } from "vitest";
import { PAPERCLIP_TOOLS } from "../src/server/tools.js";

describe("PAPERCLIP_TOOLS", () => {
  it("defines 18 tools across 3 categories", () => {
    expect(PAPERCLIP_TOOLS.length).toBe(18);
  });

  it("has all tools with OpenAI function calling shape", () => {
    for (const tool of PAPERCLIP_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("includes all 8 Paperclip API tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("paperclip_get_identity");
    expect(names).toContain("paperclip_get_inbox");
    expect(names).toContain("paperclip_checkout_issue");
    expect(names).toContain("paperclip_update_issue");
    expect(names).toContain("paperclip_add_comment");
    expect(names).toContain("paperclip_get_issue_context");
    expect(names).toContain("paperclip_get_comments");
    expect(names).toContain("paperclip_create_subtask");
  });

  it("includes all 5 filesystem tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("fs_read_file");
    expect(names).toContain("fs_write_file");
    expect(names).toContain("fs_list_directory");
    expect(names).toContain("fs_glob");
    expect(names).toContain("fs_grep");
  });

  it("includes all 5 shell/git tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("shell_exec");
    expect(names).toContain("git_status");
    expect(names).toContain("git_diff");
    expect(names).toContain("git_commit");
    expect(names).toContain("git_log");
  });
});
