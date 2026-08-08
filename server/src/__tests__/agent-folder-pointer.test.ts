import { describe, expect, it, vi } from "vitest";
import { writeAgentFolderPointerFile, removeAgentFolderPointerFile, resolveFolderInstructionsDir } from "../services/agent-instructions-inheritance.js";
import type { AgentLikeForInheritance } from "../services/agent-instructions-inheritance.js";

// Mock fs operations
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

// Mock resolvePaperclipInstanceRootForAdapter so resolveFolderInstructionsDir uses a temp path
vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  resolvePaperclipInstanceRootForAdapter: vi.fn().mockReturnValue("/tmp/paperclip-test"),
  readPaperclipSkillSyncPreference: vi.fn(),
  writePaperclipSkillSyncPreference: vi.fn(),
  isForbiddenConfigEnvKey: vi.fn(),
  parseObject: vi.fn(),
}));

const TEST_AGENT: AgentLikeForInheritance = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  companyId: "123e4567-e89b-12d3-a456-426614174001",
  name: "TestAgent",
  adapterConfig: {},
  folderId: "123e4567-e89b-12d3-a456-426614174002",
};

describe("agent folder pointer files", () => {
  it("writes a pointer file for a new agent in a folder", async () => {
    const result = await writeAgentFolderPointerFile(TEST_AGENT, TEST_AGENT.folderId!);
    expect(result).toContain(TEST_AGENT.id);
    expect(result).toMatch(/\.md$/);
  });

  it("removes a pointer file without throwing when folder/agent changes", async () => {
    await expect(
      removeAgentFolderPointerFile(TEST_AGENT.companyId, TEST_AGENT.folderId!, TEST_AGENT.id),
    ).resolves.toBeUndefined();
  });

  it("writes null-override marker when no override instructions provided", async () => {
    const result = await writeAgentFolderPointerFile(TEST_AGENT, TEST_AGENT.folderId!);
    expect(result).toContain(TEST_AGENT.id);
  });

  it("resolves folder instructions dir consistently", () => {
    const dir = resolveFolderInstructionsDir(TEST_AGENT.companyId, TEST_AGENT.folderId!);
    expect(dir).toContain(TEST_AGENT.companyId);
    expect(dir).toContain(TEST_AGENT.folderId);
  });
});
