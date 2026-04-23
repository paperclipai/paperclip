import { describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { portCheck } from "./port-check.js";

vi.mock("../utils/net.js", () => ({
  checkPort: vi.fn(),
}));

import { checkPort } from "../utils/net.js";
const mockCheckPort = vi.mocked(checkPort);

// Helper: create a minimal config stub with just the port field needed
function makeConfig(port: number): PaperclipConfig {
  return { server: { port } } as unknown as PaperclipConfig;
}

// ============================================================================
// portCheck — port available
// ============================================================================

describe("portCheck — port available", () => {
  it("returns pass status when port is available", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: true });
    const result = await portCheck(makeConfig(3100));
    expect(result.status).toBe("pass");
  });

  it("sets name to 'Server port'", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: true });
    const result = await portCheck(makeConfig(3100));
    expect(result.name).toBe("Server port");
  });

  it("message includes the port number", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: true });
    const result = await portCheck(makeConfig(8080));
    expect(result.message).toContain("8080");
  });

  it("calls checkPort with the configured port", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: true });
    await portCheck(makeConfig(4567));
    expect(mockCheckPort).toHaveBeenCalledWith(4567);
  });
});

// ============================================================================
// portCheck — port unavailable
// ============================================================================

describe("portCheck — port unavailable", () => {
  it("returns warn status when port is not available", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: false });
    const result = await portCheck(makeConfig(3100));
    expect(result.status).toBe("warn");
  });

  it("includes the port in the message when no error string is provided", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: false });
    const result = await portCheck(makeConfig(3100));
    expect(result.message).toContain("3100");
  });

  it("uses the error string from checkPort result when present", async () => {
    mockCheckPort.mockResolvedValueOnce({
      available: false,
      error: "port already in use by pid 1234",
    });
    const result = await portCheck(makeConfig(3100));
    expect(result.message).toBe("port already in use by pid 1234");
  });

  it("sets canRepair to false", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: false });
    const result = await portCheck(makeConfig(3100));
    expect(result.canRepair).toBe(false);
  });

  it("includes repairHint with lsof command", async () => {
    mockCheckPort.mockResolvedValueOnce({ available: false });
    const result = await portCheck(makeConfig(3100));
    expect(result.repairHint).toContain("lsof");
    expect(result.repairHint).toContain("3100");
  });
});
