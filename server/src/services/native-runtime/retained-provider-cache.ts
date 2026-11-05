import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, withDedicatedDbConnection, workspaceOperations, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { RemoteWorkspaceTarget } from "../remote-workspace-transport.js";

const schema = "paperclip.native-provider-cache-reclaim.v1";
const prepareSchema = "paperclip.native-provider-cache-prepare.v1";
const inventorySchema = "paperclip.native-provider-cache-inventory.v1";
const preparePhase = "native_provider_cache_reclaim_prepare";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const numericIdentity = z.string().regex(/^\d{1,24}$/);
const identity = z.object({ dev: numericIdentity, ino: numericIdentity, generation: z.string().regex(/^[bc]:\d{1,24}$/) });
const inventoryCodec = z.object({ schema: z.literal(inventorySchema), sourceRunId: z.string().regex(uuidPattern),
  manifestDigest: z.string().regex(digestPattern), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  root: identity, pack: identity, manifest: identity, sessions: identity,
  targets: z.array(identity.extend({ name: z.enum(["node_modules", "provider-assets"]) })).max(2),
  availableBytesBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});
type Inventory = z.infer<typeof inventoryCodec>;

function verifiedCacheDigest(run: typeof heartbeatRuns.$inferSelect, workspaceId: string, target: RemoteWorkspaceTarget): string | null {
  const profile = record(run.runnerProfileJson), state = record(profile.nativeProviderPackAdmissionState);
  const admission = record(profile.nativeProviderPackAdmission), workspace = record(profile.remoteWorkspace);
  if (!uuidPattern.test(target.leaseId ?? "") || state.schema !== "paperclip.native-provider-pack-admission-state.v1" || state.state !== "verified"
    || typeof state.admissionEpoch !== "string" || !uuidPattern.test(state.admissionEpoch)
    || admission.schema !== "paperclip.native-provider-pack-admission.v1" || admission.stage !== "session_admitted"
    || admission.authority !== "core_verified_selection" || admission.runId !== run.id
    || admission.companyId !== run.companyId || admission.agentId !== run.agentId
    || workspace.workspaceId !== workspaceId || workspace.remoteCwd !== target.remoteCwd || workspace.leaseId !== target.leaseId
    || typeof admission.providerPackDigest !== "string" || !digestPattern.test(admission.providerPackDigest)) return null;
  return admission.providerPackDigest;
}

const reclaimScript = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const [mode,root,source,expected,raw]=process.argv.slice(1),schema='paperclip.native-provider-cache-reclaim.v1';
 if(!['inventory','reclaim'].includes(mode)||!path.isAbsolute(root)||!/^[a-f0-9-]{36}$/.test(source)
   ||!/^sha256:[a-f0-9]{64}$/.test(expected)||await fs.realpath(root)!==root)throw Error('invalid_binding');
 const runtime=path.join(root,'.paperclip-runtime'),runner=path.join(runtime,'paperclip-runner'),pack=path.join(runner,'provider-pack');
 const sessions=path.join(runner,'sessions'),file=path.join(pack,'provider-pack.json');
 const stat=async p=>fs.lstat(p,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 const directory=async p=>{const x=await fs.lstat(p,{bigint:true});if(!x.isDirectory()||x.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_directory');return x;};
 const identity=x=>({dev:String(x.dev),ino:String(x.ino),generation:(x.birthtimeNs>0n?'b:'+x.birthtimeNs:'c:'+x.ctimeNs)});
 const same=(a,b,generation=true)=>a&&b&&['dev','ino',...(generation?['generation']:[])].every(k=>a[k]===b[k]);
 const rootIdentity=identity(await directory(root));await directory(runtime);await directory(runner);
 const packIdentity=identity(await directory(pack)),sessionIdentity=identity(await directory(sessions)),m=await stat(file);
 if(!m||!m.isFile()||m.isSymbolicLink()||m.nlink!==1n||m.size>524288n)throw Error('unsafe_manifest');
 const bytes=await fs.readFile(file),manifest=JSON.parse(bytes),manifestIdentity=identity(m);
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
 const manifestSha256=crypto.createHash('sha256').update(bytes).digest('hex');
 if(manifest.schema!=='paperclip-runner/remote-provider-pack/v1'||manifest.digest!==expected
   ||expected!=='sha256:'+crypto.createHash('sha256').update(canonical(manifest.payload)).digest('hex'))throw Error('manifest_changed');
 const available=async()=>{try{const capacity=await fs.statfs(root),bytes=capacity.bavail*capacity.bsize;
  return Number.isSafeInteger(bytes)?Math.max(0,bytes):null;}catch{return null;}};
 const availableBytesBefore=await available();
 if(mode==='inventory'){
  const targets=[];
  for(const name of ['node_modules','provider-assets']){const p=path.join(pack,name),x=await stat(p);if(!x)continue;
   if(!x.isDirectory()||x.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_cache_directory');targets.push({name,...identity(x)});}
  console.log(JSON.stringify({schema:'paperclip.native-provider-cache-inventory.v1',sourceRunId:source,manifestDigest:expected,
   manifestSha256,root:rootIdentity,pack:packIdentity,manifest:manifestIdentity,sessions:sessionIdentity,
   targets,availableBytesBefore}));return;
 }
 const request=JSON.parse(raw),plan=request.inventory;
 if(!/^[a-f0-9-]{36}$/.test(request.preparationOperationId)||plan?.schema!=='paperclip.native-provider-cache-inventory.v1'
   ||plan.sourceRunId!==source||plan.manifestDigest!==expected||plan.manifestSha256!==manifestSha256
   ||!same(plan.root,rootIdentity)||!same(plan.pack,packIdentity,false)||!same(plan.manifest,manifestIdentity)||!same(plan.sessions,sessionIdentity)
   ||!Array.isArray(plan.targets)||plan.targets.length>2||new Set(plan.targets.map(x=>x.name)).size!==plan.targets.length)throw Error('plan_changed');
 for(const item of plan.targets){
  if(!['node_modules','provider-assets'].includes(item.name))throw Error('plan_changed');
  const p=path.join(pack,item.name),current=await stat(p);
  if(current&&(!current.isDirectory()||current.isSymbolicLink()||await fs.realpath(p)!==p||!same(item,identity(current))))throw Error('cache_changed');
 }
 let changed=false;
 for(const item of plan.targets){const p=path.join(pack,item.name),current=await stat(p);if(!current)continue;
  if(!current.isDirectory()||current.isSymbolicLink()||!same(item,identity(current)))throw Error('cache_changed');
  await fs.rm(p,{recursive:true,force:false});changed=true;}
 if(!same(plan.sessions,identity(await directory(sessions))))throw Error('sessions_changed');
 console.log(JSON.stringify({schema,sourceRunId:source,manifestDigest:expected,
  preparationOperationId:request.preparationOperationId,status:'evicted',changed,sessionDirectoryPreserved:true,
  availableBytesBefore,availableBytesAfter:await available()}));
})().catch(()=>{process.stderr.write('native_provider_cache_reclaim_unconfirmed');process.exitCode=1;});`;

function readInventory(value: unknown, runId: string, expected: string): Inventory {
  const parsed = inventoryCodec.parse(value);
  if (parsed.sourceRunId !== runId || parsed.manifestDigest !== expected
    || new Set(parsed.targets.map(target => target.name)).size !== parsed.targets.length)
    throw new Error("native_provider_cache_reclaim_unconfirmed");
  return parsed;
}

export async function reclaimInactiveNativeProviderCache(input: {
  db: Db; companyId: string; issueId: string; runId: string; workspaceId: string;
  target: RemoteWorkspaceTarget; assertOwned: () => Promise<void>;
}): Promise<boolean> {
  await input.assertOwned();
  const [source] = await input.db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns).innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
      eq(nativeRunFinalizations.issueId, input.issueId))).limit(1);
  if (!source || source.run.status !== "failed" || source.run.runtimeMode !== "native"
    || (source.run.nativeIssueId ?? source.run.issueId ?? source.run.contextSnapshot?.issueId) !== input.issueId
    || source.coordinator.phase !== "terminal_failure" || source.coordinator.leaseOwner !== null
    || record(source.coordinator.failureDetail).recoverable === true) return false;
  const expected = verifiedCacheDigest(source.run, input.workspaceId, input.target);
  if (!expected) return false;
  const scope = and(eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId),
    eq(workspaceOperations.heartbeatRunId, input.runId), eq(workspaceOperations.executionWorkspaceId, input.workspaceId));
  const execute = async (mode: "inventory" | "reclaim", preparation?: { preparationOperationId: string; inventory: Inventory }) => {
    await input.assertOwned();
    const response = await input.target.runner!.execute({ command: "node", args: ["-e", reclaimScript,
      mode, input.target.remoteCwd, input.runId, expected, JSON.stringify(preparation ?? null)],
      cwd: input.target.remoteCwd, bypassSession: true, env: { NODE_OPTIONS: "", NODE_PATH: "" }, timeoutMs: 45_000 });
    await input.assertOwned();
    if (response.exitCode !== 0 || response.timedOut || Buffer.byteLength(response.stdout) > 16_384)
      throw new Error("native_provider_cache_reclaim_unconfirmed");
    return record(JSON.parse(response.stdout));
  };
  const startedAt = new Date();
  let confirmed = false, changed = false, preparationOperationId: string | null = null;
  let metadata: Record<string, unknown> = { schema, manifestDigest: expected, outcome: "unconfirmed" };
  try {
    let [prepared] = await input.db.select().from(workspaceOperations)
      .where(and(scope, eq(workspaceOperations.phase, preparePhase), eq(workspaceOperations.status, "succeeded")))
      .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.id)).limit(1);
    if (!prepared) {
      const inventory = readInventory(await execute("inventory"), input.runId, expected);
      if (!inventory.targets.length) return false;
      await input.assertOwned();
      [prepared] = await withDedicatedDbConnection(input.db, journal => journal.transaction(async tx => {
        await tx.execute(sql`select set_config('statement_timeout', '10000', true), set_config('lock_timeout', '2000', true)`);
        return tx.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
          heartbeatRunId: input.runId, executionWorkspaceId: input.workspaceId, phase: preparePhase,
          status: "succeeded", startedAt, finishedAt: new Date(),
          metadata: { schema: prepareSchema, intentOnly: true, leaseId: input.target.leaseId,
            remoteCwd: input.target.remoteCwd, inventory },
        }).returning();
      }));
    }
    if (!prepared || prepared.metadata?.schema !== prepareSchema || prepared.metadata.intentOnly !== true
      || prepared.metadata.leaseId !== input.target.leaseId || prepared.metadata.remoteCwd !== input.target.remoteCwd)
      throw new Error("native_provider_cache_reclaim_unconfirmed");
    const inventory = readInventory(prepared.metadata.inventory, input.runId, expected);
    preparationOperationId = prepared.id;
    metadata = { ...metadata, preparationOperationId };
    const [completed] = await input.db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(scope,
      eq(workspaceOperations.phase, "native_provider_cache_reclaim"), eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.metadata}->>'preparationOperationId' = ${preparationOperationId}`,
      sql`${workspaceOperations.metadata}->>'outcome' = 'evicted'`)).limit(1);
    if (completed) return false;
    const receipt = await execute("reclaim", { preparationOperationId, inventory });
    if (receipt.schema !== schema || receipt.sourceRunId !== input.runId || receipt.manifestDigest !== expected
      || receipt.preparationOperationId !== preparationOperationId || receipt.status !== "evicted"
      || typeof receipt.changed !== "boolean" || receipt.sessionDirectoryPreserved !== true)
      throw new Error("native_provider_cache_reclaim_unconfirmed");
    metadata = { schema, manifestDigest: expected, preparationOperationId, outcome: receipt.status, changed: receipt.changed,
      sessionDirectoryPreserved: true,
      availableBytesBefore: typeof receipt.availableBytesBefore === "number" ? receipt.availableBytesBefore : null,
      availableBytesAfter: typeof receipt.availableBytesAfter === "number" ? receipt.availableBytesAfter : null };
    confirmed = true;
    changed = receipt.changed;
  } catch {}
  await input.db.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
    heartbeatRunId: input.runId, executionWorkspaceId: input.workspaceId, phase: "native_provider_cache_reclaim",
    status: confirmed ? "succeeded" : "failed", startedAt, finishedAt: new Date(), metadata });
  return changed;
}
