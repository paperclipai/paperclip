import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companyMemberships, closeRegisteredClients, companies, createDb, environments,
  executionWorkspaces, issues } from "@paperclipai/db";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, shellQuote, startSshEnvLabFixture,
  stopSshEnvLabFixture, type SshEnvLabFixtureState } from "@paperclipai/adapter-utils/ssh";
import type { AiProvider } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import * as storageModule from "../../storage/index.js";
import { getServerAdapter } from "../../adapters/index.js";
import { readRemoteWorkspaceAuthority } from "../remote-workspaces.js";
import { heartbeatService } from "../heartbeat.js";
import { aiConnectionService } from "../ai-connections.js";
import { collectEnvironmentSecretRefs, normalizeEnvironmentConfigForPersistence } from "../environment-config.js";
import { secretService } from "../secrets.js";
import * as runLogModule from "../run-log-store.js";
import { objectLogFixture } from "../heartbeat/__tests__/object-log-fixture.js";
import { issueService } from "../issues.js";

const [postgres, ssh] = await Promise.all([getEmbeddedPostgresTestSupport(), getSshEnvLabSupport()]);
export const sshWorkspaceTestsSupported = postgres.supported && ssh.supported;

export interface SshWorkspaceFixture {
  root: string;
  database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  db: ReturnType<typeof createDb>;
  sshd: SshEnvLabFixtureState | undefined;
}

export function useSshWorkspaceFixture(prefix: string): SshWorkspaceFixture {
  const fixture = { sshd: undefined } as SshWorkspaceFixture;
  beforeAll(async () => {
    fixture.root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
    fixture.database = await startEmbeddedPostgresTestDatabase(prefix);
    fixture.db = createDb(fixture.database.connectionString);
    vi.stubEnv("DATABASE_URL", fixture.database.connectionString);
    vi.stubEnv("PAPERCLIP_HOME", path.join(fixture.root, "controller-home"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    fixture.sshd = await startSshEnvLabFixture({ statePath: path.join(fixture.root, "sshd", "state.json") });
  }, 60_000);

  afterAll(async () => {
    if (fixture.sshd) await stopSshEnvLabFixture(fixture.sshd);
    if (fixture.database) await closeRegisteredClients(fixture.database.connectionString);
    await fixture.database?.cleanup();
    if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 60_000);
  return fixture;
}

export const sshHeartbeatHarnesses = [
  { adapterType: "claude_local", provider: "anthropic", authEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6", engines: ["cli", "acp"] },
  { adapterType: "codex_local", provider: "openai", authEnv: "OPENAI_API_KEY", model: "gpt-5.4-mini", engines: ["cli", "acp"] },
  { adapterType: "gemini_local", provider: "google", authEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", engines: ["cli", "acp"] },
  { adapterType: "grok_local", provider: "xai", authEnv: "XAI_API_KEY", model: "grok-4", engines: ["cli"] },
  { adapterType: "opencode_local", provider: "openrouter", authEnv: "OPENROUTER_API_KEY", model: "openrouter/openai/gpt-4.1", engines: ["cli"] },
  { adapterType: "pi_local", provider: "openai", authEnv: "OPENAI_API_KEY", model: "openai/gpt-5.4-mini", engines: ["cli"] },
  { adapterType: "cursor", provider: null, authEnv: "PAPERCLIP_SSH_FIXTURE_AUTH", model: "auto", engines: ["cli"] },
  { adapterType: "kimi_local", provider: null, authEnv: "PAPERCLIP_SSH_FIXTURE_AUTH", model: "kimi-k2.5", engines: ["cli"] },
] as const;

export const sshHeartbeatRuns = sshHeartbeatHarnesses.flatMap(harness =>
  harness.engines.map(engine => ({ ...harness, engine, key: `${harness.adapterType}-${engine}` })));

type SshHeartbeatAdapterType = (typeof sshHeartbeatHarnesses)[number]["adapterType"];

export function describeSshHeartbeatRuns(title: string,
  selection: { include: readonly SshHeartbeatAdapterType[] } | { exclude: readonly SshHeartbeatAdapterType[] }) {
  const runs = sshHeartbeatRuns.filter(run => "include" in selection
    ? selection.include.includes(run.adapterType) : !selection.exclude.includes(run.adapterType));
  describe.skipIf(!sshWorkspaceTestsSupported)(title, () => {
    const fixture = useSshWorkspaceFixture("cloud-ssh-heartbeat-");

    it.each(runs)("runs an assigned $key task through heartbeat over SSH", async ({ adapterType, provider, authEnv, model, engine, key }) => {
      const { root, db, sshd } = fixture;
      vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
      vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-cloud-ssh-jwt-secret");
      vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
      const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, `heartbeat-${key}-objects`))), provider: "s3" as const };
      vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
      vi.spyOn(runLogModule, "getRunLogStore").mockReturnValue(objectLogFixture());
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `ssh-user-${randomUUID()}`;
      await db.insert(authUsers).values({ id: userId, name: "SSH test user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companies).values({ id: companyId, name: "Cloud SSH task", issuePrefix: `SSH${sshHeartbeatRuns.findIndex(run => run.key === key)}`, defaultResponsibleUserId: userId });
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
}
