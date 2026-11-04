import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { assertKimiContextObserverConfig, projectKimiContextCheckpoint } from "./kimi-context-checkpoint.js";
import { pendingKimiContextPermission, publishKimiContextContinuation, readKimiContextProof, withoutProvenKimiContext } from "./kimi-context-rendezvous.js";
import { observeKimiLifecyclePending } from "./kimi-lifecycle-evidence.js";
const hash = (v: unknown) => `sha256:${createHash("sha256").update(canonicalJson(v)).digest("hex")}`;
const bytesHash = (v: string) => `sha256:${createHash("sha256").update(v).digest("hex")}`;
type Row = Record<string, any>;
const produced = JSON.parse(await readFile(new URL("./fixtures/kimi-context-command-v2.json", import.meta.url), "utf8"));
function fixture() {
  const identity = produced.identity, scope = { companyId: "synthetic-company", agentId: "synthetic-agent", environmentId: "synthetic-env", issueId: "synthetic-task", runId: identity.runId }, action = produced.action;
  const row = (seq: number, eventType: string, payload: Row): Row => ({ companyId: scope.companyId, runId: scope.runId, seq, eventType, protocolSchemaVersion: 1,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: identity.runnerInstanceId, sourceSeq: seq, sourceEventId: `${identity.runnerInstanceId}:${scope.runId}:${seq}`, emittedAt: "2026-10-29T00:00:00Z", normalizedSessionId: identity.normalizedSessionId, itemId: identity.itemId, turnId: produced.nativeTurnId, runId: scope.runId, eventType, payload } } });
  const tool = { schema: "paperclip.tool.execution.v1", executionId: "0:synthetic-context-call", transport: "mcp", namespace: "paperclip", name: "get_task_context", operation: "unknown", status: "running", target: null, output: "", outputTruncated: false };
  const request = { schema: "paperclip.runtime_request.v2", requestKind: "permission_approval", type: "permission", status: "pending", requestId: "context-request", turnId: produced.nativeTurnId, itemId: identity.itemId, method: "session/request_permission", prompt: "mcp__paperclip__get_task_context", origin: { adapter: "acpx-runtime-sidecar", provider: "kimi", method: "session/request_permission" }, choices: [{ key: "accept" }, { key: "decline" }, { key: "cancel" }], details: { toolCallId: tool.executionId, turnId: produced.nativeTurnId, itemId: identity.itemId } };
  const rows = [row(1, "tool.execution.started", tool), row(2, "runtime_request.created", { request })], pending = pendingKimiContextPermission(rows, scope)!;
  const publication: any = { ...pending, schema: "paperclip.e2e.kimi-context-publication.v1", observerLeaseId: "synthetic-lease", actionSha256: bytesHash(action), setupSha256: bytesHash(action), observerSha256: hash({ complete: true }) };
  const records = new Map<string,string>(produced.checkpoint.records), header: Row = { schema: "paperclip.runner.controller-checkpoint.v2", runnerVersion: "0.3.0", runnerDigest: `sha256:${"a".repeat(64)}`, state: { schema: "paperclip.runner.durable.control-plane-state.v1", checkpointEventPolicy: "control-v1", identity: structuredClone(identity) } };
  records.set("header", JSON.stringify(header));
  const checkpoint: any = { ...structuredClone(produced.checkpoint), records };
  const inputKey = [...records].find(([k,v]) => k.startsWith("event:") && JSON.parse(v).eventType === "semantic_tool.input")![0], commandKey = [...records].find(([k,v]) => k.startsWith("command:") && JSON.parse(v).type === "semantic_tool.result")![0];
  function modify(key: string, f: (v: Row) => void) { const v=JSON.parse(records.get(key)!);f(v);records.set(key,JSON.stringify(v)); }
  function deliver() {
    const command = JSON.parse(records.get(commandKey)!);
    const output = JSON.stringify(command.payload.result).slice(0,4096) + "…<truncated>";
    rows.push(row(44, "runtime_request.resolved", { requestId: request.requestId, requestKind: "permission_approval", turnId: produced.nativeTurnId, action: "accept" }),
      row(48, "tool.execution.completed", { ...tool, name: null, namespace: null, transport: "builtin", status: "completed", output, outputBytes: Buffer.byteLength(output), outputDigest: bytesHash(output) }));
  }
  function write() { rows.push(row(49,"tool.execution.started",{...tool,executionId:"0:native-write",transport:"builtin",namespace:null,name:"Write",operation:"edit"}),row(50,"runtime_request.created",{request:{...request,requestId:"write-request",prompt:"Change file: denied/target.txt",details:{toolCallId:"0:native-write"}}})); }
  return { scope, identity, action, row, rows, tool, request, pending, publication, checkpoint, records, header, inputKey, commandKey, modify, deliver, write };
}
it("requires the independently selected execution workspace authority",()=>{const f=fixture();expect(()=>projectKimiContextCheckpoint(f.checkpoint,f.publication,undefined as any)).toThrow();expect(()=>projectKimiContextCheckpoint(f.checkpoint,f.publication,"foreign-workspace")).toThrow();});
const payload = (r: Row) => r.payload.prpEvent.payload;
describe("Kimi checkpoint-bound context rendezvous", () => {
  it("uses the calibrated actual checkpoint command shape and keeps only the unanswered native Write", () => {
    const f=fixture(),authority=projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)!;expect(authority).toEqual(produced.projected);expect(authority.turnId).not.toBe(authority.controllerTurnId);expect(authority.observerLeaseId).not.toBe(authority.executionWorkspaceId);f.deliver();expect(Buffer.byteLength(payload(f.rows[3]!).output)).toBeGreaterThan(4096);expect(()=>JSON.parse(payload(f.rows[3]!).output)).toThrow();
    const proof=readKimiContextProof(f.rows,f.publication,authority)!;expect(proof).toBeDefined();f.write();expect(withoutProvenKimiContext(f.rows,proof)).toEqual(f.rows.slice(4));
    const run={id:f.scope.runId,companyId:f.scope.companyId,nativeIssueId:f.scope.issueId,status:"running",runtimeMode:"native",nativeSessionId:f.identity.normalizedSessionId,runnerInstanceId:f.identity.runnerInstanceId,resultJson:{}};
    expect(observeKimiLifecyclePending({run,issue:{id:f.scope.issueId,companyId:f.scope.companyId,status:"in_progress"},events:f.rows,scope:{companyId:f.scope.companyId,issueId:f.scope.issueId,runId:f.scope.runId,target:"denied/target.txt",contextProof:proof}})).toMatchObject({requestId:"write-request"});
  });
  it.each(["company","issue","agent","run","session","runner","turn","marker","no-auth","input-digest","extra-arguments","call","source","correlation","result-hash","failed-command","duplicate-input","duplicate-command","logical-lease","controller-turn","controller-item","request-id","request-tool","request-kind","resolved-turn","resolved-action","resolution-ack","start-turn","start-ack","input-order"])("rejects %s before accepting scoped result delivery", kind => {
    const f=fixture();
    if(["company","issue","agent"].includes(kind)) f.publication[`${kind}Id`]="foreign";
    if(kind==="run")f.checkpoint.runId="foreign";if(kind==="session")f.publication.sessionId="foreign";if(kind==="runner")f.publication.sourceInstanceId="foreign";if(kind==="turn")f.publication.turnId="foreign";
    if(kind==="marker")f.records.set("header",JSON.stringify({schema:"paperclip.runner.durable.control-plane-external.v1"}));if(kind==="no-auth")f.checkpoint.recoveryEvidence.authenticatedConnectionCount=0;
    if(kind==="input-digest")f.modify(f.commandKey,c=>c.payload.inputDigest="0".repeat(64));if(kind==="extra-arguments")f.modify(f.inputKey,c=>{c.envelope.payload.payload.semantic_tool.input={path:"foreign"};c.envelope.payload.payload.semantic_tool.content.digest=hash({path:"foreign"});});
    if(kind==="call")f.modify(f.commandKey,c=>c.payload.callId="foreign");if(kind==="source")f.modify(f.commandKey,c=>c.payload.sourceEventId="foreign");if(kind==="correlation")f.modify(f.commandKey,c=>c.payload.correlation.turnId="foreign");
    if(kind==="result-hash")f.modify(f.commandKey,c=>c.payload.result.activeTask.description="foreign");if(kind==="failed-command")f.modify(f.commandKey,c=>c.status="failed");
    if(kind==="duplicate-input")f.records.set("event:999",f.records.get(f.inputKey)!);if(kind==="duplicate-command")f.records.set("command:999",f.records.get(f.commandKey)!);
    const requestKey=[...f.records].find(([k,v])=>k.startsWith("event:")&&JSON.parse(v).eventType==="runtime_request.created")![0], resolvedKey=[...f.records].find(([k,v])=>k.startsWith("event:")&&JSON.parse(v).eventType==="runtime_request.resolved")![0], startKey=[...f.records].find(([k,v])=>k.startsWith("command:")&&JSON.parse(v).type==="turn.start")![0], resolutionKey=[...f.records].find(([k,v])=>k.startsWith("command:")&&JSON.parse(v).type==="request.resolve")![0];
    if(kind==="logical-lease")f.header.state.identity.environmentLeaseId="foreign";
    if(kind==="controller-turn")f.header.state.identity.turnId="foreign";if(kind==="controller-item")f.header.state.identity.itemId="foreign";
    if(["logical-lease","controller-turn","controller-item"].includes(kind))f.records.set("header",JSON.stringify(f.header));
    if(kind==="request-id")f.publication.requestId="foreign";if(kind==="request-tool")f.modify(requestKey,c=>c.envelope.payload.payload.request.details.toolCallId="foreign");
    if(kind==="request-kind")f.modify(requestKey,c=>c.envelope.payload.payload.request.requestKind="runtime");if(kind==="resolved-turn")f.modify(resolvedKey,c=>c.envelope.payload.payload.turnId="foreign");if(kind==="resolved-action")f.modify(resolvedKey,c=>c.envelope.payload.payload.action="decline");
    if(kind==="resolution-ack")f.modify(resolutionKey,c=>c.result.result.status="queued");if(kind==="start-turn")f.modify(startKey,c=>c.payload.turnId="foreign");if(kind==="start-ack")f.modify(startKey,c=>c.result.result.providerTurnId="foreign");if(kind==="input-order")f.modify(f.inputKey,c=>c.envelope.payload.sourceSeq=2);
    if(kind==="request-id")expect(projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)).toBeUndefined();else expect(()=>projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)).toThrow();
  });
  it("waits for the matching completed command and correlated native completion",()=>{const f=fixture();f.modify(f.commandKey,c=>c.status="pending");expect(projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)).toBeUndefined();f.deliver();expect(readKimiContextProof(f.rows,f.publication)).toBeUndefined();});
  it.each(["queued-only","wrong-request-kind","declined","native-output","input-order","foreign-turn","foreign-item","foreign-native-request-turn"])("rejects %s as delivered native context",kind=>{
    const f=fixture(),a=projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)!;f.deliver();if(kind==="queued-only"){f.rows.pop();expect(readKimiContextProof(f.rows,f.publication,a)).toBeUndefined();return;}
    if(kind==="wrong-request-kind")payload(f.rows[2]!).requestKind="runtime";if(kind==="declined")payload(f.rows[2]!).action="decline";if(kind==="native-output")payload(f.rows[3]!).output="{}";if(kind==="input-order")a.inputSourceSeq=a.requestResolvedSourceSeq;if(kind==="foreign-item")payload(f.rows[1]!).request.details.itemId="foreign";if(kind==="foreign-native-request-turn")payload(f.rows[1]!).request.details.turnId="foreign";if(kind==="foreign-turn")a.turnId="foreign";
    expect(()=>readKimiContextProof(f.rows,f.publication,a)).toThrow();
  });
  it.each(["Read","Write","mcp__other__get_task_context","mcp__paperclip__call_api"])("never approves unknown native or foreign operation %s",name=>{const f=fixture();f.request.prompt=name;expect(()=>pendingKimiContextPermission(f.rows,f.scope)).toThrow();});
  it("accepts an honestly bounded native display whose metadata describes its full preimage",()=>{const f=fixture(),a=projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)!;f.deliver();const full=JSON.stringify(JSON.parse(f.records.get(f.commandKey)!).payload.result),view=payload(f.rows[3]!);view.outputTruncated=true;view.outputBytes=Buffer.byteLength(full);view.outputDigest=bytesHash(full);expect(readKimiContextProof(f.rows,f.publication,a)).toBeDefined();});
  it("never strips an unknown native Read",()=>{const f=fixture(),a=projectKimiContextCheckpoint(f.checkpoint,f.publication,f.identity.environmentLeaseId)!;f.deliver();const proof=readKimiContextProof(f.rows,f.publication,a)!;const read=f.row(49,"tool.execution.started",{...f.tool,executionId:"unknown",transport:"builtin",namespace:null,name:"Read",operation:"read"});expect(withoutProvenKimiContext([...f.rows,read],proof)).toContainEqual(read);});
  it("rejects ambient observer configuration before opening a database",async()=>{await expect(assertKimiContextObserverConfig({})).rejects.toThrow();});
  it("rejects a foreign physical config path before opening a database",async()=>{const root=await mkdtemp(path.join(tmpdir(),"kimi-context-config-"));try{const home=path.join(root,"paperclip-home");await mkdir(home);const foreign=path.join(root,"foreign.json");await writeFile(foreign,"{}");await expect(assertKimiContextObserverConfig({PAPERCLIP_RUNNER_E2E_TEMP_ROOT:root,PAPERCLIP_HOME:home,PAPERCLIP_INSTANCE_ID:"synthetic",PAPERCLIP_CONFIG:foreign})).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}});
});
function publicationFixture() {
  const f=fixture(),actionFile=`.paperclip-eval-action-${"a".repeat(36)}.txt`;
  const snapshot:Row={complete:true,binding:{leaseId:"synthetic-lease",companyId:f.scope.companyId,environmentId:f.scope.environmentId,runId:f.scope.runId},watcher:{complete:true,targetMutationCount:0,workspaceMutationCount:0},setup:{path:actionFile,published:true,sha256:bytesHash(f.action)}};
  const issue:Row={id:f.scope.issueId,companyId:f.scope.companyId,assigneeAgentId:f.scope.agentId,executionRunId:f.scope.runId,status:"in_progress"},run:Row={id:f.scope.runId,companyId:f.scope.companyId,agentId:f.scope.agentId,status:"running",runtimeMode:"native",nativeIssueId:f.scope.issueId,nativeSessionId:f.identity.normalizedSessionId,runnerInstanceId:f.identity.runnerInstanceId};
  const api={get:vi.fn(async(p:string)=>structuredClone(p.includes("heartbeat-runs")?run:issue)),patch:vi.fn(async(_p:string,body:unknown)=>{Object.assign(issue,body);return structuredClone(issue);})},remote={actionFile,snapshot:vi.fn(async()=>snapshot)};
  const client = {
    get: async<T>(p:string):Promise<T> => await api.get(p) as T,
    patch: async<T>(p:string,body:unknown):Promise<T> => await api.patch(p,body) as T,
  };
  return {...f,snapshot,issue,run,api,remote,publish:()=>publishKimiContextContinuation({pending:f.pending,action:f.action,fixture:remote,api:client})};
}
it("publishes once only after immutable observer arming and exact active native ownership",async()=>{const f=publicationFixture();await expect(f.publish()).resolves.toMatchObject({actionSha256:bytesHash(f.action)});expect(f.remote.snapshot).toHaveBeenCalledBefore(f.api.patch);expect(f.api.patch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${f.scope.issueId}`,{description:f.action});});
it.each(["company","environment","run","unarmed","mutated","wrong-path","wrong-hash","unpublished","foreign-task","foreign-agent","terminal-run","foreign-session"])("blocks %s before operator description publication",async kind=>{const f=publicationFixture();if(kind==="company")f.snapshot.binding.companyId="foreign";if(kind==="environment")f.snapshot.binding.environmentId="foreign";if(kind==="run")f.snapshot.binding.runId="foreign";if(kind==="unarmed")f.snapshot.complete=false;if(kind==="mutated")f.snapshot.watcher.targetMutationCount=1;if(kind==="wrong-path")f.snapshot.setup.path="foreign";if(kind==="wrong-hash")f.snapshot.setup.sha256=bytesHash("foreign");if(kind==="unpublished")f.snapshot.setup.published=false;if(kind==="foreign-task")f.issue.id="foreign";if(kind==="foreign-agent")f.issue.assigneeAgentId="foreign";if(kind==="terminal-run")f.run.status="failed";if(kind==="foreign-session")f.run.nativeSessionId="foreign";await expect(f.publish()).rejects.toThrow();expect(f.api.patch).not.toHaveBeenCalled();});
