import { describe, expect, it } from "vitest";
import { isChatEndpointRepairing, setupTestProgressMessage } from "./ChatEndpointSetup";

describe("chat endpoint setup recovery state", () => {
  it("keeps a secret-only GitHub endpoint in first-time setup", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "github",
          status: "attention",
          providerAccountId: null,
          botExternalId: null,
        },
        "github-endpoint",
        false,
      ),
    ).toBe(false);
  });

  it("offers reconnect only after GitHub has an immutable provider identity", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "github",
          status: "attention",
          providerAccountId: "github-app-123",
          botExternalId: "github-app-registration-456",
        },
        "github-endpoint",
        false,
      ),
    ).toBe(true);
  });

  it("preserves explicit reconnect for an active endpoint", () => {
    expect(
      isChatEndpointRepairing(
        {
          provider: "slack",
          status: "active",
          providerAccountId: "workspace-123",
          botExternalId: "bot-123",
        },
        "slack-endpoint",
        true,
      ),
    ).toBe(true);
  });
});

describe("chat endpoint setup test progress", () => {
  const status = (waitingFor: "message" | "follow_up" | "agent_reply" | null, ready = false) =>
    ({ messageReceivedAt: null, ready, waitingFor });

  it("shows nothing before the first status result, and for providers that do not report progress", () => {
    expect(setupTestProgressMessage("discord", "Ada", undefined)).toBeNull();
    expect(setupTestProgressMessage("discord", "Ada", status(null))).toBeNull();
  });

  it("names the step the test is waiting for", () => {
    expect(setupTestProgressMessage("discord", "Ada", status("message"))).toEqual({ text: "Waiting for your test message.", busy: false });
    expect(setupTestProgressMessage("discord", "Ada", status("follow_up"))?.text).toContain("do not mention Ada");
    expect(setupTestProgressMessage("telegram", "Ada", status("follow_up"))?.text).toBe("Waiting for your direct message.");
    expect(setupTestProgressMessage("discord", "Ada", status("agent_reply"))).toEqual({
      text: "Message received. Waiting for Ada to reply. Setup finishes automatically.",
      busy: true,
    });
  });

  it("reports that setup is finishing when the round trip is complete", () => {
    expect(setupTestProgressMessage("discord", "Ada", status(null, true))).toEqual({ text: "Reply received. Finishing setup…", busy: true });
  });
});
