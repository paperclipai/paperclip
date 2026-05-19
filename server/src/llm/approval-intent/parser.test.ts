import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseApprovalIntent } from "./parser.js";
import * as clientModule from "./client.js";

// --- Mock layer ---
vi.mock("./client.js", () => ({
  callWithToolUse: vi.fn(),
}));

const mockCallWithToolUse = vi.mocked(clientModule.callWithToolUse);

describe("parseApprovalIntent (unit — mocked LLM)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.LLM_INTENT_PROVIDER;
  });

  afterEach(() => {
    delete process.env.LLM_INTENT_PROVIDER;
  });

  it("returns default for empty comment without calling LLM", async () => {
    const result = await parseApprovalIntent("");
    expect(mockCallWithToolUse).not.toHaveBeenCalled();
    expect(result.jira.action).toBe("default");
    expect(result.rawIntentSummary).toBe("");
  });

  it("returns default for whitespace-only comment without calling LLM", async () => {
    const result = await parseApprovalIntent("   ");
    expect(mockCallWithToolUse).not.toHaveBeenCalled();
    expect(result.jira.action).toBe("default");
  });

  it("returns default without calling LLM when LLM_INTENT_PROVIDER=noop", async () => {
    process.env.LLM_INTENT_PROVIDER = "noop";
    const result = await parseApprovalIntent("Please skip Jira");
    expect(mockCallWithToolUse).not.toHaveBeenCalled();
    expect(result.jira.action).toBe("default");
  });

  it("maps 'skip' action from LLM", async () => {
    mockCallWithToolUse.mockResolvedValueOnce({
      action: "skip",
      rawIntentSummary: "Reviewer wants to skip Jira sync entirely.",
    });
    const result = await parseApprovalIntent("Don't touch Jira for this one.");
    expect(result.jira.action).toBe("skip");
    expect(result.rawIntentSummary).toBe("Reviewer wants to skip Jira sync entirely.");
  });

  it("maps 'transition' action with transition name from LLM", async () => {
    mockCallWithToolUse.mockResolvedValueOnce({
      action: "transition",
      transition: "In Review",
      rawIntentSummary: "Reviewer wants to move ticket to In Review status.",
    });
    const result = await parseApprovalIntent("Please move the ticket to In Review.");
    expect(result.jira.action).toBe("transition");
    expect(result.jira.transition).toBe("In Review");
  });

  it("maps 'reassign' action with assignee name from LLM", async () => {
    mockCallWithToolUse.mockResolvedValueOnce({
      action: "reassign",
      assignee: "john.doe",
      rawIntentSummary: "Reviewer wants to reassign the ticket to john.doe.",
    });
    const result = await parseApprovalIntent("Reassign this to john.doe please.");
    expect(result.jira.action).toBe("reassign");
    expect(result.jira.assignee).toBe("john.doe");
  });

  it("maps 'default' action from LLM (explicit LGTM)", async () => {
    mockCallWithToolUse.mockResolvedValueOnce({
      action: "default",
      rawIntentSummary: "Reviewer approves with default Jira handling.",
    });
    const result = await parseApprovalIntent("LGTM!");
    expect(result.jira.action).toBe("default");
  });

  it("returns <<llm-unavailable>> default when LLM call throws (timeout/network)", async () => {
    mockCallWithToolUse.mockRejectedValueOnce(new Error("AbortError: The operation was aborted"));
    const result = await parseApprovalIntent("Skip Jira please.");
    expect(result.jira.action).toBe("default");
    expect(result.rawIntentSummary).toBe("<<llm-unavailable>>");
  });

  it("returns <<llm-unavailable>> default when LLM call throws API error", async () => {
    mockCallWithToolUse.mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const result = await parseApprovalIntent("Approved.");
    expect(result.jira.action).toBe("default");
    expect(result.rawIntentSummary).toBe("<<llm-unavailable>>");
  });
});

// --- Live integration tests — skipped unless ANTHROPIC_API_KEY is set ---
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!hasApiKey)("parseApprovalIntent (integration — real LLM)", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // un-mock client so real SDK is used
    delete process.env.LLM_INTENT_PROVIDER;
  });

  it("classifies 'LGTM' as default action", async () => {
    const result = await parseApprovalIntent("LGTM!");
    expect(result.jira.action).toBe("default");
    expect(result.rawIntentSummary).toBeTruthy();
  }, 15_000);

  it("classifies explicit skip request", async () => {
    const result = await parseApprovalIntent("Approved, but please skip the Jira update this time.");
    expect(result.jira.action).toBe("skip");
  }, 15_000);

  it("classifies transition request", async () => {
    const result = await parseApprovalIntent(
      "Looks good to me. Please transition the ticket to Done.",
    );
    expect(result.jira.action).toBe("transition");
    expect(result.jira.transition).toBeTruthy();
  }, 15_000);
});
