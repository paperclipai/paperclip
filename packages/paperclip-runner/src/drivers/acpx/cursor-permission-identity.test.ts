import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpPermissionRequest } from "acpx/runtime";
import { expect, it } from "vitest";
import { normalizeAcpxPermission } from "./acp-permission-adapter.js";
import { cursorToolIdentity } from "./cursor-plan-tool-identity.js";
import { createCursorToolEvidence } from "./cursor-tool-evidence.js";
import { validateAcpxRichEvent } from "./profile-extensions.js";

const rawIds = ["native\u0000tool", "native\u007ftool", "native\u0085tool", "tool/1", "x".repeat(161), "safe-tool-1"];
// Synthetic protocol fixture, not a claim about the unretained paid wire bytes.
// Native permission deliberately omits rawInput, matching pinned Cursor's shape.
const peer = String.raw`
const ids=['native\u0000tool','native\u007ftool','native\u0085tool','tool/1','x'.repeat(161),'safe-tool-1'];
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
let promptId, index=0;
function next() {
 if(index===ids.length) { send({id:promptId,result:{stopReason:'end_turn'}}); return; }
 const tool={method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:ids[index],kind:'execute',title:'Run command',status:'pending',rawInput:{command:'printf fixture-'+index}}}};
 const permission={id:index,method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:ids[index],kind:'execute',title:'Run command',status:'pending'},options:[{kind:'reject_once',optionId:'native-denial-'+index,name:'Deny'}]}};
 for(const frame of process.env.ORDER==='tool-first'?[tool,permission]:[permission,tool])send(frame);
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native'}});
 else if(m.method==='session/prompt'){promptId=m.id;next();}
 else if(m.id===index&&!m.method){
  if(m.result?.outcome?.outcome!=='selected'||m.result.outcome.optionId!=='native-denial-'+index){process.exitCode=2;process.stdin.destroy();return;}
  index++;next();
 }
});`;

it.each(["tool-first", "permission-first"])("real ACPX streams Cursor tool origins while native permission callbacks remain held: %s", async order => {
  const cwd = await mkdtemp(join(tmpdir(), "cursor-permission-identity-"));
  const children: ChildProcess[] = [];
  const pending: Array<{ request: AcpPermissionRequest; before: AcpPermissionRequest; release(): void; delivery: Promise<void> | undefined }> = [];
  const replies: unknown[] = [];
  const fields: Array<Record<string, string>> = [];
  let promptSettled = false;
  const evidence = createCursorToolEvidence({ sessionId: "native", turnId: "turn", workingDirectory: cwd, active: () => true,
    emit: event => { validateAcpxRichEvent(event); fields.push(Object.fromEntries((event.payload.details as Array<{ name: string; value: string }>).map(field => [field.name, field.value]))); },
  });
  const runtime = createAcpRuntime({ cwd, agentRegistry: createAgentRegistry({ overrides: { cursor: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(cwd, "state") }), permissionMode: "approve-reads", authPolicy: "skip",
    spawnAgent: () => { const child = spawn(process.execPath, ["-e", peer], { cwd, env: { ORDER: order }, stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; },
    onAcpMessage: (direction, value) => {
      const message = value as { id?: number; result?: { outcome?: unknown } };
      if (direction === "outbound" && message.result?.outcome) replies.push(structuredClone(message));
    },
    onPermissionRequest: async (request, context) => {
      const before = structuredClone(request);
      const normalized = normalizeAcpxPermission(request, { provider: "cursor" });
      const delivered = evidence.permission(request, `request-${pending.length}`, normalized.choices.map(choice => choice.key));
      const gate = Promise.withResolvers<void>();
      pending.push({ request, before, release: gate.resolve, delivery: context.responseDelivery });
      await gate.promise;
      const decision = normalized.resolve({ action: "decline" });
      // Delivery is observed outside this callback; waiting here would deadlock
      // the ACP response writer that must receive the callback result first.
      void context.responseDelivery?.then(() => delivered?.(decision.outcome));
      return decision;
    },
  });
  let handle: Awaited<ReturnType<typeof runtime.ensureSession>> | undefined;
  let drain: Promise<void> | undefined;
  try {
    handle = await runtime.ensureSession({ sessionKey: "identity-fixture", agent: "cursor", mode: "persistent", cwd });
    const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "turn", timeoutMs: 5_000 });
    void turn.result.then(() => { promptSettled = true; });
    drain = (async () => { for await (const event of turn.events) evidence.tool(event); })();
    for (const [index, rawId] of rawIds.entries()) {
      await expect.poll(() => fields.some(row => row.stage === "permission_requested" && row.requestId === `request-${index}`), { timeout: 2_000 }).toBe(true);
      expect(promptSettled).toBe(false);
      expect(replies).toHaveLength(index);
      const held = pending[index]!;
      expect(held.request.raw.toolCall.toolCallId).toBe(rawId);
      const projectedId = cursorToolIdentity(rawId);
      const related = fields.filter(row => row.toolCallId === projectedId);
      expect(related.map(row => row.stage)).toEqual(["tool", "permission_requested"]);
      expect(related[1]).toMatchObject({ requestId: `request-${index}`, declineOffered: "true", commandSha256: related[0]!.commandSha256 });
      expect(held.request).toEqual(held.before);
      held.release();
      await held.delivery;
      expect(replies[index]).toEqual({ jsonrpc: "2.0", id: index, result: { outcome: { outcome: "selected", optionId: `native-denial-${index}` } } });
    }
    await expect(turn.result).resolves.toMatchObject({ status: "completed" });
    await drain;
    expect(new Set(fields.map(row => row.toolCallId)).size).toBe(rawIds.length);
    expect(fields.some(row => row.stage === "evidence_incomplete")).toBe(false);
  } finally {
    pending.forEach(value => value.release());
    if (handle) await runtime.close({ handle, reason: "fixture complete" });
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    }
    await drain;
    await rm(cwd, { recursive: true, force: true });
  }
}, 10_000);
