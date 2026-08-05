import { describe, expect, it } from "vitest";

import type { PluginPostUploadCommand, PluginSyncOperation } from "../src/protocol.js";

// Phase 1 contract test (PAP-3222 / PAP-3159 #2+#4): the sync operation carries
// an OPTIONAL, ordered `postUploadCommands` array whose absence is
// indistinguishable from today's behavior. The field is a structured control
// command — `{ command; cwd?; timeoutMs? }` — never free interpolation, and per
// Security Condition C1 may be authored ONLY by Paperclip/adapter code.
describe("PluginSyncOperation.postUploadCommands", () => {
  it("test_plugin_sync_operation_carries_ordered_post_upload_commands", () => {
    const commands: PluginPostUploadCommand[] = [
      { command: "tar -xf /runtime/asset.tar -C /runtime/asset" },
      { command: "merge-auth /runtime/asset", cwd: "/runtime/asset", timeoutMs: 30_000 },
    ];
    const operation: PluginSyncOperation = {
      operationId: "sync-op-1",
      files: [
        { sourcePath: "/host/asset", targetPath: "/runtime/asset", kind: "directory" },
      ],
      postUploadCommands: commands,
    };

    // The field is present, is the SAME ordered array we supplied, and preserves
    // order (no reordering, no rewriting of the opaque command strings).
    expect(operation.postUploadCommands).toBeDefined();
    expect(operation.postUploadCommands).toHaveLength(2);
    expect(operation.postUploadCommands?.[0]?.command).toBe(
      "tar -xf /runtime/asset.tar -C /runtime/asset",
    );
    expect(operation.postUploadCommands?.[1]).toEqual({
      command: "merge-auth /runtime/asset",
      cwd: "/runtime/asset",
      timeoutMs: 30_000,
    });
  });

  it("absent postUploadCommands is undefined (backward compatible)", () => {
    const operation: PluginSyncOperation = {
      operationId: "sync-op-2",
      files: [{ sourcePath: "/host/a", targetPath: "/runtime/a", kind: "directory" }],
    };
    expect(operation.postUploadCommands).toBeUndefined();
  });
});
