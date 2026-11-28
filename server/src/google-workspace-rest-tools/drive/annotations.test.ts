import { describe, expect, it } from "vitest";
import { DRIVE_TOOLS } from "./index.js";

const READS = ["search_files", "list_recent_files", "get_file_metadata", "get_file_permissions", "read_file_content", "download_file_content"];
const CREATES = ["create_file", "copy_file"];

describe("Drive tool annotations", () => {
  it("covers every Drive tool", () => {
    expect(DRIVE_TOOLS.map((tool) => tool.definition.name).sort()).toEqual([...READS, ...CREATES].sort());
  });

  it.each(READS)("%s is a read-only, idempotent, non-destructive tool", (name) => {
    const tool = DRIVE_TOOLS.find((candidate) => candidate.definition.name === name)!;
    expect(tool.definition.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it.each(CREATES)("%s is a write that is not idempotent; it only creates new files, so it is not destructive", (name) => {
    const tool = DRIVE_TOOLS.find((candidate) => candidate.definition.name === name)!;
    expect(tool.definition.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });
});
