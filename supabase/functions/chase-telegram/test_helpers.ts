import type { PaperclipAgent, PaperclipIssue, PaperclipApproval } from "./types.ts";

// Mock fetch infrastructure

type MockHandler = (url: string, options?: RequestInit) => Response | Promise<Response>;

const mockHandlers: Map<string | RegExp, MockHandler> = new Map();
let originalFetch: typeof globalThis.fetch | undefined;

export function mockFetch(pattern: string | RegExp, handler: MockHandler): void {
  mockHandlers.set(pattern, handler);
}

export function setupMockFetch(): void {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
  }
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    for (const [pattern, handler] of mockHandlers) {
      if (typeof pattern === "string" ? url === pattern : pattern.test(url)) {
        return Promise.resolve(handler(url, init));
      }
    }
    return Promise.resolve(new Response("Unmocked URL: " + url, { status: 404 }));
  };
}

export function teardownMockFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  mockHandlers.clear();
}

export function resetMockHandlers(): void {
  mockHandlers.clear();
}

// Response builders

export function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function mockTextResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

// Fixture data

export const SAMPLE_AGENTS: PaperclipAgent[] = [
  { id: "agent-jeff", name: "Jeff", role: "CEO", title: "Chief Executive Officer" },
  { id: "agent-hunter", name: "Hunter", role: "CTO", title: "Chief Technology Officer" },
  { id: "agent-christie", name: "Christie", role: "Chief of Staff", title: "Chief of Staff" },
  { id: "agent-miles", name: "Miles", role: "CEO", title: "Chief Executive Officer" },
  { id: "agent-quinn", name: "Quinn", role: "QA Director", title: "Quality Director" },
  { id: "agent-hayes", name: "Hayes", role: "Engineering", title: "Founding Engineer" },
  { id: "agent-chase", name: "Chase", role: "Operations", title: "Operations Assistant" },
];

export const SAMPLE_ISSUES: PaperclipIssue[] = [
  {
    id: "issue-1",
    identifier: "CRE-301",
    title: "Fix login timeout bug",
    status: "blocked",
    priority: "high",
    assigneeAgentId: "agent-hunter",
    description: "Users are experiencing login timeouts after 30 seconds.",
    blockedBy: [{ id: "issue-3", identifier: "CRE-303", title: "Update auth library", status: "in_progress" }],
  },
  {
    id: "issue-2",
    identifier: "CRE-302",
    title: "Add dark mode support",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-hayes",
    description: "Implement dark mode across all UI components.",
  },
  {
    id: "issue-3",
    identifier: "CRE-303",
    title: "Update auth library",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent-hunter",
    blockedBy: [],
  },
  {
    id: "issue-4",
    identifier: "CRE-400",
    title: "Write API documentation",
    status: "todo",
    priority: "low",
    assigneeAgentId: "agent-christie",
    description: "Document all REST API endpoints with examples.",
  },
];

export const SAMPLE_APPROVALS: PaperclipApproval[] = [
  {
    id: "approval-1",
    title: "Deploy v2026.512.0 to production",
    status: "pending",
    type: "deploy",
    payload: { title: "Deploy v2026.512.0 to production", recommendedAction: "Review release notes and approve" },
  },
  {
    id: "approval-2",
    title: "Hire new QA engineer",
    status: "pending",
    type: "hire",
    payload: { title: "Hire new QA engineer", recommendedAction: "Schedule interview panel" },
  },
];

export const SAMPLE_ISSUE_DETAIL: PaperclipIssue = {
  id: "issue-1",
  identifier: "CRE-301",
  title: "Fix login timeout bug",
  status: "blocked",
  priority: "high",
  assigneeAgentId: "agent-hunter",
  description: "Users are experiencing login timeouts after 30 seconds. This is a critical bug affecting all users.",
  blockedBy: [{ id: "issue-3", identifier: "CRE-303", title: "Update auth library", status: "in_progress" }],
};

export const SAMPLE_METAR = "KJFK 151651Z 21015G25KT 10SM FEW025 BKN045 22/14 A3002 RMK AO2 SLP166 T02170139";
export const SAMPLE_TAF = "KJFK 151120Z 1512/1618 20012G20KT P6SM SCT035 BKN050 FM151500 19018G28KT P6SM BKN040";

export function setupPaperclipApiMocks(): void {
  mockFetch(
    /\/api\/companies\/.*\/issues\?status=blocked/,
    () => mockJsonResponse(SAMPLE_ISSUES.filter((i) => i.status === "blocked")),
  );
  mockFetch(
    /\/api\/companies\/.*\/approvals\?status=pending/,
    () => mockJsonResponse(SAMPLE_APPROVALS),
  );
  mockFetch(
    /\/api\/companies\/.*\/agents/,
    () => mockJsonResponse(SAMPLE_AGENTS),
  );
  mockFetch(
    /\/api\/companies\/.*\/issues\?q=CRE-301/,
    () => mockJsonResponse([SAMPLE_ISSUE_DETAIL]),
  );
  mockFetch(
    /\/api\/issues\/issue-1/,
    () => mockJsonResponse(SAMPLE_ISSUE_DETAIL),
  );
  mockFetch(
    /\/api\/companies\/.*\/issues\?q=CRE-999/,
    () => mockJsonResponse([]),
  );
  mockFetch(
    /\/api\/companies\/.*\/issues\?q/,
    () => mockJsonResponse(SAMPLE_ISSUES),
  );
  mockFetch(
    /\/api\/companies\/.*\/issues/,
    () => mockJsonResponse(SAMPLE_ISSUES[0]),
  );
}
