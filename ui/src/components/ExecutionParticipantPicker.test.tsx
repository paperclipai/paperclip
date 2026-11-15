// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { issueExecutionPolicySchema, type Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { ExecutionParticipantPicker } from "./ExecutionParticipantPicker";

vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("../lib/sentry", () => ({ captureBrowserException: vi.fn() }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function renderPicker(policy: unknown) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onUpdate = vi.fn();
  const issue = { companyId: "company-fixture", executionPolicy: policy } as Issue;
  act(() => root.render(<QueryClientProvider client={client}>
    <ExecutionParticipantPicker issue={issue} stageType="review" agents={[]} currentUserId="board-reviewer" onUpdate={onUpdate} />
  </QueryClientProvider>));
  return { container, onUpdate, cleanup: () => { act(() => root.unmount()); client.clear(); } };
}

describe("ExecutionParticipantPicker", () => {
  it("adds a reviewer to a valid policy that omits stages without dropping authorization", () => {
    const policy = { authorizationPolicy: { trustPreset: "standard" }, maxReviewRounds: 4 };
    const { container, onUpdate, cleanup } = renderPicker(policy);
    expect(container.textContent).not.toContain("Execution policy unavailable");
    const assign = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Assign to me");
    expect(assign).toBeTruthy();
    act(() => assign!.click());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const updated = onUpdate.mock.calls[0][0].executionPolicy;
    expect(issueExecutionPolicySchema.safeParse(updated).success).toBe(true);
    expect(updated).toMatchObject({ ...policy, stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }] });
    expect(policy).not.toHaveProperty("stages");
    cleanup();
  });

  it("shows an existing reviewer and preserves other policy settings when that reviewer is removed", () => {
    const policy = {
      authorizationPolicy: { trustPreset: "standard" }, maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }],
    };
    const { container, onUpdate, cleanup } = renderPicker(policy);
    expect(container.querySelector("button")?.textContent).toBe("You");
    const remove = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "No reviewers");
    expect(remove).toBeTruthy();
    act(() => remove!.click());
    expect(onUpdate).toHaveBeenCalledWith({ executionPolicy: {
      mode: "normal", commentRequired: true, stages: [],
      authorizationPolicy: policy.authorizationPolicy, maxReviewRounds: 4,
    } });
    expect(policy.stages[0].participants).toHaveLength(1);
    cleanup();
  });

  it("keeps a malformed policy unavailable and exposes no mutation controls", () => {
    const { container, onUpdate, cleanup } = renderPicker({ stages: [{ type: "review", participants: {} }] });
    expect(container.textContent).toBe("Execution policy unavailable. Refresh to try again.");
    expect(container.querySelector("button")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    cleanup();
  });
});
