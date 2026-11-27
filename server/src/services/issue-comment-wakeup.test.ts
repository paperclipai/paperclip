import { describe, expect, it } from "vitest";
import { hasActionableCommentIntent, canNotifyIssueCommentAssignee, isOrdinaryIssueCommentWake, shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});

describe("ordinary mention-only input", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const mention = `[@Assignee](agent://${id})`;
  it.each(["blocked", "done", "cancelled"])("does not notify %s", status => {
    expect(canNotifyIssueCommentAssignee(mention, id, status,true)).toBe(false);
  });
  it("requires the actual assignee's structured mention", () => {
    expect(canNotifyIssueCommentAssignee("status", id, "in_progress",true)).toBe(false);
    expect(canNotifyIssueCommentAssignee("@Assignee", id, "in_progress",true)).toBe(false);
    expect(canNotifyIssueCommentAssignee(mention, "33333333-3333-4333-8333-333333333333", "in_progress",true)).toBe(false);
    expect(canNotifyIssueCommentAssignee(mention + mention, id, "in_progress",true)).toBe(true);
  });
  it("keeps explicit resume subject to reblocking", () => {
    expect(shouldWakeAssigneeForIssueComment({selfComment:false,resumeRequested:true,
      issueAtCommentStart:{},reopened:true,currentStatus:"blocked"})).toBe(false);
  });
  it("preserves structured interaction, recovery and assignment admission", () => {
    expect(isOrdinaryIssueCommentWake("issue_commented", {source:"plugin:test"})).toBe(true);
    expect(isOrdinaryIssueCommentWake("issue_commented", {interactionId:"question"})).toBe(false);
    expect(isOrdinaryIssueCommentWake("issue_commented", {source:"issue.stop_relay"})).toBe(false);
    expect(isOrdinaryIssueCommentWake("issue_assigned", {})).toBe(false);
    expect(isOrdinaryIssueCommentWake("execution_review_requested", {})).toBe(false);
  });
});

describe("persisted actionable intent",()=>{
 const id="22222222-2222-4222-8222-222222222222";
 const row={companyId:"company",issueId:"issue",authorUserId:"user",metadata:{commentWake:{version:1,kind:"actionable",companyId:"company",issueId:"issue",actorType:"user",actorId:"user",recipientAgentId:id,request:"Inspect the retained evidence"}}};
 it("defaults a bare mentioned status note to silent",()=>expect(canNotifyIssueCommentAssignee(`[@A](agent://${id}) still waiting`,id,"todo")).toBe(false));
 it("requires the persisted writer and destination rather than a body claim",()=>{
  expect(hasActionableCommentIntent(row,id)).toBe(true);
  expect(hasActionableCommentIntent({...row,authorUserId:"other"},id)).toBe(false);
  expect(hasActionableCommentIntent({...row,companyId:"foreign"},id)).toBe(false);
  expect(hasActionableCommentIntent({...row,issueId:"foreign"},id)).toBe(false);
  expect(hasActionableCommentIntent(row,"other")).toBe(false);
  expect(hasActionableCommentIntent({...row,authorAgentId:"forged-agent"},id)).toBe(false);
  expect(hasActionableCommentIntent({...row,metadata:null},id)).toBe(false);
 });
});
