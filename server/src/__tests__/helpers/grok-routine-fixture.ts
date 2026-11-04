import { createHash, randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, type createDb } from "@paperclipai/db";
import { accessService } from "../../services/access.js";
import { createPublicMcpOAuth } from "../../services/public-mcp/oauth.js";
import { dotRunnerBroker } from "../../services/dot-runner-broker.js";
import { grokRoutineService } from "../../services/grok-bot/routine.js";

export async function grokRoutineFixture(db: ReturnType<typeof createDb>) {
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Grok operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  const [company] = await db.insert(companies).values({ name: "Grok test", issuePrefix: "GK" + randomBytes(3).toString("hex") }).returning();
  await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await accessService(db).setPrincipalPermission(company!.id, "user", userId, "agents:create", true, userId);
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Grok test", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider: "grok_bot", allowUnmeteredProvider: true, lifecycleMode: "per_turn" } }).returning();
  const oauth = createPublicMcpOAuth(db, { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/runner" });
  const client = await oauth.register({ client_name: "Synthetic Grok client", redirect_uris: ["https://client.example/callback"] }, randomUUID());
  const verifier = randomBytes(32).toString("base64url");
  const input = { client_id: client.client_id, redirect_uri: "https://client.example/callback", response_type: "code", resource: oauth.config.resource,
    scope: "paperclip:agent offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
  const requestId = (await oauth.authorize(input)).split("/").at(-1)!;
  const pairing = await dotRunnerBroker(db).createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId, provider: "grok_bot" });
  const consent = await oauth.consentDotPairing(requestId, pairing.pairingCode);
  const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: input.redirect_uri,
    resource: oauth.config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
  const principal = await oauth.authenticate(tokens.access_token);
  const delivery = vi.fn().mockResolvedValue({ delivery: "accepted", httpStatus: 200 });
  const service = grokRoutineService(db, delivery);
  const config = { companyId: company!.id, agentId: agent!.id, bindingId: pairing.bindingId, operatorId: userId,
    expectedRevision: 0, botName: "Synthetic Bot", webhookUrl: "https://bot.example.test/routines/synthetic", webhookKey: "synthetic-sender-key" };
  await service.configure(config);
  return { company: company!, agent: agent!, principal, pairing, service, delivery, config, oauth, tokens };
}
