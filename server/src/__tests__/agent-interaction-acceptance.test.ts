import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, agentWakeupRequests, authUsers, boardApiKeys, companies,
  companyMemberships, createDb, heartbeatRuns, issueComments, issues, principalPermissionGrants } from "@paperclipai/db";
import { AGENT_INTERACTION_PERMISSION_KEYS, PERMISSION_KEYS } from "@paperclipai/shared";
import { createApp } from "../app.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

const execute = promisify(execFile);

it("configures each control with the CLI against the assembled app and enforces API and native mutations", async () => {
  const database = await startEmbeddedPostgresTestDatabase("interaction-acceptance-");
  const db = createDb(database.connectionString);
  const directory = await mkdtemp(join(tmpdir(), "interaction-acceptance-storage-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: ReturnType<NonNullable<typeof app>["listen"]> | undefined;
  try {
    const companyId = randomUUID(), sender = randomUUID(), recipient = randomUUID(), userId = randomUUID();
    const senderKey = `pcp_agent_${randomUUID()}`, boardKey = `pcp_board_${randomUUID()}`;
    const hash = (token: string) => createHash("sha256").update(token).digest("hex");
    await db.insert(companies).values({ id: companyId, name: "Permission acceptance", issuePrefix: "IPA", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.com`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([sender, recipient].map((id, index) => ({ id, companyId, name: index ? "Recipient" : "Sender",
      adapterType: "process", status: "idle", permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false, intervalSec: 0 } } })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[sender, recipient].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values(["user", "agent"].flatMap(principalType => PERMISSION_KEYS.map(permissionKey => ({
      companyId, principalType, principalId: principalType === "user" ? userId : sender, permissionKey,
    }))));
    await db.insert(boardApiKeys).values({ userId, name: "Acceptance human", keyHash: hash(boardKey) });
    await db.insert(agentApiKeys).values({ companyId, agentId: sender, name: "Acceptance agent", keyHash: hash(senderKey), responsibleUserId: userId });
    const [owned, peer] = await db.insert(issues).values([
      { companyId, title: "Owned task", assigneeAgentId: sender, status: "todo" },
      { companyId, title: "Peer task", assigneeAgentId: recipient, status: "todo" },
    ]).returning();
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: false,
      managedPluginAutoInstall: [], storageService: createStorageService(createLocalDiskStorageProvider(directory)),
      decisionServiceOptions: { wakeOriginAgent: async () => null },
    });
    await app.locals.bundledPluginsStartup;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP test address");
    const base = `http://127.0.0.1:${address.port}`;
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const cli = async (agentId: string, patch?: Record<string, boolean | null>) => {
      const result = await execute(process.execPath, ["--import", `${repo}cli/node_modules/tsx/dist/loader.mjs`, `${repo}cli/src/index.ts`,
        "agent", patch ? "interaction-permissions:update" : "interaction-permissions", agentId, "--api-base", base,
        "--api-key", boardKey, "--json", ...(patch ? ["--payload-json", JSON.stringify(patch)] : [])], {
        cwd: repo, env: { ...process.env, PAPERCLIP_TELEMETRY_DISABLED: "1" }, timeout: 60000,
      });
      return JSON.parse(result.stdout);
    };
    const api = async (path: string, body: unknown, method = "POST", token = senderKey) => {
      const response = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const snapshot = async () => ({
      tasks: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
    });
    expect((await cli(sender)).overrides).toEqual({});
    expect((await cli(recipient)).overrides).toEqual({});
    for (const key of AGENT_INTERACTION_PERMISSION_KEYS) {
      const policyAgent = key.startsWith("canReceive") ? recipient : sender;
      expect((await cli(policyAgent, { [key]: false })).overrides).toEqual({ [key]: false });
      const before = await snapshot();
      const response = key.includes("Assign") ? await api(`/companies/${companyId}/issues`, {
        title: "Prohibited delegation", status: "todo", ...(key === "canAssignTasksToHumans" ? { assigneeUserId: userId } : { assigneeAgentId: recipient }),
      }) : key.includes("Mention") ? await api(`/issues/${owned!.id}/comments`, { body: `[@Recipient](agent://${recipient})` })
        : key.includes("Comment") ? await api(`/issues/${peer!.id}/comments`, { body: "Prohibited reply" })
        : key.includes("Edit") ? await api(`/issues/${peer!.id}`, { title: "Prohibited edit" }, "PATCH")
        : await api(`/agents/${recipient}`, { capabilities: "Prohibited configuration" }, "PATCH");
      expect(response, key).toMatchObject({ status: 403, body: { details: { code: "agent_interaction_denied", permission: key } } });
      expect(await snapshot(), key).toEqual(before);
      expect((await cli(policyAgent, { [key]: null })).overrides).toEqual({});
    }
    await cli(recipient, { canReceiveAssignmentsFromAgents: false });
    const runId = randomUUID();
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, sender));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: sender, status: "running", runtimeMode: "native",
      nativeIssueId: owned!.id, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: owned!.id } });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, owned!.id));
    let nativeWakes = 0;
    const native = new PaperclipRunnerToolAuthority(db, { companyId, agentId: sender, issueId: owned!.id, runId,
      enqueueWakeup: async () => { nativeWakes++; return null; } });
    await expect(native.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      idempotencyKey: randomUUID(), title: "Prohibited native delegation", assigneeActorId: recipient,
    } })).rejects.toMatchObject({ status: 403, details: { permission: "canReceiveAssignmentsFromAgents" } });
    expect(nativeWakes).toBe(0);
    await cli(recipient, { canReceiveAssignmentsFromAgents: null, canReceiveCommentsFromAgents: false });
    expect((await api(`/issues/${peer!.id}/comments`, { body: "Authorized human message" }, "POST", boardKey)).status).toBe(201);
    expect((await api(`/agents/${sender}/interaction-permissions`, { canMentionAgents: true }, "PATCH")).status).toBe(403);
    await cli(recipient, { canReceiveCommentsFromAgents: null });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.interaction_permissions_updated")));
    expect(audit).toHaveLength(25);
    expect(audit.every(row => row.actorId === userId)).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.companyId, companyId))).every(row => !Object.hasOwn(row.permissions, "interactions"))).toBe(true);
  } finally {
    await app?.locals.paperclipShutdown?.();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await db.$client.end();
    await database.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
