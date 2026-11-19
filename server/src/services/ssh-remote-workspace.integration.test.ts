import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companyMemberships, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, shellQuote, startSshEnvLabFixture,
  stopSshEnvLabFixture, type SshEnvLabFixtureState } from "@paperclipai/adapter-utils/ssh";
import type { AiProvider, EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "./remote-workspaces.js";
import { requireRemoteWorkspaceTarget } from "./remote-workspace-transport.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { heartbeatService } from "./heartbeat.js";
import { aiConnectionService } from "./ai-connections.js";
import * as storageModule from "../storage/index.js";
import { collectEnvironmentSecretRefs, normalizeEnvironmentConfigForPersistence } from "./environment-config.js";
import { secretService } from "./secrets.js";
import * as runLogModule from "./run-log-store.js";
import { objectLogFixture } from "./heartbeat/__tests__/object-log-fixture.js";
import { issueService } from "./issues.js";
import { getServerAdapter } from "../adapters/index.js";
import * as recoverySnapshots from "./workspace-recovery-snapshot.js";
import { hasRemoteRecoveryAttachment } from "./remote-workspace-transport.js";

const [postgres, ssh] = await Promise.all([getEmbeddedPostgresTestSupport(), getSshEnvLabSupport()]);

describe.skipIf(!postgres.supported || !ssh.supported)("Cloud SSH durable workspace with a real SSH server", () => {
  let root: string;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let sshd: SshEnvLabFixtureState | undefined;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cloud-ssh-workspace-")));
    database = await startEmbeddedPostgresTestDatabase("cloud-ssh-workspace-");
    db = createDb(database.connectionString);
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "controller-home"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    sshd = await startSshEnvLabFixture({ statePath: path.join(root, "sshd", "state.json") });
  }, 60_000);

  afterAll(async () => {
    if (sshd) await stopSshEnvLabFixture(sshd);
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 60_000);

  it("keeps Hello World through controller replacement and restores it to a new SSH allocation", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SSH workspace test", issuePrefix: "SSH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "SSH Claude", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write Hello World", assigneeAgentId: agentId });
    const config = await buildSshEnvLabFixtureConfig(sshd!);
    const [environment] = await db.insert(environments).values({ driver: "ssh", name: "SSH test", config: {} }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))), provider: "s3" as const };

    async function acquire(id: string, remoteCwd = config.remoteWorkspacePath, providerLeaseId = "ssh-fixture") {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id,
        heartbeatRunId: id, issueId, provider: "ssh", providerLeaseId, status: "active",
        metadata: { driver: "ssh", remoteCwd } }).returning();
      const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId: environment.id,
        leaseId: lease.id, remoteCwd, spec: { ...config, remoteCwd, useHostAuth: false } };
      return { lease: lease as EnvironmentLease, target };
    }

    async function stop(id: string, lease: EnvironmentLease) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, id));
      const [stopped] = await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease, { state: "stopped", providerLeaseId: lease.providerLeaseId }) } })
        .where(eq(environmentLeases.id, lease.id)).returning();
      return stopped as EnvironmentLease;
    }

    const first = await acquire(runId);
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" }, mode: "shared_workspace" });
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId, ...first });
    const firstTarget = { ...first.target, remoteCwd: prepared.remoteRoot, spec: { ...first.target.spec, remoteCwd: prepared.remoteRoot } };
    const result = await requireRemoteWorkspaceTarget(firstTarget).runner!.execute({ command: "node", args: ["-e",
      "require('fs').writeFileSync('hello_world.txt','Hello World\\n')"], cwd: prepared.remoteRoot, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    const stopped = await stop(runId, prepared.lease);
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, async () => {}))
      .rejects.toThrow("binding_missing");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: randomUUID() }, async () => {}))
      .rejects.toThrow("binding_missing");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, ownership =>
      saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId, lease: stopped,
        target: { ...firstTarget, spec: { ...firstTarget.spec, host: "127.0.0.1", port: 1 } }, assertOwned: ownership.assertHeld })))
      .rejects.toThrow();
    const [held] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, reserved.id));
    expect(readRemoteWorkspaceAuthority(held.metadata)).toMatchObject({ writerRunId: runId, dirty: true,
      snapshotId: readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId });
    expect(await readFile(path.join(prepared.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");
    const blockedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: blockedId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
    await expect(reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: blockedId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: prepared.workspace.id, source: { kind: "empty" } })).rejects.toMatchObject({ status: 409 });
    const peerIssueId = randomUUID(), peerRunId = randomUUID();
    await db.insert(issues).values({ id: peerIssueId, companyId, title: "Use the saved shared workspace", assigneeAgentId: agentId,
      executionWorkspaceId: prepared.workspace.id });
    await db.insert(heartbeatRuns).values({ id: peerRunId, companyId, agentId, issueId: peerIssueId, runtimeMode: "legacy", status: "running" });
    const finalized = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, async ownership => {
      await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId,
        lease: stopped, target: firstTarget, assertOwned: ownership.assertHeld });
      const handedOn = await reserveRemoteWorkspace({ db, storage, companyId, issueId: peerIssueId, runId: peerRunId, agentId,
        environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: prepared.workspace.id, source: { kind: "empty" } });
      expect(readRemoteWorkspaceAuthority(handedOn.metadata)).toMatchObject({ epoch: 2, writerRunId: peerRunId });
      await ownership.assertHeld();
      await expect(saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId,
        lease: stopped, target: firstTarget, assertOwned: ownership.assertHeld })).rejects.toThrow("authority_changed");
    });
    expect(finalized.acquired).toBe(true);
    const [finishedOwner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(finishedOwner.runnerProfileJson).not.toHaveProperty("nativeWorkspaceFinalizationOwner");
    await expect(withNativeWorkspaceFinalizationOwnership({ db, companyId, runId, remoteWorkspaceId: prepared.workspace.id }, async () => {}))
      .rejects.toThrow("binding_missing");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, peerRunId));

    // Replace the controller connection. The saved task and remote files are the authority.
    db = createDb(database.connectionString);
    const [saved] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, reserved.id), eq(executionWorkspaces.companyId, companyId)));
    const snapshotId = readRemoteWorkspaceAuthority(saved.metadata)!.snapshotId;
    expect(snapshotId).toBeTruthy();
    expect(await readFile(path.join(prepared.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");

    const followupId = randomUUID();
    const followup = await acquire(followupId);
    const reused = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: followupId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: saved.id, source: { kind: "empty" } });
    const continued = await prepareRemoteWorkspace({ db, storage, workspace: reused, runId: followupId, ...followup });
    expect(continued.remoteRoot).toBe(prepared.remoteRoot);
    await saveRemoteWorkspace({ db, storage, workspace: continued.workspace, runId: followupId,
      lease: await stop(followupId, continued.lease), target: followup.target, assertOwned: async () => {} });

    const [latest] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, saved.id));
    const restoredBase = path.join(root, "replacement-remote");
    await mkdir(restoredBase);
    const restoreId = randomUUID(), replacement = await acquire(restoreId, restoredBase, "replacement-ssh-allocation");
    const restoring = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId: restoreId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: latest.id, source: { kind: "empty" } });
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: restoring, runId: restoreId, ...replacement });
    expect(restored.remoteRoot).not.toBe(prepared.remoteRoot);
    expect(await readFile(path.join(restored.remoteRoot, "hello_world.txt"), "utf8")).toBe("Hello World\n");
  }, 60_000);

  it("prepares a verified recovered copy on SSH without directory-sync support", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sourceId = randomUUID(), operationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SSH recovery test", issuePrefix: "REC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery worker", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover earlier files", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
    const [environment] = await db.insert(environments).values({ driver: "ssh", name: "SSH recovery", config: {} }).returning();
    const config = await buildSshEnvLabFixtureConfig(sshd!);
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id,
      heartbeatRunId: runId, issueId, provider: "ssh", providerLeaseId: "ssh-recovery", status: "active" }).returning();
    const target: AdapterSshExecutionTarget = { kind: "remote", transport: "ssh", environmentId: environment.id,
      leaseId: lease.id, remoteCwd: config.remoteWorkspacePath, spec: { ...config, remoteCwd: config.remoteWorkspacePath } };
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "recovery-objects"))), provider: "s3" as const };
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null,
      source: { kind: "empty" }, recoverySourceRunIds: [sourceId] });
    const provenance = JSON.stringify({ operationId, sourceRunId: sourceId });
    // Start at the verified extraction boundary; source authorization and snapshot verification keep their existing owner.
    const extract = vi.spyOn(recoverySnapshots, "attachPreservedWorkspaceSnapshots").mockImplementationOnce(async input => {
      expect(input.sourceRunIds).toContain(sourceId);
      const recovered = path.join(input.cwd, "recovered", operationId);
      await mkdir(path.join(recovered, "files", "nested"), { recursive: true });
      await writeFile(path.join(recovered, "files", "nested", "preserved.txt"), "Earlier work\n");
      await writeFile(path.join(recovered, "provenance.json"), provenance);
      return [{ operationId, sourceRunId: sourceId, path: recovered }];
    });
    try {
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId, lease: lease as EnvironmentLease, target });
      const recovered = path.join(prepared.remoteRoot, ".paperclip-recovered", operationId);
      expect(await readFile(path.join(recovered, "files", "nested", "preserved.txt"), "utf8")).toBe("Earlier work\n");
      expect(await readFile(path.join(recovered, "provenance.json"), "utf8")).toBe(provenance);
      expect(await hasRemoteRecoveryAttachment({ target: requireRemoteWorkspaceTarget(target), remoteCwd: prepared.remoteRoot, operationId, provenance })).toBe(true);
      await writeFile(path.join(recovered, "files", "nested", "preserved.txt"), "A later edit\n");
      await prepareRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId, lease: prepared.lease, target });
      expect(await readFile(path.join(recovered, "files", "nested", "preserved.txt"), "utf8")).toBe("A later edit\n");
    } finally { extract.mockRestore(); }
  }, 60_000);

  const harnesses = [
    { adapterType: "claude_local", provider: "anthropic", authEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6", engines: ["cli", "acp"] },
    { adapterType: "codex_local", provider: "openai", authEnv: "OPENAI_API_KEY", model: "gpt-5.4-mini", engines: ["cli", "acp"] },
    { adapterType: "gemini_local", provider: "google", authEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", engines: ["cli", "acp"] },
    { adapterType: "grok_local", provider: "xai", authEnv: "XAI_API_KEY", model: "grok-4", engines: ["cli"] },
    { adapterType: "opencode_local", provider: "openrouter", authEnv: "OPENROUTER_API_KEY", model: "openrouter/openai/gpt-4.1", engines: ["cli"] },
    { adapterType: "pi_local", provider: "openai", authEnv: "OPENAI_API_KEY", model: "openai/gpt-5.4-mini", engines: ["cli"] },
    { adapterType: "cursor", provider: null, authEnv: "PAPERCLIP_SSH_FIXTURE_AUTH", model: "auto", engines: ["cli"] },
    { adapterType: "kimi_local", provider: null, authEnv: "PAPERCLIP_SSH_FIXTURE_AUTH", model: "kimi-k2.5", engines: ["cli"] },
  ];
  const runs = harnesses.flatMap(harness => harness.engines.map(engine => ({ ...harness, engine, key: `${harness.adapterType}-${engine}` })));
  it.each(runs)("runs an assigned $key task through heartbeat over SSH", async ({ adapterType, provider, authEnv, model, engine, key }) => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-cloud-ssh-jwt-secret");
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, `heartbeat-${key}-objects`))), provider: "s3" as const };
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    vi.spyOn(runLogModule, "getRunLogStore").mockReturnValue(objectLogFixture());
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `ssh-user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "SSH test user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Cloud SSH task", issuePrefix: `SSH${runs.findIndex(run => run.key === key)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const account = provider ? await aiConnectionService(db).save(companyId, userId, { provider: provider as AiProvider, method: "api_key",
      ownership: "personal", name: "Selected test account", apiKey: "synthetic-selected-ssh-key", agentIds: [], allAgents: true }, "synthetic-selected-ssh-key") : null;
    const config = await buildSshEnvLabFixtureConfig(sshd!);
    const command = path.join(root, `fake-${key}`);
    await writeFile(command, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }
if (process.argv.includes('models')) { console.log(${JSON.stringify(model)}); process.exit(0); }
if (process.env[${JSON.stringify(authEnv)}] !== 'synthetic-selected-ssh-key') process.exit(91);
const fs = require('fs'), path = require('path');
const harness = ${JSON.stringify(adapterType)};
const piSession = harness === 'pi_local' ? process.argv[process.argv.indexOf('--session') + 1] : null;
const history = harness === 'claude_local' ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture-history')
 : piSession || path.join(process.cwd(), '.fixture-provider-history');
const runTask = (resumed) => {
if (resumed && !fs.existsSync(history)) throw Error('Missing provider conversation history');
fs.mkdirSync(path.dirname(history), {recursive:true});
if (piSession) {
 const previous = resumed ? fs.readFileSync(piSession,'utf8') : '';
 if (resumed && JSON.parse(previous.split('\\n')[0]).cwd !== process.cwd()) throw Error('Invalid Pi session header');
 if (resumed && !previous.includes('first-turn-history')) throw Error('Missing Pi conversation messages');
 if (!resumed) fs.writeFileSync(piSession,JSON.stringify({type:'session',version:3,id:'fixture',cwd:process.cwd()})+'\\n');
 fs.appendFileSync(piSession,JSON.stringify({type:'message',message:{role:'assistant',content:resumed?'continued-history':'first-turn-history'}})+'\\n');
 fs.writeFileSync('pi-session-path.json',JSON.stringify({session:piSession,home:process.env.HOME}));
} else fs.writeFileSync(history, 'provider conversation state');
fs.writeFileSync('continuation.json', JSON.stringify({resumed}));
require('fs').writeFileSync('hello_world.txt', 'Hello World\\n');
};
if (process.argv.includes('--acp-fixture')) {
 const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
 let resumed = false;
 require('readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  try {
   if (request.method === 'initialize') result = {protocolVersion:1, agentCapabilities:{loadSession:true, sessionCapabilities:{close:{}}}};
   if (request.method === 'session/new') result = {sessionId:'12345678-1234-4abc-9def-123456789012'};
   if (request.method === 'session/load') resumed = true;
   if (request.method === 'session/new' || request.method === 'session/load') {
    if (request.params.cwd !== process.cwd()) throw Error('ACP working directory mismatch');
   }
   if (request.method === 'session/prompt') {
    runTask(resumed);
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,
     update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Created hello_world.txt'}}}});
    result = {stopReason:'end_turn'};
   }
   send({jsonrpc:'2.0',id:request.id,result});
  } catch (error) { send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}}); }
 });
} else {
 const id = '12345678-1234-4abc-9def-123456789012';
 const resumed = ['--resume', 'resume', '-r'].some(arg => process.argv.includes(arg))
  || (harness === 'opencode_local' && process.argv.includes('--session'))
  || Boolean(piSession && fs.existsSync(piSession) && fs.statSync(piSession).size > 0);
 runTask(resumed);
 const emit = value => console.log(JSON.stringify(value));
 if (harness === 'codex_local') {
  emit({type:'thread.started',thread_id:id}); emit({type:'item.completed',item:{type:'agent_message',text:'Created hello_world.txt'}});
  emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
 } else if (harness === 'gemini_local') {
  emit({type:'system',subtype:'init',session_id:id}); emit({type:'message',role:'assistant',content:'Created hello_world.txt'});
  emit({type:'result',status:'success',session_id:id,stats:{input_tokens:1,output_tokens:1}});
 } else if (harness === 'kimi_local') {
  emit({role:'assistant',content:'Created hello_world.txt'}); emit({role:'meta',type:'session.resume_hint',session_id:id});
 } else if (harness === 'opencode_local') {
  emit({type:'text',sessionID:id,part:{text:'Created hello_world.txt'}});
  emit({type:'step_finish',sessionID:id,part:{cost:0,tokens:{input:1,output:1,cache:{read:0,write:0}}}});
 } else if (harness === 'pi_local') {
  emit({type:'turn_end',message:{role:'assistant',content:'Created hello_world.txt',usage:{input:1,output:1}},toolResults:[]});
 } else if (harness === 'grok_local') {
  emit({type:'message',data:'Created hello_world.txt'}); emit({type:'end',sessionId:id,stopReason:'EndTurn',usage:{input_tokens:1,output_tokens:1}});
 } else emit({type:'result',subtype:'success',is_error:false,result:'Created hello_world.txt',session_id:id,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
}
`, { mode: 0o700 });
    const storedConfig = await normalizeEnvironmentConfigForPersistence({ db, companyId, environmentName: `Heartbeat SSH ${key}`,
      driver: "ssh", secretProvider: "local_encrypted", config: { ...config, useHostAuth: !provider } });
    const [environment] = await db.insert(environments).values({ driver: "ssh", name: `Heartbeat SSH ${key}`, config: storedConfig }).returning();
    await secretService(db).replaceSecretRefsForInstanceTarget({ targetType: "environment", targetId: environment.id },
      await collectEnvironmentSecretRefs({ db, environment: { id: environment.id, driver: "ssh", config: storedConfig } }));
    const adapterConfig = { command, ...(engine === "cli" ? { engine: "cli" } : { agentCommand: `${shellQuote(command)} --acp-fixture`, acpWarmHandleIdleMs: 60_000 }),
      model, timeoutSec: 20, ...(!provider ? { env: { [authEnv]: "synthetic-selected-ssh-key" } } : {}) };
    await db.insert(agents).values({ id: agentId, companyId, name: `${adapterType} SSH task`, adapterType, status: "idle",
      defaultEnvironmentId: environment.id, adapterConfig,
      runtimeConfig: account ? { aiConnection: { provider, method: "api_key", mode: "delegated", connectionId: account.connectionId, grantId: account.grantId } } : {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Create hello_world.txt", status: "todo", assigneeAgentId: agentId,
      responsibleUserId: userId, issueNumber: 1 });
    const adapter = getServerAdapter(adapterType), execute = adapter.execute;
    expect(adapter.type).toBe(adapterType);
    const executing = vi.spyOn(adapter, "execute").mockImplementation(async input => {
      const target = input.executionTarget;
      expect(target).toMatchObject({ kind: "remote", transport: "ssh", workspaceRealization: { mode: "in_place" } });
      const remoteCwd = target!.kind === "remote" ? target!.remoteCwd : "";
      const localAccesses: string[] = [];
      const guards = (["stat", "mkdir"] as const).map(method => {
        const original = fs[method].bind(fs);
        return vi.spyOn(fs, method).mockImplementation(((candidate: unknown, ...args: unknown[]) => {
          if (typeof candidate === "string" && (candidate === remoteCwd || candidate.startsWith(remoteCwd + path.sep))) {
            localAccesses.push(method);
            return Promise.reject(Object.assign(new Error("SSH workspace is unavailable on the controller"), { code: "EACCES" }));
          }
          return (original as (...args: unknown[]) => unknown)(candidate, ...args);
        }) as never);
      });
      let result;
      try { result = await execute(input); }
      finally { for (const guard of guards) guard.mockRestore(); }
      expect(localAccesses).toEqual([]);
      // The synthetic provider stands in for the final task update too.
      if (result.exitCode === 0) await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
      return result;
    });
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId }, contextSnapshot: { issueId } });
      expect(run).toBeTruthy();
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(run!.id);
      if (finished?.status !== "succeeded") throw new Error(JSON.stringify({ errorCode: finished?.errorCode,
        error: finished?.error, log: await heartbeat.readLog(run!.id, { limitBytes: 12_000 }).catch(() => null) }));
      expect(finished).toMatchObject({ status: "succeeded", runtimeMode: "legacy" });
      const authority = finished!.runnerProfileJson!.remoteWorkspace as { workspaceId: string; state: string; remoteCwd: string };
      expect(authority.state).toBe("saved");
      expect(await readFile(path.join(authority.remoteCwd, "hello_world.txt"), "utf8")).toBe("Hello World\n");
      const piState = adapterType === "pi_local" ? JSON.parse(await readFile(path.join(authority.remoteCwd, "pi-session-path.json"), "utf8")) : null;
      if (piState) {
        expect(await readFile(piState.session, "utf8")).toContain("first-turn-history");
        await expect(fs.stat(piState.home)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, authority.workspaceId));
      expect(readRemoteWorkspaceAuthority(workspace.metadata)).toMatchObject({ writerRunId: null, dirty: false });
      const comment = await issueService(db).addComment(issueId, "Confirm the file still exists.", { userId });
      const followup = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId }, contextSnapshot: { issueId, wakeCommentId: comment.id } });
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      const continued = await heartbeat.getRun(followup!.id);
      if (continued?.status !== "succeeded") throw new Error(JSON.stringify({ status: continued?.status,
        retryReason: continued?.scheduledRetryReason, retryAt: continued?.scheduledRetryAt, errorCode: continued?.errorCode,
        error: continued?.error, result: continued?.resultJson, log: await heartbeat.readLog(followup!.id, { limitBytes: 12_000 }).catch(() => null) }));
      expect(continued).toMatchObject({ status: "succeeded" });
      const continuation = JSON.parse(await readFile(path.join(authority.remoteCwd, "continuation.json"), "utf8"));
      expect(continuation).toEqual({ resumed: true });
      if (piState) {
        const next = JSON.parse(await readFile(path.join(authority.remoteCwd, "pi-session-path.json"), "utf8"));
        expect(next.session).toBe(piState.session);
        expect(next.home).not.toBe(piState.home);
        expect(await readFile(next.session, "utf8")).toContain("continued-history");
        await expect(fs.stat(next.home)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
      executing.mockRestore();
    }
  }, 60_000);
});
