import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";

// Mock global fetch before importing anything that uses it
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the context resolution modules
vi.mock("../../client/context.js", () => ({
  readContext: vi.fn(() => ({})),
  resolveProfile: vi.fn(() => ({
    name: "default",
    profile: { apiBase: "http://localhost:3100" },
  })),
}));

vi.mock("../../client/board-auth.js", () => ({
  getStoredBoardCredential: vi.fn(() => null),
  loginBoardCli: vi.fn(),
}));

vi.mock("../../config/store.js", () => ({
  readConfig: vi.fn(() => ({ server: { port: 3100 } })),
}));

// Sample agent data for tests
const sampleAgent = {
  id: "test-agent-id",
  name: "Test Agent",
  role: "developer",
  status: "active",
  companyId: "test-company-id",
  urlKey: "test-agent",
  reportsTo: null,
  budgetMonthlyCents: 10000,
  spentMonthlyCents: 5000,
  env: {
    OPENAI_API_KEY: "***",
    PAPERCLIP_API_URL: "http://localhost:3100",
    SOME_SAFE_VALUE: "visible",
  },
  config: {
    model: "gpt-4",
    temperature: 0.7,
  },
};

const redactedAgent = {
  id: "test-agent-id",
  name: "Test Agent",
  role: "developer",
  status: "active",
  companyId: "test-company-id",
  urlKey: "test-agent",
  reportsTo: null,
  budgetMonthlyCents: 10000,
  spentMonthlyCents: 5000,
  env: {
    OPENAI_API_KEY: "***",
    PAPERCLIP_API_URL: "http://localhost:3100",
    SOME_SAFE_VALUE: "visible",
  },
  config: {
    model: "gpt-4",
    temperature: 0.7,
  },
};

function makeProgram() {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerAgentCommands(program);
  return program;
}

describe("agent get command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Recreate console spy each test since afterEach restores it
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full agent config without --redact flag", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(sampleAgent)),
    });

    const program = makeProgram();

    await program.parseAsync(
      ["agent", "get", "test-agent-id", "--api-key", "test-key"],
      { from: "user" },
    );

    // Verify the correct endpoint was called (not the /configuration endpoint)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/test-agent-id"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer test-key",
        }),
      }),
    );

    // Verify the URL does NOT contain /configuration
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("/configuration");

    // Verify output contains the full agent data
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(sampleAgent, null, 2));
  });

  it("calls /configuration endpoint with --redact flag", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(redactedAgent)),
    });

    const program = makeProgram();

    await program.parseAsync(
      ["agent", "get", "test-agent-id", "--redact", "--api-key", "test-key"],
      { from: "user" },
    );

    // Verify the /configuration endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/test-agent-id/configuration"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("omits sensitive env values when using --redact", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(redactedAgent)),
    });

    const program = makeProgram();

    await program.parseAsync(
      ["agent", "get", "test-agent-id", "--redact", "--api-key", "test-key"],
      { from: "user" },
    );

    // Verify the /configuration endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agents/test-agent-id/configuration"),
      expect.objectContaining({
        method: "GET",
      }),
    );

    // Verify output was logged
    expect(logSpy).toHaveBeenCalled();
    const logOutput = logSpy.mock.calls[0]?.[0];
    expect(typeof logOutput).toBe("string");
    const outputData = JSON.parse(logOutput as string);

    // Sensitive values should be redacted
    expect(outputData.env.OPENAI_API_KEY).toBe("***");

    // Non-sensitive values should still be visible
    expect(outputData.env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect(outputData.env.SOME_SAFE_VALUE).toBe("visible");
  });

  it("handles API errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({ error: "Agent not found" })),
    });

    const program = makeProgram();

    await expect(
      program.parseAsync(
        ["agent", "get", "nonexistent-agent", "--api-key", "test-key"],
        { from: "user" },
      ),
    ).rejects.toThrow();
  });
});
