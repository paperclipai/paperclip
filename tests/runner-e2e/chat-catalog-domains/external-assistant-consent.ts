import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { McpConnection } from "../../../packages/shared/src/public-mcp.js";
import { connect, mcp, type ToolResult } from "../public-mcp-client.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { prepareAssistantSetup } from "./external-assistant-connections.js";
import { definition, externalObservation, observeExternal, root, checks, verifyRenderedReply } from "./external-support.js";
import { waitForReply } from "./identity-support.js";
const people = new WeakMap<ChatCatalogContext, Awaited<ReturnType<typeof createAuthenticatedPerson>>>();
function writeDenied(result: ToolResult) { return result.isError === true && result.content.some(row => row.type === "text" && /paperclip:write permission is required/.test(row.text ?? "")); }
export function gradeViewerConsent(value: unknown) {
  const c = checks(), o = externalObservation(value);
  c.add("complete-viewer-consent-evidence", !!o, "Actual viewer membership, requested/granted scopes, visible consent and real capability outcomes are required."); if (!o) return c.result();
  const connections = o.state.viewerConnections as McpConnection[] | undefined;
  c.add("requested-write-is-not-granted-write", o.state.requestedWrite === true && o.state.readOnlyRoleVisible === true && o.state.writeCheckboxDisabled === true
    && o.state.writeCheckboxUnchecked === true && o.state.companyVisible === true && o.state.viewerEscalationStatus === 403
    && connections?.length === 1 && connections[0]?.companyId === o.companyId && connections[0]?.scopes.includes("paperclip:read")
    && !connections[0]?.scopes.includes("paperclip:write") && o.state.tokenScopesReadOnly === true,
    "The actual signed-in viewer sees the intended company and requested write scope but cannot accept writes, including via the public consent API.");
  c.add("explicit-consenting-person-boundary", o.state.phaseBoundary === "operator-chat-to-viewer-browser-consent" && typeof o.state.chatCallerId === "string"
    && o.state.chatCallerId !== o.state.viewerId && o.state.viewerSessionBefore === o.state.viewerId && o.state.viewerSessionAtConsent === o.state.viewerId && o.state.viewerSessionAfter === o.state.viewerId,
    "This tests viewer authority in the explicitly separate consent phase; the operator's canonical chat is not represented as viewer chat coverage.");
  c.add("only-explicit-human-grant", o.state.viewerGrantId === connections?.[0]?.id && o.state.humanConsented === true
    && o.activity.some(row => row.action === "mcp.connection_authorized" && row.entityId === o.state.viewerGrantId && row.actorType === "user" && row.actorId === o.state.viewerId),
    "Only the invited viewer's actual browser consent authorizes this grant, with independent actor attribution.");
  c.add("actual-allowed-task-read", o.state.readTaskId === o.state.taskId && o.state.readTaskCompanyId === o.companyId && o.state.readMarkerMatched === true,
    "The resulting external client reads the intended real company task and unpredictable fixture content.");
  c.add("create-and-update-denied", o.state.createDeniedForScope === true && o.state.updateDeniedForScope === true && o.state.taskPreserved === true
    && o.state.forbiddenTaskCount === 0, "Valid create and update attempts fail specifically for write authority and leave durable tasks unchanged.");
  c.add("no-agent-self-consent-claim", !/\bI (?:have )?(?:approved|authorized|connected)\b|\b(?:is|now|already) connected\b/i.test(o.reply),
    "The initial reply does not claim the person's later browser authorization has already occurred.");
  return c.result();
}
export const assistantConsentExternalCases = [definition("assistant-connections.consent-read-only", async ctx => {
  await prepareAssistantSetup(ctx); const browser = ctx.input.page.context().browser(), secrets = ctx.input.privateSecrets;
  if (!browser || !secrets) throw new Error("Viewer consent requires an isolated signed-in person and private redactor");
  const viewer = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets, name: "Viewer Casey" }); people.set(ctx, viewer);
  try {
    const caller = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
    await enrollPrerequisitePerson(ctx, viewer, "viewer");
    const marker = `Viewer allowed fixture ${randomBytes(12).toString("hex")}`;
    const task = await ctx.input.api.post<{ id: string; title: string; description: string }>(`${root(ctx)}/issues`, { title: "Viewer consent sample task", description: marker, status: "backlog" });
    return { viewerId: viewer.id, chatCallerId: caller.user.id, phaseBoundary: "operator-chat-to-viewer-browser-consent", taskId: task.id, taskBefore: task, marker, forbiddenTitle: `Forbidden viewer task ${ctx.input.nonce}` };
  } catch (error) { people.delete(ctx); await viewer.dispose(); throw error; }
}, gradeViewerConsent, {
  authentication: "human-session",
  sourceFiles: ["chat-catalog-domains/external-assistant-consent.ts", "chat-catalog-domains/external-assistant-connections.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-support.ts", "public-mcp-client.ts", "chat-scenarios/assistant-connections.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)); const viewer = people.get(ctx); if (!viewer || !ctx.input.privateSecrets) throw new Error("Viewer consent fixture missing");
    const page = await viewer.context.newPage();
    try {
      async function signedInPerson() { const response = await page.context().request.get(`${ctx.input.api.baseURL}/api/auth/get-session`); if (!response.ok()) throw new Error("Viewer browser session check failed"); return (await response.json() as { user: { id: string } }).user.id; }
      state.viewerSessionBefore = await signedInPerson();
      const connection = await connect(viewer.context, { ...ctx.input.fixtures.company, issuePrefix: ctx.input.fixtures.company.issuePrefix ?? "EVAL" }, false, page, ctx.input.privateSecrets, false, {
        requestedWrite: true,
        async inspectConsent(consent) {
          state.viewerSessionAtConsent = await signedInPerson();
          await expect(consent.getByRole("radio", { name: ctx.input.fixtures.company.name, exact: true })).toBeChecked(); state.companyVisible = true;
          await expect(consent.getByText("Your role in this organization is read-only.", { exact: true })).toBeVisible(); state.readOnlyRoleVisible = true;
          const writes = consent.getByRole("checkbox", { name: "Write all of your Paperclip data", exact: true });
          await expect(writes).toBeDisabled(); await expect(writes).not.toBeChecked(); state.writeCheckboxDisabled = true; state.writeCheckboxUnchecked = true;
          const requestId = new URL(consent.url()).pathname.split("/").at(-1)!;
          const requestResponse = await viewer.request(`/api/mcp/requests/${encodeURIComponent(requestId)}`);
          if (!requestResponse.ok) throw new Error("Viewer cannot inspect the actual pending authorization request");
          const request = await requestResponse.json() as { requestedWrite: boolean }; state.requestedWrite = request.requestedWrite;
          const escalation = await viewer.request(`/api/mcp/requests/${encodeURIComponent(requestId)}/consent`, "POST", { decision: "approve", companyId: ctx.input.fixtures.company.id, allowWrites: true });
          state.viewerEscalationStatus = escalation.status; await escalation.body?.cancel();
        },
      });
      state.humanConsented = true;
      state.viewerSessionAfter = await signedInPerson();
      await ctx.input.evidence("chat-catalog-viewer-consent-boundary.json", { phaseBoundary: state.phaseBoundary, chatCallerId: state.chatCallerId, consentingViewerId: state.viewerId, viewerSessionBefore: state.viewerSessionBefore, viewerSessionAtConsent: state.viewerSessionAtConsent, viewerSessionAfter: state.viewerSessionAfter });
      state.tokenScopesReadOnly = connection.tokens.scope.split(/\s+/).includes("paperclip:read") && !connection.tokens.scope.split(/\s+/).includes("paperclip:write");
      const client = await mcp(connection.tokens);
      try {
        const identity = await client.call("paperclip_connection"); state.viewerGrantId = identity.structuredContent?.connectionId;
        const read = await client.call("paperclip_read_task", { companyId: ctx.input.fixtures.company.id, taskId: state.taskId });
        if (read.isError) throw new Error("Viewer read capability was unavailable after consent");
        const task = read.structuredContent?.task as { id?: string; companyId?: string; description?: string } | undefined;
        state.readTaskId = task?.id; state.readTaskCompanyId = task?.companyId; state.readMarkerMatched = task?.description === state.marker;
        state.createDeniedForScope = writeDenied(await client.call("paperclip_create_task", { companyId: ctx.input.fixtures.company.id, requestId: randomUUID(), title: state.forbiddenTitle, description: "Negative viewer create probe", assigneeAgentId: ctx.input.fixtures.agent.id }));
        state.updateDeniedForScope = writeDenied(await client.call("paperclip_update_task", { companyId: ctx.input.fixtures.company.id, taskId: state.taskId, requestId: randomUUID(), changes: { title: "Forbidden viewer mutation" } }));
      } finally { await client.close(); }
      await expect(page.getByRole("heading", { name: "Assistant connections", exact: true })).toBeVisible();
    } finally { await page.close(); }
  },
  async observe(ctx, state) {
    const viewer = people.get(ctx); if (!viewer) throw new Error("Viewer identity fixture missing");
    const response = await viewer.request("/api/mcp/connections"); if (!response.ok) throw new Error("Viewer grant listing failed"); state.viewerConnections = await response.json();
    const task = await ctx.input.api.get<{ id: string; title: string; description: string }>(`/api/issues/${state.taskId}`); const before = state.taskBefore as typeof task;
    state.taskPreserved = task.id === before.id && task.title === before.title && task.description === before.description;
    const o = await observeExternal(ctx, state); state.forbiddenTaskCount = o.tasks.filter(row => row.title === state.forbiddenTitle).length; return { ...o, state };
  },
  async verifyResult(ctx, _state, value) { await verifyRenderedReply(ctx, value); },
  async cleanup(ctx, state) {
    const viewer = people.get(ctx); people.delete(ctx);
    try {
      if (viewer) {
        const listing = await viewer.request("/api/mcp/connections"); if (!listing.ok) throw new Error("Viewer cleanup cannot inspect owned grants");
        for (const grant of await listing.json() as McpConnection[]) {
          if (grant.companyId !== ctx.input.fixtures.company.id) throw new Error("Disposable viewer unexpectedly owns another company grant");
          const response = await viewer.request(`/api/mcp/connections/${grant.id}`, "DELETE"); if (!response.ok && response.status !== 404) throw new Error("Viewer grant cleanup failed"); await response.body?.cancel();
        }
      }
    } finally { await viewer?.dispose(); }
  },
})];
