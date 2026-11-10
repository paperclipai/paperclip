import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpApiDispatch } from "../services/public-mcp/capabilities.js";
import type { McpPrincipal } from "../services/public-mcp/oauth.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());
const trackErrorHandlerCrashMock = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({}) }));
vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: trackErrorHandlerCrashMock,
}));

const principal = { actor: { type: "board", userId: "user-1" } } as unknown as McpPrincipal;

// The internal dispatch runs each public MCP call in its own Express app, so
// the shutdown flag set on the main app must reach that app's error handler.
function endedPoolApi() {
  const api = express.Router();
  api.get("/tasks", () => {
    throw new Error('Failed query: select "id" from "issues"', {
      cause: Object.assign(new Error("write CONNECTION_ENDED db.example:5432"), { code: "CONNECTION_ENDED" }),
    });
  });
  return api;
}

describe("public MCP dispatch during database shutdown", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    trackErrorHandlerCrashMock.mockReset();
  });

  it("does not report a call that outlived the database pool", async () => {
    const parentLocals: Record<string, unknown> = {};
    const dispatch = createMcpApiDispatch(endedPoolApi(), parentLocals);
    parentLocals.paperclipDatabaseClosing = true;

    await expect(dispatch(principal, "GET", "/tasks", undefined)).rejects.toMatchObject({ status: 503 });
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(trackErrorHandlerCrashMock).not.toHaveBeenCalled();
  });

  it("still reports an ended-pool error outside database shutdown", async () => {
    const dispatch = createMcpApiDispatch(endedPoolApi(), {});

    await expect(dispatch(principal, "GET", "/tasks", undefined)).rejects.toMatchObject({ status: 500 });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
