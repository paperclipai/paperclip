import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, {
  MAX_WEBHOOK_BODY_BYTES,
  ORIGIN_KIND,
  WEBHOOK_KEY,
  stateKeyForDelivery,
  stateKeyForPullRequest,
  verifyGithubSignature,
} from "../src/worker.js";

const secretRef = "github-webhook-secret";
const resolvedSecret = `resolved:${secretRef}`;
const repository = "keegoidllc/agentic-strategy-designer";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: {
      full_name: repository,
      html_url: `https://github.com/${repository}`,
    },
    pull_request: {
      number: 42,
      title: "Wire Paperclip PR ingress",
      html_url: `https://github.com/${repository}/pull/42`,
      state: "open",
      draft: false,
      merged: false,
      user: { login: "keegoid-codex" },
      head: {
        ref: "codex/github-pr-ingress",
        sha: "abc123",
        repo: { full_name: repository },
      },
      base: {
        ref: "main",
        repo: { full_name: repository },
      },
    },
    ...overrides,
  };
}

function signature(rawBody: string, secret = resolvedSecret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function webhookInput(body: unknown, deliveryId: string = randomUUID(), secret = resolvedSecret) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: WEBHOOK_KEY,
    requestId: `req-${deliveryId}`,
    rawBody,
    parsedBody: body,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature(rawBody, secret),
    },
  };
}

function harnessForRepo(companyId = randomUUID()) {
  return {
    companyId,
    harness: createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: {
        githubWebhookSecretRef: secretRef,
        repositories: [
          {
            repository,
            companyId,
            priority: "high",
          },
        ],
      },
    }),
  };
}

describe("github pr ingress plugin", () => {
  it("declares the webhook and issue sync capabilities", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "keegoid.plugin-github-pr-ingress",
      capabilities: expect.arrayContaining([
        "webhooks.receive",
        "secrets.read-ref",
        "issues.read",
        "issues.create",
        "issues.update",
        "issue.comments.create",
        "plugin.state.write",
      ]),
      webhooks: [
        expect.objectContaining({
          endpointKey: WEBHOOK_KEY,
        }),
      ],
    });
  });

  it("verifies GitHub HMAC signatures over the raw body", () => {
    const rawBody = JSON.stringify(payload());
    expect(verifyGithubSignature(rawBody, signature(rawBody), resolvedSecret)).toBe(true);
    expect(verifyGithubSignature(rawBody, signature(rawBody, "wrong"), resolvedSecret)).toBe(false);
    expect(verifyGithubSignature(rawBody, null, resolvedSecret)).toBe(false);
  });

  it("creates a Paperclip issue for a mapped pull_request webhook", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onWebhook?.(webhookInput(payload(), "delivery-create"))).resolves.toBeUndefined();

    const issues = await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${repository}#42` });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      title: `[code-change] ${repository}#42: Wire Paperclip PR ingress`,
      status: "todo",
      priority: "high",
      billingCode: "github-pr-review",
      originKind: ORIGIN_KIND,
      originId: `${repository}#42`,
    });
    expect(issues[0]?.description).toContain("Review routing is handled by the post-D4 opposite-model review routine.");
    expect(harness.getState({ scopeKind: "instance", stateKey: stateKeyForDelivery("delivery-create") })).toMatchObject({
      action: "created",
      issueId: issues[0]?.id,
    });
    expect(harness.getState({ scopeKind: "instance", stateKey: stateKeyForPullRequest(repository, 42) })).toMatchObject({
      issueId: issues[0]?.id,
      prNumber: 42,
      action: "opened",
    });
  });

  it("does not duplicate work for a repeated GitHub delivery", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const input = webhookInput(payload(), "delivery-repeat");

    await plugin.definition.onWebhook?.(input);
    await plugin.definition.onWebhook?.(input);

    const issues = await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${repository}#42` });
    expect(issues).toHaveLength(1);
    const comments = await harness.ctx.issues.listComments(issues[0]!.id, companyId);
    expect(comments).toHaveLength(0);
  });

  it("checks signatures before accepting repeated delivery ids", async () => {
    const { harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onWebhook?.(webhookInput(payload(), "delivery-repeat-auth"));

    await expect(
      plugin.definition.onWebhook?.(webhookInput(payload(), "delivery-repeat-auth", "wrong-secret")),
    ).rejects.toThrow("Invalid GitHub webhook signature");
  });

  it("rejects malformed signature headers before resolving secrets", async () => {
    const { harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    let secretResolved = false;
    harness.ctx.secrets.resolve = async () => {
      secretResolved = true;
      return resolvedSecret;
    };
    const input = webhookInput(payload(), "delivery-malformed-signature");
    input.headers["x-hub-signature-256"] = "not-a-github-signature";

    await expect(plugin.definition.onWebhook?.(input)).rejects.toThrow("Invalid GitHub webhook signature");

    expect(secretResolved).toBe(false);
  });

  it("parses the verified raw body instead of trusting parsedBody", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const input = webhookInput(payload(), "delivery-raw-body");
    input.parsedBody = payload({
      repository: {
        full_name: "elsewhere/ignored",
        html_url: "https://github.com/elsewhere/ignored",
      },
    });

    await plugin.definition.onWebhook?.(input);

    const issues = await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${repository}#42` });
    expect(issues).toHaveLength(1);
  });

  it("updates the existing issue and records a comment when the PR closes", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const updatePatches: Record<string, unknown>[] = [];
    const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    harness.ctx.issues.update = async (issueId, patch, companyIdArg, actor) => {
      updatePatches.push(patch as Record<string, unknown>);
      return originalUpdate(issueId, patch, companyIdArg, actor);
    };

    await plugin.definition.onWebhook?.(webhookInput(payload(), "delivery-open"));
    await plugin.definition.onWebhook?.(webhookInput(payload({
      action: "closed",
      pull_request: {
        ...payload().pull_request,
        state: "closed",
        merged: true,
      },
    }), "delivery-close"));

    const issues = await harness.ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${repository}#42` });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("done");
    const comments = await harness.ctx.issues.listComments(issues[0]!.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("GitHub PR webhook `closed` received");
    expect(updatePatches).toHaveLength(1);
    expect(updatePatches[0]).not.toHaveProperty("originKind");
    expect(updatePatches[0]).not.toHaveProperty("originId");
  });

  it("ignores signed pull_request webhooks for unmapped repositories", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const body = payload({
      repository: {
        full_name: "elsewhere/ignored",
        html_url: "https://github.com/elsewhere/ignored",
      },
    });

    await plugin.definition.onWebhook?.(webhookInput(body, "delivery-ignored"));

    const issues = await harness.ctx.issues.list({ companyId, limit: 10, offset: 0 });
    expect(issues).toHaveLength(0);
    expect(harness.getState({ scopeKind: "instance", stateKey: stateKeyForDelivery("delivery-ignored") })).toBeUndefined();
  });

  it("lets an ignored delivery sync if repository mapping is added before retry", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const remappedRepository = "elsewhere/ignored";
    const body = payload({
      repository: {
        full_name: remappedRepository,
        html_url: `https://github.com/${remappedRepository}`,
      },
    });

    await plugin.definition.onWebhook?.(webhookInput(body, "delivery-remapped"));
    harness.setConfig({
      githubWebhookSecretRef: secretRef,
      repositories: [
        {
          repository: remappedRepository,
          companyId,
          priority: "high",
        },
      ],
    });
    await plugin.definition.onWebhook?.(webhookInput(body, "delivery-remapped"));

    const issues = await harness.ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originId: `${remappedRepository}#42`,
    });
    expect(issues).toHaveLength(1);
  });

  it("rejects an invalid GitHub webhook signature before mutating issues", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const input = webhookInput(payload(), "delivery-bad-signature", "wrong-secret");

    await expect(plugin.definition.onWebhook?.(input)).rejects.toThrow("Invalid GitHub webhook signature");

    const issues = await harness.ctx.issues.list({ companyId, limit: 10, offset: 0 });
    expect(issues).toHaveLength(0);
    expect(harness.getState({ scopeKind: "instance", stateKey: stateKeyForDelivery("delivery-bad-signature") })).toBeUndefined();
  });

  it("rejects oversized webhook bodies before HMAC or JSON work", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const input = webhookInput(payload(), "delivery-too-large", "wrong-secret");
    input.rawBody = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    input.headers["x-hub-signature-256"] = signature(input.rawBody, "wrong-secret");

    await expect(plugin.definition.onWebhook?.(input)).rejects.toThrow("GitHub webhook payload is too large");

    const issues = await harness.ctx.issues.list({ companyId, limit: 10, offset: 0 });
    expect(issues).toHaveLength(0);
  });

  it("rejects malformed raw JSON after signature verification", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    const input = webhookInput(payload(), "delivery-malformed-json");
    input.rawBody = "{\"action\":";
    input.headers["x-hub-signature-256"] = signature(input.rawBody);

    await expect(plugin.definition.onWebhook?.(input)).rejects.toThrow("Invalid GitHub webhook JSON");

    const issues = await harness.ctx.issues.list({ companyId, limit: 10, offset: 0 });
    expect(issues).toHaveLength(0);
    expect(harness.getState({ scopeKind: "instance", stateKey: stateKeyForDelivery("delivery-malformed-json") })).toBeUndefined();
  });

  it("uses consistent health diagnostics for RPC and dashboard data", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        githubWebhookSecretRef: secretRef,
        repositories: [],
      },
    });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onHealth?.()).resolves.toMatchObject({
      status: "degraded",
      details: {
        repositoriesConfigured: 0,
        secretRefConfigured: true,
      },
    });
    await expect(harness.getData("health")).resolves.toMatchObject({
      status: "degraded",
      details: {
        repositoriesConfigured: 0,
        secretRefConfigured: true,
      },
    });
  });
});
