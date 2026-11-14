import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_UPLOAD_TIMEOUT_MS, createFeedbackTraceShareClientFromConfig } from "../services/feedback-share-client.js";

describe("feedback trace share client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ objectKey: "feedback-traces/test.json" }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults to telemetry.paperclip.ing when no backend url is configured", async () => {
    const client = createFeedbackTraceShareClientFromConfig({
      feedbackExportBackendUrl: undefined,
      feedbackExportBackendToken: undefined,
    });

    await client.uploadTraceBundle({
      traceId: "trace-1",
      exportId: "export-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-1",
      adapterType: "codex_local",
      captureStatus: "full",
      notes: [],
      envelope: {},
      surface: null,
      paperclipRun: null,
      rawAdapterTrace: null,
      normalizedAdapterTrace: null,
      privacy: null,
      integrity: {},
      files: [],
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://telemetry.paperclip.ing/feedback-traces",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("wraps the feedback trace payload as gzip+base64 json before upload", async () => {
    const client = createFeedbackTraceShareClientFromConfig({
      feedbackExportBackendUrl: "https://telemetry.paperclip.ing",
      feedbackExportBackendToken: "test-token",
    });

    await client.uploadTraceBundle({
      traceId: "trace-1",
      exportId: "export-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-1",
      adapterType: "codex_local",
      captureStatus: "full",
      notes: [],
      envelope: { hello: "world" },
      surface: null,
      paperclipRun: null,
      rawAdapterTrace: null,
      normalizedAdapterTrace: null,
      privacy: null,
      integrity: {},
      files: [],
    });

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe("https://telemetry.paperclip.ing/feedback-traces");
    expect(call?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
    });

    const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as {
      encoding?: string;
      payload?: string;
    };
    expect(body.encoding).toBe("gzip+base64+json");
    expect(typeof body.payload).toBe("string");

    const decoded = gunzipSync(Buffer.from(body.payload ?? "", "base64")).toString("utf8");
    const parsed = JSON.parse(decoded) as {
      objectKey: string;
      bundle: { envelope: { hello: string } };
    };
    expect(parsed.objectKey).toContain("feedback-traces/company-1/");
    expect(parsed.objectKey.endsWith("/export-1.json")).toBe(true);
    expect(parsed.bundle.envelope).toEqual({ hello: "world" });
  });
  it.each(["headers", "body"])("cancels a stalled upload at its deadline while waiting for %s", async phase => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const block = () => new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        started();
      });
      if (phase === "headers") return block();
      return { ok: true, json: block } as unknown as Response;
    });
    const client = createFeedbackTraceShareClientFromConfig({ feedbackExportBackendUrl: undefined, feedbackExportBackendToken: undefined });
    const bundle = { companyId: "company", traceId: "trace" } as Parameters<typeof client.uploadTraceBundle>[0];
    const uploading = client.uploadTraceBundle(bundle);
    const rejected = expect(uploading).rejects.toThrow("upload deadline");
    await waiting;
    expect(timeout).toHaveBeenCalledWith(FEEDBACK_UPLOAD_TIMEOUT_MS);
    deadline.abort(new Error("upload deadline"));
    await rejected;
  });

  it("passes shutdown cancellation through to a pending upload", async () => {
    const shutdown = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      started();
    }));
    const client = createFeedbackTraceShareClientFromConfig({ feedbackExportBackendUrl: undefined, feedbackExportBackendToken: undefined });
    const bundle = { companyId: "company", traceId: "trace" } as Parameters<typeof client.uploadTraceBundle>[0];
    const rejected = expect(client.uploadTraceBundle(bundle, shutdown.signal)).rejects.toThrow("shutdown");
    await waiting;
    shutdown.abort(new Error("shutdown"));
    await rejected;
  });

});
