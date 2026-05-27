/**
 * Webhook handler tests — drives `handleWebhook` directly with a mock
 * PluginContext so we don't need to spin up the full worker RPC host.
 *
 * Test pattern mirrors `paperclip-plugin-slack/src/__tests__/user-mapping.test.ts`:
 * a `mkCtx()` factory that returns vitest-mocked clients, plus a typed
 * `unknownCast` helper to keep us inside strict TS.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  WebhookUnauthorizedError,
  handleWebhook,
  verifyBearerToken,
} from "../webhook-handler.js";
import { ORIGIN_KIND } from "../types.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
  AlertStateRecord,
} from "../types.js";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TOKEN = "super-secret-token";

const baseAlert = (overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    team: "platform",
    node: "pve-3",
  },
  annotations: {
    summary: "261 GB of EGRESS traffic dropped on pve-3 in 21h",
    description: "Sustained policy-denied drops",
    runbook_url: "https://wiki/runbooks/cilium-drops",
    dashboard_url: "https://grafana/d/cilium",
  },
  startsAt: "2026-04-29T08:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus-0:9090/graph?g0.expr=foo",
  fingerprint: "9a3b1e4c5f6d7890",
  ...overrides,
});

const baseEnvelope = (
  overrides: Partial<AlertmanagerWebhookPayload> = {},
): AlertmanagerWebhookPayload => ({
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupLabels: { alertname: "CiliumPolicyDropsHigh" },
  commonLabels: { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: [baseAlert()],
  ...overrides,
});

const baseConfig = (
  overrides: Partial<AlertmanagerPluginConfig> = {},
): AlertmanagerPluginConfig => ({
  defaultCompanyId: "company-1",
  webhookToken: TOKEN,
  acceptOnlyLabels: {},
  severityToPriority: { critical: "critical", warning: "high", info: "medium" },
  autoCloseOnResolve: false,
  ownerMap: { team: { platform: "alice@example.com" } },
  ...overrides,
});

const baseInput = (
  overrides: Partial<PluginWebhookInput> = {},
): PluginWebhookInput => ({
  endpointKey: "alertmanager",
  headers: { authorization: `Bearer ${TOKEN}` },
  rawBody: JSON.stringify(baseEnvelope()),
  parsedBody: baseEnvelope(),
  requestId: "req-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

interface MockClients {
  state: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  users: { get: ReturnType<typeof vi.fn>; findByEmail: ReturnType<typeof vi.fn> };
  issues: {
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  metrics: { write: ReturnType<typeof vi.fn> };
  activity: { log: ReturnType<typeof vi.fn> };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

const mkCtx = (): { ctx: PluginContext; mocks: MockClients } => {
  const mocks: MockClients = {
    state: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    users: {
      get: vi.fn(async () => null),
      findByEmail: vi.fn(async () => null),
    },
    issues: {
      get: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "issue-1" })),
      update: vi.fn(async () => ({ id: "issue-1" })),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    events: { emit: vi.fn(async () => {}) },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  // The cast is contained to test code where it's documented and the
  // mocks satisfy the subset of the surface the handler actually touches.
  const ctx = mocks as unknown as PluginContext;
  return { ctx, mocks };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// verifyBearerToken — direct unit tests
// ---------------------------------------------------------------------------

describe("verifyBearerToken", () => {
  it("rejects when no expected token is configured", () => {
    expect(verifyBearerToken({ authorization: `Bearer x` }, null)).toBe(false);
    expect(verifyBearerToken({ authorization: `Bearer x` }, "")).toBe(false);
  });

  it("rejects when the header is missing", () => {
    expect(verifyBearerToken({}, TOKEN)).toBe(false);
  });

  it("rejects on length mismatch (constant-time-safe)", () => {
    expect(verifyBearerToken({ authorization: `Bearer wrong` }, TOKEN)).toBe(false);
  });

  it("rejects on a near-miss with the same length", () => {
    const sameLengthBad = "x".repeat(TOKEN.length);
    expect(verifyBearerToken({ authorization: `Bearer ${sameLengthBad}` }, TOKEN)).toBe(false);
  });

  it("accepts a correctly formed Authorization header", () => {
    expect(verifyBearerToken({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });

  it("matches the capitalized Authorization header too", () => {
    expect(verifyBearerToken({ Authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook — integration-flavored tests
// ---------------------------------------------------------------------------

describe("handleWebhook — auth", () => {
  it("throws WebhookUnauthorizedError when bearer token is missing", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: {} });
    await expect(handleWebhook(ctx, config, TOKEN, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("throws WebhookUnauthorizedError on a bad token", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: { authorization: "Bearer nope" } });
    await expect(handleWebhook(ctx, config, TOKEN, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("accepts a correct bearer token and processes the payload", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });
});

describe("handleWebhook — schema validation", () => {
  it("drops malformed payloads (writes a metric, returns 200-equivalent)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ parsedBody: { not: "an alertmanager payload" } });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.malformed",
      1,
    );
  });

  it("drops payloads with unsupported schema version", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const envelope = baseEnvelope({ version: "5" });
    const input = baseInput({
      parsedBody: envelope,
      rawBody: JSON.stringify(envelope),
    });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.unsupported_version",
      1,
      { version: "5" },
    );
  });

  it("ignores unknown endpointKey", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ endpointKey: "something-else" });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
  });
});

describe("handleWebhook — firing first time", () => {
  it("creates an issue with the right title, priority, originKind, and assignee", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    // owner-by-email cache miss → falls through to ctx.users.findByEmail
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-42",
      email: "alice@example.com",
      name: "Alice",
    });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.companyId).toBe("company-1");
    expect(createArgs.title).toBe("[critical] CiliumPolicyDropsHigh · platform");
    expect(createArgs.priority).toBe("critical");
    expect(createArgs.originKind).toBe(ORIGIN_KIND);
    expect(createArgs.originId).toBe("9a3b1e4c5f6d7890");
    expect(createArgs.assigneeUserId).toBe("user-42");
    expect(createArgs.description).toContain("[Dashboard](https://grafana/d/cilium)");
    expect(createArgs.description).toContain("[Runbook](https://wiki/runbooks/cilium-drops)");

    // State row written
    expect(mocks.state.set).toHaveBeenCalledWith(
      { scopeKind: "instance", stateKey: "alert:9a3b1e4c5f6d7890" },
      expect.objectContaining({
        paperclipIssueId: "issue-1",
        paperclipCompanyId: "company-1",
        assigneeUserId: "user-42",
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        resolvedAt: null,
      }),
    );

    // Firing event emitted
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.firing",
      "company-1",
      expect.objectContaining({
        fingerprint: "9a3b1e4c5f6d7890",
        paperclipIssueId: "issue-1",
        assigneeUserId: "user-42",
        reFired: false,
      }),
    );
    // Activity + metric
    expect(mocks.activity.log).toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.handled",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("creates the issue unassigned when no owner resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
  });

  it("forwards billing_code label to ctx.issues.create", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      labels: {
        alertname: "X",
        severity: "info",
        billing_code: "cost-ctr-7",
      },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.billingCode).toBe("cost-ctr-7");
  });
});

describe("handleWebhook — dedup on re-fire", () => {
  it("does not create a second issue when an open one already exists", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "in_progress" });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).not.toHaveBeenCalled();
    // It should bump the description but not change status
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
    );
    const updatePatch = mocks.issues.update.mock.calls[0][1];
    expect(updatePatch.status).toBeUndefined();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.deduped",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("re-opens a closed issue on re-fire after manual resolve (§8.3)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: "2026-04-29T09:00:00Z",
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "done" });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ status: "todo" }),
      "company-1",
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.reopened",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });
});

describe("handleWebhook — resolved", () => {
  it("posts a comment when autoCloseOnResolve=false", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.createComment).toHaveBeenCalledWith(
      "issue-existing",
      "Alert resolved at 2026-04-29T10:00:00Z.",
      "company-1",
    );
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.resolved",
      "company-1",
      expect.objectContaining({
        paperclipIssueId: "issue-existing",
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("closes the issue when autoCloseOnResolve=true", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "X",
      severity: "info",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      { status: "done" },
      "company-1",
    );
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("logs and drops resolved-without-state (no action taken)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.state.get.mockResolvedValueOnce(null);

    const resolvedAlert = baseAlert({ status: "resolved" });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
  });
});

describe("handleWebhook — acceptOnlyLabels filter", () => {
  it("skips alerts that don't match the filter", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ acceptOnlyLabels: { paperclip: "true" } });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.filtered",
      1,
      { alertname: "CiliumPolicyDropsHigh" },
    );
  });

  it("processes alerts that match the filter", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ acceptOnlyLabels: { paperclip: "true" } });
    const alert = baseAlert({
      labels: {
        alertname: "Watchdog",
        severity: "info",
        paperclip: "true",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });
});

describe("handleWebhook — severity → priority", () => {
  it("maps severity=warning to priority=high using the default map", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ severityToPriority: undefined });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "warning" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("high");
  });

  it("operator severity-to-priority overrides the default", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      severityToPriority: { critical: "low" },
    });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("low");
  });

  it("falls back to medium for unknown severities", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      labels: { alertname: "X", severity: "page" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("medium");
  });
});

describe("handleWebhook — observability link rendering", () => {
  it("renders all reserved annotation keys plus generatorURL", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      annotations: {
        summary: "x",
        dashboard_url: "https://grafana/d/x",
        trace_url: "https://grafana/t",
        profile_url: "https://pyroscope/p",
        flow_query_url: "https://hubble/f",
        runbook_url: "https://runbooks/r",
        // Unsupported observability key — must NOT appear in the output.
        random_url: "https://attacker/",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const desc = mocks.issues.create.mock.calls[0][0].description as string;
    expect(desc).toContain("[Dashboard](https://grafana/d/x)");
    expect(desc).toContain("[Tempo trace](https://grafana/t)");
    expect(desc).toContain("[Pyroscope flamegraph](https://pyroscope/p)");
    expect(desc).toContain("[Hubble flow query](https://hubble/f)");
    expect(desc).toContain("[Runbook](https://runbooks/r)");
    expect(desc).toContain("[Source query in Prometheus](http://prometheus-0:9090/graph?g0.expr=foo)");
    expect(desc).not.toContain("https://attacker/");
  });
});

describe("handleWebhook — owner resolution fallback chain", () => {
  it("label override beats the owner-map", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const alert = baseAlert({
      labels: {
        alertname: "X",
        severity: "info",
        team: "platform",
        paperclip_assignee_email: "bob@example.com",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).toHaveBeenCalledWith("bob@example.com");
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-bob");
  });

  it("owner-map resolves when no override is present", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.users.findByEmail).toHaveBeenCalledWith("alice@example.com");
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-alice");
  });

  it("annotation override is the last resort before unassigned", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-carol",
      email: "carol@example.com",
      name: "Carol",
    });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "info" },
      annotations: { paperclip_assignee_email: "carol@example.com" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-carol");
  });

  it("creates the issue unassigned when nothing resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "info" },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).not.toHaveBeenCalled();
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
  });
});
