import { describe, expect, it } from "vitest";
import {
  NEEDS_DISPATCH_NOTICE_TITLE,
  NO_LIVE_RUN_NOTICE_TITLE,
  buildNeedsDispatchNotice,
  isNoLiveRunEscalation,
} from "./no-live-run-dispatch-guard.js";

describe("isNoLiveRunEscalation", () => {
  it("matches the no-live-run notice title", () => {
    expect(isNoLiveRunEscalation({
      notice: { title: NO_LIVE_RUN_NOTICE_TITLE, body: "anything", tone: "danger" },
    })).toBe(true);
  });

  it("does not match a first-class blocker notice", () => {
    expect(isNoLiveRunEscalation({
      notice: { title: "Workspace validation failed", body: "no live execution path", tone: "danger" },
    })).toBe(false);
  });

  it("falls back to the body when there is no title", () => {
    expect(isNoLiveRunEscalation({
      notice: { title: "  ", body: "It still has No Live Execution Path.", tone: "danger" },
    })).toBe(true);
    expect(isNoLiveRunEscalation({ notice: { title: "", body: "disk is full", tone: "danger" } })).toBe(false);
  });

  it("falls back to the plain comment when there is no notice", () => {
    expect(isNoLiveRunEscalation({ comment: "no live execution path for this issue" })).toBe(true);
    expect(isNoLiveRunEscalation({})).toBe(false);
  });
});

describe("buildNeedsDispatchNotice", () => {
  it("uses an informational tone so the issue does not read as blocked", () => {
    const notice = buildNeedsDispatchNotice({ attempts: 0, maxAttempts: 3 });
    expect(notice.presentation.tone).toBe("info");
    expect(notice.presentation.title).toBe(NEEDS_DISPATCH_NOTICE_TITLE);
    expect(notice.body).toContain("dispatch gap, not a blocker");
  });

  it("omits the attempt counter on the first attempt", () => {
    expect(buildNeedsDispatchNotice({ attempts: 0, maxAttempts: 3 }).body).not.toContain("attempt");
  });

  it("counts attempts from one for the operator", () => {
    expect(buildNeedsDispatchNotice({ attempts: 2, maxAttempts: 3 }).body).toContain("attempt 3 of 3");
  });
});
