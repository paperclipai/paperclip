import { describe, expect, it, vi } from "vitest";
import { agentJwtSecretCheck } from "./agent-jwt-secret-check.js";

vi.mock("../config/env.js", () => ({
  readAgentJwtSecretFromEnv: vi.fn(),
  resolveAgentJwtEnvFile: vi.fn(() => "/fake/.paperclip/.env"),
  readAgentJwtSecretFromEnvFile: vi.fn(),
  ensureAgentJwtSecret: vi.fn(),
}));

import {
  ensureAgentJwtSecret,
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
const mockReadEnv = vi.mocked(readAgentJwtSecretFromEnv);
const mockReadFile = vi.mocked(readAgentJwtSecretFromEnvFile);
const mockResolveEnvFile = vi.mocked(resolveAgentJwtEnvFile);
const mockEnsure = vi.mocked(ensureAgentJwtSecret);

// ============================================================================
// agentJwtSecretCheck — secret present in environment
// ============================================================================

describe("agentJwtSecretCheck — secret in environment", () => {
  it("returns pass when secret is in the environment", () => {
    mockReadEnv.mockReturnValue("supersecret");
    const result = agentJwtSecretCheck();
    expect(result.status).toBe("pass");
  });

  it("sets name to 'Agent JWT secret'", () => {
    mockReadEnv.mockReturnValue("supersecret");
    const result = agentJwtSecretCheck();
    expect(result.name).toBe("Agent JWT secret");
  });

  it("does not check the file when env has the secret", () => {
    mockReadEnv.mockReturnValue("supersecret");
    agentJwtSecretCheck();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

// ============================================================================
// agentJwtSecretCheck — secret in .env file but not in environment
// ============================================================================

describe("agentJwtSecretCheck — secret in .env file only", () => {
  it("returns warn when secret is in the file but not the environment", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue("file-secret");
    const result = agentJwtSecretCheck();
    expect(result.status).toBe("warn");
  });

  it("includes the file path in the warn message", () => {
    mockReadEnv.mockReturnValue(null);
    mockResolveEnvFile.mockReturnValue("/home/.paperclip/.env");
    mockReadFile.mockReturnValue("file-secret");
    const result = agentJwtSecretCheck();
    expect(result.message).toContain("/home/.paperclip/.env");
  });

  it("includes a repairHint mentioning the file path", () => {
    mockReadEnv.mockReturnValue(null);
    mockResolveEnvFile.mockReturnValue("/home/.paperclip/.env");
    mockReadFile.mockReturnValue("file-secret");
    const result = agentJwtSecretCheck();
    expect(result.repairHint).toContain("/home/.paperclip/.env");
  });
});

// ============================================================================
// agentJwtSecretCheck — secret missing from both env and file
// ============================================================================

describe("agentJwtSecretCheck — secret missing everywhere", () => {
  it("returns fail when secret is not in env or file", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue(null);
    const result = agentJwtSecretCheck();
    expect(result.status).toBe("fail");
  });

  it("sets canRepair to true", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue(null);
    const result = agentJwtSecretCheck();
    expect(result.canRepair).toBe(true);
  });

  it("includes the env file path in the fail message", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue(null);
    mockResolveEnvFile.mockReturnValue("/home/.paperclip/.env");
    const result = agentJwtSecretCheck();
    expect(result.message).toContain("/home/.paperclip/.env");
  });

  it("repair function calls ensureAgentJwtSecret", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue(null);
    const result = agentJwtSecretCheck();
    result.repair?.();
    expect(mockEnsure).toHaveBeenCalled();
  });

  it("repairHint mentions --repair flag", () => {
    mockReadEnv.mockReturnValue(null);
    mockReadFile.mockReturnValue(null);
    const result = agentJwtSecretCheck();
    expect(result.repairHint).toContain("--repair");
  });
});
