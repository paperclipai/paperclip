import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareBobPromptBundle } from "./prompt-cache.js";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

describe("prepareBobPromptBundle", () => {
  let tempDir: string;
  let mockOnLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bob-prompt-cache-test-"));
    mockOnLog = async () => {};
    
    // Set test environment
    process.env.PAPERCLIP_HOME = tempDir;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  it("should generate a stable bundle key for the same inputs", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: "Test capabilities",
      mode: "paperclip-agent",
      modeConfig: { customInstructions: "Test instructions" },
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: "Test instructions content",
      onLog: mockOnLog,
    };

    const bundle1 = await prepareBobPromptBundle(input);
    const bundle2 = await prepareBobPromptBundle(input);

    expect(bundle1.bundleKey).toBe(bundle2.bundleKey);
  });

  it("should generate different bundle keys for different inputs", async () => {
    const baseInput = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: "Test capabilities",
      mode: "paperclip-agent",
      modeConfig: { customInstructions: "Test instructions" },
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: "Test instructions content",
      onLog: mockOnLog,
    };

    const bundle1 = await prepareBobPromptBundle(baseInput);
    const bundle2 = await prepareBobPromptBundle({
      ...baseInput,
      instructionsContents: "Different instructions",
    });

    expect(bundle1.bundleKey).not.toBe(bundle2.bundleKey);
  });

  it("should create the correct directory structure", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);

    // Check that directories exist
    const bobDirExists = await fs.access(bundle.bobDir).then(() => true).catch(() => false);
    expect(bobDirExists).toBe(true);

    const rulesDirExists = await fs.access(path.join(bundle.bobDir, "rules-paperclip-agent"))
      .then(() => true)
      .catch(() => false);
    expect(rulesDirExists).toBe(true);
  });

  it("should create custom_modes.yaml with correct content", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: "I am a test agent",
      mode: "paperclip-agent",
      modeConfig: { customInstructions: "Custom test instructions" },
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);
    const customModesPath = path.join(bundle.bobDir, "custom_modes.yaml");
    const content = await fs.readFile(customModesPath, "utf-8");

    expect(content).toContain("paperclip-agent:");
    expect(content).toContain('name: "Test Agent"');
    expect(content).toContain("I am a test agent");
    expect(content).toContain("Custom test instructions");
  });

  it("should create mcp.json with correct content", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);
    const mcpJsonPath = path.join(bundle.bobDir, "mcp.json");
    const content = await fs.readFile(mcpJsonPath, "utf-8");
    const mcpConfig = JSON.parse(content);

    expect(mcpConfig.paperclip).toBeDefined();
    expect(mcpConfig.paperclip.command).toBe("npx");
    expect(mcpConfig.paperclip.args).toContain("@paperclipai/mcp-server");
    expect(mcpConfig.paperclip.env.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(mcpConfig.paperclip.env.PAPERCLIP_AGENT_ID).toBe("agent-1");
  });

  it("should create rule files", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);
    const rulesDir = path.join(bundle.bobDir, "rules-paperclip-agent");

    // Check core rule files exist
    const coreRulesExist = await fs.access(path.join(rulesDir, "01-core.md"))
      .then(() => true)
      .catch(() => false);
    expect(coreRulesExist).toBe(true);

    const repoRulesExist = await fs.access(path.join(rulesDir, "02-repo.md"))
      .then(() => true)
      .catch(() => false);
    expect(repoRulesExist).toBe(true);

    const taskingRulesExist = await fs.access(path.join(rulesDir, "03-tasking.md"))
      .then(() => true)
      .catch(() => false);
    expect(taskingRulesExist).toBe(true);
  });

  it("should write instructions file when provided", async () => {
    const instructionsContent = "# Agent Instructions\n\nTest instructions content";
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: instructionsContent,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);

    expect(bundle.instructionsFilePath).not.toBeNull();
    if (bundle.instructionsFilePath) {
      const content = await fs.readFile(bundle.instructionsFilePath, "utf-8");
      expect(content).toBe(instructionsContent);
    }
  });

  it("should not create instructions file when not provided", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);

    expect(bundle.instructionsFilePath).toBeNull();
  });

  it("should reuse existing bundle when called with same inputs", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {},
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: "Test instructions",
      onLog: mockOnLog,
    };

    const bundle1 = await prepareBobPromptBundle(input);
    
    // Add a marker file to verify reuse
    const markerPath = path.join(bundle1.rootDir, "marker.txt");
    await fs.writeFile(markerPath, "test marker");

    const bundle2 = await prepareBobPromptBundle(input);

    expect(bundle1.bundleKey).toBe(bundle2.bundleKey);
    expect(bundle1.rootDir).toBe(bundle2.rootDir);

    // Verify marker file still exists (bundle was reused)
    const markerExists = await fs.access(markerPath).then(() => true).catch(() => false);
    expect(markerExists).toBe(true);
  });

  it("should handle mode config with tool groups", async () => {
    const input = {
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Test Agent",
      agentCapabilities: null,
      mode: "paperclip-agent",
      modeConfig: {
        toolGroups: ["read", "edit", "command"],
      },
      skills: [] as PaperclipSkillEntry[],
      instructionsContents: null,
      onLog: mockOnLog,
    };

    const bundle = await prepareBobPromptBundle(input);
    const customModesPath = path.join(bundle.bobDir, "custom_modes.yaml");
    const content = await fs.readFile(customModesPath, "utf-8");

    expect(content).toContain("tool_groups:");
    expect(content).toContain("- read");
    expect(content).toContain("- edit");
    expect(content).toContain("- command");
  });
});
