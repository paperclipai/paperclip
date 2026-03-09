import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "../../../packages/plugins/examples/plugin-ntfy-notifier-example/src/worker.js";

describe("ntfy notifier example worker", () => {
  it("returns an ok health payload", async () => {
    const result = await worker.definition.onHealth?.();
    expect(result).toEqual({
      status: "ok",
      message: "ntfy notifier example plugin ready",
    });
  });

  describe("onValidateConfig", () => {
    it("fails if topic is missing", async () => {
      const result = await worker.definition.onValidateConfig?.({});
      expect(result).toEqual({ ok: false, errors: ["topic is required"] });
    });

    it("fails if priority is out of range", async () => {
      const result = await worker.definition.onValidateConfig?.({ topic: "test", defaultPriority: 6 });
      expect(result).toEqual({ ok: false, errors: ["defaultPriority must be between 1 and 5"] });
    });

    it("passes with valid config", async () => {
      const result = await worker.definition.onValidateConfig?.({ topic: "test", defaultPriority: 3 });
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
          get: vi.fn().mockResolvedValue({ topic: "my-topic" }),
        },
        logger: {
          warn: vi.fn(),
          error: vi.fn(),
        },
        http: {
          fetch: vi.fn().mockResolvedValue({ ok: true }),
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
          resolve: vi.fn().mockResolvedValue("secret-token"),
        }
      };
    });

    const triggerEvent = async (name: string, payload: any) => {
      const handler = eventHandlers[name];
      if (!handler) throw new Error(`No handler registered for event: ${name}`);
      await handler(payload);
    };

    it("subscribes to expected events", async () => {
      await worker.definition.setup?.(ctx);
      const expectedEvents = [
        "agent.run.started",
        "agent.run.finished",
        "agent.run.failed",
        "agent.run.cancelled",
        "agent.status_changed",
        "issue.created",
        "issue.comment.created",
        "approval.created",
        "approval.decided",
      ];
      
      expectedEvents.forEach(event => {
        expect(ctx.events.on).toHaveBeenCalledWith(event, expect.any(Function));
      });
    });

    it("sends ntfy message when agent.run.finished is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("agent.run.finished", {
        eventType: "agent.run.finished",
        entityId: "run-123",
        companyId: "comp-1",
      });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Paperclip Agent Activity",
            "Priority": "3",
            "Tags": expect.stringContaining("robot_face"),
          }),
          body: "Agent run finished: run-123",
        })
      );
      expect(ctx.metrics.write).toHaveBeenCalledWith("ntfy_notifications_sent", 1);
      expect(ctx.activity.log).toHaveBeenCalledWith(expect.objectContaining({
        entityType: "run",
        entityId: "run-123",
      }));
    });

    it("sends ntfy message when agent.run.failed is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("agent.run.failed", {
        eventType: "agent.run.failed",
        entityId: "run-failed-1",
        companyId: "comp-1",
      });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Priority": "4",
            "Tags": expect.stringContaining("x"),
          }),
          body: "Agent run failed: run-failed-1",
        })
      );
    });

    it("sends ntfy message when agent.run.cancelled is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("agent.run.cancelled", {
        eventType: "agent.run.cancelled",
        entityId: "run-cancelled-1",
        companyId: "comp-1",
      });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Priority": "2",
            "Tags": expect.stringContaining("stop_sign"),
          }),
          body: "Agent run cancelled: run-cancelled-1",
        })
      );
    });

    it("sends ntfy message when agent.status_changed is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("agent.status_changed", {
        eventType: "agent.status_changed",
        entityId: "agent-1",
        companyId: "comp-1",
      });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Priority": "2",
          }),
          body: "Agent agent-1 status changed",
        })
      );
    });

    it("uses custom serverUrl and tokenSecretRef", async () => {
      ctx.config.get.mockResolvedValue({
        topic: "secure-topic",
        serverUrl: "https://ntfy.example.com",
        tokenSecretRef: "my-token-ref"
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.started", { eventType: "agent.run.started", entityId: "run-456" });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.example.com/secure-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Authorization": "Bearer secret-token",
          })
        })
      );
      expect(ctx.secrets.resolve).toHaveBeenCalledWith("my-token-ref");
    });

    it("respects eventAllowlist", async () => {
      ctx.config.get.mockResolvedValue({
        topic: "filtered",
        eventAllowlist: ["issue.created"]
      });

      await worker.definition.setup?.(ctx);
      
      // Should NOT send for agent.run.started
      await triggerEvent("agent.run.started", { eventType: "agent.run.started" });
      expect(ctx.http.fetch).not.toHaveBeenCalled();

      // Should send for issue.created
      await triggerEvent("issue.created", { eventType: "issue.created", entityId: "issue-1" });
      expect(ctx.http.fetch).toHaveBeenCalled();
    });

    it("sends ntfy message when issue.created is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("issue.created", {
        eventType: "issue.created",
        entityId: "issue-123",
      });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Title": "Paperclip Issue Update",
            "Priority": "4",
            "Tags": "new,memo",
          }),
          body: "New issue created: issue-123",
        })
      );
    });

    it("sends ntfy message and updates state when issue.comment.created is triggered", async () => {
      await worker.definition.setup?.(ctx);
      const occurredAt = new Date().toISOString();
      
      await triggerEvent("issue.comment.created", {
        eventType: "issue.comment.created",
        entityId: "issue-456",
        occurredAt,
      });

      expect(ctx.http.fetch).toHaveBeenCalled();
      expect(ctx.state.set).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "issue",
          scopeId: "issue-456",
          stateKey: "last_ntfy_notified_at",
        }),
        occurredAt
      );
    });

    it("sends ntfy message when approval.created is triggered", async () => {
      await worker.definition.setup?.(ctx);
      
      await triggerEvent("approval.created", { eventType: "approval.created" });

      expect(ctx.http.fetch).toHaveBeenCalledWith(
        "https://ntfy.sh/my-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Title": "Paperclip Approval",
            "Priority": "5",
          }),
        })
      );
    });

    it("merges default tags from configuration", async () => {
      ctx.config.get.mockResolvedValue({
        topic: "tagged",
        defaultTags: ["global", "paperclip"]
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.started", { eventType: "agent.run.started", entityId: "run-1" });

      const fetchCall = ctx.http.fetch.mock.calls[0];
      const tagsHeader = fetchCall[1].headers["Tags"];
      
      // Should contain both event tags and config default tags
      expect(tagsHeader).toContain("robot_face");
      expect(tagsHeader).toContain("global");
      expect(tagsHeader).toContain("paperclip");
    });

    it("handles non-ok HTTP responses as failures", async () => {
      ctx.http.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      
      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.started", { eventType: "agent.run.started" });

      expect(ctx.metrics.write).toHaveBeenCalledWith("ntfy_notification_failures", 1);
      expect(ctx.logger.error).toHaveBeenCalledWith("ntfy notifier delivery failed", expect.objectContaining({
        error: expect.stringContaining("500"),
      }));
    });

    it("skips post-send activity updates when delivery fails", async () => {
      ctx.http.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.finished", {
        eventType: "agent.run.finished",
        entityId: "run-123",
        companyId: "comp-1",
      });

      expect(ctx.activity.log).not.toHaveBeenCalled();
    });

    it("skips post-send state updates when delivery fails", async () => {
      ctx.http.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      await worker.definition.setup?.(ctx);
      await triggerEvent("issue.comment.created", {
        eventType: "issue.comment.created",
        entityId: "issue-456",
        occurredAt: new Date().toISOString(),
      });

      expect(ctx.state.set).not.toHaveBeenCalled();
    });

    it("handles fetch errors gracefully", async () => {
      ctx.http.fetch.mockRejectedValue(new Error("Network fail"));
      
      await worker.definition.setup?.(ctx);
      await triggerEvent("approval.created", { eventType: "approval.created" });

      expect(ctx.metrics.write).toHaveBeenCalledWith("ntfy_notification_failures", 1);
      expect(ctx.logger.error).toHaveBeenCalledWith("ntfy notifier delivery failed", expect.any(Object));
    });

    it("logs warning if topic is missing in config during event", async () => {
      ctx.config.get.mockResolvedValue({ topic: "" });
      
      await worker.definition.setup?.(ctx);
      await triggerEvent("agent.run.started", { eventType: "agent.run.started" });

      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("topic missing"));
      expect(ctx.http.fetch).not.toHaveBeenCalled();
    });
  });
});
