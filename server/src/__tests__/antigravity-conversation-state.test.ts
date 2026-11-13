import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgyConversationDir } from "../services/antigravity-conversation-state.js";

// The restore/preserve copy steps live in the adapter
// (@paperclipai/adapter-agy-local/server) with their tests; this file
// covers only the server-owned part: the per-agent durable path.
describe("antigravity conversation state", () => {
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", "/tmp/paperclip-home-fixture");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "brain-fixture");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it("scopes the durable directory by company, grant and agent", () => {
    const dir = resolveAgyConversationDir("company-1", "grant-2", "agent-3");
    expect(dir).toContain(path.join("ai-connections", "company-1", "grant-2", "agents", "agent-3", "antigravity-brain"));
    expect(dir).toContain("brain-fixture");
  });

  it("refuses ids that cannot be path segments", () => {
    expect(resolveAgyConversationDir("../escape", "grant-2", "agent-3")).toBeNull();
    expect(resolveAgyConversationDir("company-1", "grant/2", "agent-3")).toBeNull();
    expect(resolveAgyConversationDir("company-1", "grant-2", "agent/3")).toBeNull();
    expect(resolveAgyConversationDir("company-1", "grant-2", "")).toBeNull();
  });
});
