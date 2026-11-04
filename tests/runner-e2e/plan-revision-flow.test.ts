import { expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { runPlanRevisionAcceptance } from "./plan-revision-flow.js";

const state = {
  currentIssue: { status: "in_progress" },
  taskRuns: [{ status: "succeeded" }],
  interactions: [{ id: "confirmation", kind: "request_confirmation", status: "pending",
    payload: { target: { type: "issue_document", key: "plan", revisionId: "draft" } } }],
};

it("keeps the classic Plan story alive through a transient observation failure", async () => {
  const reachedDocument = new Error("reached the canonical Plan read");
  const load = vi.fn().mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValue(state);
  const get = vi.fn(async () => { throw reachedDocument; });
  await expect(runPlanRevisionAcceptance({
    page: {} as Page, api: { get }, origin: "https://qa.example.test", issue: { id: "owned" },
    issuePrefix: "QA", native: true, planMarkers: { draft: "draft", revised: "revised" },
    revisionRequest: "revise", deadlineAt: Date.now() + 5000,
    load, reject: () => undefined, capture: async () => {},
  })).rejects.toBe(reachedDocument);
  expect(load).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledWith("/api/issues/owned/documents/plan");
});

it("lets deployment callers reject a binding failure without another observation", async () => {
  const bindingFailure = new Error("owned task binding changed");
  const load = vi.fn().mockRejectedValueOnce(bindingFailure).mockResolvedValue(state);
  const get = vi.fn(async () => { throw new Error("must not read an unbound document"); });
  await expect(runPlanRevisionAcceptance({
    page: {} as Page, api: { get }, origin: "https://qa.example.test", issue: { id: "owned" },
    issuePrefix: "QA", native: true, planMarkers: { draft: "draft", revised: "revised" },
    revisionRequest: "revise", deadlineAt: Date.now() + 5000,
    load, retryOnError: error => error !== bindingFailure, reject: () => undefined, capture: async () => {},
  })).rejects.toBe(bindingFailure);
  expect(load).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
});
