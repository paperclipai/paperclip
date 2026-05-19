import { describe, expect, it } from "vitest";
import { classifyAction } from "../services/smart-approval.js";

describe("smart-approval classifyAction", () => {
  it("routes file_edit to execute", () => {
    const out = classifyAction({ kind: "file_edit" });
    expect(out.decision).toBe("execute");
    expect(out.class).toBe("file_edit");
  });

  it("routes paperclip_comment to execute", () => {
    const out = classifyAction({ kind: "paperclip_comment" });
    expect(out.decision).toBe("execute");
  });

  it("routes gbrain_page_write to execute", () => {
    const out = classifyAction({ kind: "gbrain_page_write" });
    expect(out.decision).toBe("execute");
  });

  it("routes git push to feature branch to notify", () => {
    const out = classifyAction({ kind: "git_push", branch: "feature/foo" });
    expect(out.decision).toBe("notify");
    expect(out.class).toBe("git_push_feature");
  });

  it("routes git push to main to approve", () => {
    const out = classifyAction({ kind: "git_push", branch: "main" });
    expect(out.decision).toBe("approve");
    expect(out.class).toBe("git_push_main");
  });

  it("routes git force push to approve", () => {
    const out = classifyAction({ kind: "git_force_push" });
    expect(out.decision).toBe("approve");
  });

  it("routes external email to approve", () => {
    const out = classifyAction({ kind: "external_email" });
    expect(out.decision).toBe("approve");
  });

  it("routes IAM/cron/sudoers changes to approve", () => {
    expect(classifyAction({ kind: "iam_change" }).decision).toBe("approve");
    expect(classifyAction({ kind: "cron_change" }).decision).toBe("approve");
    expect(classifyAction({ kind: "sudoers_change" }).decision).toBe("approve");
  });

  it("routes small api calls under $0.50 to execute", () => {
    const out = classifyAction({ kind: "api_call", callCostUsd: 0.05 });
    expect(out.decision).toBe("execute");
    expect(out.class).toBe("small_api_call");
  });

  it("escalates api calls at or above $0.50 to cost-bearing", () => {
    const out = classifyAction({ kind: "api_call", callCostUsd: 0.75 });
    expect(out.class).toBe("cost_bearing");
    // Single call $0.75 is below the $50/mo threshold, so still execute.
    expect(out.decision).toBe("execute");
  });

  it("approves cost-bearing actions over $50/mo delta", () => {
    const out = classifyAction({
      kind: "cost_bearing",
      costDeltaUsdPerMonth: 200,
    });
    expect(out.decision).toBe("approve");
    expect(out.class).toBe("cost_bearing");
  });

  it("executes cost-bearing actions at or under threshold", () => {
    const out = classifyAction({
      kind: "cost_bearing",
      costDeltaUsdPerMonth: 10,
    });
    expect(out.decision).toBe("execute");
  });

  it("rule-of-two short-circuit: untrusted+external_state_change always approves", () => {
    const out = classifyAction({
      kind: "file_edit",
      capabilityTags: { untrusted: true, external_state_change: true },
    });
    expect(out.decision).toBe("approve");
    expect(out.class).toBe("untrusted_external");
  });

  it("untrusted alone (no external state change) does not trigger short-circuit", () => {
    const out = classifyAction({
      kind: "file_edit",
      capabilityTags: { untrusted: true },
    });
    expect(out.decision).toBe("execute");
    expect(out.class).toBe("file_edit");
  });

  it("unknown kinds default to approve (conservative)", () => {
    const out = classifyAction({ kind: "some_new_thing" });
    expect(out.decision).toBe("approve");
    expect(out.class).toBe("unknown");
  });

  it("repo commits execute (commits without push are cheap)", () => {
    const out = classifyAction({ kind: "repo_commit" });
    expect(out.decision).toBe("execute");
  });

  it("cache writes and searches execute", () => {
    expect(classifyAction({ kind: "cache_write" }).decision).toBe("execute");
    expect(classifyAction({ kind: "search" }).decision).toBe("execute");
  });
});
