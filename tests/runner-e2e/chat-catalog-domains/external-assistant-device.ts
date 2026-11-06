import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { definition, externalObservation, observeExternal, checks, verifyRenderedReply } from "./external-support.js";
import { waitForReply } from "./identity-support.js";
import { oauthPost, mcp, origin, resource, type Tokens } from "../public-mcp-client.js";

import { privateBrowserEntry } from "./external-private-browser.js";
import { matchesDevicePrivateReceipt } from "./external-device-private-contract.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
interface DeviceCode { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
interface DeviceFixture { personId: string; clientId: string; otherClientId: string; primary: DeviceCode; expiring: DeviceCode; expiresAt: number; polledAt: number; tokens?: Tokens }
const fixtures = new WeakMap<ChatCatalogContext, DeviceFixture>();
async function requestDevice(clientId: string, companyId: string): Promise<DeviceCode> {
  const response = await oauthPost("device_authorization", { client_id: clientId, resource, company_id: companyId, scope: "paperclip:read offline_access" });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("Device authorization setup failed; response withheld"); }
  return response.json() as Promise<DeviceCode>;
}
async function registerClient() {
  const response = await oauthPost("register", { client_name: "Paperclip disposable CLI", application_type: "native", redirect_uris: [], grant_types: [DEVICE_GRANT, "refresh_token"] });
  if (response.status !== 201) { await response.body?.cancel(); throw new Error("Disposable CLI registration failed; response withheld"); }
  return (await response.json() as { client_id: string }).client_id;
}
async function exchange(fixture: DeviceFixture, code: DeviceCode, override: Record<string, unknown> = {}) {
  return oauthPost("token", { grant_type: DEVICE_GRANT, client_id: fixture.clientId, device_code: code.device_code, resource, ...override });
}
export function gradeDeviceLogin(value: unknown) {
  const c = checks(), o = externalObservation(value);
  c.add("complete-device-evidence", !!o, "Actual CLI device request, browser consent, token/resource tests and real expiration are required."); if (!o) return c.result();
  c.add("correct-human-verification", o.state.verificationPath === "/mcp-device" && o.state.currentCodeVisible === true && o.state.companyConsentVisible === true && o.state.readScopeVisible === true
    && o.state.humanApproved === true && o.state.clientCompanyId === o.companyId && o.state.clientReadOnly === true,
    "The person follows the issuer's actual page/current code and authorizes exactly the intended company and read scope.");
  c.add("private-device-ui", matchesDevicePrivateReceipt("device-approve", o.state.approvalUi) && matchesDevicePrivateReceipt("device-expired", o.state.expiredUi),
    "Both actual device UI phases use the isolated finite browser with closed receipts, outside Test reporting.");
  c.add("pending-without-human-approval", o.state.pendingError === "authorization_pending", "The waiting CLI cannot obtain credentials before human approval.");
  c.add("resource-and-client-mismatch-denied", o.state.wrongResourceDenied === true && o.state.wrongClientDenied === true && o.state.correctExchangeSucceeded === true,
    "Mismatched resource/client requests fail without consuming the valid selected grant.");
  c.add("spent-code-denied", o.state.reusedCodeDenied === true, "A consumed device code cannot mint another credential.");
  c.add("actually-expired-code-denied", o.state.expirationWaitMs === 600_000 && Number(o.state.elapsedBeforeExpiryProbe) >= 600_000
    && o.state.expiredCodeDenied === true && o.state.expiredPageVisible === true, "A distinct real code expires under the actual issuer clock and the browser and token endpoint reject it.");
  c.add("supported-guidance", /device|code|CLI/i.test(o.reply) && /sign.in|verif|connect/i.test(o.reply)
    && !/I (?:have )?(?:approved|signed in|authorized).*?(?:you|your behalf)/i.test(o.reply), "Chat guides the human without self-consent or impersonation.");
  return c.result();
}
export const assistantDeviceExternalCases = [definition("assistant-connections.device-login", async ctx => {
  if (origin !== ctx.input.api.baseURL || !ctx.input.privateSecrets) throw new Error("Device setup requires the owned issuer and private redaction context");
  await ctx.input.api.patch("/api/instance/settings/experimental", { enablePublicMcp: true });
  const setup = await ctx.input.api.get<{ enabled: boolean; serverUrl: string }>("/api/mcp/setup");
  if (!setup.enabled || setup.serverUrl !== resource) throw new Error("Setup blocker: this disposable instance has no compatible public MCP issuer/resource");
  const clientId = await registerClient(), otherClientId = await registerClient();
  const primary = await requestDevice(clientId, ctx.input.fixtures.company.id);
  ctx.input.privateSecrets.push(primary.device_code, primary.user_code, primary.verification_uri_complete);
  const expiring = await requestDevice(clientId, ctx.input.fixtures.company.id);
  ctx.input.privateSecrets.push(expiring.device_code, expiring.user_code, expiring.verification_uri_complete);
  if (primary.expires_in !== 600 || expiring.expires_in !== 600 || primary.verification_uri !== `${origin}/mcp-device`) throw new Error("Declared bounded device-code lifetime or verification origin differs from the real issuer");
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (!session.user?.id) throw new Error("Device UI requires the authenticated fixture person");
  const expiresAt = Date.now() + expiring.expires_in * 1000;
  const fixture = { personId: session.user.id, clientId, otherClientId, primary, expiring, expiresAt, polledAt: Date.now() }; fixtures.set(ctx, fixture);
  const pending = await exchange(fixture, primary); const pendingBody = await pending.json() as { error?: string };
  return { verificationPath: new URL(primary.verification_uri).pathname, pendingError: pendingBody.error, expirationWaitMs: 600_000 };
}, gradeDeviceLogin, {
  authentication: "human-session", attemptTimeoutMs: 780_000,
  sourceFiles: ["chat-catalog-domains/external-assistant-device.ts", "chat-catalog-domains/external-private-browser.ts", "chat-catalog-domains/external-private-browser-worker.ts", "chat-catalog-domains/external-device-private-contract.ts", "../../ui/src/pages/McpConnect.tsx", "../../server/src/routes/public-mcp.ts", "../../server/src/services/public-mcp/oauth.ts", "../../packages/shared/src/public-mcp.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "public-mcp-client.ts", "chat-scenarios/assistant-connections.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const fixture = fixtures.get(ctx); if (!fixture) throw new Error("Device fixture missing");
    const approvalUi = await privateBrowserEntry({
      mode: "device-approve", baseURL: origin, setupURL: fixture.primary.verification_uri_complete,
      providerURL: origin, credential: fixture.primary.user_code, companyId: ctx.input.fixtures.company.id,
      device: { userId: fixture.personId, companyName: ctx.input.fixtures.company.name },
      cookies: await ctx.input.page.context().cookies(origin),
    });
    state.approvalUi = approvalUi;
    state.currentCodeVisible = approvalUi.currentCodeVisible;
    state.companyConsentVisible = approvalUi.companyConsentVisible;
    state.readScopeVisible = approvalUi.readScopeVisible;
    state.humanApproved = approvalUi.humanApproved;
    const wrongResource = await exchange(fixture, fixture.primary, { resource: origin + "/mcp/not-the-resource" }); state.wrongResourceDenied = wrongResource.status === 400; await wrongResource.body?.cancel();
    const wrongClient = await exchange(fixture, fixture.primary, { client_id: fixture.otherClientId }); state.wrongClientDenied = wrongClient.status === 400; await wrongClient.body?.cancel();
    if (Date.now() < fixture.polledAt + fixture.primary.interval * 1000) await pollUntil({ label: "advertised device polling interval", deadlineAt: Date.now() + 15_000, intervalMs: 200, load: async () => Date.now(), accept: now => now >= fixture.polledAt + fixture.primary.interval * 1000 });
    const correct = await exchange(fixture, fixture.primary); state.correctExchangeSucceeded = correct.status === 200;
    if (!correct.ok) { await correct.body?.cancel(); throw new Error("Approved device exchange failed; response withheld"); }
    fixture.tokens = await correct.json() as Tokens; ctx.input.privateSecrets!.push(fixture.tokens.access_token, fixture.tokens.refresh_token);
    const client = await mcp(fixture.tokens);
    try { const receipt = (await client.call("paperclip_connection")).structuredContent; state.clientCompanyId = receipt?.companyId;
      state.clientReadOnly = Array.isArray(receipt?.scopes) && receipt.scopes.includes("paperclip:read") && !receipt.scopes.includes("paperclip:write");
    } finally { await client.close(); }
    const reused = await exchange(fixture, fixture.primary); state.reusedCodeDenied = reused.status === 400; await reused.body?.cancel();
    // Deliberately spend the issuer's actual 10-minute lifetime, never mock time,
    // rewrite database expiry or silently relax an observed failed deadline.
    await pollUntil({ label: "real unused device-code expiration", deadlineAt: fixture.expiresAt + 15_000, intervalMs: 1000,
      load: async () => Date.now(), accept: now => now >= fixture.expiresAt + 500 });
    state.elapsedBeforeExpiryProbe = Date.now() - (fixture.expiresAt - 600_000);
    const expired = await exchange(fixture, fixture.expiring); const body = await expired.json() as { error?: string };
    state.expiredCodeDenied = expired.status === 400 && body.error === "expired_token";
    const expiredUi = await privateBrowserEntry({
      mode: "device-expired", baseURL: origin, setupURL: fixture.expiring.verification_uri_complete,
      providerURL: origin, credential: fixture.expiring.user_code, companyId: ctx.input.fixtures.company.id,
      device: { userId: fixture.personId, companyName: ctx.input.fixtures.company.name },
      cookies: await ctx.input.page.context().cookies(origin),
    });
    state.expiredUi = expiredUi;
    state.expiredPageVisible = expiredUi.expiredPageVisible;
  },
  async observe(ctx, state) { return observeExternal(ctx, state); },
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx) { for (const grant of await ctx.input.api.get<Array<{ id: string }>>("/api/mcp/connections")) await ctx.input.api.delete(`/api/mcp/connections/${grant.id}`); fixtures.delete(ctx); },
})];
