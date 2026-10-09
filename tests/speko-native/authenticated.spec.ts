import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const origin = "http://127.0.0.1:3482";

test("E03/E14: real signed-in callers cannot substitute companies, private tasks or another caller; revoked members can hang up", async ({ browser, page }, info) => {
  const memberContext = await browser.newContext(), outsiderContext = await browser.newContext(), anonymousContext = await browser.newContext();
  const request = async (api: APIRequestContext, method: "POST" | "PATCH", path: string, data: unknown) => {
    const response = await api.fetch(`${origin}/api${path}`, { method, headers: { Origin: origin }, data });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
    return response.json();
  };
  const signUp = (api: APIRequestContext, name: string) => request(api, "POST", "/auth/sign-up/email", { name, email: `${randomUUID()}@example.test`, password: randomBytes(24).toString("base64url") });
  try {
    await signUp(page.request, "Voice operator");
    await request(page.request, "POST", "/bootstrap/claim", {});
    const member = await signUp(memberContext.request, "Voice member");
    await signUp(outsiderContext.request, "Other company member");
    const company = await request(page.request, "POST", "/companies", { name: "Private voice company" });
    const other = await request(page.request, "POST", "/companies", { name: "Other voice company" });
    const invite = async (api: APIRequestContext, companyId: string) => {
      const invitation = await request(page.request, "POST", `/companies/${companyId}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
      const token = new URL(invitation.inviteUrl, origin).pathname.split("/").at(-1);
      await request(api, "POST", `/invites/${token}/accept`, { requestType: "human" });
    };
    await invite(memberContext.request, company.id); await invite(outsiderContext.request, other.id);
    await request(page.request, "PATCH", `/companies/${company.id}`, { requireBoardApprovalForNewAgents: false });
    const agent = await request(page.request, "POST", `/companies/${company.id}/agents`, { name: "Voice worker", role: "general", adapterType: "process", adapterConfig: { command: "fixture" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    const endpoint = await request(memberContext.request, "POST", `/companies/${company.id}/chat-endpoints`, { provider: "speko", assignedAgentId: agent.id });
    const configured = await request(memberContext.request, "POST", `/chat-endpoints/${endpoint.id}/setup`, { action: "configure", credentials: { apiKey: "fixture-speko-key", agentId: "agent_member", signingSecret: `whsec_${randomBytes(32).toString("base64")}` } });
    expect(configured.setup.step).toBe("test");
    const privateTask = await request(page.request, "POST", `/companies/${company.id}/issues`, { title: "Private task", status: "backlog", assigneeAgentId: agent.id, visibility: "private" });
    const start = (api: APIRequestContext, companyId = company.id, issueId?: string) => api.post(`${origin}/api/companies/${companyId}/voice-sessions`, { headers: { Origin: origin }, data: { endpointId: endpoint.id, ...(issueId ? { issueId } : {}), idempotencyKey: randomUUID() } });
    expect([401, 403]).toContain((await start(anonymousContext.request)).status());
    expect((await start(outsiderContext.request)).status()).toBe(403);
    expect([403, 404]).toContain((await start(memberContext.request, other.id)).status());
    expect([403, 404]).toContain((await start(memberContext.request, company.id, privateTask.id)).status());
    const created = await start(memberContext.request);
    expect(created.status()).toBe(201);
    const { session, media } = await created.json();
    expect(session.callerId).toBeUndefined(); // Private authority metadata is not projected into the browser session.
    expect(media.transportToken).toMatch(/^fixture:/);
    const path = `/api/companies/${company.id}/voice-sessions/${session.id}`;
    expect((await page.request.get(origin + path)).status()).toBe(403);
    expect((await outsiderContext.request.get(origin + path)).status()).toBe(403);
    expect((await memberContext.request.get(origin + path)).status()).toBe(200);
    const { members } = await (await page.request.get(`${origin}/api/companies/${company.id}/members`)).json();
    const membership = members.find((entry: any) => entry.principalId === member.user.id);
    expect(membership).toBeTruthy();
    await request(page.request, "PATCH", `/companies/${company.id}/members/${membership.id}`, { status: "suspended" });
    expect((await memberContext.request.get(origin + path + "/notification")).status()).toBe(403);
    expect((await memberContext.request.get(origin + path)).status()).toBe(403);
    const ended = await request(memberContext.request, "POST", path.replace(/^\/api/, "") + "/end", {});
    expect(ended.state).toBe("ended");
    const { home } = JSON.parse(await readFile(resolve(import.meta.dirname, ".auth-instance.json"), "utf8"));
    await expect.poll(async () => {
      const evidence = JSON.parse(await readFile(resolve(home, "evidence.json"), "utf8"));
      return { sessions: evidence.sessions.length, ended: evidence.sessions[0]?.state, accepted: evidence.tools.length };
    }).toEqual({ sessions: 1, ended: "ended", accepted: 0 });
    await info.attach("authority-results", { body: JSON.stringify({ companyId: company.id, otherCompanyId: other.id, sessionId: session.id, privateTaskId: privateTask.id, denied: ["anonymous", "cross-company", "private-task", "other-caller", "suspended-member"], revokedCallerHangup: "passed" }), contentType: "application/json" });
  } finally {
    await Promise.all([memberContext.close(), outsiderContext.close(), anonymousContext.close()]);
  }
});
