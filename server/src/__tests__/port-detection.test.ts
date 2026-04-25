import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectPortMock } = vi.hoisted(() => ({
  detectPortMock: vi.fn(),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

import { detectAvailablePort } from "../port-detection.js";

describe("detectAvailablePort", () => {
  beforeEach(() => {
    detectPortMock.mockReset();
  });

  it("probes only the configured host when one is provided", async () => {
    detectPortMock.mockResolvedValue(3100);

    await expect(detectAvailablePort(3100, "127.0.0.1")).resolves.toBe(3100);

    expect(detectPortMock).toHaveBeenCalledWith({
      port: 3100,
      hostname: "127.0.0.1",
    });
  });

  it("falls back to default detect-port probing when host is blank", async () => {
    detectPortMock.mockResolvedValue(3101);

    await expect(detectAvailablePort(3100, "  ")).resolves.toBe(3101);

    expect(detectPortMock).toHaveBeenCalledWith(3100);
  });

  it("falls back to default detect-port probing when host is undefined", async () => {
    detectPortMock.mockResolvedValue(3102);

    await expect(detectAvailablePort(3100)).resolves.toBe(3102);

    expect(detectPortMock).toHaveBeenCalledWith(3100);
  });
});
