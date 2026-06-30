import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockActivity = vi.hoisted(() => vi.fn());

const createStore = () => {
  type Issue = {
    id: string;
    status: "todo" | "in_progress" | "done" | "cancelled";
    title: string;
    description: string | null;
    priority: string;
    assigneeAgentId: string | null;
    projectId: string | null;
    originKind: string;
    originId: string | null;
    originFingerprint: string | null;
    updatedAt: Date;
    hiddenAt?: Date | null;
  };

  const issues = new Map<string, Issue>();
  let counter = 0;

  return {
    issues,
    findByOrigin: vi.fn(async (_companyId: string, _originKind: string, originId: string) => {
      const issue = issues.get(originId) ?? null;
      return issue?.hiddenAt ? null : issue;
    }),
    create: vi.fn(async (_companyId: string, input: { title: string; description: string; priority: string; assigneeAgentId: string | null; originKind: string; originId: string; originFingerprint: string; }) => {
      counter += 1;
      const issue: Issue = {
        id: `issue-${counter}`,
        status: "todo",
        title: input.title,
        description: input.description,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
        projectId: null,
        originKind: input.originKind,
        originId: input.originId,
        originFingerprint: input.originFingerprint,
        updatedAt: new Date(),
      };
      issues.set(input.originId, issue);
      return issue;
    }),
    update: vi.fn(async (issueId: string, input: { title: string; description: string; priority: string; assigneeAgentId?: string | null; originKind: string; originId: string; originFingerprint: string; }) => {
      const current = Array.from(issues.values()).find((issue) => issue.id === issueId) ?? null;
      if (!current) return null;
      const updated: Issue = {
        ...current,
        title: input.title,
        description: input.description,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId ?? current.assigneeAgentId,
        originKind: input.originKind,
        originId: input.originId,
        originFingerprint: input.originFingerprint,
        updatedAt: new Date(),
      };
      if (current.originId) {
        issues.set(current.originId, updated);
      }
      return updated;
    }),
  };
};

const mockIssueStore = createStore();

vi.mock("../services/index.js", () => ({
  logActivity: mockActivity,
}));

import { handleGithubWebhookRequest } from "../routes/github-webhook.js";

function createRequest(input: {
  event: string;
  deliveryId: string;
  body: Record<string, unknown>;
  signature?: string;
}) {
  const headers = new Map<string, string>();
  headers.set("x-github-event", input.event);
  headers.set("x-github-delivery", input.deliveryId);
  if (input.signature) {
    headers.set("x-hub-signature-256", input.signature);
  }

  return {
    body: input.body,
    rawBody: Buffer.from(JSON.stringify(input.body)),
    header(name: string) {
      return headers.get(name.toLowerCase()) ?? null;
    },
  } as unknown as Parameters<typeof handleGithubWebhookRequest>[1];
}

function createResponse() {
  const response: {
    statusCode: number | null;
    body: unknown;
    status(code: number): typeof response;
    json(payload: unknown): typeof response;
  } = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return response as unknown as Parameters<typeof handleGithubWebhookRequest>[2] & {
    statusCode: number | null;
    body: unknown;
  };
}

describe("github webhook route", () => {
  const originalEnv = {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    companyId: process.env.GITHUB_WEBHOOK_COMPANY_ID,
    projectId: process.env.GITHUB_WEBHOOK_PROJECT_ID,
    botLogins: process.env.GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS,
    allowHuman: process.env.GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS,
    allowedRepos: process.env.GITHUB_WEBHOOK_ALLOWED_REPOS,
    ceo: process.env.GITHUB_WEBHOOK_CEO_AGENT_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = "github-secret";
    process.env.GITHUB_WEBHOOK_COMPANY_ID = "company-123";
    process.env.GITHUB_WEBHOOK_PROJECT_ID = "project-123";
    process.env.GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS = "chatgpt-codex-connector[bot]";
    process.env.GITHUB_WEBHOOK_ALLOWED_REPOS = "acme/repo";
    process.env.GITHUB_WEBHOOK_CEO_AGENT_ID = "agent-ceo";
    delete process.env.GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS;
    mockIssueStore.issues.clear();
  });

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = originalEnv.secret;
    process.env.GITHUB_WEBHOOK_COMPANY_ID = originalEnv.companyId;
    process.env.GITHUB_WEBHOOK_PROJECT_ID = originalEnv.projectId;
    process.env.GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS = originalEnv.botLogins;
    process.env.GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS = originalEnv.allowHuman;
    process.env.GITHUB_WEBHOOK_ALLOWED_REPOS = originalEnv.allowedRepos;
    process.env.GITHUB_WEBHOOK_CEO_AGENT_ID = originalEnv.ceo;
  });

  it("creates an idempotent task for pull_request_review.submitted from the Codex bot", async () => {
    const payload = {
      action: "submitted",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      pull_request: {
        number: 7,
        title: "Fix review flow",
        body: "PR body",
        html_url: "https://github.com/acme/repo/pull/7",
        head: { ref: "feature/review-flow", sha: "deadbeef" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      review: {
        id: 1001,
        state: "changes_requested",
        body: "Please fix the spacing in the UI.",
        html_url: "https://github.com/acme/repo/pull/7#review-1001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`;

    const firstReq = createRequest({ event: "pull_request_review", deliveryId: "delivery-1", signature, body: payload });
    const secondReq = createRequest({ event: "pull_request_review", deliveryId: "delivery-1", signature, body: payload });
    const firstRes = createResponse();
    const secondRes = createResponse();

    await handleGithubWebhookRequest({} as never, firstReq, firstRes, { issueStore: mockIssueStore });
    await handleGithubWebhookRequest({} as never, secondReq, secondRes, { issueStore: mockIssueStore });

    expect(firstRes.statusCode).toBe(201);
    expect(firstRes.body).toMatchObject({
      ok: true,
      processed: true,
      kind: "created",
      disposition: "actionable",
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body).toMatchObject({
      kind: "duplicate",
      processed: true,
    });
    expect(mockIssueStore.create).toHaveBeenCalledTimes(1);
    expect(mockIssueStore.update).not.toHaveBeenCalled();
    expect(mockActivity).toHaveBeenCalledWith({}, expect.objectContaining({
      companyId: "company-123",
      actorType: "system",
      actorId: "github-webhook",
      action: "github.webhook.issue.created",
      entityType: "issue",
      entityId: "issue-1",
    }));
  });

  it("returns completed for Codex reviews without fixes or improvements and does not create a Paperclip task", async () => {
    const payload = {
      action: "submitted",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      pull_request: {
        number: 7,
        title: "Fix review flow",
        body: "PR body",
        html_url: "https://github.com/acme/repo/pull/7",
        head: { ref: "feature/review-flow", sha: "deadbeef" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      review: {
        id: 1002,
        state: "approved",
        body: "LGTM. No corrections or improvements requested.",
        html_url: "https://github.com/acme/repo/pull/7#review-1002",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`;
    const req = createRequest({ event: "pull_request_review", deliveryId: "delivery-completed", signature, body: payload });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      processed: true,
      kind: "completed",
      disposition: "completed",
      originId: "github:webhook|acme/repo|pull_request_review|submitted|pr:7|item:1002",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/merge/i);
    expect(mockIssueStore.create).not.toHaveBeenCalled();
    expect(mockIssueStore.update).not.toHaveBeenCalled();
  });

  it("updates an existing task with review comment path, line, and body", async () => {
    mockIssueStore.issues.set("github:webhook|acme/repo|pull_request_review_comment|created|pr:8|item:2001", {
      id: "issue-9",
      status: "todo",
      title: "Ajuste antigo",
      description: "Texto antigo",
      priority: "medium",
      assigneeAgentId: "agent-ceo",
      projectId: "project-123",
      originKind: "github:webhook",
      originId: "github:webhook|acme/repo|pull_request_review_comment|created|pr:8|item:2001",
      originFingerprint: "github:webhook|acme/repo|pr:8",
      updatedAt: new Date(),
    });

    const payload = {
      action: "created",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      pull_request: {
        number: 8,
        title: "Fix review comment handling",
        body: "PR body",
        html_url: "https://github.com/acme/repo/pull/8",
        head: { ref: "feature/review-comment", sha: "beaded" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      comment: {
        id: 2001,
        body: "Please adjust src/app.ts around line 27.",
        path: "src/app.ts",
        line: 27,
        side: "RIGHT",
        html_url: "https://github.com/acme/repo/pull/8#discussion_r2001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`;

    const req = createRequest({ event: "pull_request_review_comment", deliveryId: "delivery-2", signature, body: payload });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      kind: "updated",
      processed: true,
    });
    expect(mockIssueStore.update).toHaveBeenCalledTimes(1);
    expect(mockIssueStore.update).toHaveBeenCalledWith("issue-9", expect.objectContaining({
      originKind: "github:webhook",
      originId: "github:webhook|acme/repo|pull_request_review_comment|created|pr:8|item:2001",
      description: expect.stringContaining("File: src/app.ts"),
    }));
  });

  it("accepts issue_comment on PRs and ignores issue_comment on regular issues", async () => {
    const prPayload = {
      action: "created",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      issue: {
        number: 11,
        title: "PR issue",
        pull_request: {
          url: "https://api.github.com/repos/acme/repo/pulls/11",
        },
      },
      comment: {
        id: 3001,
        body: "Please adjust the API response.",
        html_url: "https://github.com/acme/repo/pull/11#issuecomment-3001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const prSignature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(JSON.stringify(prPayload))).digest("hex")}`;
    const prReq = createRequest({ event: "issue_comment", deliveryId: "delivery-3", signature: prSignature, body: prPayload });
    const prRes = createResponse();

    await handleGithubWebhookRequest({} as never, prReq, prRes, { issueStore: mockIssueStore });

    expect(prRes.statusCode).toBe(201);
    expect(prRes.body).toMatchObject({
      kind: "created",
      processed: true,
    });
    expect(mockIssueStore.create).toHaveBeenCalledWith("company-123", expect.objectContaining({
      originId: "github:webhook|acme/repo|issue_comment|created|pr:11|item:3001",
      originFingerprint: "github:webhook|acme/repo|pr:11",
      title: expect.stringContaining("#11"),
    }));

    const issuePayload = {
      action: "created",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      issue: {
        number: 12,
        title: "Normal issue",
        html_url: "https://github.com/acme/repo/issues/12",
      },
      comment: {
        id: 3002,
        body: "This is about a regular issue.",
        html_url: "https://github.com/acme/repo/issues/12#issuecomment-3002",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const issueSignature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(JSON.stringify(issuePayload))).digest("hex")}`;
    const issueReq = createRequest({ event: "issue_comment", deliveryId: "delivery-4", signature: issueSignature, body: issuePayload });
    const issueRes = createResponse();

    await handleGithubWebhookRequest({} as never, issueReq, issueRes, { issueStore: mockIssueStore });

    expect(issueRes.statusCode).toBe(200);
    expect(issueRes.body).toMatchObject({
      ignored: true,
    });
  });

  it("rejects repositories outside the allowlist", async () => {
    const payload = {
      action: "submitted",
      repository: {
        full_name: "other/repo",
        html_url: "https://github.com/other/repo",
      },
      pull_request: {
        number: 5,
        title: "Out of allowlist",
        body: "PR body",
        html_url: "https://github.com/other/repo/pull/5",
        head: { ref: "feature/other", sha: "bb22" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      review: {
        id: 5001,
        state: "changes_requested",
        body: "Please fix.",
        html_url: "https://github.com/other/repo/pull/5#review-5001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const signature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(JSON.stringify(payload))).digest("hex")}`;
    const req = createRequest({ event: "pull_request_review", deliveryId: "delivery-5", signature, body: payload });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ignored: true,
    });
    expect(mockIssueStore.create).not.toHaveBeenCalled();
  });

  it("ignores human reviews by default and accepts them when configured", async () => {
    const payload = {
      action: "submitted",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      pull_request: {
        number: 6,
        title: "Human review gate",
        body: "PR body",
        html_url: "https://github.com/acme/repo/pull/6",
        head: { ref: "feature/human", sha: "cc33" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      review: {
        id: 6001,
        state: "changes_requested",
        body: "Please fix the typo.",
        html_url: "https://github.com/acme/repo/pull/6#review-6001",
        user: { login: "carol" },
      },
      sender: { login: "carol" },
    };
    const signature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(JSON.stringify(payload))).digest("hex")}`;
    const req = createRequest({ event: "pull_request_review", deliveryId: "delivery-6", signature, body: payload });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ignored: true,
    });
    expect(mockIssueStore.create).not.toHaveBeenCalled();

    process.env.GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS = "true";
    const allowRes = createResponse();
    await handleGithubWebhookRequest({} as never, req, allowRes, { issueStore: mockIssueStore });

    expect(allowRes.statusCode).toBe(201);
    expect(allowRes.body).toMatchObject({
      kind: "created",
      processed: true,
    });
  });


  it("creates a new task when a previous matching origin is hidden", async () => {
    const originId = "github:webhook|acme/repo|pull_request_review|submitted|pr:7|item:9001";
    mockIssueStore.issues.set(originId, {
      id: "issue-hidden",
      status: "todo",
      title: "Hidden old task",
      description: null,
      priority: "high",
      assigneeAgentId: "agent-ceo",
      projectId: "project-123",
      originKind: "github:webhook",
      originId,
      originFingerprint: "github:webhook|acme/repo|pr:7",
      updatedAt: new Date(),
      hiddenAt: new Date(),
    });

    const payload = {
      action: "submitted",
      repository: { full_name: "acme/repo", html_url: "https://github.com/acme/repo" },
      pull_request: { number: 7, title: "Fix review flow", html_url: "https://github.com/acme/repo/pull/7" },
      review: {
        id: 9001,
        state: "changes_requested",
        body: "Please fix the failing validation.",
        html_url: "https://github.com/acme/repo/pull/7#review-9001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const signature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(JSON.stringify(payload))).digest("hex")}`;
    const req = createRequest({ event: "pull_request_review", deliveryId: "delivery-hidden", signature, body: payload });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ kind: "created", processed: true });
  });

  it("rejects an invalid signature", async () => {
    const payload = {
      action: "submitted",
      repository: {
        full_name: "acme/repo",
        html_url: "https://github.com/acme/repo",
      },
      pull_request: {
        number: 7,
        title: "Bad signature",
        body: "PR body",
        html_url: "https://github.com/acme/repo/pull/7",
        head: { ref: "feature/bad", sha: "dd44" },
        base: { ref: "main" },
        user: { login: "alice" },
      },
      review: {
        id: 7001,
        state: "changes_requested",
        body: "Please fix.",
        html_url: "https://github.com/acme/repo/pull/7#review-7001",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
      sender: { login: "chatgpt-codex-connector[bot]" },
    };
    const req = createRequest({
      event: "pull_request_review",
      deliveryId: "delivery-7",
      signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      body: payload,
    });
    const res = createResponse();

    await handleGithubWebhookRequest({} as never, req, res, { issueStore: mockIssueStore });

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      error: "Invalid signature",
    });
    expect(mockIssueStore.create).not.toHaveBeenCalled();
  });
});
