import { describe, expect, it } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { slackSetupState } from "./setup-state";
import { i18n, t } from "@/i18n";
const draft = (method?: "managed" | "automatic" | "manual" | "existing") => ({ id: "endpoint", setup: { step: "provider_setup", slackSetupMethod: method } }) as ChatEndpoint;
const state = (endpoint: ChatEndpoint | null, extra = {}) => slackSetupState({ endpoint, repairing: false, credentialsReady: false, identityReady: false, ...extra });
describe("Slack setup capabilities and progress", () => {
  it.each(["managed", "automatic", "manual"] as const)("changes only navigation copy for %s while preserving draft stages", async method => {
    const endpoint = draft(method);
    endpoint.setup!.slackRegistration = { status: "configured", appId: "{{RAW}} <app>", managementUrl: "https://api.slack.com/apps/AAPP" };
    const original = JSON.stringify(endpoint), baseline = state(endpoint);
    try {
      for (const locale of ["en", "ru", "en"]) {
        await i18n.changeLanguage(locale);
        const current = state(endpoint);
        expect(current.labels[0]).toBe(t("chatUi.chatEndpointSetup.chooseAgent"));
        expect(current.labels.at(-1)).toBe(t(method === "managed" ? "sep13Connections.connect" : method === "automatic" ? "stableOct26Apps.sendMessage" : "chatUi.chatEndpointSetup.tryIt"));
        expect([current.availableStage, current.finalStage, current.complete, current.provisioned]).toEqual([baseline.availableStage, baseline.finalStage, baseline.complete, baseline.provisioned]);
        for (const step of [0, 1, 2, 3, 4, 5]) {
          expect(current.toStage(step)).toBe(baseline.toStage(step));
          expect(current.toVisible(step)).toBe(baseline.toVisible(step));
        }
        expect(JSON.stringify(endpoint)).toBe(original);
      }
    } finally { await i18n.changeLanguage("en"); }
  });
  it("does not flash token instructions while discovery is pending", () => {
    expect(state(null).labels).toEqual(["Choose agent", "Connect"]);
  });
  it("defaults only new drafts and preserves legacy manual drafts", () => {
    expect(state(null, { defaultMethod: "managed" }).labels).toEqual(["Choose agent", "Connect"]);
    expect(state(draft(), { defaultMethod: "managed" }).provisioned).toBe(false);
    expect(state(draft("automatic"), { defaultMethod: "managed" }).labels).toHaveLength(4);
  });
  it("keeps managed provider operations within the two visible stops", () => {
    const endpoint = draft("managed");
    endpoint.setup!.slackRegistration = { status: "install", appId: "AAPP", managementUrl: "https://api.slack.com/apps/AAPP" };
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
    endpoint.setup!.slackRegistration.status = "credentials_saved";
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
    endpoint.providerAccountId = "TWORKSPACE";
    endpoint.setup!.slackRegistration.status = "configured";
    endpoint.setup!.slackAccount = { status: "linked", externalUserId: "UPERSON", paperclipUserId: "person", welcomeStatus: "sent" };
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
    endpoint.setup!.step = "test";
    expect(state(endpoint).complete).toBe(true);
    expect(state(endpoint).toStage(1)).toBe(3);
    expect(state(endpoint).toVisible(state(endpoint).availableStage)).toBe(1);
  });
});
