import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGitHubWebhookIssueInput,
  normalizeGitHubWebhookEvent,
  readGitHubWebhookConfig,
  verifyGitHubWebhookSignature,
} from "../services/github-webhook.js";

describe("github webhook helpers", () => {
  it("verifica a assinatura HMAC com o corpo bruto", () => {
    const secret = "super-secret";
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature({
      secret,
      rawBody,
      signature,
    })).toBe(true);
  });

  it("rejeita assinatura inválida", () => {
    expect(verifyGitHubWebhookSignature({
      secret: "super-secret",
      rawBody: Buffer.from("{}"),
      signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    })).toBe(false);
  });

  it("lê allowlist e credenciais sem expor secrets", () => {
    const config = readGitHubWebhookConfig({
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_WEBHOOK_COMPANY_ID: "company-123",
      GITHUB_WEBHOOK_PROJECT_ID: "project-123",
      GITHUB_WEBHOOK_ALLOWED_REPOS: "acme/repo,other/repo",
      GITHUB_WEBHOOK_ALLOWED_ORGS: "acme",
      GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS: "chatgpt-codex-connector[bot],review-bot[bot]",
      GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS: "true",
      GITHUB_WEBHOOK_DEFAULT_ASSIGNEE_AGENT_ID: "agent-ceo",
    });

    expect(config).toMatchObject({
      secret: "secret",
      companyId: "company-123",
      projectId: "project-123",
      allowedRepos: ["acme/repo", "other/repo"],
      allowedOrgs: ["acme"],
      allowedBotLogins: ["chatgpt-codex-connector[bot]", "review-bot[bot]"],
      allowHumanReviewers: true,
      defaultAssigneeAgentId: "agent-ceo",
    });
  });

  it("normaliza um review submitted acionável do bot do Codex", () => {
    const normalized = normalizeGitHubWebhookEvent({
      event: "pull_request_review",
      deliveryId: "delivery-1",
      config: {
        secret: "secret",
        companyId: "company-123",
        projectId: null,
        allowedRepos: [],
        allowedOrgs: [],
        allowedBotLogins: ["chatgpt-codex-connector[bot]"],
        allowHumanReviewers: false,
        defaultAssigneeAgentId: "agent-ceo",
        ownerAgentIds: {
          CEO: "agent-ceo",
          DevOps: null,
          QA: null,
          CTO: null,
          UXDesigner: null,
        },
      },
      payload: {
        action: "submitted",
        repository: {
          full_name: "acme/repo",
          html_url: "https://github.com/acme/repo",
        },
        pull_request: {
          number: 42,
          title: "Fix webhook handling",
          body: "Body of the PR",
          html_url: "https://github.com/acme/repo/pull/42",
          head: { ref: "feature/github-review", sha: "deadbeef" },
          base: { ref: "main" },
          user: { login: "alice" },
        },
        review: {
          id: 9001,
          state: "changes_requested",
          body: "Please fix the layout spacing.",
          html_url: "https://github.com/acme/repo/pull/42#review-9001",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
        sender: { login: "chatgpt-codex-connector[bot]" },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized).toMatchObject({
      provider: "github",
      event: "pull_request_review",
      disposition: "actionable",
      assigneeAgentId: "agent-ceo",
      pullRequest: {
        number: 42,
        headRef: "feature/github-review",
        baseRef: "main",
      },
      review: {
        id: "9001",
        state: "changes_requested",
      },
    });

    expect(buildGitHubWebhookIssueInput(normalized!)).toMatchObject({
      status: "todo",
      priority: "high",
      originKind: "github:webhook",
    });
  });

  it("ignora comentário em issue comum", () => {
    const normalized = normalizeGitHubWebhookEvent({
      event: "issue_comment",
      deliveryId: "delivery-2",
      config: {
        secret: "secret",
        companyId: "company-123",
        projectId: null,
        allowedRepos: [],
        allowedOrgs: [],
        allowedBotLogins: ["chatgpt-codex-connector[bot]"],
        allowHumanReviewers: false,
        defaultAssigneeAgentId: null,
        ownerAgentIds: {
          CEO: null,
          DevOps: null,
          QA: null,
          CTO: null,
          UXDesigner: null,
        },
      },
      payload: {
        action: "created",
        repository: { full_name: "acme/repo", html_url: "https://github.com/acme/repo" },
        issue: {
          number: 9,
          title: "Normal issue",
          html_url: "https://github.com/acme/repo/issues/9",
        },
        comment: {
          id: 55,
          body: "Looks good.",
          html_url: "https://github.com/acme/repo/issues/9#issuecomment-55",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
        sender: { login: "chatgpt-codex-connector[bot]" },
      },
    });

    expect(normalized).toBeNull();
  });
});
