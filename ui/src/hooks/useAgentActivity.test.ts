import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { liveEventToBeam } from "./useAgentActivity";

function ev(type: string, payload: Record<string, unknown>): LiveEvent {
  return { id: 1, companyId: "c1", type: type as LiveEvent["type"], createdAt: "", payload };
}

describe("liveEventToBeam", () => {
  it("maps a delegation (issue.updated w/ new assignee) to a beam", () => {
    const beam = liveEventToBeam(
      ev("activity.logged", {
        actorType: "agent",
        actorId: "a1",
        action: "issue.updated",
        details: { assigneeAgentId: "a2" },
      }),
    );
    expect(beam).toEqual({ fromAgentId: "a1", toAgentId: "a2", kind: "delegation" });
  });

  it("maps a comment mention to a beam", () => {
    const beam = liveEventToBeam(
      ev("activity.logged", {
        actorType: "agent",
        actorId: "a1",
        action: "issue.comment_added",
        details: { toAgentId: "a3" },
      }),
    );
    expect(beam).toEqual({ fromAgentId: "a1", toAgentId: "a3", kind: "mention" });
  });

  it("returns null for a comment with no target agent", () => {
    expect(
      liveEventToBeam(
        ev("activity.logged", {
          actorType: "agent",
          actorId: "a1",
          action: "issue.comment_added",
          details: {},
        }),
      ),
    ).toBeNull();
  });

  it("ignores a self-directed event", () => {
    expect(
      liveEventToBeam(
        ev("activity.logged", {
          actorType: "agent",
          actorId: "a1",
          action: "issue.updated",
          details: { assigneeAgentId: "a1" },
        }),
      ),
    ).toBeNull();
  });

  it("ignores non-agent actors", () => {
    expect(
      liveEventToBeam(
        ev("activity.logged", {
          actorType: "user",
          actorId: "u1",
          action: "issue.updated",
          details: { assigneeAgentId: "a2" },
        }),
      ),
    ).toBeNull();
  });

  it("maps an active run to a sync beam up the org chain when a manager resolves", () => {
    const beam = liveEventToBeam(ev("heartbeat.run.queued", { agentId: "a1" }), (id) =>
      id === "a1" ? "boss" : null,
    );
    expect(beam).toEqual({ fromAgentId: "a1", toAgentId: "boss", kind: "sync" });
  });

  it("returns null for a run event with no manager resolver", () => {
    expect(liveEventToBeam(ev("heartbeat.run.queued", { agentId: "a1" }))).toBeNull();
  });

  it("returns null for unrelated event types", () => {
    expect(liveEventToBeam(ev("plugin.ui.updated", { foo: "bar" }))).toBeNull();
  });
});
