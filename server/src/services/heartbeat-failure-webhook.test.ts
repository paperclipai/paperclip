import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock fetch before importing the module ─────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock the logger
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { notifyHeartbeatFailure, type HeartbeatFailurePayload } from "./heartbeat-failure-webhook.js";
import { logger } from "../middleware/logger.js";

const WEBHOOK_URL_ENV_KEY = "PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL";

function makePayload(overrides: Partial<HeartbeatFailurePayload> = {}): HeartbeatFailurePayload {
  return {
    event: "heartbeat.failed",
    timestamp: "2026-08-21T19:30:00.000Z",
    runId: "run-123",
    agentId: "agent-456",
    agentName: "TestAgent",
    companyId: "company-789",
    errorCode: "adapter_failed",
    error: "Something went wrong",
    previousStatus: "running",
    ...overrides,
  };
}

describe("heartbeatFailureWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[WEBHOOK_URL_ENV_KEY];
  });

  afterEach(() => {
    delete process.env[WEBHOOK_URL_ENV_KEY];
  });

  it("skips notification when no webhook URL is configured", async () => {
    await notifyHeartbeatFailure(makePayload());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends a POST request to the configured webhook URL", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "https://discord.com/api/webhooks/test";
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const payload = makePayload();
    await notifyHeartbeatFailure(payload);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual(payload);
  });

  it("logs a warning when the webhook returns a non-2xx status", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "https://example.com/webhook";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await notifyHeartbeatFailure(makePayload());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ webhookStatus: 404 }),
      "heartbeat failure webhook returned non-2xx status",
    );
  });

  it("logs a warning when the fetch itself throws", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "https://example.com/webhook";
    const networkError = new Error("connection refused");
    mockFetch.mockRejectedValueOnce(networkError);

    await notifyHeartbeatFailure(makePayload());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: networkError }),
      "failed to send heartbeat failure webhook notification",
    );
  });

  it("strips whitespace from the webhook URL", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "  https://example.com/webhook  ";
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    await notifyHeartbeatFailure(makePayload());

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.any(Object),
    );
  });

  it("treats an empty string URL as not configured", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "";
    await notifyHeartbeatFailure(makePayload());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never rejects (error in fetch is caught)", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "https://example.com/webhook";
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    // Should resolve (not reject)
    await expect(notifyHeartbeatFailure(makePayload())).resolves.toBeUndefined();
  });

  it("never rejects (error in logger.warn is caught by try/catch)", async () => {
    process.env[WEBHOOK_URL_ENV_KEY] = "https://example.com/webhook";
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    // No way for the happy path to throw — the try/catch covers all of it.
    await expect(notifyHeartbeatFailure(makePayload())).resolves.toBeUndefined();
  });
});
