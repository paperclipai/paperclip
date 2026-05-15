import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockFetch,
  SAMPLE_AGENTS,
} from "../test_helpers.ts";

Deno.test({
  name: "handleCreateIssue creates issue with title and description",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/\/api\/companies\/.*\/issues$/, (url, init) => {
      return mockJsonResponse({
        id: "new-1",
        identifier: "CRE-500",
        title: "Test issue",
        status: "todo",
        priority: "medium",
      });
    });
    const result = await handleCreateIssue({
      title: "Test issue",
      description: "Test description",
    });
    assertStringIncludes(result.text, "Issue Created");
    assertStringIncludes(result.text, "CRE-500");
    assertEquals(result.text.includes("Assigned to:"), false);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue creates issue with assignee",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/\/api\/companies\/.*\/issues$/, () => mockJsonResponse({
      id: "new-2",
      identifier: "CRE-501",
      title: "Hunter: review PR",
      status: "todo",
      priority: "medium",
    }));
    const result = await handleCreateIssue({
      title: "Hunter: review PR #42",
      description: "review PR #42",
      assigneeName: "Hunter",
    });
    assertStringIncludes(result.text, "Issue Created");
    assertStringIncludes(result.text, "Assigned to:");
    assertStringIncludes(result.text, "Hunter");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
