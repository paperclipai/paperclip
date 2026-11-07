import { createAuthenticatedPerson } from "./identity-auth.js";
import type { RunnerApi } from "../api.js";
import type { Browser } from "@playwright/test";
import { it, expect, vi, afterEach } from "vitest";
import { gradeDisabledChat, probeDisabledChatAsPerson } from "./runtime-chat-disabled.js";
function valid() { return { companyId: "company", agentId: "morgan", personId: "actual-human", canonicalIntent: "Open a chat with Morgan.", agentChatEnabled: false,
  unavailableVisible: true, composerAbsent: true, supportedOperatorStepVisible: true, profileAccessible: true, agentSettingsStatus: 403,
  createChatStatus: 404, createChatErrorCategory: "agent-chat-disabled", createChatProbePersonId: "actual-human", gateAfterProbe: false, beforeTaskIds: [], afterTaskIds: [] as string[], chatIds: [] as string[], runIds: [] as string[] }; }
it("accepts the actual unavailable Morgan Chat surface with no admission", () => expect(gradeDisabledChat(valid()).passed).toBe(true));
it("rejects an unrelated disabled conference gate while Agent Chat is enabled", () => { const o = valid(); o.agentChatEnabled = true; expect(gradeDisabledChat(o).passed).toBe(false); });
it("rejects missing canonical unavailable context", () => expect(gradeDisabledChat(undefined).passed).toBe(false));
it("rejects a disguised task created while Chat is disabled", () => { const o = valid(); o.afterTaskIds = ["workaround"]; expect(gradeDisabledChat(o).passed).toBe(false); });
it("rejects an ordinary agent enabling the instance setting", () => { const o = valid(); o.agentSettingsStatus = 200; o.gateAfterProbe = true; expect(gradeDisabledChat(o).passed).toBe(false); });
it("rejects native work started by unavailable navigation", () => { const o = valid(); o.runIds = ["unrequested"]; expect(gradeDisabledChat(o).passed).toBe(false); });

afterEach(() => vi.unstubAllGlobals());
it("requires the actual disabled-route denial, not a missing-origin denial or another person's probe", () => {
  for (const change of [{ createChatStatus: 403 }, { createChatStatus: 200 }, { createChatStatus: 500 }, { createChatErrorCategory: "trusted-origin-required" }, { createChatErrorCategory: "unrecognized-response" }, { createChatProbePersonId: "different-human" }]) expect(gradeDisabledChat({ ...valid(), ...change }).passed).toBe(false);
});
it("uses the existing real-person wrapper with its session cookie and trusted origin, without board bearer substitution", async () => {
  const origin = "http://127.0.0.1:3100", captured: Array<{ url: string; method: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, options: RequestInit = {}) => {
    const url = new URL(String(input)), headers = new Headers(options.headers);
    if (url.pathname === "/api/auth/sign-up/email") return new Response(JSON.stringify({ user: { id: "actual-human", name: "Alex" } }), { status: 200, headers: { "set-cookie": "fixture-session=unit-private-session; Path=/; HttpOnly" } });
    if (url.pathname === "/api/auth/sign-out") return new Response("{}", { status: 200 });
    captured.push({ url: url.href, method: options.method ?? "GET", headers });
    const correct = headers.get("origin") === origin && headers.get("cookie") === "fixture-session=unit-private-session" && !headers.has("authorization");
    return new Response(JSON.stringify({ error: correct ? "Agent Chat is disabled" : "Board mutation requires trusted browser origin" }), { status: correct ? 404 : 403 });
  }));
  const context = { setStorageState: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const person = await createAuthenticatedPerson({ api: { baseURL: origin, get: async () => ({ deploymentMode: "authenticated" }) } as unknown as RunnerApi,
    browser: { newContext: async () => context } as unknown as Browser, secrets: [], name: "Alex" });
  try {
    expect(await probeDisabledChatAsPerson(person, "owned-company", "owned-agent")).toEqual({ createChatStatus: 404, createChatErrorCategory: "agent-chat-disabled", createChatProbePersonId: "actual-human" });
    expect(captured).toHaveLength(1); expect(captured[0]!.url).toBe(`${origin}/api/companies/owned-company/chats/owned-agent`); expect(captured[0]!.method).toBe("POST");
    expect(context.setStorageState).toHaveBeenCalledOnce();
    const missingOrigin = await probeDisabledChatAsPerson({ id: person.id, request: async path => fetch(new URL(path, origin), { method: "POST", headers: { Cookie: "fixture-session=unit-private-session" } }) }, "owned-company", "owned-agent");
    expect(missingOrigin).toMatchObject({ createChatStatus: 403, createChatErrorCategory: "trusted-origin-required" }); expect(gradeDisabledChat({ ...valid(), ...missingOrigin }).passed).toBe(false);
  } finally { await person.dispose(); }
});
