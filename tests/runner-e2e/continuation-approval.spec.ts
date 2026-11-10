import { createServer } from "node:http";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { confirmContinuationPlan, type ContinuationApproval } from "./continuation-approval.js";
import type { ContinuationCheckpoint } from "./continuation-scoring.js";

async function fixture(request: APIRequestContext) {
  const card: ContinuationApproval = { id: "current", issueId: "parent", kind: "request_confirmation", status: "pending",
    resolverPolicy: "human_only", effectiveResolverPolicy: "human_only", continuationPolicy: "wake_assignee_on_accept",
    payload: { acceptLabel: "Confirm", target: { type: "issue_document", issueId: "parent", key: "plan", revisionId: "revision-2" } } };
  const documents = [{ key: "plan", body: "Revised plan", latestRevisionId: "revision-2" }];
  const checkpoint: ContinuationCheckpoint = { phase: "revised", issue: { id: "parent", status: "in_review" },
    children: [], comments: [], attachments: [], runs: [], documents: structuredClone(documents), interactions: [structuredClone(card)] };
  const acceptedIds: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/issues/parent/interactions") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([card]));
    } else if (req.method === "GET" && req.url === "/api/issues/parent/documents") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(documents));
    } else if (req.method === "POST" && req.url?.endsWith("/accept")) {
      const id = req.url.split("/").at(-2)!;
      acceptedIds.push(id);
      if (id === card.id) Object.assign(card, { status: "accepted", result: { outcome: "accepted" },
        resolvedByUserId: "fixture-user", resolvedByAgentId: null, resolvedAt: new Date().toISOString() });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(card));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<section data-testid="task-chat-composer-takeover"><div id="interaction-current">
        <p>Approve revised plan</p><button onclick="fetch('/api/issues/parent/interactions/current/accept',{method:'POST'})">Confirm</button>
        <button>Dismiss request</button></div></section>
        <div id="interaction-stale"><button onclick="fetch('/api/issues/parent/interactions/stale/accept',{method:'POST'})">Confirm</button></div>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  return { card, documents, checkpoint, acceptedIds, origin,
    api: { get: async <T>(path: string) => { const response = await request.get(`${origin}${path}`); expect(response.ok()).toBe(true); return response.json() as Promise<T>; } },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test("uses the exact revised card's real Confirm action and reads its saved human verdict", async ({ page, request }) => {
  const f = await fixture(request);
  try {
    await page.goto(f.origin);
    const saved = await confirmContinuationPlan({ page, api: f.api, checkpoint: f.checkpoint, deadlineAt: Date.now() + 5000 });
    expect(f.acceptedIds).toEqual(["current"]);
    expect(saved).toMatchObject({ id: "current", status: "accepted", resolverPolicy: "human_only", resolvedByUserId: "fixture-user", result: { outcome: "accepted" } });
    expect(saved.payload.target?.revisionId).toBe("revision-2");
  } finally { await f.close(); }
});

test("refuses a plan revised after the checkpoint without approving either card", async ({ page, request }) => {
  const f = await fixture(request);
  try {
    f.documents[0]!.latestRevisionId = "revision-3";
    await page.goto(f.origin);
    await expect(confirmContinuationPlan({ page, api: f.api, checkpoint: f.checkpoint, deadlineAt: Date.now() + 5000 }))
      .rejects.toThrow(/current plan revision/);
    expect(f.acceptedIds).toEqual([]);
    expect(f.card.status).toBe("pending");
  } finally { await f.close(); }
});
