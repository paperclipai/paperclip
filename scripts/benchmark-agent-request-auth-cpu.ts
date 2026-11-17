import { randomBytes, randomUUID } from "node:crypto";
import { loadavg } from "node:os";
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.PAPERCLIP_AGENT_JWT_SECRET ??= randomBytes(32).toString("base64");
const { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase } =
  await import("../packages/db/src/index.js");
const { createLocalAgentJwt } = await import("../server/src/agent-auth-jwt.js");
const { actorMiddleware } = await import("../server/src/middleware/auth.js");

const N = Number(process.env.N ?? 2000), PASSES = Number(process.env.PASSES ?? 7);
const temporary = await startEmbeddedPostgresTestDatabase("auth-request-cpu-");
const db = createDb(temporary.connectionString);
try {
  const [company] = await db.insert(companies).values({ name: "Auth", issuePrefix: "AUT" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "A", adapterType: "process" }).returning();
  const userId = "user-1", runId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "U", email: "u@example.test", createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent!.id, status: "running", responsibleUserId: userId });
  const token = createLocalAgentJwt(agent!.id, company!.id, "process", runId, userId)!;
  const middleware = actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-paperclip-run-id": runId };
  const once = () => new Promise<void>((resolve, reject) => {
    const req: any = { method: "GET", url: "/api/x", originalUrl: "/api/x", path: "/api/x", headers,
      header: (name: string) => headers[name.toLowerCase()], get: (name: string) => headers[name.toLowerCase()] };
    const res: any = { once() {}, on() {}, status() { return res; }, json(body: unknown) { reject(new Error(JSON.stringify(body))); }, statusCode: 200 };
    middleware(req, res, (error?: unknown) => {
      if (error) return reject(error);
      if (req.actor?.type !== "agent" || req.actor.onBehalfOfMemberships?.length !== 1) return reject(new Error(`bad actor ${JSON.stringify(req.actor)}`));
      resolve();
    });
  });
  for (let i = 0; i < 500; i++) await once();
  const samples: number[] = [];
  for (let p = 0; p < PASSES; p++) {
    const c = process.cpuUsage();
    for (let i = 0; i < N; i++) await once();
    const u = process.cpuUsage(c);
    samples.push((u.user + u.system) / N);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ cpuMicrosPerRequest: { median: +samples[Math.floor(PASSES / 2)]!.toFixed(1), min: +samples[0]!.toFixed(1),
    max: +samples[PASSES - 1]!.toFixed(1), all: samples.map(s => +s.toFixed(1)) }, loadavg: loadavg().map(v => +v.toFixed(1)) }));
} finally {
  await db.$client.end({ timeout: 1 });
  await temporary.cleanup();
}
