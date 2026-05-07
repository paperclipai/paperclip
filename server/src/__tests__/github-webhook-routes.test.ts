import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  addComment: vi.fn(async () => ({ id: "comment-1", body: "" })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockDbSelect = vi.hoisted(() => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    then: vi.fn(async () => []),
  };
  return vi.fn(() => chain);
});

const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
}

const WEBHOOK_SECRET = "test-webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function makePrPayload(overrides?: Partial<{
  action: string;
  merged: boolean;
  title: string;
  body: string | null;
  number: number;
}>) {
  return {
    action: overrides?.action ?? "closed",
    pull_request: {
      merged: overrides?.merged ?? true,
      number: overrides?.number ?? 42,
      title: overrides?.title ?? "feat: implement FOO-123 feature",
      body: overrides?.body ?? "Closes FOO-123\nAlso refs BAR-456",
      html_url: "https://github.com/org/repo/pull/42",
      base: { repo: { full_name: "org/repo" } },
    },
  };
}

async function createApp() {
  const { githubWebhookRoutes } = await import("../routes/github-webhooks.js");
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }));
  app.use("/api", githubWebhookRoutes(mockDb as any));
  return app;
}

describe("github webhook routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    registerModuleMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  describe("signature verification", () => {
    it("rejects requests without signature", async () => {
      const app = await createApp();
      await request(app)
        .post("/api/github/webhooks")
        .send(makePrPayload())
        .expect(401);
    });

    it("rejects requests with invalid signature", async () => {
      const app = await createApp();
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", "sha256=invalid")
        .set("x-github-event", "pull_request")
        .send(makePrPayload())
        .expect(401);
    });

    it("returns 503 when GITHUB_WEBHOOK_SECRET is not set", async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const app = await createApp();
      const body = JSON.stringify(makePrPayload());
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "pull_request")
        .set("content-type", "application/json")
        .send(body)
        .expect(503);
    });
  });

  describe("event filtering", () => {
    it("ignores non-pull_request events", async () => {
      const app = await createApp();
      const body = JSON.stringify({ action: "completed" });
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "check_run")
        .set("content-type", "application/json")
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.ignored).toBe(true);
        });
    });

    it("ignores closed but not merged PRs", async () => {
      const app = await createApp();
      const payload = makePrPayload({ merged: false });
      const body = JSON.stringify(payload);
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "pull_request")
        .set("content-type", "application/json")
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.ignored).toBe(true);
          expect(res.body.reason).toBe("PR not merged");
        });
    });

    it("ignores opened PRs", async () => {
      const app = await createApp();
      const payload = makePrPayload({ action: "opened" });
      const body = JSON.stringify(payload);
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "pull_request")
        .set("content-type", "application/json")
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.ignored).toBe(true);
        });
    });
  });

  describe("issue identifier extraction", () => {
    it("extracts identifiers from PR title and body", async () => {
      const app = await createApp();
      const selectChain = {
        from: vi.fn(() => selectChain),
        where: vi.fn(() => [
          {
            id: "issue-1",
            identifier: "FOO-123",
            status: "in_review",
            companyId: "company-1",
            assigneeAgentId: "agent-1",
          },
        ]),
        innerJoin: vi.fn(() => selectChain),
        then: vi.fn(async () => []),
      };
      mockDbSelect.mockReturnValue(selectChain as any);
      // First select call returns matched issues, second call (work products) returns empty
      selectChain.where
        .mockResolvedValueOnce([
          {
            id: "issue-1",
            identifier: "FOO-123",
            status: "in_review",
            companyId: "company-1",
            assigneeAgentId: "agent-1",
          },
        ])
        .mockResolvedValueOnce([]);

      const payload = makePrPayload({ title: "feat: FOO-123 and BAR-456" });
      const body = JSON.stringify(payload);
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "pull_request")
        .set("content-type", "application/json")
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.processed).toBe(true);
          expect(res.body.closedIssueCount).toBe(1);
        });

      expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "done" });
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        "issue-1",
        expect.stringContaining("Auto-closed: PR [#42]"),
        expect.any(Object),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.auto_closed_pr_merged",
          entityId: "issue-1",
        }),
      );
    });
  });

  describe("valid merged PR with no matching issues", () => {
    it("returns 200 with zero closed issues", async () => {
      const app = await createApp();
      const selectChain = {
        from: vi.fn(() => selectChain),
        where: vi.fn(async () => []),
        innerJoin: vi.fn(() => selectChain),
      };
      mockDbSelect.mockReturnValue(selectChain as any);

      const payload = makePrPayload({ title: "chore: update deps", body: null });
      const body = JSON.stringify(payload);
      await request(app)
        .post("/api/github/webhooks")
        .set("x-hub-signature-256", sign(body))
        .set("x-github-event", "pull_request")
        .set("content-type", "application/json")
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.processed).toBe(true);
          expect(res.body.closedIssueCount).toBe(0);
        });

      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });
});
