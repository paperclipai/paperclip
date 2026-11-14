import { createAuthenticatedPerson } from "./identity-auth.js";
import type { RunnerApi } from "../api.js";
import type { Browser } from "@playwright/test";
import { it, expect, vi, afterEach } from "vitest";
import { gradeConferenceRoomOff, probeBoardChatAsPerson, type ConferenceRoomOffObservation } from "./runtime-chat-disabled.js";
function valid(): ConferenceRoomOffObservation { return { companyId: "company", companyPrefix: "RUN", agentId: "morgan-id", personId: "actual-human",
  canonicalIntent: "Open the conference room so I can talk with Morgan.", conferenceRoomEnabled: false, oldLinkLandedPath: "/RUN/dashboard",
  conferenceComposerVisible: false, conferenceNavOffered: false, chatAlternativePath: "/RUN/chats/morgan", chatAlternativeAgentRefs: ["morgan-id", "morgan"],
  chatComposerVisible: true, boardChatStatus: 403, boardChatErrorCode: "FEATURE_DISABLED", boardChatProbePersonId: "actual-human",
  agentSettingsStatus: 403, gateAfterProbe: false, beforeTaskIds: ["seed"], afterTasks: [{ id: "seed", conversationAgentId: null }], runIds: [] }; }
const fails = (change: Partial<ConferenceRoomOffObservation>) => expect(gradeConferenceRoomOff({ ...valid(), ...change }).passed).toBe(false);
it("accepts the off Conference Room landing on the dashboard with Chat as the working alternative", () => expect(gradeConferenceRoomOff(valid()).passed).toBe(true));
it("accepts Morgan's own ordinary chat record opened from Chat", () => expect(gradeConferenceRoomOff({ ...valid(), chatAlternativePath: "/RUN/chats/morgan-id",
  afterTasks: [{ id: "seed", conversationAgentId: null }, { id: "morgan-chat", conversationAgentId: "morgan-id" }] }).passed).toBe(true));
it("rejects missing context or the experiment actually on", () => { expect(gradeConferenceRoomOff(undefined).passed).toBe(false); fails({ conferenceRoomEnabled: true }); });
it("rejects a broken route, an unusable conference composer or a lingering nav entry", () => {
  for (const change of [{ oldLinkLandedPath: "/RUN/board-chat" }, { oldLinkLandedPath: "/OTHER/dashboard" }, { conferenceComposerVisible: true }, { conferenceNavOffered: true }]) fails(change);
});
it("rejects a missing or wrong chat alternative", () => {
  for (const change of [{ chatComposerVisible: false }, { chatAlternativePath: "/RUN/chats/someone-else" }, { chatAlternativePath: "/OTHER/chats/morgan" }]) fails(change);
});
it("rejects a board discussion that is not refused by the Conference Room gate", () => {
  for (const change of [{ boardChatStatus: 200 }, { boardChatErrorCode: "DEPLOYMENT_MODE_UNSUPPORTED" }, { boardChatErrorCode: "trusted-origin-required" }, { boardChatProbePersonId: "someone-else" }]) fails(change);
});
it("rejects an ordinary agent enabling the instance setting", () => fails({ agentSettingsStatus: 200, gateAfterProbe: true }));
it("rejects a disguised task, a removed record or started native work", () => {
  fails({ afterTasks: [{ id: "seed", conversationAgentId: null }, { id: "board-operations", conversationAgentId: null }] });
  fails({ afterTasks: [{ id: "seed", conversationAgentId: null }, { id: "other-chat", conversationAgentId: "other-agent" }] });
  fails({ afterTasks: [] }); fails({ runIds: ["unrequested"] });
});

afterEach(() => vi.unstubAllGlobals());
it("probes with the real person's session cookie and trusted origin, and classifies only the closed refusal code", async () => {
  const origin = "http://127.0.0.1:3100", captured: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, options: RequestInit = {}) => {
    const url = new URL(String(input)), headers = new Headers(options.headers);
    if (url.pathname === "/api/auth/sign-up/email") return new Response(JSON.stringify({ user: { id: "actual-human", name: "Alex" } }), { status: 200, headers: { "set-cookie": "fixture-session=unit-private-session; Path=/; HttpOnly" } });
    if (url.pathname === "/api/auth/sign-out") return new Response("{}", { status: 200 });
    captured.push({ url: url.href, method: options.method ?? "GET", headers, body: String(options.body ?? "") });
    const correct = headers.get("origin") === origin && headers.get("cookie") === "fixture-session=unit-private-session" && !headers.has("authorization");
    return new Response(JSON.stringify(correct ? { error: "Conference Room Chat is not enabled", code: "FEATURE_DISABLED" } : { error: "Board mutation requires trusted browser origin" }), { status: 403 });
  }));
  const context = { setStorageState: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const person = await createAuthenticatedPerson({ api: { baseURL: origin, get: async () => ({ deploymentMode: "authenticated" }) } as unknown as RunnerApi,
    browser: { newContext: async () => context } as unknown as Browser, secrets: [], name: "Alex" });
  try {
    expect(await probeBoardChatAsPerson(person, "owned-company", "Open the conference room so I can talk with Morgan."))
      .toEqual({ boardChatStatus: 403, boardChatErrorCode: "FEATURE_DISABLED", boardChatProbePersonId: "actual-human" });
    expect(captured).toHaveLength(1); expect(captured[0]!.url).toBe(`${origin}/api/board/chat/stream`); expect(captured[0]!.method).toBe("POST");
    expect(JSON.parse(captured[0]!.body)).toEqual({ companyId: "owned-company", message: "Open the conference room so I can talk with Morgan." });
    const missingOrigin = await probeBoardChatAsPerson({ id: person.id, request: async path => fetch(new URL(path, origin), { method: "POST", headers: { Cookie: "fixture-session=unit-private-session" } }) }, "owned-company", "x");
    expect(missingOrigin).toMatchObject({ boardChatStatus: 403, boardChatErrorCode: "trusted-origin-required" });
    expect(gradeConferenceRoomOff({ ...valid(), ...missingOrigin }).passed).toBe(false);
  } finally { await person.dispose(); }
});
