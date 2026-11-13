import { describe, expect, it } from "vitest";
import { ASSIGNED_MCP_SERVER_NAME, boundedMcpToolName } from "./mcp-tool-names.js";

describe("provider MCP name budget", () => {
  it("keeps short names compatible", () => {
    expect(boundedMcpToolName("mcp.drive-12345678:read-file", ["connection", "read_file"]))
      .toBe("mcp.drive-12345678:read-file");
  });
  it("bounds the complete provider name and retains unique, stable aliases", () => {
    const name = `mcp.app-gallery-posthog-${"a".repeat(40)}-cb60822c:file-download-batch-exports-count-rows-create`;
    const first = boundedMcpToolName(name, ["connection-one", "file_download_batch_exports_count_rows_create"]);
    expect(`mcp__${ASSIGNED_MCP_SERVER_NAME}__${first}`.length).toBeLessThanOrEqual(128);
    expect(first).toContain("file-download");
    expect(boundedMcpToolName(name, ["connection-one", "file_download_batch_exports_count_rows_create"])).toBe(first);
    expect(boundedMcpToolName(name, ["connection-two", "file_download_batch_exports_count_rows_create"])).not.toBe(first);
  });
});
