import { describe, expect, it, vi } from "vitest";
import {
  BillingCapMonitor,
  CompositeCapNotifier,
  InMemoryBillingCapStore,
  LogCapNotifier,
  createOpenMonthlyIncidentHook,
  createPaperclipCommentCapNotifier,
  createTelegramCapNotifier,
  createTelegramHttpTransport,
  type CapNotifierIssueCommentService,
  type CapNotifierIssueCreateService,
  type SourceB,
  type SourceBSample,
} from "./index.js";

class StaticSourceB implements SourceB {
  constructor(private readonly fixture: SourceBSample) {}
  async sample(): Promise<SourceBSample> {
    return this.fixture;
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const COMPANY = "company-let-392";
const PILOT_INCIDENT_ISSUE_ID = "pilot-incident-uuid-365";
const PILOT_PROJECT_ID = "pilot-project-uuid";
const NOW = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));

describe("LET-392 cap-notifier wiring", () => {
  function buildIssuesSvcMocks() {
    const addComment: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: "comment-x" }));
    const create: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: "incident-issue-99" }));
    const listLabels: ReturnType<typeof vi.fn> = vi.fn(async () => [] as Array<{ id: string; name: string }>);
    const createLabel: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: "label-sandbox-cost-breach" }));
    const issuesSvc: CapNotifierIssueCommentService & CapNotifierIssueCreateService = {
      addComment: addComment as unknown as CapNotifierIssueCommentService["addComment"],
      create: create as unknown as CapNotifierIssueCreateService["create"],
      listLabels: listLabels as unknown as CapNotifierIssueCreateService["listLabels"],
      createLabel: createLabel as unknown as CapNotifierIssueCreateService["createLabel"],
    };
    return { issuesSvc, addComment, create, listLabels, createLabel };
  }

  it("hard-cap month tick fires log + paperclip-comment + telegram transports AND opens an incident issue", async () => {
    const { issuesSvc, addComment, create, listLabels, createLabel } = buildIssuesSvcMocks();
    const telegramFetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));
    const log = silentLogger();
    const telegramTransport = createTelegramHttpTransport({
      botToken: "bot-token-xyz",
      chatId: "chat-id-789",
      fetcher: telegramFetcher,
      logger: log,
    });
    expect(telegramTransport).not.toBeNull();
    const paperclipNotifier = createPaperclipCommentCapNotifier({
      issuesSvc,
      pilotIncidentIssueId: PILOT_INCIDENT_ISSUE_ID,
      authorAgentId: "agent-auto-cap-monitor",
      logger: log,
    });
    const telegramNotifier = createTelegramCapNotifier(telegramTransport);
    expect(telegramNotifier).not.toBeNull();
    const openMonthlyIncident = createOpenMonthlyIncidentHook({
      issuesSvc,
      resolveProjectId: () => PILOT_PROJECT_ID,
      resolveParentIssueId: () => PILOT_INCIDENT_ISSUE_ID,
      logger: log,
    });
    const composite = new CompositeCapNotifier([
      new LogCapNotifier(log),
      paperclipNotifier,
      telegramNotifier!,
    ]);
    const monitor = new BillingCapMonitor({
      store: new InMemoryBillingCapStore(),
      sourceA: null,
      sourceB: new StaticSourceB({
        dayCents: 5_00,
        monthCents: 250_00,
        dayRuntimeSeconds: 0,
        monthRuntimeSeconds: 0,
        ratePerSecondCents: 0.01,
      }),
      notifier: composite,
      openMonthlyIncident,
      logger: log,
    });

    const result = await monitor.tick({ companyId: COMPANY, now: NOW });

    // Monitor recorded a monthly hard-cap breach + monthly_incident_opened event.
    expect(result.capState).toBe("hard-cap-breached-auto-disabled");
    expect(result.notifications.some((n) => n.kind === "hard_cap_breached" && n.tone === "danger")).toBe(true);
    const incidentEvent = result.events.find((e) => e.kind === "monthly_incident_opened");
    expect(incidentEvent?.incidentIssueId).toBe("incident-issue-99");

    // PaperclipCommentCapNotifier fired against the configured incident issue.
    expect(addComment).toHaveBeenCalled();
    const commentCalls = addComment.mock.calls as unknown as Array<[string, string, unknown, { presentation?: { tone?: string } } | undefined]>;
    expect(commentCalls.every((call) => call[0] === PILOT_INCIDENT_ISSUE_ID)).toBe(true);
    const hardCommentCall = commentCalls.find((call) => /monthly hard cap breached/i.test(String(call[1])));
    expect(hardCommentCall).toBeDefined();
    expect(hardCommentCall?.[3]?.presentation?.tone).toBe("danger");

    // TelegramCapNotifier fired with the AC #3 page on the danger-tone hard-cap.
    expect(telegramFetcher).toHaveBeenCalled();
    const telegramCalls = telegramFetcher.mock.calls as unknown as Array<[string, { body: string }]>;
    expect(telegramCalls.every((call) => String(call[0]).startsWith("https://api.telegram.org/bot"))).toBe(true);
    const pages = telegramCalls.map((call) => JSON.parse(call[1].body) as { chat_id: string; text: string });
    expect(pages.every((p) => p.chat_id === "chat-id-789")).toBe(true);
    expect(pages.some((p) => /monthly hard cap breached/i.test(p.text))).toBe(true);
    // No raw bot-token leaks into the message body.
    expect(pages.every((p) => !p.text.includes("bot-token-xyz"))).toBe(true);

    // openMonthlyIncident hook actually invoked issuesSvc.create with the right shape.
    expect(create).toHaveBeenCalledTimes(1);
    const createCall = create.mock.calls[0] as unknown as [string, {
      title: string;
      parentId: string | null;
      projectId: string | null;
      priority: string;
      labelIds: string[];
    }];
    expect(createCall[0]).toBe(COMPANY);
    expect(createCall[1].title).toMatch(/Sandbox cost-breach/i);
    expect(createCall[1].parentId).toBe(PILOT_INCIDENT_ISSUE_ID);
    expect(createCall[1].projectId).toBe(PILOT_PROJECT_ID);
    expect(createCall[1].priority).toBe("high");
    expect(createCall[1].labelIds).toEqual(["label-sandbox-cost-breach"]);
    expect(listLabels).toHaveBeenCalledWith(COMPANY);
    expect(createLabel).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ name: "sandbox/cost-breach" }));
  });

  it("falls back to noop when Telegram env credentials are missing", async () => {
    const transport = createTelegramHttpTransport({ botToken: "", chatId: "" });
    expect(transport).toBeNull();
    const notifier = createTelegramCapNotifier(transport);
    expect(notifier).toBeNull();
  });

  it("PaperclipCommentCapNotifier skips when no pilot-incident issue id is configured", async () => {
    const { issuesSvc, addComment } = buildIssuesSvcMocks();
    const log = silentLogger();
    const notifier = createPaperclipCommentCapNotifier({
      issuesSvc,
      pilotIncidentIssueId: null,
      logger: log,
    });
    await notifier.notify({
      companyId: COMPANY,
      provider: "e2b",
      kind: "hard_cap_breached",
      tone: "danger",
      interrupt: true,
      title: "x",
      body: "y",
    });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("PaperclipCommentCapNotifier suppresses comments for operator_toggle_flipped (activity-log already covers it)", async () => {
    const { issuesSvc, addComment } = buildIssuesSvcMocks();
    const log = silentLogger();
    const notifier = createPaperclipCommentCapNotifier({
      issuesSvc,
      pilotIncidentIssueId: PILOT_INCIDENT_ISSUE_ID,
      logger: log,
    });
    await notifier.notify({
      companyId: COMPANY,
      provider: "e2b",
      kind: "operator_toggle_flipped",
      tone: "info",
      title: "operator toggled off",
      body: "manual pause",
    });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("openMonthlyIncident hook returns null and does not throw when issuesSvc.create fails", async () => {
    const log = silentLogger();
    const issuesSvc: CapNotifierIssueCreateService = {
      create: vi.fn(async () => {
        throw new Error("issues API unreachable");
      }),
      listLabels: vi.fn(async () => []),
      createLabel: vi.fn(async () => ({ id: "label-x" })),
    };
    const hook = createOpenMonthlyIncidentHook({
      issuesSvc,
      resolveProjectId: () => PILOT_PROJECT_ID,
      resolveParentIssueId: () => PILOT_INCIDENT_ISSUE_ID,
      logger: log,
    });
    const result = await hook({
      companyId: COMPANY,
      provider: "e2b",
      kind: "hard_cap_breached",
      tone: "danger",
      title: "x",
      body: "y",
    });
    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it("Telegram transport surfaces non-OK responses as a thrown error without leaking the bot token", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "{\"description\":\"Unauthorized\"}",
    }));
    const transport = createTelegramHttpTransport({
      botToken: "secret-token-do-not-log",
      chatId: "chat-id-789",
      fetcher,
    });
    expect(transport).not.toBeNull();
    await expect(transport!.sendPage("hello")).rejects.toThrow(/Unauthorized/);
    await expect(transport!.sendPage("hello")).rejects.not.toThrow(/secret-token-do-not-log/);
  });
});
