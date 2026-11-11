import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, chatActions, chatEndpoints, companies, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { chatCredentialMutationLease } from "../../services/chat-credential-mutation-lease.js";
import { createGitHubWebhookIngress, type GitHubWebhookIngressPayload } from "../../services/chat-channels/github/webhook-ingress.js";

type Factory = typeof createGitHubWebhookIngress;
type Options = Parameters<Factory>[1];
export type CapturedQuery = { sql: string; params: unknown[] };

export function captureIngressQueries(db: Db, queries: CapturedQuery[]) {
  const session = Reflect.get(db, "session");
  const logger = { logQuery(query: string, params: unknown[]) { queries.push({ sql: query, params }); } };
  session.logger = logger;
  session.options.logger = logger;
}

export async function cleanupIngressFixture(db: Db, companyId: string) {
  await db.delete(toolConnections).where(eq(toolConnections.companyId, companyId));
  await db.delete(toolApplications).where(eq(toolApplications.companyId, companyId));
  await db.delete(agents).where(eq(agents.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
}

export async function githubIngressFixture(db: Db, factory: Factory = createGitHubWebhookIngress, bodyBytes = 96 * 1024) {
  const companyId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic webhook ingress", issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic bot", adapterType: "process" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Synthetic GitHub", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" });
  const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId, assignedAgentId: agentId, publicId: randomUUID(), provider: "github", status: "active" }).returning();
  const body = JSON.stringify({ action: "created", content: randomBytes(bodyBytes).toString("base64") });
  const payload: GitHubWebhookIngressPayload = { version: 1, body, bodySha256: createHash("sha256").update(body).digest("hex"),
    deliveryId: randomUUID(), eventType: "issue_comment", runtimeGeneration: 1, credentialFingerprint: "fixture-credentials", contentType: "application/json" };
  const calls: Array<{ publicId: string; provider: string; body: string; delivery: string | null; signature: string | null }> = [];
  const unused = async (): Promise<never> => { throw new Error("Unexpected fixture dependency"); };
  const options: Options = {
    endpointRecord: async id => id === endpoint.id ? { endpoint, assignedAgentName: "Synthetic bot", connectionName: "Synthetic GitHub", applicationId, credentialSecretRefs: [] } : null,
    runtimeContextForRecord: () => ({ generation: 1, credentialFingerprint: "fixture-credentials", localEpoch: 0, version: "fixture" }),
    resolveCredentialRefs: async () => ({ webhookSecret: "fixture-secret" }),
    runtimeGeneration: () => 1, credentialFingerprint: () => "fixture-credentials", getWebhookPublicBaseUrl: () => null,
    redactError: error => error instanceof Error ? error.message : String(error),
    handleWebhook: async (publicId, provider, request) => {
      calls.push({ publicId, provider, body: await request.text(), delivery: request.headers.get("x-github-delivery"), signature: request.headers.get("x-hub-signature-256") });
      return new Response("accepted", { status: 202 });
    },
    runtimeCallbackEndpoint: unused, fetchImpl: unused,
    persistence: { compareAndSet: unused, deleteIfVersion: unused, read: unused },
    withCredentialMutationLease: chatCredentialMutationLease(db), isShuttingDown: () => false,
    supportedWebhookEvents: new Set(["issue_comment"]),
  };
  const service = factory(db, options);
  async function insertAction(overrides: Partial<typeof chatActions.$inferInsert> = {}) {
    const [action] = await db.insert(chatActions).values({ companyId, endpointId: endpoint.id, kind: "github_webhook_ingress", providerActionId: randomUUID(), payload, ...overrides }).returning();
    return action;
  }
  const readAction = (id: string) => db.select().from(chatActions).where(eq(chatActions.id, id)).then(rows => rows[0]!);
  return { companyId, endpoint, payload, calls, options, service, insertAction, readAction };
}
