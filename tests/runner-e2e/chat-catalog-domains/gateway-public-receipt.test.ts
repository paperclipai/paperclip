import { expect, it } from "vitest";
import { executeRunnerApi } from "../../../server/src/services/native-runtime/runner-api-client.js";
import { redactRunnerApiPayloads } from "../../../server/src/services/native-runtime/runner-api-log-redaction.js";
import { nativeSha256 } from "../../../server/src/services/native-runtime/canonical.js";
import { observedRedactedPublicReceipt } from "./gateway-public-receipt.js";
const binding = { companyId: "company", leadId: "ceo", canonicalRunId: "canonical", workerId: "morgan", workerTaskId: "worker-task", workerRunId: "worker-run" };
async function valid() {
  const report = { id: "public-comment", companyId: "company", issueId: "worker-task", authorAgentId: "morgan", createdByRunId: "worker-run", body: "The required notes write returned a provider error and the page remained unchanged.", createdAt: "2026-10-28T12:00:00.000Z" };
  const request = { operationId: "GET /api/issues/{id}/comments", pathParams: { id: "worker-task" } };
  let requests = 0;
  const response = await executeRunnerApi(request, { companyId: "company", issueId: "canonical-task", runId: "canonical", workMode: "standard" }, {
    apiUrl: "https://synthetic.invalid", token: "synthetic-test-token", fetch: async (url, init) => { requests++; expect(new URL(String(url)).pathname).toBe("/api/issues/worker-task/comments"); expect(init?.method).toBe("GET"); return new Response(JSON.stringify([report]), { status: 200, headers: { "content-type": "application/json" } }); },
    readFile: async () => { throw Error("unexpected file read"); }, saveResponse: async () => { throw Error("unexpected artifact write"); },
  });
  expect(requests).toBe(1);
  const { operationId, ...rest } = response;
  const wire = { ...rest, apiOperationId: operationId };
  const event = (seq: number, eventType: string, payload: unknown) => ({ companyId: "company", agentId: "ceo", runId: "canonical", seq, eventType, createdAt: `2026-10-28T12:00:0${seq}.000Z`, protocolSchemaVersion: 2, payload: { prpEvent: { schema: "paperclip.prp.event.v2", schemaVersion: 2, sourceKind: "runner", payload } } });
  const events = [event(1, "item.started", { kind: "dynamicToolCall", item: { id: "call", type: "tool_use", name: "call_api", input: redactRunnerApiPayloads(request) } }), event(2, "item.completed", { kind: "dynamicToolCall", item: { id: "call", tool_use_id: "call", type: "tool_result", result: redactRunnerApiPayloads(wire) } })];
  return { report, comments: [report], events, binding: { ...binding } };
}
const observe = (o: Awaited<ReturnType<typeof valid>>) => observedRedactedPublicReceipt(o.events, o.report, o.comments, o.binding);
const item = (o: Awaited<ReturnType<typeof valid>>, index = 1): any => o.events[index]!.payload.prpEvent.payload;
it("binds the actual production API envelope/redaction to an independent public comment without a transport-ID assumption", async () => { const o = await valid(); expect(observe(o)).toBe(true); expect((item(o).item.result as any).apiPayloadSha256).toBe(nativeSha256({ ok: true, status: 200, contentType: "application/json", retryAfter: null, data: o.comments, apiOperationId: "GET /api/issues/{id}/comments" })); });
it.each(["companyId", "agentId", "runId"])("rejects a foreign event %s", async field => { const o = await valid(); (o.events[1] as any)[field] = "foreign"; expect(observe(o)).toBe(false); });
it.each(["companyId", "leadId", "canonicalRunId", "workerId", "workerTaskId", "workerRunId"])("rejects a foreign expected binding %s", async field => { const o = await valid(); (o.binding as any)[field] = "foreign"; expect(observe(o)).toBe(false); });
it.each(["body", "id", "authorAgentId", "createdByRunId", "companyId", "issueId"])("rejects mutated independently saved receipt %s", async field => { const o = await valid(); (o.report as any)[field] = "wrong"; expect(observe(o)).toBe(false); });
it.each(["apiPayloadSha256", "apiOperationId", "status", "ok", "contentType", "data", "apiPayloadRedacted"])("rejects a wrong or missing typed result %s", async field => { const o = await valid(); delete item(o).item.result[field]; expect(observe(o)).toBe(false); });
it("rejects reordered/incomplete/comment-contaminated public DTO collections", async () => { for (const mode of ["extra", "empty", "foreign"]){ const o = await valid(); if(mode==="empty") o.comments=[]; else o.comments.push({...o.report,id:"another",...(mode==="foreign"?{companyId:"foreign"}:{})}); expect(observe(o)).toBe(false); } });
it("rejects wrong/missing/duplicate call starts and results, errors and bad chronology", async () => { for(const mutate of [(o:any)=>o.events.shift(),(o:any)=>o.events.push(structuredClone(o.events[0])),(o:any)=>o.events.push(structuredClone(o.events[1])),(o:any)=>item(o,0).item.name="read_task",(o:any)=>item(o,0).item.input.operationId="GET /api/companies/{companyId}/activity",(o:any)=>item(o).item.tool_use_id="other-call",(o:any)=>item(o).item.is_error=true,(o:any)=>o.events[0].seq=3,(o:any)=>o.events[1].createdAt="2026-10-28T11:59:59.000Z",(o:any)=>o.events[0].createdAt="2026-10-28T12:00:03.000Z",(o:any)=>o.events[1].protocolSchemaVersion=1,(o:any)=>o.events[1].payload.prpEvent.sourceKind="provider",(o:any)=>item(o).item.result.unproven="extra"]){ const o=await valid(); mutate(o);expect(observe(o)).toBe(false); } });
it("never replaces Morgan's public receipt with the CEO's own real receipt", async () => { const o=await valid(); o.comments=[{...o.report, id:"own-comment",authorAgentId:"ceo",createdByRunId:"own-run",issueId:"own-task"}]; expect(observe(o)).toBe(false); });
it("requires both actual response digest and the public DTO; a hash label alone cannot prove a read",async()=>{const o=await valid();item(o).item.result.apiPayloadSha256="a".repeat(64);expect(observe(o)).toBe(false)});

it("matches supported actual public response orders without synthesizing or sorting private response bytes",async()=>{
 const o=await valid(),prior={...o.report,id:"prior-comment",body:"Checking the required source.",createdAt:"2026-10-28T11:59:00Z"};
 const ascending=[prior,o.report],descending=[o.report,prior];
 item(o).item.result=redactRunnerApiPayloads({ok:true,status:200,contentType:"application/json",retryAfter:null,data:descending,apiOperationId:"GET /api/issues/{id}/comments"});
 expect(observedRedactedPublicReceipt(o.events,o.report,ascending,o.binding)).toBe(false);
 expect(observedRedactedPublicReceipt(o.events,o.report,ascending,o.binding,[descending])).toBe(true);
 expect(observedRedactedPublicReceipt(o.events,o.report,ascending,o.binding,[[{...o.report,body:"changed"},prior]])).toBe(false);
 item(o).item.result=redactRunnerApiPayloads({ok:true,status:200,contentType:"application/json",retryAfter:null,data:ascending,apiOperationId:"GET /api/issues/{id}/comments"});
 expect(observedRedactedPublicReceipt(o.events,o.report,descending,o.binding,[ascending])).toBe(true);
});
