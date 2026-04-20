import { afterEach, describe, expect, it, vi } from "vitest";
import { startDevRunnerControlServer } from "../dev-runner-control-server.js";

describe("dev runner control server", () => {
  const startedServers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(startedServers.splice(0).map((server) => server.close()));
  });

  it("accepts restart requests from the active board origin", async () => {
    const onRestartRequested = vi.fn();
    const server = await startDevRunnerControlServer({
      port: 0,
      getAllowedOrigins: () => ["http://127.0.0.1:3102"],
      onRestartRequested,
    });
    startedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.listenPort}/restart`, {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3102",
        "Content-Type": "text/plain",
      },
      body: "",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });

    await vi.waitFor(() => {
      expect(onRestartRequested).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects restart requests from unexpected origins", async () => {
    const onRestartRequested = vi.fn();
    const server = await startDevRunnerControlServer({
      port: 0,
      getAllowedOrigins: () => ["http://127.0.0.1:3102"],
      onRestartRequested,
    });
    startedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.listenPort}/restart`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        "Content-Type": "text/plain",
      },
      body: "",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origin not allowed" });
    expect(onRestartRequested).not.toHaveBeenCalled();
  });

  it("accepts restart requests from dynamic private-network origins when allowed by predicate", async () => {
    const onRestartRequested = vi.fn();
    const server = await startDevRunnerControlServer({
      port: 0,
      getAllowedOrigins: () => [],
      isOriginAllowed: (origin) => origin === "http://10.90.10.20:3102",
      onRestartRequested,
    });
    startedServers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.listenPort}/restart`, {
      method: "POST",
      headers: {
        Origin: "http://10.90.10.20:3102",
        "Content-Type": "text/plain",
      },
      body: "",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    await vi.waitFor(() => {
      expect(onRestartRequested).toHaveBeenCalledTimes(1);
    });
  });
});
