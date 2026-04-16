import { beforeEach, describe, expect, it, vi } from "vitest";

const detectPortMock = vi.fn();

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

describe("selectAvailableDevRunnerPort", () => {
  beforeEach(() => {
    detectPortMock.mockReset();
  });

  it("keeps the requested port when both server and HMR ports are free", async () => {
    detectPortMock.mockImplementation(async (input: number | { port: number }) =>
      typeof input === "number" ? input : input.port);

    const { selectAvailableDevRunnerPort } = await import("../dev-server-ports.js");
    const selection = await selectAvailableDevRunnerPort(3100);

    expect(selection).toEqual({
      requestedPort: 3100,
      selectedPort: 3100,
      hmrPort: 13_100,
      attempts: 1,
    });
    expect(detectPortMock).toHaveBeenNthCalledWith(1, { port: 3100, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(2, { port: 13_100, hostname: "0.0.0.0" });
  });

  it("moves to the next free port when the requested server port is busy", async () => {
    detectPortMock
      .mockResolvedValueOnce(3101)
      .mockImplementation(async (input: number | { port: number }) =>
        typeof input === "number" ? input : input.port);

    const { selectAvailableDevRunnerPort } = await import("../dev-server-ports.js");
    const selection = await selectAvailableDevRunnerPort(3100);

    expect(selection).toEqual({
      requestedPort: 3100,
      selectedPort: 3101,
      hmrPort: 13_101,
      attempts: 2,
    });
    expect(detectPortMock).toHaveBeenNthCalledWith(1, { port: 3100, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(2, { port: 3101, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(3, { port: 13_101, hostname: "0.0.0.0" });
  });

  it("moves to the next free port when the HMR port is busy", async () => {
    detectPortMock.mockImplementation(async (input: number | { port: number }) => {
      const port = typeof input === "number" ? input : input.port;
      if (port === 13_100) {
        return 13_101;
      }
      return port;
    });

    const { selectAvailableDevRunnerPort } = await import("../dev-server-ports.js");
    const selection = await selectAvailableDevRunnerPort(3100);

    expect(selection).toEqual({
      requestedPort: 3100,
      selectedPort: 3101,
      hmrPort: 13_101,
      attempts: 2,
    });
    expect(detectPortMock).toHaveBeenNthCalledWith(1, { port: 3100, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(2, { port: 13_100, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(3, { port: 3101, hostname: "0.0.0.0" });
    expect(detectPortMock).toHaveBeenNthCalledWith(4, { port: 13_101, hostname: "0.0.0.0" });
  });
});
