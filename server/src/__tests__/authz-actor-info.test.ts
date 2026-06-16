import { describe, expect, it } from "vitest";
import { getActorInfo } from "../routes/authz.js";

function reqWithActor(actor: Express.Request["actor"]) {
  return { actor } as Express.Request;
}

describe("getActorInfo", () => {
  it("uses a distinct Dan board actor id for local trusted board-web audit events", () => {
    const actor = getActorInfo(reqWithActor({
      type: "board",
      userId: "local-board",
      userName: "Local Board",
      userEmail: null,
      source: "local_implicit",
      isInstanceAdmin: true,
    }));

    expect(actor).toMatchObject({
      actorType: "user",
      actorId: "dan-board",
      agentId: null,
      runId: null,
    });
  });

  it("keeps session board audit events attributed to their user id", () => {
    const actor = getActorInfo(reqWithActor({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    }));

    expect(actor).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
    });
  });
});
