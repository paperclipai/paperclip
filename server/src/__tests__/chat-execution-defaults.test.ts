import { describe, expect, it } from "vitest";
import { chatExecutionDefaultsSchema, updateChatEndpointSchema, replaceChatEndpointResourcesSchema } from "@paperclipai/shared";
import { resolveChatExecutionDefaults } from "../services/chat-execution-defaults.js";

const projectId = "11f01381-578d-4bb7-9de4-57e6d9678313";
const workspaceId = "13f01381-578d-4bb7-9de4-57e6d9678313";

describe("channel execution defaults", () => {
  it("leaves unconfigured channels on common task defaults", () => {
    expect(resolveChatExecutionDefaults(null, null)).toEqual({});
  });
  it("inherits omitted properties and clears explicit null independently", () => {
    expect(resolveChatExecutionDefaults({ projectId, workspace: { kind: "existing", workspaceId } }, { projectId: null }))
      .toEqual({ projectId: null, workspace: { kind: "existing", workspaceId } });
    expect(resolveChatExecutionDefaults({ projectId, workspace: { kind: "existing", workspaceId } }, { workspace: null }))
      .toEqual({ projectId, workspace: null });
  });
  it("resource task directories override endpoint shared choices", () => {
    expect(resolveChatExecutionDefaults({ workspace: { kind: "existing", workspaceId } }, { workspace: { kind: "task_directory" } }))
      .toEqual({ workspace: { kind: "task_directory" } });
  });
  it("rejects unknown fields, paths and commands rather than granting filesystem authority", () => {
    for (const input of [{ cwd: "/tmp" }, { workspace: { kind: "task_directory", command: "echo hello" } }, { projectId: "not-a-uuid" }]) {
      expect(chatExecutionDefaultsSchema.safeParse(input).success).toBe(false);
    }
  });
  it("accepts defaults through both endpoint and resource management contracts", () => {
    expect(updateChatEndpointSchema.parse({ executionDefaults: { projectId } })).toEqual({ executionDefaults: { projectId } });
    expect(replaceChatEndpointResourcesSchema.parse({ resources: [{ id: workspaceId, enabled: true, executionDefaults: { workspace: null } }] }).resources[0].executionDefaults)
      .toEqual({ workspace: null });
  });
});
