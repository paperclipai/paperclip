import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, chatEndpoints, companies, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";

// Synthetic benchmark setup belongs with test fixtures. Production agent writes
// must use the agent lifecycle module.
export async function seedChatCredentialBenchmark(db: Db) {
  const companyId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic credentials", issuePrefix: companyId });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic agent", adapterType: "process" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId,
    transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId });
  const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
  assert.ok(endpoint);
  const service = secretService(db);
  const refs = [];
  const expected: Record<string, string> = {};
  for (const key of ["botToken", "signingSecret", "appToken", "webhookSecret"]) {
    const value = `synthetic-${key}-${"x".repeat(128)}`;
    const secret = await service.create(companyId, { name: key, provider: "local_encrypted", value });
    await service.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connectionId,
      configPath: `credentials.${key}` });
    refs.push({ secretId: secret.id, versionSelector: "latest" as const, configPath: `credentials.${key}`, required: true });
    expected[key] = value;
  }
  await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, connectionId));
  return { companyId, endpoint, expected };
}
