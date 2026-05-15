import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockFetch,
  SAMPLE_AGENTS,
} from "../test_helpers.ts";
import { cleanTaskTitle } from "./cleanup.ts";

Deno.test({
  name: "handleCreateIssue rejects creation without assigneeName",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    const result = await handleCreateIssue({
      title: "Test issue",
      description: "Test description",
    });
    assertStringIncludes(result.text, "who this task is for");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue creates issue with valid assignee",
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

Deno.test({
  name: "handleCreateIssue rejects unresolvable agent name",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    const result = await handleCreateIssue({
      title: "UnknownPerson: do something",
      description: "do something",
      assigneeName: "UnknownPerson",
    });
    assertStringIncludes(result.text, "couldn't find an agent");
    assertStringIncludes(result.text, "UnknownPerson");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue includes required source/audit note on confirmed creation",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));

    let commentBody = "";
    mockFetch(/\/issues$/, () => mockJsonResponse({
      id: "test-issue-1",
      identifier: "CRE-502",
      title: "",
      status: "todo",
      priority: "medium",
    }));
    mockFetch(/\/comments/, (_url, init) => {
      const body = JSON.parse(init?.body as string);
      commentBody = body.body;
      return mockJsonResponse({});
    });

    await handleCreateIssue({
      title: "Hunter: review PR #42",
      description: "review PR #42",
      assigneeName: "Hunter",
      sourceMessage: "Can you have Hunter review PR #42?",
      confirmationMessage: "Yes",
      chatId: 12345,
    });

    assertStringIncludes(commentBody, "Created by Chase via Telegram.");
    assertStringIncludes(commentBody, "Requested by: Jeff");
    assertStringIncludes(commentBody, 'Source message: "Can you have Hunter review PR #42?"');
    assertStringIncludes(commentBody, "Confirmed by Jeff: Yes");
    assertStringIncludes(commentBody, 'Confirmation message: "Yes"');
    assertStringIncludes(commentBody, "Created from Telegram at:");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue includes edit metadata when title was edited before creation",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));

    const rawTitle = "Hunter: review PR #42?";
    const finalTitle = cleanTaskTitle(rawTitle, "Hunter");

    let commentBody = "";
    mockFetch(/\/issues$/, () => mockJsonResponse({
      id: "test-issue-2",
      identifier: "CRE-503",
      title: "",
      status: "todo",
      priority: "medium",
    }));
    mockFetch(/\/comments/, (_url, init) => {
      const body = JSON.parse(init?.body as string);
      commentBody = body.body;
      return mockJsonResponse({});
    });

    await handleCreateIssue({
      title: rawTitle,
      description: "review PR #42?",
      assigneeName: "Hunter",
      sourceMessage: "Can you have Hunter review PR #42?",
      confirmationMessage: "Yes",
      chatId: 12345,
      originalDraftTitle: rawTitle,
    });

    assertStringIncludes(commentBody, "Edited before creation: Yes");
    assertStringIncludes(commentBody, `Original draft title: "${rawTitle}"`);
    assertStringIncludes(commentBody, `Final title: "${finalTitle}"`);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Can you have Miles delete CRE-549? creates clean title/details",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));

    let createdIssueTitle = "";
    mockFetch(/\/issues$/, (_url, init) => {
      const body = JSON.parse(init?.body as string);
      createdIssueTitle = body.title;
      return mockJsonResponse({
        id: "test-issue-3",
        identifier: "CRE-504",
        title: createdIssueTitle,
        status: "todo",
        priority: "medium",
      });
    });
    mockFetch(/\/comments/, () => mockJsonResponse({}));

    await handleCreateIssue({
      title: "Hunter: review PR #42?",
      description: "review PR #42?",
      assigneeName: "Hunter",
      sourceMessage: "Can you have Hunter review PR #42?",
      confirmationMessage: "Yes",
      chatId: 12345,
      originalDraftTitle: "Hunter: review PR #42?",
    });

    assertEquals(createdIssueTitle, "Review PR #42");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue returns permission error on 403 from API",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(
      /\/api\/companies\/.*\/issues$/,
      () => new Response(
        JSON.stringify({ error: "Missing permission: tasks:assign" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleCreateIssue({
      title: "Hunter: review PR",
      description: "review PR",
      assigneeName: "Hunter",
      sourceMessage: "Can you have Hunter review PR?",
      confirmationMessage: "Yes",
      chatId: 12345,
    });

    assertStringIncludes(result.text, "unable to create tasks");
    assertStringIncludes(result.text, "tasks:assign");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue succeeds even when audit comment fails",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(/\/api\/companies\/.*\/issues$/, () => mockJsonResponse({
      id: "audit-fail-issue",
      identifier: "CRE-510",
      title: "Test audit failure",
      status: "todo",
      priority: "medium",
    }));
    // Comment POST returns 500
    mockFetch(
      /\/comments/,
      () => new Response("Server error", { status: 500 }),
    );

    const result = await handleCreateIssue({
      title: "Hunter: test audit failure",
      description: "test audit failure",
      assigneeName: "Hunter",
      sourceMessage: "Test audit failure",
      confirmationMessage: "Yes",
      chatId: 12345,
    });

    // Issue creation should still succeed despite audit comment failure
    assertStringIncludes(result.text, "Issue Created");
    assertStringIncludes(result.text, "CRE-510");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleCreateIssue returns permission error for 403 even without chatId (LLM path)",
  async fn() {
    setupMockFetch();
    const { handleCreateIssue } = await import("./actions.ts");
    mockFetch(/agents/, () => mockJsonResponse(SAMPLE_AGENTS));
    mockFetch(
      /\/api\/companies\/.*\/issues$/,
      () => new Response(
        JSON.stringify({ error: "Missing permission: tasks:assign" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleCreateIssue({
      title: "Hunter: review PR",
      description: "review PR",
      assigneeName: "Hunter",
    });

    assertStringIncludes(result.text, "unable to create tasks");
    assertStringIncludes(result.text, "tasks:assign");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
