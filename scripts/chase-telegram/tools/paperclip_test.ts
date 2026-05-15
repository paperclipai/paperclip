import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockFetch,
  SAMPLE_AGENTS,
  SAMPLE_ISSUES,
  SAMPLE_APPROVALS,
  SAMPLE_ISSUE_DETAIL,
} from "../test_helpers.ts";

Deno.test({
  name: "handleBlockedQuery returns 'all clear' when nothing blocked",
  async fn() {
    setupMockFetch();
    const { handleBlockedQuery } = await import("./paperclip.ts");
    mockFetch(/status=blocked/, () => mockJsonResponse([]));
    const result = await handleBlockedQuery();
    assertStringIncludes(result.text, "All clear");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleBlockedQuery returns blocked issues list",
  async fn() {
    setupMockFetch();
    const { handleBlockedQuery } = await import("./paperclip.ts");
    mockFetch(/status=blocked/, () => mockJsonResponse(SAMPLE_ISSUES.filter((i) => i.status === "blocked")));
    const result = await handleBlockedQuery();
    assertStringIncludes(result.text, "Blocked Issues");
    assertStringIncludes(result.text, "CRE-301");
    assertStringIncludes(result.text, "high");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleApprovalsQuery returns 'no pending' when none",
  async fn() {
    setupMockFetch();
    const { handleApprovalsQuery } = await import("./paperclip.ts");
    mockFetch(/approvals/, () => mockJsonResponse([]));
    const result = await handleApprovalsQuery();
    assertStringIncludes(result.text, "No pending approvals");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleApprovalsQuery returns pending approvals list",
  async fn() {
    setupMockFetch();
    const { handleApprovalsQuery } = await import("./paperclip.ts");
    mockFetch(/approvals/, () => mockJsonResponse(SAMPLE_APPROVALS));
    const result = await handleApprovalsQuery();
    assertStringIncludes(result.text, "Pending Approvals");
    assertStringIncludes(result.text, "Deploy");
    assertStringIncludes(result.text, "Hire");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleAgentsQuery returns 'no agents' when empty",
  async fn() {
    setupMockFetch();
    const { handleAgentsQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse([]));
    const result = await handleAgentsQuery();
    assertStringIncludes(result.text, "No agents found");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleAgentsQuery returns agent roster",
  async fn() {
    setupMockFetch();
    const { handleAgentsQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const result = await handleAgentsQuery();
    assertStringIncludes(result.text, "Agents");
    assertStringIncludes(result.text, "Jeff");
    assertStringIncludes(result.text, "Chief Executive Officer");
    assertStringIncludes(result.text, "Hayes");
    assertStringIncludes(result.text, "Founding Engineer");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleDetailQuery returns not found for unknown identifier",
  async fn() {
    setupMockFetch();
    const { handleDetailQuery } = await import("./paperclip.ts");
    mockFetch(/q=CRE-999/, () => mockJsonResponse([]));
    const result = await handleDetailQuery("CRE-999");
    assertStringIncludes(result.text, "Could not find issue");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleDetailQuery returns issue detail for known identifier",
  async fn() {
    setupMockFetch();
    const { handleDetailQuery } = await import("./paperclip.ts");
    mockFetch(/q=CRE-301/, () => mockJsonResponse([SAMPLE_ISSUE_DETAIL]));
    mockFetch(/\/api\/issues\/issue-1/, () => mockJsonResponse(SAMPLE_ISSUE_DETAIL));
    const result = await handleDetailQuery("CRE-301");
    assertStringIncludes(result.text, "CRE-301");
    assertStringIncludes(result.text, "Fix login timeout bug");
    assertStringIncludes(result.text, "blocked");
    assertStringIncludes(result.text, "high");
    assertStringIncludes(result.text, "Blocked by");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleDetailQuery resolves bare number to CRE-N format",
  async fn() {
    setupMockFetch();
    const { handleDetailQuery } = await import("./paperclip.ts");
    mockFetch(/q=CRE-301/, () => mockJsonResponse([SAMPLE_ISSUE_DETAIL]));
    mockFetch(/\/api\/issues\/issue-1/, () => mockJsonResponse(SAMPLE_ISSUE_DETAIL));
    const result = await handleDetailQuery("301");
    assertStringIncludes(result.text, "CRE-301");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleSearchQuery returns no results message",
  async fn() {
    setupMockFetch();
    const { handleSearchQuery } = await import("./paperclip.ts");
    mockFetch(/q=zzznotfound/, () => mockJsonResponse([]));
    const result = await handleSearchQuery("zzznotfound");
    assertStringIncludes(result.text, "No results");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleSearchQuery returns matching issues",
  async fn() {
    setupMockFetch();
    const { handleSearchQuery } = await import("./paperclip.ts");
    mockFetch(/q=login/, () => mockJsonResponse(SAMPLE_ISSUES));
    const result = await handleSearchQuery("login");
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "CRE-301");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleOverviewQuery returns company overview",
  async fn() {
    setupMockFetch();
    const { handleOverviewQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/status=blocked/, () => mockJsonResponse(SAMPLE_ISSUES.filter((i) => i.status === "blocked")));
    const result = await handleOverviewQuery();
    assertStringIncludes(result.text, "Company Overview");
    assertStringIncludes(result.text, "Agents: 6");
    assertStringIncludes(result.text, "Blocked issues: 1");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleAgentIssuesQuery returns agent not found",
  async fn() {
    setupMockFetch();
    const { handleAgentIssuesQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const result = await handleAgentIssuesQuery("NonExistentAgent");
    assertStringIncludes(result.text, "Could not find an agent");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleAgentIssuesQuery returns agent's issues",
  async fn() {
    setupMockFetch();
    const { handleAgentIssuesQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/assigneeAgentId=agent-hunter/, () => mockJsonResponse(
      SAMPLE_ISSUES.filter((i) => i.assigneeAgentId === "agent-hunter"),
    ));
    const result = await handleAgentIssuesQuery("Hunter");
    assertStringIncludes(result.text, "Hunter");
    assertStringIncludes(result.text, "CRE-301");
    assertStringIncludes(result.text, "CRE-303");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleAgentIssuesQuery returns no issues message",
  async fn() {
    setupMockFetch();
    const { handleAgentIssuesQuery } = await import("./paperclip.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/assigneeAgentId=agent-chase/, () => mockJsonResponse([]));
    const result = await handleAgentIssuesQuery("Chase");
    assertStringIncludes(result.text, "no assigned issues");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
