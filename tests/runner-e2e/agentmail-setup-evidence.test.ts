import { describe, expect, it } from "vitest";
import { gradeAgentmailSetup } from "./agentmail-setup-evidence.js";

const good = {
  interactions: [{ id: "card", kind: "connection_intent", status: "pending", addresseeUserId: "user",
    payload: { serviceSlug: "agentmail", purpose: "channel", requestingAgentId: "agent" } }],
  agentId: "agent", userId: "user", visible: true, inputTypes: ["password"],
  keyLink: "https://console.agentmail.to/dashboard/api-keys", accessSelectorCount: 0, dialogCount: 0,
};
describe("AgentMail setup oracle", () => {
  it("accepts the persisted inline credential form", () => {
    expect(gradeAgentmailSetup(good).every(check => check.passed)).toBe(true);
  });
  it.each([
    { interactions: [] }, // The original search + prose link failure.
    { interactions: [good.interactions[0], good.interactions[0]] },
    { agentId: "another-agent" },
    { userId: "another-user" },
    { visible: false },
    { inputTypes: ["text"] },
    { inputTypes: ["password", "text"] },
    { keyLink: "https://console.agentmail.to" },
    { keyLink: null },
    { accessSelectorCount: 2 },
    { dialogCount: 1 },
  ])("rejects incomplete or misleading evidence: %j", bad => {
    expect(gradeAgentmailSetup({ ...good, ...bad }).some(check => !check.passed)).toBe(true);
  });
});
