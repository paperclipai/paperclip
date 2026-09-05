import { describe, expect, it, vi } from "vitest";
import {
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
  type ProductFeedbackRelayRequest,
} from "@paperclipai/shared";
import { createHttpProductFeedbackRelay, ProductFeedbackRelayError } from "./product-feedback-relay.js";

const request: ProductFeedbackRelayRequest = {
  schemaVersion: PRODUCT_FEEDBACK_SCHEMA_VERSION,
  submissionId: "123e4567-e89b-42d3-a456-426614174000",
  submittedAt: "2026-09-03T12:00:00.000Z",
  feedback: "Please make review status clearer.",
  followUpConsent: false,
  context: {
    routeTemplate: "/company/issues",
    appVersion: "2026.9.3",
    deploymentMode: "local_trusted" as const,
    browser: "Chrome 151",
    operatingSystem: "macOS 15",
    diagnostics: [],
  },
};

describe("product feedback relay", () => {
  it("posts the strict payload to the fixed telemetry endpoint without credentials", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      new Response(JSON.stringify({
        ok: true,
        duplicate: false,
        submissionId: request.submissionId,
        receiptId: "223e4567-e89b-42d3-a456-426614174000",
      }), { status: 202, headers: { "Content-Type": "application/json" } })
    ));

    const receipt = await createHttpProductFeedbackRelay(fetchImpl as typeof fetch).submit(request);

    expect(receipt.receiptId).toBe("223e4567-e89b-42d3-a456-426614174000");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://telemetry.paperclip.ing/product-feedback",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify(request),
      }),
    );
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("PostHog");
  });

  it("fails closed on downstream errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(createHttpProductFeedbackRelay(fetchImpl as typeof fetch).submit(request))
      .rejects.toEqual(new ProductFeedbackRelayError(503));
  });

  it("rejects oversized response bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", {
      status: 202,
      headers: { "content-length": String(16 * 1024 + 1) },
    }));
    await expect(createHttpProductFeedbackRelay(fetchImpl as typeof fetch).submit(request))
      .rejects.toThrow("product_feedback_response_too_large");
  });
});
