import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { chatWebhookBodyParser } from "../middleware/chat-webhook-body.js";
import { errorHandler } from "../middleware/error-handler.js";
import { chatWebhookRoutes } from "../routes/chat-channels.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import {
  createChatWebhookDiagnostics,
  recordChatWebhookReceipt,
  recordChatWebhookStage,
  type ChatWebhookDiagnosticEvent,
} from "../services/chat-webhook-diagnostics.js";

const endpointId = "11111111-1111-4111-8111-111111111111";
const receiptId = "22222222-2222-4222-8222-222222222222";
const webhookPath = "/api/chat-webhooks/private-endpoint-url/slack";

function appWith(options: {
  events: ChatWebhookDiagnosticEvent[];
  handleWebhook?: (...args: unknown[]) => Promise<Response>;
  emit?: (event: ChatWebhookDiagnosticEvent) => void;
  now?: () => number;
  afterReceipt?: () => void;
}) {
  const app = express();
  app.use(
    createChatWebhookDiagnostics({
      emit: options.emit ?? ((event) => options.events.push(event)),
      monotonicNow: options.now,
    }),
  );
  app.use((_req, _res, next) => {
    options.afterReceipt?.();
    next();
  });
  app.use(chatWebhookBodyParser);
  app.use(
    chatWebhookRoutes({
      handleWebhook: options.handleWebhook ?? (async () => new Response("ok")),
    } as unknown as ChatChannelService),
  );
  app.use(errorHandler);
  return app;
}

describe("local chat webhook timing diagnostics", () => {
  it("separates HTTP receipt, route, runtime, committed receipt and acknowledgement without logging payloads", async () => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    let clock = 100;
    const app = appWith({
      events,
      now: () => clock,
      afterReceipt: () => {
        clock = 115;
      },
      handleWebhook: async () => {
        recordChatWebhookStage("endpoint_resolved", endpointId);
        clock = 120;
        recordChatWebhookStage("runtime_requested");
        clock = 140;
        recordChatWebhookStage("runtime_ready");
        clock = 160;
        recordChatWebhookReceipt(
          endpointId,
          receiptId,
          "message_delivery",
          new Date(1_000),
        );
        clock = 170;
        return new Response("private challenge body");
      },
    });
    const response = await request(app)
      .post(`${webhookPath}?token=private-query`)
      .set("Authorization", "Bearer private-auth")
      .set("X-Slack-Signature", "v0=private-signature")
      .set("X-Slack-Retry-Num", "2")
      .set("X-Slack-Retry-Reason", "http_timeout")
      .send({ text: "private user text", credentials: "private-credentials" });
    expect(response.status).toBe(200);
    expect(response.text).toBe("private challenge body");
    expect(events.map(({ stage, elapsedMs }) => [stage, elapsedMs])).toEqual([
      ["http_received", 0],
      ["handler_started", 15],
      ["endpoint_resolved", 15],
      ["runtime_requested", 20],
      ["runtime_ready", 40],
      ["durable_receipt", 60],
      ["response_ready", 70],
      ["response_finished", 70],
    ]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events[0]).toMatchObject({
      provider: "slack",
      slackRetryNumHint: 2,
      slackRetryReasonHint: "http_timeout",
    });
    expect(
      events.find((event) => event.stage === "durable_receipt"),
    ).toMatchObject({
      endpointId,
      receiptId,
      receiptKind: "message_delivery",
      providerSentAtMs: 1_000,
    });
    expect(events.at(-1)?.statusCode).toBe(200);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it.each([
    ["99999999999", "secret=value"],
    ["1, 2", "http_timeout, secret"],
    ["-1", ""],
    ["1.5", "HTTP_TIMEOUT"],
  ])("drops malformed retry hints %s / %s", async (num, reason) => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    await request(appWith({ events }))
      .post(webhookPath)
      .set("x-slack-retry-num", num)
      .set("x-slack-retry-reason", reason)
      .send("test");
    for (const event of events) {
      expect(event).not.toHaveProperty("slackRetryNumHint");
      expect(event).not.toHaveProperty("slackRetryReasonHint");
    }
  });

  it("does not treat another provider's Slack-like headers as retry evidence", async () => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    await request(appWith({ events }))
      .post(webhookPath.replace("slack", "telegram"))
      .set("x-slack-retry-num", "1")
      .set("x-slack-retry-reason", "http_error")
      .send("test");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.provider).toBe("telegram");
      expect(event).not.toHaveProperty("slackRetryNumHint");
      expect(event).not.toHaveProperty("slackRetryReasonHint");
    }
  });

  it("records body-parser rejection before route admission without recording body or error", async () => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    const handler = vi.fn(async () => new Response("ok"));
    const response = await request(appWith({ events, handleWebhook: handler }))
      .post(webhookPath)
      .set("Content-Encoding", "gzip")
      .send("private-body");
    expect(response.status).toBe(415);
    expect(handler).not.toHaveBeenCalled();
    expect(events.map((event) => event.stage)).toEqual([
      "http_received",
      "response_finished",
    ]);
    expect(events.at(-1)?.statusCode).toBe(415);
    expect(JSON.stringify(events)).not.toContain("private-body");
  });

  it("cannot delay or change acknowledgement when the diagnostic sink fails or returns a pending promise", async () => {
    for (const emit of [
      () => {
        throw new Error("private logger failure");
      },
      () => new Promise<void>(() => {}),
      () => Promise.reject(new Error("private async logger failure")),
    ]) {
      const response = await request(appWith({ events: [], emit }))
        .post(webhookPath)
        .send("test");
      expect(response.status).toBe(200);
      expect(response.text).toBe("ok");
    }
  });

  it("isolates concurrent requests and records a late committed receipt after a retryable acknowledgement", async () => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    let release!: () => void;
    let lateReceipt!: Promise<void>;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = appWith({
      events,
      handleWebhook: async (_publicId, provider) => {
        if (provider === "slack") {
          lateReceipt = gate.then(() =>
            recordChatWebhookReceipt(endpointId, receiptId, "message_delivery"),
          );
          return new Response("retry", { status: 503 });
        }
        return new Response("ok");
      },
    });
    const [slack, telegram] = await Promise.all([
      request(app).post(webhookPath).send("test"),
      request(app).post(webhookPath.replace("slack", "telegram")).send("test"),
    ]);
    expect(slack.status).toBe(503);
    expect(telegram.status).toBe(200);
    expect(
      events.filter((event) => event.stage === "durable_receipt"),
    ).toHaveLength(0);
    release();
    await lateReceipt;
    const receipt = events.find((event) => event.stage === "durable_receipt")!;
    const finished = events.find(
      (event) =>
        event.provider === "slack" && event.stage === "response_finished",
    )!;
    expect(receipt.requestId).toBe(finished.requestId);
    expect(receipt.provider).toBe("slack");
    expect(events.indexOf(receipt)).toBeGreaterThan(events.indexOf(finished));
    expect(new Set(events.map((event) => event.requestId)).size).toBe(2);
  });

  it("bounds and deduplicates receipt logs and ignores invalid IDs and non-webhook calls", async () => {
    const events: ChatWebhookDiagnosticEvent[] = [];
    recordChatWebhookReceipt(endpointId, receiptId, "message_delivery");
    const app = appWith({
      events,
      handleWebhook: async () => {
        recordChatWebhookStage("endpoint_resolved", "private-credential");
        recordChatWebhookReceipt(
          endpointId,
          "private-credential",
          "message_delivery",
        );
        for (let index = 0; index < 20; index++) {
          const id = `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
          recordChatWebhookReceipt(
            endpointId,
            id,
            "message_delivery",
            new Date(NaN),
          );
          recordChatWebhookReceipt(endpointId, id, "message_delivery");
        }
        return new Response("ok");
      },
    });
    await request(app).post(webhookPath).send("test");
    expect(
      events.filter((event) => event.stage === "durable_receipt"),
    ).toHaveLength(8);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events.every((event) => event.providerSentAtMs === undefined)).toBe(
      true,
    );
    const count = events.length;
    await request(app)
      .post("/api/chat-webhooks/private/unknown-provider")
      .send("test");
    expect(events).toHaveLength(count);
  });
});
