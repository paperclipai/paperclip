import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  toolActionRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  projects,
  toolConnections,
  toolInvocations,
  toolMcpElicitations,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { paperclipQuestionSetPayloadSchema } from "@paperclipai/shared";
import { forgetMcpHttpSessions, MCP_MODERN_PROTOCOL_VERSION, mcpClientCapabilities, mcpHttpRequestInit } from "../services/mcp-http.js";
import {
  buildElicitationQuestionSet,
  elicitationContent,
  elicitationQuestionHash,
  elicitationResponseForCard,
  elicitationSensitiveFields,
  openElicitationState,
  sealElicitationState,
} from "../services/mcp-elicitation.js";
import { mcpInputRequiredPending } from "../services/tool-gateway.js";
import { mcpInputRequired } from "../services/mcp-http.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** Every spec form type (SEP-1330 enums, SEP-1034 defaults). */
const TICKET_SCHEMA = {
  type: "object",
  required: ["title", "priority"],
  properties: {
    title: { type: "string", title: "Ticket title", minLength: 3, maxLength: 80, default: "Untitled" },
    contact: { type: "string", format: "email", title: "Contact email" },
    priority: { type: "string", title: "Priority", oneOf: [{ const: "p1", title: "Urgent" }, { const: "p2", title: "Normal" }], default: "p2" },
    team: { type: "string", title: "Team", enum: ["ops", "eng"] },
    labels: { type: "array", title: "Labels", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "ux", title: "UX" }, { const: "perf", title: "Speed" }] }, default: ["bug"] },
    tags: { type: "array", title: "Tags", items: { type: "string", enum: ["a", "b"] } },
    urgent: { type: "boolean", title: "Page someone?", default: false },
    count: { type: "integer", title: "How many?", minimum: 1, maximum: 5, default: 1 },
    budget: { type: "number", title: "Budget" },
  },
};

describe("MCP form elicitation mapping", () => {
  it("maps every spec field type to a real card field, with defaults", () => {
    const built = buildElicitationQuestionSet({ appName: "Linear", request: { message: "Tell us about the ticket", requestedSchema: TICKET_SCHEMA } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The card passes the same validation every question card does.
    expect(paperclipQuestionSetPayloadSchema.safeParse(built.questionSet).success).toBe(true);
    expect(built.questionSet).toMatchObject({ title: "Linear needs your input", description: "Tell us about the ticket", submitLabel: "Send to Linear" });
    const byId = Object.fromEntries(built.questionSet.questions.map((question) => [question.id, question]));
    expect(byId.title).toMatchObject({ answerMode: "text", required: true, initialText: "Untitled", textValidation: { minLength: 3, maxLength: 80 } });
    // The question form checks only fixed-width patterns: an email is a hint, a date is checked.
    expect(byId.contact).toMatchObject({ answerMode: "text", required: false, helpText: "An email address." });
    expect(byId.contact).not.toHaveProperty("textValidation");
    expect(buildElicitationQuestionSet({ appName: "A", request: { message: "m", requestedSchema: { properties: { d: { type: "string", format: "date" } } } } }))
      .toMatchObject({ ok: true, questionSet: { questions: [{ textValidation: { pattern: "^\\d\\d\\d\\d-\\d\\d-\\d\\d$" } }] } });
    expect(byId.priority).toMatchObject({ answerMode: "single_select", options: [{ label: "Urgent" }, { label: "Normal", recommended: true }] });
    expect(byId.team).toMatchObject({ answerMode: "single_select", options: [{ label: "ops" }, { label: "eng" }] });
    expect(byId.labels).toMatchObject({ answerMode: "multi_select", helpText: "Choose at least 1. Choose at most 2.", options: [{ label: "Bug", recommended: true }, { label: "UX" }, { label: "Speed" }] });
    expect(byId.tags).toMatchObject({ answerMode: "multi_select" });
    expect(byId.urgent).toMatchObject({ answerMode: "single_select", options: [{ label: "Yes" }, { label: "No", recommended: true }] });
    expect(byId.count).toMatchObject({ answerMode: "text", initialText: "1", textValidation: { inputType: "integer", minimum: 1, maximum: 5 } });
    expect(byId.budget).toMatchObject({ answerMode: "text", textValidation: { inputType: "number" } });
  });

  it("turns card answers back into typed content on the provider's schema", () => {
    const request = { message: "m", requestedSchema: TICKET_SCHEMA };
    const content = elicitationContent(request, { answers: [
      { questionId: "title", optionIds: ["paperclip_text_answer"], otherText: " Login broken " },
      { questionId: "priority", optionIds: ["choice_1"] },
      { questionId: "labels", optionIds: ["choice_1", "choice_3"] },
      { questionId: "urgent", optionIds: ["choice_1"] },
      { questionId: "count", optionIds: [], otherText: "3" },
      { questionId: "budget", optionIds: [], otherText: "12.5" },
    ] });
    expect(content).toEqual({ title: "Login broken", priority: "p1", labels: ["bug", "perf"], urgent: true, count: 3, budget: 12.5 });
  });

  it("answers accept, decline (skipped), or cancel (anything else ending the card)", () => {
    const request = { message: "Continue?", requestedSchema: { type: "object", properties: {} } };
    expect(elicitationResponseForCard(request, { status: "pending", result: null })).toBeNull();
    expect(elicitationResponseForCard(request, { status: "answered", result: { version: 1, answers: [{ questionId: "continue", optionIds: ["continue"] }] } }))
      .toEqual({ action: "accept", content: {} });
    expect(elicitationResponseForCard(request, { status: "cancelled", result: { version: 1, answers: [], outcome: "skipped" } })).toEqual({ action: "decline" });
    expect(elicitationResponseForCard(request, { status: "cancelled", result: { version: 1, answers: [], outcome: "withdrawn" } })).toEqual({ action: "cancel" });
    expect(elicitationResponseForCard(request, { status: "expired", result: null })).toEqual({ action: "cancel" });
  });

  it("reads a card saved before typed fields (an MCP Task waiting across the upgrade)", () => {
    const request = { message: "m", requestedSchema: { type: "object", properties: {
      workspace: { enum: ["ops", "engineering"] }, page: { type: "boolean" }, count: { type: "integer" },
    } } };
    const payload = { version: 1, questions: [
      { id: "workspace", prompt: "workspace", selectionMode: "single", options: [{ id: "ops", label: "ops" }, { id: "engineering", label: "engineering" }] },
      { id: "page", prompt: "page", selectionMode: "single", options: [{ id: "answer", label: "Provide answer" }] },
      { id: "count", prompt: "count", selectionMode: "single", options: [{ id: "answer", label: "Provide answer" }] },
    ] };
    const result = { version: 1, answers: [
      { questionId: "workspace", optionIds: ["engineering"] },
      { questionId: "page", optionIds: [], otherText: "yes" },
      { questionId: "count", optionIds: [], otherText: "4" },
    ] };
    expect(elicitationResponseForCard(request, { status: "answered", result, payload }))
      .toEqual({ action: "accept", content: { workspace: "engineering", page: true, count: 4 } });
  });

  it("refuses forms that ask for secrets, and shapes outside the spec", () => {
    expect(elicitationSensitiveFields({ properties: { password: { type: "string" } } })).toEqual(["password"]);
    expect(elicitationSensitiveFields({ properties: { key: { type: "string", title: "Your API key" } } })).toEqual(["key"]);
    expect(elicitationSensitiveFields({ properties: { code: { type: "string", description: "The one-time code we texted you" } } })).toEqual(["code"]);
    expect(elicitationSensitiveFields({ properties: { x: { type: "string", format: "password" } } })).toEqual(["x"]);
    expect(elicitationSensitiveFields({ properties: { name: { type: "string" }, max_tokens: { type: "integer" } } })).toEqual([]);
    const ask = (requestedSchema: Record<string, unknown>) => buildElicitationQuestionSet({ appName: "App", request: { message: "m", requestedSchema } });
    expect(ask({ properties: { card_number: { type: "string" } } })).toEqual({ ok: false, reason: "sensitive", fields: ["card_number"] });
    // The message itself asking for a secret is refused, whatever the field is called.
    expect(buildElicitationQuestionSet({ appName: "App", request: { message: "Type your account password in the notes field", requestedSchema: { properties: { notes: { type: "string" } } } } }))
      .toEqual({ ok: false, reason: "sensitive", fields: ["message"] });
    expect(buildElicitationQuestionSet({ appName: "App", request: { message: "How many tokens should the summary use?", requestedSchema: { properties: { n: { type: "integer" } } } } }).ok).toBe(true);
    expect(ask({ properties: { nested: { type: "object", properties: {} } } })).toEqual({ ok: false, reason: "unsupported" });
    expect(ask({ properties: { list: { type: "array", items: { type: "string" } } } })).toEqual({ ok: false, reason: "unsupported" });
    expect(ask({ properties: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`f${index}`, { type: "string" }])) })).toEqual({ ok: false, reason: "unsupported" });
  });

  it("keeps provider text plain: no clickable links, no markup", () => {
    const built = buildElicitationQuestionSet({ appName: "App", request: { message: "Open [this](https://evil.example.com) or <b>https://x.example.com</b>", requestedSchema: { properties: {} } } });
    expect(built.ok && built.questionSet.description).toBe("Open [this] (https:​//evil.example.com) or bhttps:​//x.example.com/b");
  });

  it("seals the server's state to the company and connection that received it", () => {
    const scope = { companyId: "c1", connectionId: "k1" };
    const sealed = sealElicitationState("secret", scope, "opaque-state");
    expect(sealed).not.toContain("opaque-state");
    expect(openElicitationState("secret", scope, sealed)).toBe("opaque-state");
    expect(openElicitationState("secret", { ...scope, companyId: "c2" }, sealed)).toBeNull();
    expect(openElicitationState("other", scope, sealed)).toBeNull();
  });

  it("identifies a question by its words and schema, not key order", () => {
    expect(elicitationQuestionHash({ message: "m", requestedSchema: { a: 1, b: { c: 2, d: 3 } } }))
      .toBe(elicitationQuestionHash({ message: "m", requestedSchema: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(elicitationQuestionHash({ message: "m", requestedSchema: {} })).not.toBe(elicitationQuestionHash({ message: "n", requestedSchema: {} }));
  });

  it("declares form questions only where a person can answer them", () => {
    expect(mcpClientCapabilities(MCP_MODERN_PROTOCOL_VERSION).elicitation).toEqual({ url: {} });
    expect(mcpClientCapabilities(MCP_MODERN_PROTOCOL_VERSION, { elicitationForm: true }).elicitation).toEqual({ form: {}, url: {} });
    expect(mcpClientCapabilities("2025-11-25", { elicitationForm: true }).elicitation).toEqual({ form: {}, url: {} });
    expect(mcpClientCapabilities("2025-06-18", { elicitationForm: true }).elicitation).toEqual({});
    expect(mcpClientCapabilities("2025-03-26", { elicitationForm: true })).not.toHaveProperty("elicitation");
    // Older stdio sessions keep what they had.
    expect(mcpClientCapabilities("2025-11-25")).not.toHaveProperty("elicitation");
    const body = JSON.parse(mcpHttpRequestInit({ "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION }, { id: 1, method: "tools/call", params: { name: "x" } }, { elicitationForm: true }).body);
    expect(body.params._meta[META_CAPABILITIES].elicitation).toEqual({ form: {}, url: {} });
  });

  it("shows the link first when a round mixes a link and a form, and never claims consent", () => {
    const mixed = mcpInputRequiredPending(mcpInputRequired({ resultType: "input_required", requestState: "s", inputRequests: {
      consent: { method: "elicitation/create", params: { mode: "url", message: "Approve", url: "https://auth.example.com/consent" } },
      name: { method: "elicitation/create", params: { message: "Name?", requestedSchema: { type: "object", properties: {} } } },
    } })!);
    expect(mixed).toMatchObject({ answerable: true, upstreamPending: { links: [{ url: "https://auth.example.com/consent" }] } });
    expect(mixed).not.toHaveProperty("retryState");
  });
});

type Recorded = { method: string; headers: Headers; body: Record<string, any> };

/** A stateless (2026-07-28) server whose tools ask the person questions. */
function askingServer() {
  const requests: Recorded[] = [];
  let refuseAnswers = 0;
  const respond = (id: unknown, result: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
  const form = (message: string, requestedSchema: Record<string, unknown>) => ({ method: "elicitation/create", params: { mode: "form", message, requestedSchema } });
  const handle = async (_url: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init.body));
    requests.push({ method: body.method, headers: new Headers(init.headers), body });
    if (body.params?._meta?.[META_VERSION] !== MCP_MODERN_PROTOCOL_VERSION) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "metadata" } }, { status: 400 });
    if (body.method === "server/discover") return respond(body.id, { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION], capabilities: { tools: {} } });
    if (body.method === "tools/list") {
      return respond(body.id, { tools: ["create_ticket", "two_questions", "ask_secret", "two_rounds"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } })) });
    }
    if (body.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
    const { name, inputResponses, requestState } = body.params;
    if (inputResponses && refuseAnswers > 0) { refuseAnswers -= 1; return new Response(null, { status: 503 }); }
    if (name === "two_rounds" && inputResponses?.first) {
      return respond(body.id, { resultType: "input_required", requestState: "round-2", inputRequests: { second: form("And the due date?", { type: "object", properties: { due: { type: "string", format: "date" } }, required: ["due"] }) } });
    }
    if (name === "two_rounds" && !inputResponses) {
      return respond(body.id, { resultType: "input_required", requestState: "round-1", inputRequests: { first: form("Which team?", { type: "object", properties: { team: { type: "string", enum: ["ops", "eng"] } }, required: ["team"] }) } });
    }
    if (inputResponses) return respond(body.id, { content: [{ type: "text", text: JSON.stringify({ inputResponses, requestState: requestState ?? null }) }] });
    if (name === "create_ticket") {
      return respond(body.id, { resultType: "input_required", requestState: `state-for-${body.params.arguments?.ref ?? "none"}`, inputRequests: { details: form("Tell us about the ticket", TICKET_SCHEMA) } });
    }
    if (name === "two_questions") {
      return respond(body.id, { resultType: "input_required", requestState: "two-state", inputRequests: {
        who: form("Who should own it?", { type: "object", properties: { owner: { type: "string", title: "Owner" } }, required: ["owner"] }),
        go: form("Ship it now?", { type: "object", properties: {} }),
      } });
    }
    return respond(body.id, { resultType: "input_required", inputRequests: { secret: form("Sign in", { type: "object", properties: { password: { type: "string" } } }) } });
  };
  return { requests, handle, calls: () => requests.filter((request) => request.method === "tools/call"), refuseNextAnswer: () => { refuseAnswers = 1; } };
}

/**
 * A 2025-06-18 server with a session that asks over the open tools/call stream
 * and waits for the client's reply before it finishes, like the SDK servers.
 * It asks its questions in turn and stops at the first one not accepted.
 */
function legacyAskingServer(options: { questions?: Array<{ message: string; key: string; values: string[]; askAgainIf?: string }>; refuseReplies?: number } = {}) {
  const requests: Recorded[] = [];
  const replies: Array<Record<string, any>> = [];
  const questions = options.questions ?? [{ message: "Which team?", key: "team", values: ["ops", "eng"] }];
  let refuseReplies = options.refuseReplies ?? 0;
  let sessions = 0;
  let asks = 0;
  const waiting = new Map<string, (reply: Record<string, any>) => void>();
  const sse = (message: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
  const handle = async (_url: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? "GET").toUpperCase() !== "POST") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({ method: body.method ?? "(reply)", headers, body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } } },
        { headers: { "Mcp-Session-Id": `legacy-${++sessions}` } });
    }
    if (!headers.get("mcp-session-id")) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, { status: 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (!body.method && body.id) {
      if (refuseReplies > 0) { refuseReplies -= 1; return new Response(null, { status: 500 }); }
      replies.push(body);
      waiting.get(String(body.id))?.(body);
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "create_ticket", description: "x", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
    if (body.method === "tools/call") {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const answers: unknown[] = [];
          for (const question of questions) {
            const askId = `ask-${++asks}`;
            const reply = new Promise<Record<string, any>>((resolve) => waiting.set(askId, resolve));
            controller.enqueue(sse({ jsonrpc: "2.0", id: askId, method: "elicitation/create", params: { message: question.message,
              requestedSchema: { type: "object", properties: { [question.key]: { type: "string", enum: question.values } }, required: [question.key] } } }));
            let answer = await reply;
            if (answer.result?.action !== "accept") { controller.close(); return; }
            // The app asks the same question again to have the answer corrected.
            if (question.askAgainIf !== undefined && answer.result.content?.[question.key] === question.askAgainIf) {
              const againId = `ask-${++asks}`;
              const again = new Promise<Record<string, any>>((resolve) => waiting.set(againId, resolve));
              controller.enqueue(sse({ jsonrpc: "2.0", id: againId, method: "elicitation/create", params: { message: question.message,
                requestedSchema: { type: "object", properties: { [question.key]: { type: "string", enum: question.values } }, required: [question.key] } } }));
              answer = await again;
              if (answer.result?.action !== "accept") { controller.close(); return; }
            }
            answers.push(answer.result);
          }
          const text = answers.length === 1 ? `answer: ${JSON.stringify(answers[0])}` : `answers: ${JSON.stringify(answers)}`;
          controller.enqueue(sse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } }));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  };
  return { requests, replies, handle, calls: () => requests.filter((request) => request.method === "tools/call"), refuseNextReply: () => { refuseReplies = 1; } };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("MCP form elicitation end to end", () => {
  const actor = { actorType: "user" as const, actorId: "mcp-elicitation-user", actorSource: "local_implicit" as const };
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "mcp-elicitation-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("mcp-elicitation-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function setup(handle: (url: string, init: RequestInit) => Promise<Response>, input: { askFirst?: string[] } = {}) {
    const [org] = await db.insert(companies).values({ name: `Elicit ${randomUUID()}`, issuePrefix: `E${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: org!.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: org!.id, name: "Ticket agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const [project] = await db.insert(projects).values({ companyId: org!.id, name: "Tickets" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: org!.id, projectId: project!.id, title: "File the bug", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: org!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id, projectId: project!.id } }).returning();
    const options = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }], remoteHttpRequest: handle };
    const service = toolAccessService(db, options);
    const connected = await service.connectGalleryApp(org!.id, { link: `https://ask-${randomUUID().slice(0, 8)}.example.com/mcp`, name: "Tracker" }, actor);
    await service.finishGalleryAppConnection(org!.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id),
      askFirstCatalogEntryIds: connected.catalog.filter((entry) => input.askFirst?.includes(entry.toolName)).map((entry) => entry.id), access: "all_agents",
    }, actor);
    const gatewayOptions = { ...options, toolActionSigningSecret: "elicitation-signing-key" };
    let gateway = createToolGatewayService(db, gatewayOptions);
    let session = await gateway.createSession({ companyId: org!.id, agentId: agent!.id, runId: run!.id });
    const names = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    const toolName = (name: string) => names.find((candidate) => candidate.endsWith(`:${name.replace(/_/g, "-")}`))!;
    const call = (name: string, parameters: Record<string, unknown> = { ref: "main" }, extra: { idempotencyKey?: string; tenant?: string } = {}) =>
      gateway.executeTool({ sessionToken: session.token, tool: toolName(name), parameters, timeoutMs: 5_000,
        idempotencyKey: extra.idempotencyKey, ...(extra.tenant ? { callerHeaders: { "x-tenant-id": extra.tenant } } : {}) });
    const cards = () => db.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, org!.id), eq(issueThreadInteractions.issueId, issue!.id)))
      .orderBy(issueThreadInteractions.createdAt);
    const interactions = issueThreadInteractionService(db);
    const answer = (cardId: string, answers: Array<{ questionId: string; optionIds: string[]; otherText?: string }>) =>
      interactions.answerQuestions({ id: issue!.id, companyId: org!.id }, cardId, { answers }, { userId: actor.actorId });
    const skip = (cardId: string) => interactions.skipInteraction({ id: issue!.id, companyId: org!.id }, cardId, {}, { userId: actor.actorId });
    const rounds = () => db.select().from(toolMcpElicitations).where(eq(toolMcpElicitations.companyId, org!.id));
    return {
      org: org!, agent: agent!, issue: issue!, run: run!, connected, call, cards, answer, skip, rounds, interactions,
      gateway: () => gateway,
      /** A call from another run of the agent on the same task, with its own session. */
      callerInAnotherRun: async () => {
        const [other] = await db.insert(heartbeatRuns).values({ companyId: org!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } }).returning();
        const otherSession = await gateway.createSession({ companyId: org!.id, agentId: agent!.id, runId: other!.id });
        return (name: string, parameters: Record<string, unknown>) =>
          gateway.executeTool({ sessionToken: otherSession.token, tool: toolName(name), parameters, timeoutMs: 5_000 });
      },
      /** The agent's next run on the task (a woken agent). */
      nextRun: async () => {
        const [next] = await db.insert(heartbeatRuns).values({ companyId: org!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } }).returning();
        session = await gateway.createSession({ companyId: org!.id, agentId: agent!.id, runId: next!.id });
      },
      /** A new process: only the database survives. */
      restart: async () => {
        forgetMcpHttpSessions(connected.connectionId);
        gateway = createToolGatewayService(db, gatewayOptions);
        session = await gateway.createSession({ companyId: org!.id, agentId: agent!.id, runId: run!.id });
      },
    };
  }

  it("puts a stateless server's form on a human-only card and sends the answer with the exact state on the repeated call", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    const first = await ctx.call("create_ticket").catch((error) => error);
    expect(first).toMatchObject({ reasonCode: "elicitation_required", message: expect.stringContaining("Tracker asked a question") });
    expect(server.calls()[0]!.body.params._meta[META_CAPABILITIES].elicitation).toEqual({ form: {}, url: {} });
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ kind: "ask_user_questions", status: "pending", title: "Tracker needs your input", requestedResolverPolicy: "human_only" });
    expect(card!.payload).toMatchObject({ questionSet: { description: "Tell us about the ticket", submitLabel: "Send to Tracker" } });
    const [round] = await ctx.rounds();
    expect(round).toMatchObject({ status: "waiting", era: "modern", issueId: ctx.issue.id });
    // The server's state is never stored readable.
    expect(round!.sealedRequestState).not.toContain("state-for-main");
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, round!.invocationId));
    expect(invocation).toMatchObject({ status: "awaiting_approval", errorCode: "elicitation_required" });

    // Repeating before anyone answers waits again and never reaches the app.
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(server.calls()).toHaveLength(1);

    // An agent can't answer its own tool's question.
    await expect(ctx.interactions.answerQuestions({ id: ctx.issue.id, companyId: ctx.org.id }, card!.id,
      { answers: [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Nope" }] }, { agentId: ctx.agent.id, runId: ctx.run.id }))
      .rejects.toBeTruthy();

    await ctx.answer(card!.id, [
      { questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Login broken" },
      { questionId: "priority", optionIds: ["choice_1"] },
      { questionId: "labels", optionIds: ["choice_2"] },
      { questionId: "count", optionIds: ["paperclip_text_answer"], otherText: "2" },
    ]);
    const done = await ctx.call("create_ticket");
    expect(done).toMatchObject({ status: "completed" });
    const retried = server.calls()[1]!;
    expect(retried.body.id).not.toBe(server.calls()[0]!.body.id);
    expect(retried.body.params.requestState).toBe("state-for-main");
    expect(retried.body.params.inputResponses).toEqual({ details: { action: "accept", content: { title: "Login broken", priority: "p1", labels: ["ux"], count: 2 } } });
    expect((await ctx.rounds())[0]).toMatchObject({ status: "sent" });
    // Sent once: the same call in a later run is a fresh call.
    await ctx.nextRun();
    await ctx.call("create_ticket").catch(() => undefined);
    expect(server.calls()[2]!.body.params).not.toHaveProperty("inputResponses");
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, ctx.org.id), eq(activityLog.action, "tool_gateway.elicitation_sent")));
    expect(logged).toHaveLength(1);
    // Which kind of answer went back, never the words.
    expect(JSON.stringify(logged[0]!.details)).not.toContain("Login broken");
    expect(logged[0]!.details).toMatchObject({ responses: ["accept"] });
  });

  it("sends decline when the person skips, and survives a restart while waiting", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "skip" }).catch(() => undefined);
    const [card] = await ctx.cards();
    await ctx.restart();
    await ctx.skip(card!.id);
    await ctx.call("create_ticket", { ref: "skip" });
    expect(server.calls()[1]!.body.params).toMatchObject({ requestState: "state-for-skip", inputResponses: { details: { action: "decline" } } });
  });

  it("asks two questions at once and sends both answers in one repeated call", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    expect(await ctx.call("two_questions").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required", details: { interactionIds: [expect.any(String), expect.any(String)] } });
    const [owner, go] = await ctx.cards();
    await ctx.answer(owner!.id, [{ questionId: "owner", optionIds: ["paperclip_text_answer"], otherText: "Ada" }]);
    // One answered, one still waiting: no send.
    expect(await ctx.call("two_questions").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(server.calls()).toHaveLength(1);
    await ctx.interactions.withdrawInteraction({ id: ctx.issue.id, companyId: ctx.org.id }, go!.id, {}, { userId: actor.actorId }).catch(async () => {
      await db.update(issueThreadInteractions).set({ status: "cancelled", result: { version: 1, answers: [], outcome: "withdrawn" } }).where(eq(issueThreadInteractions.id, go!.id));
    });
    await ctx.call("two_questions");
    expect(server.calls()[1]!.body.params).toMatchObject({
      requestState: "two-state",
      inputResponses: { who: { action: "accept", content: { owner: "Ada" } }, go: { action: "cancel" } },
    });
  });

  it("refuses a form asking for a password: no card, a clear reason for the agent", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    expect(await ctx.call("ask_secret").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_sensitive_refused", message: expect.stringContaining("secure link") });
    expect(await ctx.cards()).toHaveLength(0);
    expect(await ctx.rounds()).toHaveLength(0);
  });

  it("reclaims a send interrupted by a crash, and never lets another company collect the round", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "crash" }).catch(() => undefined);
    const [card] = await ctx.cards();
    await ctx.answer(card!.id, [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "After crash" }, { questionId: "priority", optionIds: ["choice_2"] }]);
    // A process died mid-send: the claim is held but its time has passed.
    const [round] = await ctx.rounds();
    await db.update(toolMcpElicitations).set({ claimedUntil: new Date(Date.now() - 1_000) }).where(eq(toolMcpElicitations.id, round!.id));
    // Another company with the same app and arguments starts its own call.
    const other = await setup(server.handle);
    await other.call("create_ticket", { ref: "crash" }).catch(() => undefined);
    expect(server.calls().at(-1)!.body.params).not.toHaveProperty("inputResponses");
    await ctx.restart();
    await ctx.call("create_ticket", { ref: "crash" });
    expect(server.calls().at(-1)!.body.params).toMatchObject({ requestState: "state-for-crash", inputResponses: { details: { action: "accept", content: { title: "After crash", priority: "p2" } } } });
  });

  it("withdraws an expired round's card and starts the call over", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "late" }).catch(() => undefined);
    await db.update(toolMcpElicitations).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(toolMcpElicitations.companyId, ctx.org.id));
    expect(await ctx.call("create_ticket", { ref: "late" }).catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(server.calls()[1]!.body.params).not.toHaveProperty("inputResponses");
    const [stale, fresh] = await ctx.cards();
    expect(stale!.status).not.toBe("pending");
    expect(fresh!.status).toBe("pending");
    expect((await ctx.rounds()).map((round) => round.status).sort()).toEqual(["expired", "waiting"]);
  });

  it("answers an older server's question: cancel at once the first time, then the person's answer on the repeated call", async () => {
    const server = legacyAskingServer();
    const ctx = await setup(server.handle);
    // The listing session only reads: it declares no questions.
    expect(server.requests.find((request) => request.method === "initialize")!.body.params.capabilities).not.toHaveProperty("elicitation");
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    // The tool call's own session asked for 2025-11-25, which knows form and URL questions.
    const initialize = server.requests.filter((request) => request.method === "initialize").at(-1)!;
    expect(initialize.body.params.capabilities.elicitation).toEqual({ form: {}, url: {} });
    // The server was never left waiting.
    expect(server.replies.map((reply) => reply.result)).toEqual([{ action: "cancel" }]);
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ title: "Tracker needs your input", requestedResolverPolicy: "human_only" });
    await ctx.answer(card!.id, [{ questionId: "team", optionIds: ["choice_2"] }]);
    const done = await ctx.call("create_ticket");
    expect(done).toMatchObject({ status: "completed", result: { content: 'answer: {"action":"accept","content":{"team":"eng"}}' } });
    expect(server.replies.map((reply) => reply.result)).toEqual([{ action: "cancel" }, { action: "accept", content: { team: "eng" } }]);
    expect((await ctx.rounds())[0]).toMatchObject({ era: "legacy", status: "sent" });
    // Spent: the same call in a later run asks again.
    await ctx.nextRun();
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(await ctx.cards()).toHaveLength(2);
  });

  it("never lets one forwarded tenant collect another tenant's answers", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, ctx.connected.connectionId));
    await db.update(toolConnections).set({ config: { ...connection!.config, headerPolicy: { passthrough: { allow: ["x-tenant-id"] } } } })
      .where(eq(toolConnections.id, ctx.connected.connectionId));
    await ctx.call("create_ticket", { ref: "t" }, { tenant: "acme" }).catch(() => undefined);
    const [card] = await ctx.cards();
    await ctx.answer(card!.id, [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Acme only" }, { questionId: "priority", optionIds: ["choice_1"] }]);
    await ctx.call("create_ticket", { ref: "t" }, { tenant: "globex" }).catch(() => undefined);
    const globex = server.calls().at(-1)!;
    expect(globex.headers.get("x-tenant-id")).toBe("globex");
    expect(globex.body.params).not.toHaveProperty("inputResponses");
    await ctx.call("create_ticket", { ref: "t" }, { tenant: "acme" });
    const acme = server.calls().at(-1)!;
    expect(acme.headers.get("x-tenant-id")).toBe("acme");
    expect(acme.body.params.inputResponses).toMatchObject({ details: { action: "accept", content: { title: "Acme only" } } });
  });

  it("makes a missing card again under the same key when the process stopped before showing it", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "lost" }).catch(() => undefined);
    const [round] = await ctx.rounds();
    // The round was saved, but its card never reached the task.
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, ctx.issue.id));
    expect(await ctx.call("create_ticket", { ref: "lost" }).catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    expect(server.calls()).toHaveLength(1);
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ idempotencyKey: round!.questions[0]!.cardKey, status: "pending" });
    await ctx.answer(card!.id, [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Recovered" }, { questionId: "priority", optionIds: ["choice_2"] }]);
    await ctx.call("create_ticket", { ref: "lost" });
    expect(server.calls()[1]!.body.params.inputResponses).toMatchObject({ details: { action: "accept", content: { title: "Recovered" } } });
  });

  it("runs a keyed retry again only for the same request", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "a" }, { idempotencyKey: "ticket-key" }).catch(() => undefined);
    const other = await ctx.call("create_ticket", { ref: "b" }, { idempotencyKey: "ticket-key" }).catch((error) => error);
    expect(other).not.toMatchObject({ status: "completed" });
    expect(server.calls()).toHaveLength(1);
    expect((await ctx.rounds())[0]).toMatchObject({ status: "waiting" });
  });

  it("keeps an older server's answer when the server refuses the reply", async () => {
    const server = legacyAskingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket").catch(() => undefined);
    const [card] = await ctx.cards();
    await ctx.answer(card!.id, [{ questionId: "team", optionIds: ["choice_1"] }]);
    server.refuseNextReply();
    await ctx.nextRun();
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "mcp_remote_status" });
    // Not spent and not held: the next call sends it again.
    expect((await ctx.rounds())[0]).toMatchObject({ status: "waiting", claimedUntil: null });
    await ctx.nextRun();
    expect(await ctx.call("create_ticket")).toMatchObject({ status: "completed", result: { content: 'answer: {"action":"accept","content":{"team":"ops"}}' } });
    expect((await ctx.rounds())[0]).toMatchObject({ status: "sent" });
  });

  it("keeps an older server's earlier answers until the whole call finishes", async () => {
    const server = legacyAskingServer({ questions: [
      { message: "Which team?", key: "team", values: ["ops", "eng"] },
      { message: "Which size?", key: "size", values: ["s", "m"] },
    ] });
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket").catch(() => undefined);
    const [teamCard] = await ctx.cards();
    await ctx.answer(teamCard!.id, [{ questionId: "team", optionIds: ["choice_2"] }]);
    await ctx.nextRun();
    // The team answer goes back, then the app asks its second question.
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    const [, sizeCard] = await ctx.cards();
    await ctx.answer(sizeCard!.id, [{ questionId: "size", optionIds: ["choice_1"] }]);
    await ctx.nextRun();
    const done = await ctx.call("create_ticket");
    expect(done).toMatchObject({ status: "completed", result: { content: 'answers: [{"action":"accept","content":{"team":"eng"}},{"action":"accept","content":{"size":"s"}}]' } });
    // Nobody was asked the first question twice.
    expect(await ctx.cards()).toHaveLength(2);
    expect((await ctx.rounds()).map((round) => round.status)).toEqual(["sent", "sent"]);
  });

  it("sends the answer again in the same run after the app failed to take it", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "flaky" }).catch(() => undefined);
    const [card] = await ctx.cards();
    await ctx.answer(card!.id, [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Second try" }, { questionId: "priority", optionIds: ["choice_1"] }]);
    server.refuseNextAnswer();
    expect(await ctx.call("create_ticket", { ref: "flaky" }).catch((error) => error)).toMatchObject({ reasonCode: "mcp_remote_status" });
    // Same run, same request: not a replay of the failure; the answer goes out again.
    expect(await ctx.call("create_ticket", { ref: "flaky" })).toMatchObject({ status: "completed" });
    expect(server.calls()).toHaveLength(3);
    expect(server.calls()[2]!.body.params.inputResponses).toMatchObject({ details: { action: "accept", content: { title: "Second try" } } });
    expect((await ctx.rounds())[0]).toMatchObject({ status: "sent" });
  });

  it("shows one card when two matching calls ask at the same time", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    const first = await ctx.callerInAnotherRun();
    const second = await ctx.callerInAnotherRun();
    const results = await Promise.all([
      first("create_ticket", { ref: "race" }).catch((error) => error),
      second("create_ticket", { ref: "race" }).catch((error) => error),
    ]);
    for (const result of results) expect(result).toMatchObject({ reasonCode: "elicitation_required" });
    expect(await ctx.cards()).toHaveLength(1);
    expect((await ctx.rounds()).filter((round) => round.status === "waiting")).toHaveLength(1);
  });

  it("continues a stateless app's follow-up question after the first answer", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("two_rounds").catch(() => undefined);
    const [first] = await ctx.cards();
    await ctx.answer(first!.id, [{ questionId: "team", optionIds: ["choice_2"] }]);
    expect(await ctx.call("two_rounds").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    // The first round is spent and the follow-up is saved; nothing is lost between them.
    expect((await ctx.rounds()).map((round) => round.status).sort()).toEqual(["sent", "waiting"]);
    const [, second] = await ctx.cards();
    await ctx.answer(second!.id, [{ questionId: "due", optionIds: ["paperclip_text_answer"], otherText: "2026-12-01" }]);
    await ctx.call("two_rounds");
    expect(server.calls().at(-1)!.body.params).toMatchObject({ requestState: "round-2", inputResponses: { second: { action: "accept", content: { due: "2026-12-01" } } } });
  });

  it("asks again on a fresh card when an older app repeats a question to correct the answer", async () => {
    const server = legacyAskingServer({ questions: [{ message: "Which team?", key: "team", values: ["ops", "eng"], askAgainIf: "ops" }] });
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket").catch(() => undefined);
    const [first] = await ctx.cards();
    await ctx.answer(first!.id, [{ questionId: "team", optionIds: ["choice_1"] }]);
    await ctx.nextRun();
    // The app takes "ops", then asks again: a second card, not a stall.
    expect(await ctx.call("create_ticket").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    const cards = await ctx.cards();
    expect(cards).toHaveLength(2);
    await ctx.answer(cards[1]!.id, [{ questionId: "team", optionIds: ["choice_2"] }]);
    await ctx.nextRun();
    expect(await ctx.call("create_ticket")).toMatchObject({ status: "completed", result: { content: 'answer: {"action":"accept","content":{"team":"eng"}}' } });
  });

  it("advances to a follow-up question even when the task is at its open-question limit", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("two_rounds").catch(() => undefined);
    const [round] = await ctx.rounds();
    // Nine other questions are waiting on the task: ten in all, the limit.
    await db.insert(toolMcpElicitations).values(Array.from({ length: 9 }, (_, index) => ({
      ...round!, id: randomUUID(), callIdentity: `other-call-${index}`, dedupeKey: `other-${index}`, createdAt: new Date(), updatedAt: new Date(),
    })));
    const [first] = await ctx.cards();
    await ctx.answer(first!.id, [{ questionId: "team", optionIds: ["choice_1"] }]);
    expect(await ctx.call("two_rounds").catch((error) => error)).toMatchObject({ reasonCode: "elicitation_required" });
    // The answered round made room for its own follow-up.
    expect(await ctx.cards()).toHaveLength(2);
    expect((await ctx.rounds()).filter((row) => row.status === "waiting")).toHaveLength(10);
  });

  it("keeps an approved action's approval while its question waits, and sends the answer without asking again", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle, { askFirst: ["create_ticket"] });
    await expect(ctx.call("create_ticket", { ref: "approved" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, ctx.org.id));
    if (pending!.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, pending!.approvalId));
    // The approved execution reaches the app, which asks a question.
    await ctx.gateway().approveActionRequest({ companyId: ctx.org.id, actionRequestId: pending!.id, actor: { userId: actor.actorId } }).catch((error) => error);
    expect(server.calls()).toHaveLength(1);
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending!.id));
    expect(request).toMatchObject({ status: "approved" });
    const card = (await ctx.cards()).find((candidate) => candidate.kind === "ask_user_questions")!;
    await ctx.answer(card.id, [{ questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Approved and answered" }, { questionId: "priority", optionIds: ["choice_1"] }]);
    // The repeated call continues the approved action: no second approval, the answer goes out.
    // An approved action's continuation is reported with its result (status "replayed").
    const done = await ctx.call("create_ticket", { ref: "approved" });
    expect(JSON.stringify(done.result)).toContain("Approved and answered");
    expect(server.calls()).toHaveLength(2);
    expect(server.calls()[1]!.body.params.inputResponses).toMatchObject({ details: { action: "accept", content: { title: "Approved and answered" } } });
  });

  it("marks an app's question card so skipping it wakes the agent (route test: issue-thread-interaction-routes)", async () => {
    const server = askingServer();
    const ctx = await setup(server.handle);
    await ctx.call("create_ticket", { ref: "skip-wake" }).catch(() => undefined);
    const [card] = await ctx.cards();
    const { isAppQuestionCardKey } = await import("../services/mcp-elicitation.js");
    expect(isAppQuestionCardKey(card!.idempotencyKey)).toBe(true);
  });
});
