import { createServer } from "node:http";
import { PassThrough } from "node:stream";

import type { DurablePrpControlPlane } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerRunnerPrpAuthority,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "./runner-prp-ws.js";

describe("runner PRP websocket route", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("routes only the registered run and releases it by generation", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3210" });
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });

    expect(registration.connectUrl).toBe(
      `ws://127.0.0.1:3210/api/runner/v1/connect/${runId}`,
    );
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(true);

    const socket = new PassThrough();
    const request = { url: `/api/runner/v1/connect/${runId}`, headers: {} };
    server.emit("upgrade", request, socket, Buffer.alloc(0));
    expect(request).toMatchObject({ paperclipWebSocketHandled: true });
    expect(handleUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: `/api/runner/v1/connect/${runId}` }),
      socket,
      `/api/runner/v1/connect/${runId}`,
      expect.any(Buffer),
    );

    await registration.release();
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(false);
    server.close();
  });

  it.each([
    ["/api/runner/v1/connect/not-a-run", "400 Bad Request"],
    [
      "/api/runner/v1/connect/00000000-0000-4000-8000-000000000778",
      "404 Not Found",
    ],
  ])("fails closed for %s", (path, expectedStatus) => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3211" });
    const socket = new PassThrough();
    const writes: Buffer[] = [];
    socket.on("data", (chunk) => writes.push(Buffer.from(chunk)));
    server.emit("upgrade", { url: path, headers: {} }, socket, Buffer.alloc(0));
    expect(Buffer.concat(writes).toString("utf8")).toContain(expectedStatus);
    server.close();
  });

  it("does not replace an active registration", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3212" });
    const runId = "00000000-0000-4000-8000-000000000779";
    const authority = {
      handleUpgrade: vi.fn(),
    } as unknown as DurablePrpControlPlane;
    const first = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority,
    });
    await expect(
      registerRunnerPrpAuthority({ companyId: "company-2", runId, authority }),
    ).rejects.toThrow("runner_prp_authority_already_registered");
    await first.release();
    server.close();
  });
});
