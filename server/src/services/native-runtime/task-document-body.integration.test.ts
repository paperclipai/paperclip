import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { documentService } from "../documents.js";

let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
beforeAll(async () => {
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
  server = await startRunnerApiTestServer();
}, 60_000);
afterAll(async () => {
  await server?.close();
  if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
});

const bodies = [
  "# Final newline\n",
  "  Leading whitespace\n\nA Markdown hard break  \nnext line\n\n",
  "No final newline",
  "\t日本語 café 🧭\r\n\r\nSecond line  \r\n\n",
];

it.each(["write_document", "write_task_document", "rest"] as const)(
  "%s preserves exact Markdown on create, update, and read-back", async surface => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const issueId = surface === "write_task_document" ? fixture.blockerId : fixture.issueId;
    const service = documentService(server.db);
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", fixture.runId);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    for (const [index, body] of bodies.entries()) {
      const key = `exact-body-${index}`;
      let baseRevisionId: string | null = null;
      for (const phase of ["create", "update"] as const) {
        const supplied = phase === "create" ? body : `Updated\n${body}`;
        const args = { key, title: "  Exact body  ", body: supplied, baseRevisionId };
        const call = { tool: surface, callId: randomUUID(), arguments: surface === "write_document"
          ? { ...args, idempotencyKey: randomUUID() } : { ...args, taskId: issueId } };
        if (surface === "rest") {
          const response = await fetch(`${server.apiUrl}/api/issues/${issueId}/documents/${key}`, {
            method: "PUT", headers, body: JSON.stringify({ ...args, format: "markdown" }),
          });
          expect(response.status).toBe(phase === "create" ? 201 : 200);
          expect((await response.json()).body).toBe(supplied);
        } else {
          const result = await fixture.authority.execute(call);
          expect(result).toMatchObject(surface === "write_document"
            ? { document: { body: supplied, title: "Exact body" } } : { ok: true, status: phase === "create" ? 201 : 200 });
          expect(await fixture.authority.execute({ ...call, callId: surface === "write_document" ? randomUUID() : call.callId })).toEqual(result);
        }
        const saved = await service.getIssueDocumentByKey(issueId, key);
        expect(saved?.body).toBe(supplied);
        expect(saved?.latestRevisionNumber).toBe(phase === "create" ? 1 : 2);
        const read = await fixture.authority.execute({ tool: surface === "write_task_document" ? "read_task_document" : "read_document",
          callId: randomUUID(), arguments: surface === "write_task_document" ? { taskId: issueId, key } : { key } }) as { document?: { body: string }; data?: { body: string } };
        expect(surface === "write_task_document" ? read.data?.body : read.document?.body).toBe(supplied);
        baseRevisionId = saved!.latestRevisionId;
      }
    }
  }, 30_000,
);

it("retains required body validation for write_document", async () => {
  const fixture = await server.fixture({ disableWakeOnDemand: true });
  for (const body of [undefined, null, 42, "", " \n\t"]) {
    await expect(fixture.authority.execute({ tool: "write_document", callId: randomUUID(), arguments: {
      key: "invalid-body", title: "Invalid body", body, baseRevisionId: null, idempotencyKey: randomUUID(),
    } })).rejects.toThrow("paperclip_runner_tool_input_invalid");
  }
  expect(await documentService(server.db).getIssueDocumentByKey(fixture.issueId, "invalid-body")).toBeNull();
});
