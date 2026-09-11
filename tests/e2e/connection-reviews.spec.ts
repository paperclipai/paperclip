import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { startReviewProvider } from "../fixtures/connection-review-provider";

type Json = Record<string, unknown>;
type Seed = { companyId: string; prefix: string };
type Agent = { id: string; name: string };

async function json<T = Json>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(
    response.ok(),
    `${response.url()} failed ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function newCompany(request: APIRequestContext): Promise<Seed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", {
      data: { name: `Connection review E2E ${Date.now()}` },
    }),
  );
  return { companyId: company.id, prefix: company.issuePrefix };
}

async function createAgent(
  request: APIRequestContext,
  companyId: string,
  name: string,
): Promise<Agent> {
  return await json<Agent>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name,
        role: "qa",
        title: "Connection intent fixture agent",
        capabilities: "Exercises deterministic connection intent wiring.",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "process.exit(0)"],
        },
      },
    }),
  );
}

function reviewAgentScript(connectionId: string, query: string) {
  return `
const base = process.env.PAPERCLIP_API_URL + "/api";

const headers = { authorization: "Bearer " + process.env.PAPERCLIP_API_KEY, "content-type": "application/json", "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID };
const api = async (path, method = "GET", body) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
};
const describePages = (raw) => {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch {} }
  const content = typeof value === "string" ? value : typeof value?.content === "string" ? value.content : value?.data?.content?.filter(item => item.type === "text").map(item => item.text).join(" ") ?? "No pages returned.";
  return "I found these recent pages: " + content.replace(/^Pages: /, "") + ".";
};
const issueId = process.env.PAPERCLIP_TASK_ID ?? (await api("/heartbeat-runs/" + process.env.PAPERCLIP_RUN_ID)).contextSnapshot.issueId;
const interactions = await api("/issues/" + issueId + "/interactions");
const review = interactions.find(i => i.payload?.toolAction);
if (review?.status === "pending") { console.log("Still waiting for the existing review; no retry."); process.exit(0); }
if (review && review.status !== "pending") {
  const result = review.result?.toolAction;
  const message = review.status === "rejected" ? "Review declined. No pages were read." : result?.status === "failed" ? "Read failed: " + result.errorMessage : ["expired", "cancelled"].includes(review.status) ? "The review expired or was cancelled. No pages were read." : describePages(result?.resultSummary);
  await api("/issues/" + issueId + "/comments", "POST", { body: message });
  await api("/issues/" + issueId, "PATCH", { status: "done" });
  console.log(message);
  process.exit(0);
}
const session = await api("/tool-gateway/sessions", "POST", { runId: process.env.PAPERCLIP_RUN_ID, ttlMs: 60000 });
const gatewayHeaders = { "x-paperclip-tool-gateway-token": session.token, "content-type": "application/json" };
const tools = await (await fetch(base + "/tool-gateway/tools", { headers: gatewayHeaders })).json();
const tool = tools.find(t => t.connectionId === ${JSON.stringify(connectionId)} && t.upstreamToolName === "notion:list_pages");
if (!tool) throw new Error("Missing fixture connection");
const call = await fetch(base + "/tool-gateway/tools/call", { method: "POST", headers: gatewayHeaders, body: JSON.stringify({ tool: tool.name, parameters: { query: ${JSON.stringify(query)} } }) });
const result = await call.json();
if (!call.ok) {
  if (result.reasonCode !== "approval_required" && result.code !== "approval_required" && !JSON.stringify(result).includes("approval_required")) throw new Error(JSON.stringify(result));
  await api("/issues/" + issueId, "PATCH", { status: "in_review" });
  console.log("Waiting for human review. No retry.");
  process.exit(0);
}
await api("/issues/" + issueId + "/comments", "POST", { body: describePages(result.result) });
await api("/issues/" + issueId, "PATCH", { status: "done" });
`;
}

for (const journey of [
  "approve",
  "decline",
  "always",
  "failure",
  "restart",
] as const) {
  test(`connection review: ${journey}, synchronized task history and actual continuation`, async ({
    page,
    context,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
      journey === "restart" && !process.env.PAPERCLIP_REVIEW_RESTART_FILE,
      "Use connection-reviews.config.ts for controlled server restart",
    );
    let suppressReviewEvents = journey === "decline";
    if (journey === "decline") {
      // Reproduce a review arriving between the initial fetch and subscription:
      // return an empty first snapshot and drop its live creation notification.
      const initialSnapshots = new Set<string>();
      await page.route("**/api/issues/*/interactions", async (route) => {
        const url = route.request().url();
        if (route.request().method() === "GET" && !initialSnapshots.has(url)) {
          initialSnapshots.add(url);
          await route.fulfill({ json: [] });
        } else await route.continue();
      });
      await page.routeWebSocket("**/api/companies/*/events/ws", (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
          if (suppressReviewEvents && String(message).includes("issue.thread_interaction_")) return;
          socket.send(message);
        });
      });
    }
    const provider = await startReviewProvider();
    try {
      const seed = await newCompany(request);
      const agent = await createAgent(request, seed.companyId, "Page reader");
      await page.goto(`/${seed.prefix}/apps`);
      const connector = page
        .getByRole("list", { name: "Connector list" })
        .getByRole("listitem")
        .filter({ hasText: "Connect your own tool" });
      await connector
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      await connector
        .getByRole("button", { name: "Connect your own MCP server" })
        .click();
      await page
        .getByPlaceholder("https://example.com/actions")
        .fill(provider.url);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Save and continue" }).click();
      await page.getByRole("button", { name: /Check link/i }).click();
      await expect(
        page.getByRole("heading", { name: /is ready/i }),
      ).toBeVisible({ timeout: 30_000 });
      const {
        connections: [connection],
      } = await json<{ connections: Array<{ id: string }> }>(
        await request.get(`/api/companies/${seed.companyId}/tools/connections`),
      );
      await json(
        await request.put(`/api/tool-connections/${connection.id}/installs`, {
          data: { installs: [{ targetType: "agent", targetId: agent.id }] },
        }),
      );
      await page.goto(`/${seed.prefix}/apps/${connection.id}/permissions`);
      await page
        .getByRole("radio", { name: "List fixture pages: Ask first" })
        .click();
      const configureAgent = async (query: string) =>
        json(
          await request.patch(`/api/agents/${agent.id}`, {
            data: {
              adapterConfig: {
                command: process.execPath,
                args: [
                  "--input-type=module",
                  "-e",
                  reviewAgentScript(connection.id, query),
                ],
              },
              replaceAdapterConfig: true,
            },
          }),
        );
      await configureAgent(journey === "failure" ? "fail" : "recent");
      const issue = await json<{ id: string; identifier: string }>(
        await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: {
            title: "Read recent pages",
            status: "in_progress",
            assigneeAgentId: agent.id,
          },
        }),
      );
      await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
      await expect(
        page.getByRole("button", { name: "Approve & run", exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      suppressReviewEvents = false;
      const originatingReviews = await json<Array<{ id: string; sourceRunId: string | null }>>(await request.get(`/api/issues/${issue.id}/interactions`));
      const originatingReview = originatingReviews[0];
      const calls = () =>
        provider.captures.filter((c) => c.method === "tools/call").length;
      expect(calls()).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath("pending-review.png"),
      });
      await page
        .getByRole("button", { name: "Dismiss Approve tool action" })
        .click();
      await expect(
        page.getByRole("button", { name: "Approve & run", exact: true }),
      ).not.toBeVisible();
      await json(
        await request.post(`/api/issues/${issue.id}/comments`, {
          data: { body: "Keeping this review pending while I check." },
        }),
      );
      await page
        .getByRole("button", { name: "Review request", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Approve & run", exact: true }),
      ).toBeVisible();
      const queue = await context.newPage();
      await queue.goto(`/${seed.prefix}/apps/review`);
      await expect(
        queue.getByRole("button", { name: "Decline", exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      if (journey === "restart") {
        const control = process.env.PAPERCLIP_REVIEW_RESTART_FILE!;
        const token = String(Date.now());
        await writeFile(control, `restart:${token}`);
        await expect
          .poll(() => readFile(control, "utf8"), { timeout: 60_000 })
          .toBe(`started:${token}`);
        await expect
          .poll(
            async () => {
              try {
                return (await request.get("/api/health")).ok();
              } catch {
                return false;
              }
            },
            { timeout: 60_000 },
          )
          .toBe(true);
        await page.reload();
        await queue.reload();
        await expect(
          page.getByRole("button", { name: "Approve & run", exact: true }),
        ).toBeVisible();
        expect(calls()).toBe(0);
      }
      if (journey === "decline") {
        // Resolve from Connections and observe the still-open task tab update.
        await queue
          .getByRole("button", { name: "Decline", exact: true })
          .click();

      } else {
        if (journey === "always") {
          await page.getByRole("button", { name: "Approval options", exact: true }).click();
          await page.getByRole("menuitem", { name: "Always allow", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Approve & run", exact: true }).click();
        }
      }
      await expect
        .poll(
          async () =>
            (
              await json<Array<{ body: string }>>(
                await request.get(`/api/issues/${issue.id}/comments`),
              )
            )
              .map((c) => c.body)
              .join("\n"),
          { timeout: 60_000 },
        )
        .toContain(
          journey === "decline"
            ? "Review declined"
            : journey === "failure"
              ? "Read failed"
              : "Roadmap",
        );
      const replies = await json<Array<{ body: string; authorAgentId: string | null; createdByRunId: string | null }>>(await request.get(`/api/issues/${issue.id}/comments`));
      const reply = replies.find(comment => comment.authorAgentId === agent.id)!;
      expect(reply.createdByRunId).toBeTruthy();
      expect(originatingReview.sourceRunId).toBeTruthy();
      expect(reply.createdByRunId).not.toBe(originatingReview.sourceRunId);
      expect(reply.body).not.toContain('"content":');
      if (!["decline", "failure"].includes(journey)) {
        await expect(page.getByRole("button", { name: "Show result details" })).toBeVisible();
        await expect(page.locator("pre")).not.toBeVisible();
        await page.getByRole("button", { name: "Show result details" }).click();
        await expect(page.locator("pre")).toContainText('"content":');
        await page.getByRole("button", { name: "Hide result details" }).click();
      }
      expect(calls()).toBe(journey === "decline" ? 0 : 1);
      await expect(
        page.getByRole("button", { name: "Approve & run", exact: true }),
      ).not.toBeVisible();
      await expect(
        queue.getByRole("button", { name: "Decline", exact: true }),
      ).not.toBeVisible({ timeout: 20_000 });
      await page.reload();
      await expect(
        page
          .getByText(
            journey === "decline"
              ? "Declined"
              : journey === "failure"
                ? "Execution failed"
                : "Succeeded",
            { exact: false },
          )
          .first(),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("resolved-review.png"),
      });
      if (journey === "always") {
        await configureAgent("different search options");
        const later = await json<{ id: string }>(
          await request.post(`/api/companies/${seed.companyId}/issues`, {
            data: {
              title: "Read pages with different arguments",
              status: "in_progress",
              assigneeAgentId: agent.id,
            },
          }),
        );
        await expect
          .poll(
            async () =>
              (
                await json<Array<{ body: string }>>(
                  await request.get(`/api/issues/${later.id}/comments`),
                )
              )
                .map((c) => c.body)
                .join("\n"),
            { timeout: 45_000 },
          )
          .toContain("Roadmap");
        expect(calls()).toBe(2);
        expect(
          await json<unknown[]>(
            await request.get(`/api/issues/${later.id}/interactions`),
          ),
        ).toHaveLength(0);
      }
      await testInfo.attach("journey", {
        body: JSON.stringify(
          {
            source: "local MCP fixture; no live Notion",
            journey,
            ...seed,
            issue,
            agent,
            providerCalls: calls(),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await queue.close();
    } finally {
      await provider.close();
    }
  });
}
