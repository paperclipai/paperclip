import { describe, expect, it } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { slackSetupState } from "./setup-state";
const draft = (method?: "managed" | "automatic" | "manual" | "existing") => ({ id: "endpoint", setup: { step: "provider_setup", slackSetupMethod: method } }) as ChatEndpoint;
const state = (endpoint: ChatEndpoint | null, extra = {}) => slackSetupState({ endpoint, repairing: false, credentialsReady: false, identityReady: false, ...extra });
describe("Slack setup capabilities and progress", () => {
  it("defaults only new drafts and preserves legacy manual drafts", () => {
    expect(state(null, { defaultMethod: "managed" }).labels).toEqual(["Choose agent", "Add to Slack", "Connect"]);
    expect(state(draft(), { defaultMethod: "managed" }).provisioned).toBe(false);
    expect(state(draft("automatic"), { defaultMethod: "managed" }).labels).toHaveLength(4);
  });
  it("keeps managed provider operations within the three visible stops", () => {
    const endpoint = draft("managed");
    endpoint.setup!.slackRegistration = { status: "install", appId: "AAPP", managementUrl: "https://api.slack.com/apps/AAPP" };
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
    endpoint.setup!.slackRegistration.status = "credentials_saved";
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
    endpoint.providerAccountId = "TWORKSPACE";
    endpoint.setup!.slackRegistration.status = "configured";
    endpoint.setup!.slackAccount = { status: "linked", externalUserId: "UPERSON", paperclipUserId: "person", welcomeStatus: "sent" };
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(2);
    endpoint.setup!.step = "test";
    expect(state(endpoint).complete).toBe(true);
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(2);
  });
});
