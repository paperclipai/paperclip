import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, authUsers, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { documentService } from "../services/documents.js";
import { resolveConfirmationFromComment } from "../services/confirmation-comment-resolution.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { issueService } from "../services/issues.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";

async function nativeProposalRecipe(kind: "confirmation" | "checkbox", planRevisionId = randomUUID()) {
  const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
  const recipes = [...skill.matchAll(/^ {0,3}```json\n([\s\S]*?)^ {0,3}```/gm)].map(match => JSON.parse(match[1]!) as Record<string, unknown>);
  const matches = recipes.filter(recipe => recipe.interactionKind === kind);
  expect(matches, `one executable native ${kind} recipe must ship with the first-task skill`).toHaveLength(1);
  return JSON.parse(JSON.stringify(matches[0]).replaceAll("<child-title>", "Approved child")
    .replaceAll("<plan-revision-id>", planRevisionId)) as Record<string, unknown>;
}

it.each(["confirmation", "checkbox"] as const)("ships a native %s recipe accepted by the production interaction schema", async kind => {
  const recipe = await nativeProposalRecipe(kind);
  const schema = CAPABILITY_SEMANTIC_TOOL_CATALOG.find(tool => tool.operationId === "request_human_input")!.inputSchema;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  expect(validator.validate(schema, recipe), JSON.stringify(validator.errors)).toBe(true);
  expect(recipe).not.toHaveProperty("version");
  expect(recipe).not.toHaveProperty("supersedeOnUserComment");
  expect(recipe.payload).toMatchObject({ version: 1, supersedeOnUserComment: false });
  const parsed = createIssueThreadInteractionSchema.parse({ kind: kind === "confirmation" ? "request_confirmation" : "request_checkbox_confirmation",
    idempotencyKey: recipe.idempotencyKey, title: recipe.title, continuationPolicy: recipe.continuationPolicy,
    payload: { ...(recipe.payload as Record<string, unknown>), version: 1, prompt: recipe.prompt } });
  expect(parsed.kind).toBe(kind === "confirmation" ? "request_confirmation" : "request_checkbox_confirmation");
});

if (!support.supported) console.warn(`Skipping first-task admission database tests: ${support.reason}`);
describe.skipIf(!support.supported)("onboarding first-task execution admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const fixture = async () => {
    const f = await server.fixture({ disableWakeOnDemand: true, connectionScenario: "fresh" });
    await server.db.update(issues).set({ originKind: "onboarding_first_task" }).where(eq(issues.id, f.issueId));
    return f;
  };

  it("rejects native child creation before persisted human proposal acceptance", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    await expect(authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Execute proposed work", idempotencyKey: "before-acceptance", status: "todo",
    } })).rejects.toThrow(/proposal.*accept/i);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
    expect(wakes).toEqual([]);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
  });

  it.each(["root", "child"])("rejects generic %s creation including explicit standalone parent before acceptance", async path => {
    const f = await fixture();
    const before = await f.snapshot();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)!;
    const route = path === "root" ? `/api/companies/${f.companyId}/issues` : `/api/issues/${f.issueId}/children`;
    const response = await fetch(`${server.apiUrl}${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bypass proposal", parentId: null, assigneeAgentId: f.agentId, status: "todo" }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toMatch(/proposal.*accept/i);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
  });

  const create = (f: Awaited<ReturnType<typeof fixture>>, key = randomUUID()) => f.authority.execute({
    tool: "create_task", callId: randomUUID(), arguments: { title: "Approved execution", idempotencyKey: key, status: "backlog" },
  });
  const proposal = async (f: Awaited<ReturnType<typeof fixture>>, checkbox = false) => {
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    const plan = checkbox ? (await documentService(server.db).upsertIssueDocument({
      issueId: f.issueId, key: "plan", title: "First task plan", format: "markdown", body: "Create and verify the approved deliverable.",
      createdByAgentId: f.agentId, createdByRunId: f.runId,
    })).document : null;
    const svc = issueThreadInteractionService(server.db);
    const card = await svc.create(issue, checkbox ? {
      kind: "request_checkbox_confirmation", payload: { version: 1, prompt: "Approve this plan?",
        options: [{ id: "execute", label: "Execute the plan" }], defaultSelectedOptionIds: ["execute"], minSelected: 1,
        target: { type: "issue_document", key: "plan", issueId: f.issueId, documentId: plan!.id, revisionId: plan!.latestRevisionId! } },
    } : { kind: "request_confirmation", payload: { version: 1, prompt: "Create one task for the agreed deliverable?" } }, { agentId: f.agentId });
    return { issue, card, svc, plan };
  };
  const accept = async (f: Awaited<ReturnType<typeof fixture>>, p: Awaited<ReturnType<typeof proposal>>) => {
    await p.svc.acceptInteraction(p.issue, p.card.id, p.plan ? { selectedOptionIds: ["execute"] } : {}, { userId: f.responsibleUserId! });
  };

  it("rejects a first-task child blocked by its onboarding parent and permits a corrected retry", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const input = { title: "Approved artifact child", idempotencyKey: "first-task-handoff", status: "todo",
      blockedByTaskIds: [f.issueId] };
    const rejected = authority.execute({ tool: "create_task", callId: randomUUID(), arguments: input });
    await expect(rejected).rejects.toMatchObject({
      status: 400, details: { code: "onboarding_first_task_parent_blocker" },
    });
    await expect(rejected).rejects.toThrow(/Remove.*blockedByTaskIds.*set_dependencies/);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual(before.issueRelations);
    expect(after.activity).toEqual(before.activity);
    expect(after.issueDocuments).toEqual(before.issueDocuments);
    expect(wakes).toEqual([]);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);

    // A definite input error must not consume the command key or approval.
    const corrected = await authority.execute({ tool: "create_task", callId: randomUUID(),
      arguments: { ...input, blockedByTaskIds: [] } }) as { task: { id: string }; scheduledWakeIds: string[] };
    expect(corrected).toMatchObject({ task: { parentId: f.issueId, status: "todo", assigneeActorId: f.agentId } });
    expect(corrected.scheduledWakeIds).toEqual([`created-child:${corrected.task.id}`]);
    expect(wakes).toHaveLength(1);
  });

  it.each(["root", "child"])("rejects a backwards first-task dependency through generic %s creation", async path => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const before = await f.snapshot();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const route = path === "root" ? `/api/companies/${f.companyId}/issues` : `/api/issues/${f.issueId}/children`;
    const response = await fetch(`${server.apiUrl}${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Approved execution", parentId: null, assigneeAgentId: f.agentId,
        status: "todo", blockedByIssueIds: [f.issueId] }),
    });
    expect(response.status, JSON.stringify(await response.json())).toBe(400);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual(before.issueRelations);
    expect(after.activity).toEqual(before.activity);
  });

  it("preserves other first-task blockers and ordinary parent-blocked delegation", async () => {
    for (const onboarding of [true, false]) {
      const f = await fixture();
      if (onboarding) await accept(f, await proposal(f));
      else await server.db.update(issues).set({ originKind: "manual", description: "Ordinary task mentioning /first-task." }).where(eq(issues.id, f.issueId));
      const blockerId = onboarding ? f.blockerId : f.issueId;
      const wakes: unknown[] = [];
      const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
      const created = await authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
        title: "Work with a real prerequisite", idempotencyKey: "valid-blocker", status: "todo", blockedByTaskIds: [blockerId],
      } }) as { task: { id: string } };
      expect(created).toMatchObject({ task: { status: "blocked", parentId: f.issueId }, scheduledWakeIds: [] });
      expect((await f.snapshot()).issueRelations).toContainEqual(expect.objectContaining({
        issueId: blockerId, relatedIssueId: created.task.id, type: "blocks",
      }));
      expect(wakes).toEqual([]);
    }
  });

  it("executes the shipped handoff recipe with exact inputs and the child blocking its parent", async () => {
    const f = await fixture();
    const inputBytes = Buffer.from('{"nonce":"handoff-snowman-☃","values":[2,5,-1]}\n');
    const encodedInput = inputBytes.toString("base64");
    const description = `Decode this exact base64 into handoff-input.json, preserving its final newline:\n${encodedInput}\n`
      + "Write handoff-proof.json with the nonce, value count, total, and SHA-256 of the exact input bytes. "
      + "Save the proof document and register the file on this task. Do not create other tasks or access credentials.";
    const p = await proposal(f);
    await server.db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: description } })
      .where(eq(issueThreadInteractions.id, p.card.id));
    await accept(f, p);
    const skill = await readFile(new URL("../onboarding-assets/first-task/skills/first-task/SKILL.md", import.meta.url), "utf8");
    const recipe = [...skill.matchAll(/```json\s+([\s\S]*?)```/g)]
      .map(match => JSON.parse(match[1]!) as Record<string, Record<string, unknown>>)
      .find(value => value.createTask && value.setDependencies);
    if (!recipe) throw new Error("Missing shipped first-task handoff recipe");
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    await authority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: {
      idempotencyKey: "existing-prerequisite", blockedByTaskIds: [f.blockerId],
    } });
    const created = await authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      ...recipe.createTask, idempotencyKey: `first-task-child:${p.card.id}`,
      title: "Approved input proof", description, assigneeActorId: f.agentId,
    } }) as { task: { id: string } };
    expect(created).toMatchObject({ task: { status: "todo", parentId: f.issueId },
      scheduledWakeIds: [`created-child:${created.task.id}`] });
    expect(wakes).toHaveLength(1);
    await authority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: {
      ...recipe.setDependencies, idempotencyKey: `first-task-wait:${p.card.id}`,
      blockedByTaskIds: [f.blockerId, created.task.id],
    } });
    const relations = (await f.snapshot()).issueRelations;
    expect(relations).toHaveLength(2);
    for (const blocker of [f.blockerId, created.task.id]) expect(relations).toContainEqual(expect.objectContaining({
      issueId: blocker, relatedIssueId: f.issueId, type: "blocks",
    }));

    // Read under the child's own native execution binding, without a model call.
    const childRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: childRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: created.task.id,
      responsibleUserId: f.responsibleUserId, contextSnapshot: { issueId: created.task.id } });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: childRunId }).where(eq(issues.id, created.task.id));
    const childAuthority = new PaperclipRunnerToolAuthority(server.db, { ...f, issueId: created.task.id, runId: childRunId });
    const context = await childAuthority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} }) as {
      activeTask: { description: string };
    };
    expect(context.activeTask.description).toBe(description);
    const recoveredInput = Buffer.from(context.activeTask.description.split("\n")[1]!, "base64");
    expect(recoveredInput).toEqual(inputBytes);
  });

  it.each(["uppercase", "hyphenless", "braced"])("rejects a PostgreSQL-equivalent %s onboarding blocker UUID", async variant => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const sourceId = variant === "uppercase" ? f.issueId.toUpperCase()
      : variant === "hyphenless" ? f.issueId.replaceAll("-", "") : `{${f.issueId}}`;
    const before = await f.snapshot();
    await expect(f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Approved child", idempotencyKey: "equivalent-parent", status: "todo", blockedByTaskIds: [sourceId],
    } })).rejects.toMatchObject({ status: 400, details: { code: "onboarding_first_task_parent_blocker" } });
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual(before.issueRelations);
  });

  it("rejects adding the onboarding source blocker through a child PATCH", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const created = await f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Approved ready child", idempotencyKey: "ready-child", status: "todo",
    } }) as { task: { id: string } };
    const before = await f.snapshot();
    const beforeWakes = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${created.task.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked", blockedByIssueIds: [f.issueId.toUpperCase()] }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(body).toMatchObject({ details: { code: "onboarding_first_task_parent_blocker" } });
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual(before.issueRelations);
    const priorActivityIds = new Set(before.activity.map(row => row.id));
    expect(after.activity.filter(row => !priorActivityIds.has(row.id))).toEqual([expect.objectContaining({
      action: "issue.cross_issue_influence_observed", entityId: created.task.id, runId: f.runId,
      details: expect.objectContaining({ sourceIssueId: f.issueId, targetIssueId: created.task.id, kind: "update", allowed: true }),
    })]);
    expect(await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(beforeWakes);
  });

  const childExecution = async (onboarding = true) => {
    const f = await fixture();
    if (onboarding) await accept(f, await proposal(f));
    else await server.db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, f.issueId));
    const created = await f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Approved ready child", idempotencyKey: "own-execution-child", status: "todo",
    } }) as { task: { id: string } };
    // The parent is waiting, without a first-class dependency. This is not a
    // graph cycle: the forbidden parent -> child edge would be the only edge.
    await server.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, f.issueId));
    const childRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: childRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: created.task.id,
      responsibleUserId: f.responsibleUserId, contextSnapshot: { issueId: created.task.id } });
    await server.db.update(issues).set({ status: "in_progress", executionRunId: childRunId }).where(eq(issues.id, created.task.id));
    await initializeRunIdentity(server.db, { companyId: f.companyId, runId: childRunId, issueId: created.task.id,
      responsibleUserId: f.responsibleUserId, cause: "instruction" });
    const childAuthority = new PaperclipRunnerToolAuthority(server.db, { ...f, issueId: created.task.id, runId: childRunId });
    await issueService(server.db).checkout(created.task.id, f.agentId, ["in_progress"], childRunId);
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", childRunId, f.responsibleUserId)!;
    return { f, childId: created.task.id, childRunId, childAuthority, token };
  };

  it.each(["native", "REST"])("rejects the onboarding parent blocker from the child's own %s execution", async transport => {
    const { f, childId, childRunId, childAuthority, token } = await childExecution();
    const input = { idempotencyKey: "child-own-parent-blocker", blockedByTaskIds: [f.issueId.toUpperCase()] };
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, childRunId));
    const beforeWakes = await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    if (transport === "native") {
      await expect(childAuthority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: input })).rejects.toMatchObject({
        status: 400, details: { code: "onboarding_first_task_parent_blocker" },
      });
    } else {
      const response = await fetch(`${server.apiUrl}/api/issues/${childId}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "blocked", blockedByIssueIds: input.blockedByTaskIds }),
      });
      expect(response.status, JSON.stringify(await response.json())).toBe(400);
    }
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual([]);
    expect(after.activity).toEqual(before.activity);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, childRunId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
    expect(await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(beforeWakes);
    // A definite input error leaves the key available and other blockers valid.
    for (const blockedByTaskIds of [[f.blockerId], []]) await expect(childAuthority.execute({ tool: "set_dependencies",
      callId: randomUUID(), arguments: { ...input, idempotencyKey: blockedByTaskIds.length ? input.idempotencyKey : randomUUID(), blockedByTaskIds },
    })).resolves.toMatchObject({ disposition: "applied" });
  });

  it.each(["native", "REST", "board"])("preserves ordinary parent blockers and explicit board edits (%s)", async actor => {
    const { f, childId, childAuthority, token } = await childExecution(actor === "board");
    if (actor === "native") {
      await expect(childAuthority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: {
        idempotencyKey: "ordinary-parent-blocker", blockedByTaskIds: [f.issueId],
      } })).resolves.toMatchObject({ disposition: "applied" });
    } else {
      const headers = actor === "board"
        ? { Cookie: await server.humanSession(f.responsibleUserId!), "Content-Type": "application/json", Origin: server.apiUrl }
        : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const response = await fetch(`${server.apiUrl}/api/issues/${childId}`, {
        method: "PATCH", headers, body: JSON.stringify({ blockedByIssueIds: [f.issueId] }),
      });
      expect(response.status, JSON.stringify(await response.json())).toBe(200);
    }
    expect((await f.snapshot()).issueRelations).toContainEqual(expect.objectContaining({
      issueId: f.issueId, relatedIssueId: childId, type: "blocks",
    }));
  });

  it("guards native dependency edits without consuming the retry key", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const input = { idempotencyKey: "native-parent-blocker", blockedByTaskIds: [f.issueId.toUpperCase()] };
    await expect(f.authority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: input })).rejects.toMatchObject({
      status: 400, details: { code: "onboarding_first_task_parent_blocker" },
    });
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.issueRelations).toEqual(before.issueRelations);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
    await expect(f.authority.execute({ tool: "set_dependencies", callId: randomUUID(), arguments: {
      ...input, blockedByTaskIds: [f.blockerId],
    } })).resolves.toMatchObject({ disposition: "applied" });
  });

  it("keeps blocker edits and clears independent of a newer first-task proposal", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const created = await f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Existing approved child", idempotencyKey: "approved-before-new-proposal", status: "todo",
    } }) as { task: { id: string } };
    await proposal(f);
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    for (const blockedByIssueIds of [[f.blockerId], []]) {
      const response = await fetch(`${server.apiUrl}/api/issues/${created.task.id}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ blockedByIssueIds }),
      });
      expect(response.status, JSON.stringify(await response.json())).toBe(200);
    }
    for (const blockedByTaskIds of [[created.task.id], []]) await expect(f.authority.execute({
      tool: "set_dependencies", callId: randomUUID(), arguments: { idempotencyKey: randomUUID(), blockedByTaskIds },
    })).resolves.toMatchObject({ disposition: "applied" });
    expect((await f.snapshot()).issueRelations).toEqual([]);
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it("preserves an ordinary run's parent-blocked child update", async () => {
    const f = await fixture();
    await server.db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, f.issueId));
    const created = await f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {
      title: "Ordinary child", idempotencyKey: "ordinary-child", status: "todo",
    } }) as { task: { id: string } };
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${created.task.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked", blockedByIssueIds: [f.issueId] }),
    });
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    expect((await f.snapshot()).issueRelations).toContainEqual(expect.objectContaining({
      issueId: f.issueId, relatedIssueId: created.task.id, type: "blocks",
    }));
  });

  it("an explicit Approve/Revise question remains input rather than proposal authority after the human answers", async () => {
    const f = await fixture();
    const issueIds = (await f.snapshot()).issues.map(issue => issue.id).sort();
    const { interaction } = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
      idempotencyKey: "first-task-proposal-1", interactionKind: "questions", title: "Approve child task",
      prompt: "I propose exactly one child task and will wait for approval.", continuationPolicy: "wake_assignee",
      payload: { questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "approve_child_task",
        prompt: 'Approve exactly one child task named "Approved child"?', required: true, answerMode: "single_select",
        options: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }] }] } },
    } }) as { interaction: { id: string; kind: string } };
    expect(interaction.kind).toBe("ask_user_questions");
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    const answered = await issueThreadInteractionService(server.db).answerQuestions({ id: f.issueId, companyId: f.companyId }, interaction.id,
      { answers: [{ questionId: "approve_child_task", optionIds: ["approve"] }] }, { userId: f.responsibleUserId! });
    expect(answered).toMatchObject({ status: "answered", resolvedByUserId: f.responsibleUserId,
      result: { answers: [{ questionId: "approve_child_task", optionIds: ["approve"] }] } });
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    expect((await f.snapshot()).issues.map(issue => issue.id).sort()).toEqual(issueIds);
  });

  it.each(["confirmation", "checkbox"] as const)("the shipped native %s recipe requires a human decision before it admits child work", async kind => {
    for (const actor of ["human", "agent"] as const) {
      const f = await fixture();
      const plan = kind === "checkbox" ? (await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan",
        title: "Approved child plan", format: "markdown", body: "Create one child for the proposed deliverable.",
        createdByAgentId: f.agentId, createdByRunId: f.runId })).document : null;
      const args = await nativeProposalRecipe(kind, plan?.latestRevisionId ?? undefined);
      const receipt = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: args }) as { interaction: { id: string; kind: string } };
      const { interaction } = receipt;
      await expect(f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: args })).resolves.toEqual(receipt);
      expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toHaveLength(1);
      expect(interaction.kind).toBe(kind === "confirmation" ? "request_confirmation" : "request_checkbox_confirmation");
      await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
      const selectedOptionIds = kind === "checkbox" ? ((args.payload as { options: { id: string }[] }).options.map(option => option.id)) : undefined;
      await issueThreadInteractionService(server.db).acceptInteraction({ id: f.issueId, companyId: f.companyId }, interaction.id,
        selectedOptionIds ? { selectedOptionIds } : {}, actor === "human" ? { userId: f.responsibleUserId! } : { agentId: f.agentId, runId: f.runId });
      if (actor === "human") await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
      else await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    }
  });

  it.each(["confirmation", "checkbox"] as const)("rejecting the shipped native %s recipe saves an assignee continuation without authorizing child work", async kind => {
    const f = await fixture();
    const issueIds = (await f.snapshot()).issues.map(issue => issue.id).sort();
    const plan = kind === "checkbox" ? (await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan",
      title: "Proposed child plan", format: "markdown", body: "Create one child for the proposed deliverable.",
      createdByAgentId: f.agentId, createdByRunId: f.runId })).document : null;
    const args = await nativeProposalRecipe(kind, plan?.latestRevisionId ?? undefined);
    const { interaction } = await f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: args }) as { interaction: { id: string } };
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}/interactions/${interaction.id}/reject`, {
      method: "POST", headers: { cookie: await server.humanSession(f.responsibleUserId!), "Content-Type": "application/json", origin: server.apiUrl },
      body: JSON.stringify({ reason: "Please revise the proposed scope." }),
    });
    const rejected = await response.json();
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ status: "rejected", continuationPolicy: "wake_assignee",
      resolvedByUserId: f.responsibleUserId, result: { outcome: "rejected", reason: "Please revise the proposed scope." } });
    expect(response.status).toBe(200);
    const wakes = (await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .filter(wake => wake.payload?.interactionId === interaction.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.agentId, requestedByActorType: "user", requestedByActorId: f.responsibleUserId,
      payload: { issueId: f.issueId, interactionId: interaction.id, interactionStatus: "rejected",
        paperclipAgentMessage: { text: "Please revise the proposed scope.", source: "interaction_rejection" } } });
    // The fixture disables execution: observe the real durable wake, not a model call.
    expect((await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(run => run.id)).toEqual([f.runId]);
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    expect((await f.snapshot()).issues.map(issue => issue.id).sort()).toEqual(issueIds);
  });

  it.each([false, true])("admits persisted human proposal acceptance (checkbox=%s)", async checkbox => {
    const f = await fixture();
    const p = await proposal(f, checkbox);
    await accept(f, p);
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("admits a persisted conversational acceptance with actual same-task human comment provenance", async () => {
    const f = await fixture();
    const p = await proposal(f);
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.responsibleUserId!, authorType: "user", body: "Yes, create that task." }).returning();
    await resolveConfirmationFromComment(server.db, { companyId: f.companyId, issueId: f.issueId,
      interactionId: p.card.id, actor: { agentId: f.agentId, runId: f.runId }, input: { commentId: comment.id, decision: "accept" } });
    const [saved] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, p.card.id));
    expect(saved).toMatchObject({ status: "accepted", resolvedByAgentId: f.agentId, resolvedByUserId: null,
      result: { outcome: "accepted", commentId: comment.id } });
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it.each(["card", "conversation"])("preserves valid %s acceptance across clocks and a changed responding user", async kind => {
    const f = await fixture();
    const originalUserId = randomUUID();
    await server.db.insert(authUsers).values({ id: originalUserId, name: "Original requester",
      email: `${originalUserId}@fixture.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: originalUserId, status: "active", membershipRole: "member" });
    await server.db.update(issues).set({ responsibleUserId: originalUserId }).where(eq(issues.id, f.issueId));
    const p = await proposal(f);
    if (kind === "card") await accept(f, p);
    else {
      const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: f.responsibleUserId!, authorType: "user", body: "Yes, create that task." }).returning();
      await resolveConfirmationFromComment(server.db, { companyId: f.companyId, issueId: f.issueId,
        interactionId: p.card.id, actor: { agentId: f.agentId, runId: f.runId }, input: { commentId: comment.id, decision: "accept" } });
    }
    // Database-created timestamps and application decision timestamps have
    // independent clocks. Persisted authority must not depend on their order.
    await server.db.update(issueThreadInteractions).set({ resolvedAt: new Date(new Date(p.card.createdAt).getTime() - 100) })
      .where(eq(issueThreadInteractions.id, p.card.id));
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("preserves acceptance of a previously dismissed proposal", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await p.svc.dismissInteraction(p.issue, p.card.id, { userId: f.responsibleUserId! });
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    await accept(f, p);
    const [saved] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, p.card.id));
    expect(saved.dismissedAt).not.toBeNull();
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it.each(["opening-answer", "agent-self-accept", "old-comment", "foreign-comment", "derived-comment", "governed-accept", "foreign-source-run"])(
    "does not treat %s as persisted human proposal acceptance", async kind => {
      const f = await fixture();
      const p = await proposal(f);
      if (kind === "opening-answer") {
        await server.db.update(issueThreadInteractions).set({ kind: "ask_user_questions", status: "answered",
          result: { version: 1, answers: [] }, resolvedByUserId: f.responsibleUserId!, resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, p.card.id));
      } else if (kind === "agent-self-accept") {
        await p.svc.acceptInteraction(p.issue, p.card.id, {}, { agentId: f.agentId, runId: f.runId });
      } else if (kind === "governed-accept") {
        await accept(f, p);
        await server.db.update(issueThreadInteractions).set({ payload: { ...p.card.payload, toolAction: {} } as never }).where(eq(issueThreadInteractions.id, p.card.id));
      } else if (kind === "foreign-source-run") {
        const other = await server.fixture({ disableWakeOnDemand: true });
        await accept(f, p);
        await server.db.update(issueThreadInteractions).set({ sourceRunId: other.runId }).where(eq(issueThreadInteractions.id, p.card.id));
      } else {
        const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId,
          issueId: kind === "foreign-comment" ? f.blockerId : f.issueId,
          authorUserId: f.responsibleUserId!, authorType: "user", body: "A reply",
          ...(kind === "old-comment" ? { createdAt: new Date(new Date(p.card.createdAt).getTime() - 1_000) } : {}),
          ...(kind === "derived-comment" ? { derivedAuthorAgentId: f.agentId, derivedCreatedByRunId: f.runId } : {}),
        }).returning();
        await server.db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(),
          resolvedByAgentId: f.agentId, resolvedByRunId: f.runId,
          result: { version: 1, outcome: "accepted", commentId: comment.id } }).where(eq(issueThreadInteractions.id, p.card.id));
      }
      await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
    });

  it.each(["pending", "rejected"])("a newer cross-kind %s proposal supersedes old acceptance", async status => {
    const f = await fixture();
    const old = await proposal(f);
    await accept(f, old);
    const current = await proposal(f, true);
    await server.db.update(issueThreadInteractions).set({ createdAt: new Date(new Date(old.card.createdAt).getTime() + 1_000),
      ...(status === "rejected" ? { status, resolvedByUserId: f.responsibleUserId!, resolvedAt: new Date(),
        result: { version: 1, outcome: "rejected" } as const } : {}),
    }).where(eq(issueThreadInteractions.id, current.card.id));
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it("does not substitute untargeted acceptance for approval of a saved plan", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown",
      body: "This saved plan requires acceptance of its exact revision.", createdByAgentId: f.agentId, createdByRunId: f.runId });
    await accept(f, p);
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it.each(["stale", "foreign-target", "empty-selection"])("does not execute a plan with %s approval", async kind => {
    const f = await fixture();
    const p = await proposal(f, true);
    await accept(f, p);
    if (kind === "stale") {
      await documentService(server.db).unlockIssueDocument(f.issueId, "plan");
      await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown",
        baseRevisionId: p.plan!.latestRevisionId, body: "A revised scope that has not been accepted." });
    } else if (kind === "foreign-target") {
      await server.db.update(issueThreadInteractions).set({ payload: { ...p.card.payload,
        target: { type: "issue_document", key: "plan", issueId: f.blockerId, revisionId: p.plan!.latestRevisionId! } } as never }).where(eq(issueThreadInteractions.id, p.card.id));
    } else {
      await server.db.update(issueThreadInteractions).set({ result: { version: 1, outcome: "accepted", selectedOptionIds: [] } }).where(eq(issueThreadInteractions.id, p.card.id));
    }
    await expect(create(f)).rejects.toThrow(/proposal.*accept/i);
  });

  it("keeps ordinary delegation available even when its description invokes the skill", async () => {
    const f = await fixture();
    await server.db.update(issues).set({ originKind: "manual", description: "Please read /first-task, then delegate." }).where(eq(issues.id, f.issueId));
    await expect(create(f)).resolves.toMatchObject({ task: { parentId: f.issueId } });
  });

  it("preserves native creation replay and dispatch recovery after a newer pending proposal", async () => {
    const f = await fixture();
    const p = await proposal(f);
    await accept(f, p);
    const wakes: unknown[] = [];
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, enqueueWakeup: async (...args) => { wakes.push(args); return null; } });
    const input = { tool: "create_task", callId: randomUUID(), arguments: { title: "Approved child", idempotencyKey: "owned", status: "todo" } };
    const first = await authority.execute(input);
    expect(wakes).toHaveLength(1);
    await proposal(f);
    const before = await f.snapshot();
    const [beforeRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await authority.execute({ ...input, callId: randomUUID() })).toEqual(first);
    // Existing dispatch recovery remains bounded to this already-admitted child.
    expect(wakes).toHaveLength(2);
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.activity).toEqual(before.activity);
    const [afterRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(afterRun.resultJson).toEqual(beforeRun.resultJson);
    await expect(authority.execute({ ...input, arguments: { ...input.arguments, idempotencyKey: "new" } })).rejects.toThrow(/proposal.*accept/i);
  });


  it("replays an owned generic creation after a newer pending proposal", async () => {
    const f = await fixture();
    await accept(f, await proposal(f));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const route = `${server.apiUrl}/api/companies/${f.companyId}/issues`;
    const body = { title: "Approved child", parentId: f.issueId, idempotencyKey: "owned-rest", assigneeAgentId: f.agentId, status: "backlog" };
    const post = async (input = body) => {
      const response = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      return { response, data: await response.json() };
    };
    const first = await post();
    expect(first.response.status, JSON.stringify(first.data)).toBe(201);
    await proposal(f);
    const before = await f.snapshot();
    const replay = await post();
    expect(replay.response.status, JSON.stringify(replay.data)).toBe(200);
    expect(replay.data).toMatchObject({ id: first.data.id, deduplicated: true });
    const after = await f.snapshot();
    expect(after.issues).toEqual(before.issues);
    const fresh = await post({ ...body, idempotencyKey: "new-rest", title: "Another child" });
    expect(fresh.response.status, JSON.stringify(fresh.data)).toBe(403);
  });

});
