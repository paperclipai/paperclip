import { describe, expect, it } from "vitest";
import { credentialAccessNotice } from "./credential-access-notice";
import type { IssueChatLinkedRun } from "./issue-chat-messages";

const run: IssueChatLinkedRun = { runId: "denied", agentId: "codie", agentName: "Codie", status: "failed",
  createdAt: "2026-10-09T20:00:00Z", startedAt: null, responsibleUserId: "nicky",
  resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
    credentialAccess: { connectionName: "Dotta’s API Key" } } },
};
describe("credential access notice", () => {
  it("records UI fallback provenance without changing canonical sentinel values", () => {
    expect(credentialAccessNotice({ ...run, agentName: "" }, "nicky"))
      .toMatchObject({ agentName: "This agent", agentNameIsFallback: true, deniedUser: "you", deniedUserKind: "self" });
    expect(credentialAccessNotice({ ...run, agentName: "This agent" }, "viewer", new Map([["nicky", "you"]])))
      .toMatchObject({ agentName: "This agent", agentNameIsFallback: false, deniedUser: "you", deniedUserKind: "named" });
    expect(credentialAccessNotice(run, "viewer", new Map([["nicky", "the person this task runs for"]])))
      .toMatchObject({ deniedUser: "the person this task runs for", deniedUserKind: "named" });
    expect(credentialAccessNotice(run, "viewer")).toMatchObject({ deniedUserKind: "unknown" });
  });
  it("names the selected credential and addresses only the denied person as you", () => {
    expect(credentialAccessNotice(run, "nicky")).toMatchObject({ agentName: "Codie", credentialName: "Dotta’s API Key", deniedUser: "you" });
    expect(credentialAccessNotice(run, "dotta", new Map([["nicky", "Nicky"]]))?.deniedUser).toBe("Nicky");
    expect(credentialAccessNotice(run, undefined)?.deniedUser).toBe("the person this task runs for");
  });
  it("recognizes the fixed historical denial without guessing credential identity", () => {
    expect(credentialAccessNotice({ ...run, resultJson: null, error: "This credential is not shared with the responsible user" }, "nicky"))
      .toMatchObject({ deniedUser: "you", credentialName: undefined });
    expect(credentialAccessNotice({ ...run, error: "This credential is not shared with the responsible user",
      resultJson: { configurationIncomplete: { credentialAccess: { connectionName: "Dotta’s API Key" } } } }, "nicky"))
      .toMatchObject({ deniedUser: "you", credentialName: "Dotta’s API Key" });
  });
  it("does not relabel unrelated configuration failures or successful attempts", () => {
    expect(credentialAccessNotice({ ...run, status: "succeeded" }, "nicky")).toBeUndefined();
    expect(credentialAccessNotice({ ...run, resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_unavailable" } } }, "nicky")).toBeUndefined();
    expect(credentialAccessNotice({ ...run, resultJson: null, error: "Provider returned a credential problem" }, "nicky")).toBeUndefined();
  });
});
