import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../../packages/plugins/examples/plugin-slack-notifier-example/src/worker.js";

describe("slack notifier example worker", () => {
  it("returns an ok health payload", async () => {
    const result = await worker.definition.onHealth?.();
    expect(result).toEqual({
      status: "ok",
      message: "Slack notifier example plugin ready",
    });
  });

  describe("onValidateConfig", () => {
    it("fails if webhookSecretRef is missing", async () => {
      const result = await worker.definition.onValidateConfig?.({});
      expect(result).toEqual({ ok: false, errors: ["webhookSecretRef is required"] });
    });

    it("passes with valid config", async () => {
      const result = await worker.definition.onValidateConfig?.({ webhookSecretRef: "SLACK_WEBHOOK" });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("setup and event handling", () => {
    let ctx: any;
    let eventHandlers: Record<string, (event: any) => Promise<void>> = {};

    beforeEach(() => {
      eventHandlers = {};
      ctx = {
        config: {
          get: vi.fn().mockResolvedValue({ webhookSecretRef: "SLACK_WEBHOOK" }),
        },
        logger: {
          warn: vi.fn(),
          error: vi.fn(),
        },
        http: {
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue("ok"),
          }),
        },
        metrics: {
          write: vi.fn(),
        },
        activity: {
          log: vi.fn(),
        },
        state: {
          set: vi.fn(),
        },
        events: {
          on: vi.fn((name, handler) => {
            eventHandlers[name] = handler;
          }),
        },
        secrets: {
          resolve: vi.fn().mockResolvedValue("https://hooks.slack.com/services/T000/B000/XXX"),
        },
      };
    });

    const triggerEvent = async (name: string, payload: any) => {
      const handler = eventHandlers[name];
      if (!handler) throw new Error(`No handler registered for event: ${name}`);
      await handler(payload);
    };

    it("logs activity only after a successful delivery", async () => {
      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.finished", {
        eventType: "agent.run.finished",
        entityId: "run-123",
        companyId: "comp-1",
      });

      expect(ctx.metrics.write).toHaveBeenCalledWith("slack_notifications_sent", 1);
      expect(ctx.activity.log).toHaveBeenCalledWith(expect.objectContaining({
        entityType: "run",
        entityId: "run-123",
      }));
    });

    it("treats non-ok webhook responses as delivery failures", async () => {
      ctx.http.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal Server Error"),
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.finished", {
        eventType: "agent.run.finished",
        entityId: "run-123",
        companyId: "comp-1",
      });

      expect(ctx.metrics.write).toHaveBeenCalledWith("slack_notification_failures", 1);
      expect(ctx.activity.log).not.toHaveBeenCalled();
      expect(ctx.logger.error).toHaveBeenCalledWith("Slack notifier delivery failed", expect.objectContaining({
        error: expect.stringContaining("500"),
      }));
    });

    it("skips state updates when comment delivery fails", async () => {
      ctx.http.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal Server Error"),
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("issue.comment.created", {
        eventType: "issue.comment.created",
        entityId: "issue-456",
        occurredAt: new Date().toISOString(),
      });

      expect(ctx.state.set).not.toHaveBeenCalled();
    });
  });
});
