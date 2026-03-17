import { vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, DocumentRevision, Issue, IssueComment, IssueDocument } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";

export const BASE_CONFIG = {
  honchoApiBaseUrl: "https://api.honcho.dev",
  honchoApiKeySecretRef: "HONCHO_API_KEY",
  workspacePrefix: "paperclip",
  syncIssueComments: true,
  syncIssueDocuments: false,
  enablePeerChat: false,
};

export type SeedOverrides = {
  companies?: Company[];
  issues?: Issue[];
  issueComments?: IssueComment[];
  issueDocuments?: IssueDocument[];
  documentRevisions?: DocumentRevision[];
  agents?: Agent[];
};

export type CapturedRequest = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
};

type FetchMockOptions = {
  failOn?: Array<string | RegExp>;
  failOnceOn?: Array<string | RegExp>;
  searchResults?: Array<Record<string, unknown>>;
  summaries?: string[];
  chatText?: string;
  workspaceResponse?: Record<string, unknown>;
};

function matchesPattern(url: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string" || body.length === 0) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function installFetchMock(options: FetchMockOptions = {}) {
  const requests: CapturedRequest[] = [];
  const remainingFailOnce = new Map<string | RegExp, number>(
    (options.failOnceOn ?? []).map((pattern) => [pattern, 1]),
  );
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: parseBody(init?.body),
    });

    if (options.failOn?.some((pattern) => matchesPattern(url, pattern))) {
      return new Response(JSON.stringify({ error: "forced failure" }), { status: 500 });
    }
    for (const [pattern, remaining] of remainingFailOnce.entries()) {
      if (remaining > 0 && matchesPattern(url, pattern)) {
        remainingFailOnce.set(pattern, remaining - 1);
        return new Response(JSON.stringify({ error: "forced failure" }), { status: 500 });
      }
    }

    if (url.endsWith("/v3/workspaces")) {
      return new Response(JSON.stringify(options.workspaceResponse ?? { ok: true }), { status: 200 });
    }
    if (url.includes("/representation")) {
      return new Response(JSON.stringify({
        results: options.searchResults ?? [
          {
            id: "search-1",
            content: "Relevant memory hit",
            metadata: { sourceSystem: "paperclip", issueId: "iss_1" },
            score: 0.98,
          },
        ],
      }), { status: 200 });
    }
    if (url.includes("/chat")) {
      return new Response(JSON.stringify({ text: options.chatText ?? "Peer answer" }), { status: 200 });
    }
    if (url.includes("/peers")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/sessions") && !url.includes("/messages") && !url.includes("/summaries")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/summaries")) {
      return new Response(JSON.stringify({
        summaries: (options.summaries ?? ["Investigating auth regression and next steps."]).map((summary) => ({ summary })),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

export function requestsMatching(requests: CapturedRequest[], pattern: string): CapturedRequest[] {
  return requests.filter((request) => request.url.includes(pattern));
}

export function buildDefaultFixtures(): Required<SeedOverrides> {
  const companies: Company[] = [{
    id: "co_1",
    name: "Paperclip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: true,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-03-15T12:00:00.000Z"),
    updatedAt: new Date("2026-03-15T12:00:00.000Z"),
  }];

  const issues: Issue[] = [{
    id: "iss_1",
    companyId: "co_1",
    projectId: "proj_1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Fix auth regression",
    description: "Need to investigate auth failures.",
    status: "todo",
    priority: "high",
    assigneeAgentId: "agent_1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user_1",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-15T12:00:00.000Z"),
    updatedAt: new Date("2026-03-15T12:00:00.000Z"),
  }];

  const issueComments: IssueComment[] = [
    {
      id: "c_1",
      companyId: "co_1",
      issueId: "iss_1",
      authorAgentId: null,
      authorUserId: "user_1",
      body: "First comment",
      createdAt: new Date("2026-03-15T12:01:00.000Z"),
      updatedAt: new Date("2026-03-15T12:01:00.000Z"),
    },
    {
      id: "c_2",
      companyId: "co_1",
      issueId: "iss_1",
      authorAgentId: "agent_1",
      authorUserId: null,
      body: "Second comment",
      createdAt: new Date("2026-03-15T12:02:00.000Z"),
      updatedAt: new Date("2026-03-15T12:02:00.000Z"),
    },
  ];

  const issueDocuments: IssueDocument[] = [{
    id: "doc_1",
    companyId: "co_1",
    issueId: "iss_1",
    key: "design",
    title: "Design Notes",
    format: "markdown",
    body: "# Design\n\nStable chunk one.\n\nStable chunk two.",
    latestRevisionId: "rev_2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user_1",
    updatedByAgentId: "agent_1",
    updatedByUserId: null,
    createdAt: new Date("2026-03-15T12:00:00.000Z"),
    updatedAt: new Date("2026-03-15T12:03:00.000Z"),
  }];

  const documentRevisions: DocumentRevision[] = [
    {
      id: "rev_1",
      companyId: "co_1",
      documentId: "doc_1",
      issueId: "iss_1",
      key: "design",
      revisionNumber: 1,
      body: "# Design\n\nInitial body.",
      changeSummary: "Initial",
      createdByAgentId: null,
      createdByUserId: "user_1",
      createdAt: new Date("2026-03-15T12:00:00.000Z"),
    },
    {
      id: "rev_2",
      companyId: "co_1",
      documentId: "doc_1",
      issueId: "iss_1",
      key: "design",
      revisionNumber: 2,
      body: "# Design\n\nStable chunk one.\n\nStable chunk two.",
      changeSummary: "Update",
      createdByAgentId: "agent_1",
      createdByUserId: null,
      createdAt: new Date("2026-03-15T12:03:00.000Z"),
    },
  ];

  const agents: Agent[] = [{
    id: "agent_1",
    companyId: "co_1",
    name: "Agent One",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    metadata: null,
    permissions: { canCreateAgents: false },
    runtimeConfig: {},
    urlKey: "agent-one",
    icon: "bot",
    createdAt: new Date("2026-03-15T12:00:00.000Z"),
    updatedAt: new Date("2026-03-15T12:00:00.000Z"),
  }];

  return {
    companies,
    issues,
    issueComments,
    issueDocuments,
    documentRevisions,
    agents,
  };
}

export function createHonchoHarness(options: {
  config?: Partial<typeof BASE_CONFIG>;
  seed?: SeedOverrides;
} = {}) {
  const harness = createTestHarness({
    manifest,
    config: {
      ...BASE_CONFIG,
      ...(options.config ?? {}),
    },
  });
  const defaults = buildDefaultFixtures();
  harness.seed({
    companies: options.seed?.companies ?? defaults.companies,
    issues: options.seed?.issues ?? defaults.issues,
    issueComments: options.seed?.issueComments ?? defaults.issueComments,
    issueDocuments: options.seed?.issueDocuments ?? defaults.issueDocuments,
    documentRevisions: options.seed?.documentRevisions ?? defaults.documentRevisions,
    agents: options.seed?.agents ?? defaults.agents,
  });
  return harness;
}
