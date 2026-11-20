import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runScheduledRoutine } from "./routine-schedule-flow.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

// Browser rendering is covered by the real Routines component tests. This entry
// control keeps the API reads and the production attribution grade intact.
vi.mock("@playwright/test", () => ({ expect: Object.assign(() => ({ toBeVisible: async () => {} }), {
  poll: (load: () => Promise<unknown>) => ({ toBe: async (value: unknown) => expect(await load()).toBe(value) }),
}) }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(fault: "body" | "document-author" | "revision-run" | "creation-description" | "creation-project" | null = null, disableFailure = false) {
  const campaignId = "journey-1-campaign", expectedBody = `scheduled-${campaignId}\nSchedule check complete.`;
  const agent = { id: "agent", name: "Owned QA agent", provider: "opencode", model: "configured-model", runtimeMode: "native" };
  const project = { id: "project", companyId: "company", name: `Journey QA routine project ${campaignId}` };
  const trigger = { id: "trigger", companyId: "company", routineId: "routine", kind: "schedule", cronExpression: "* * * * *",
    timezone: "America/Chicago", enabled: false, updatedAt: new Date(60_000).toISOString() };
  const invocation = { id: "invocation", companyId: "company", routineId: "routine", triggerId: "trigger", source: "schedule",
    status: "completed", linkedIssueId: "task", routineRevisionId: "routine-revision", triggeredAt: new Date(61_000).toISOString() };
  const task = { id: "task", identifier: "QA-1", companyId: "company", projectId: "project", assigneeAgentId: agent.id,
    status: "done", originKind: "routine_execution", originId: "routine", originRunId: "invocation" };
  const run = { id: "native-run", companyId: "company", issueId: task.id, agentId: agent.id, status: "succeeded", runtimeMode: "native",
    contextSnapshot: { paperclipEnvironment: { id: "environment" } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: agent.provider, model: agent.model } } } };
  const body = fault === "body" ? expectedBody.slice(0, -1) : expectedBody;
  const document = { id: "document", companyId: "company", issueId: task.id, latestRevisionId: "revision", body,
    createdByAgentId: fault === "document-author" ? "foreign-agent" : agent.id, createdByUserId: null };
  const revision = { id: "revision", documentId: document.id, body, createdByAgentId: agent.id,
    createdByRunId: fault === "revision-run" ? "foreign-run" : run.id };
  const reads: string[] = [];
  let instructions = "", pastes = 0, triggerCreated = false, responseResolver: ((value: unknown) => void) | undefined;
  const routine = () => ({ id: "routine", companyId: "company", title: `Journey QA scheduled routine ${campaignId}`,
    projectId: fault === "creation-project" ? "foreign-project" : project.id, assigneeAgentId: agent.id,
    createdByUserId: "user", createdByAgentId: null,
    description: fault === "creation-description" ? instructions.replaceAll("`", "\\`") : instructions,
    concurrencyPolicy: "always_enqueue", triggers: triggerCreated ? [trigger] : [] });
  const locator = (name = ""): any => ({ first() { return this; }, getByRole: (_role: string, options: { name?: string } = {}) => locator(options.name),
    getByPlaceholder: () => locator(), locator: () => ({
      fill: async (value: string) => { instructions = value; }, focus: async () => {},
      // The real MDX browser discriminator covers serialization. Keep this unit
      // editor boundary separate from the production API reads and grade.
      evaluate: async (_action: unknown, text?: string) => {
        if (text === undefined) return false;
        pastes += 1; instructions = text;
      },
    }),
    fill: async () => {}, click: async () => {
      if (name === "Enable trigger") { trigger.enabled = true; responseResolver?.({ status: () => 200, json: async () => ({ ...trigger }) }); }
      if (name === "Pause trigger") trigger.enabled = false;
      if (name === "Create routine") responseResolver?.({ status: () => 201, json: async () => routine() });
    } });
  const api = { origin: "https://qa.example.test", async post(route: string) {
    if (route === "/api/companies/company/projects") return project;
    expect(route).toBe("/api/routines/routine/triggers"); triggerCreated = true; return { trigger: { ...trigger } };
  }, async patch(route: string, input: Row) {
    if (route === "/api/routine-triggers/trigger") {
      if (disableFailure) throw new Error("Private transport error must not replace attribution");
      trigger.enabled = input.enabled;
    }
  },
  async get(route: string) {
    reads.push(route);
    if (route === "/api/routines/routine") return routine();
    if (route === "/api/routines/routine/runs") return [invocation];
    if (route === "/api/issues/task") return task;
    if (route === "/api/issues/task/runs") return [{ runId: run.id }];
    if (route === "/api/heartbeat-runs/native-run") return run;
    if (route === "/api/issues/task/comments?order=asc" || route === "/api/issues/task/interactions") return [];
    if (route === "/api/issues/task/documents/scheduled-summary") return document;
    if (route === "/api/issues/task/documents/scheduled-summary/revisions/revision") return revision;
    throw new Error(`Unexpected fixture read ${route}`);
  } };
  const page = { getByRole: (_role: string, options: { name?: string } = {}) => locator(options.name), getByPlaceholder: () => locator(),
    async goto(url: string) { if (url.endsWith("/routines/routine/runs")) throw new Error("Stop the positive control before the real pause window"); },
    waitForResponse: () => new Promise(resolve => { responseResolver = resolve; }) };
  const context = { api, page, company: { id: "company", issuePrefix: "QA" }, user: { id: "user" }, agent, environmentId: "environment" } as unknown as JourneyContext;
  const directory = await mkdtemp(path.join(os.tmpdir(), "routine-attribution-")); directories.push(directory);
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  return { expectedBody, body, instructions: () => instructions, pastes: () => pastes, evidence, trigger, directory, reads,
    run: () => runScheduledRoutine(context, { async own() {} } as unknown as TargetSession, campaignId, evidence,
      { directory, deadlineAt: Date.now() + 10_000 }) };
}

it.each(["creation-description", "creation-project"] as const)("retains closed %s evidence before the unchanged creation failure", async fault => {
  const f = await fixture(fault);
  await expect(f.run()).rejects.toMatchObject({ code: "routine_browser_created" });
  const receipt = JSON.parse(await readFile(path.join(f.directory, "scheduled-routine-creation.json"), "utf8"));
  expect(receipt.matches).toEqual({ company: true, title: true, project: fault !== "creation-project", assignee: true,
    userCreator: true, agentCreatorNull: true, description: fault !== "creation-description", concurrency: true, zeroTriggers: true });
  expect(receipt.expectedDescription.sha256).toBe(createHash("sha256").update(f.instructions()).digest("hex"));
  expect(receipt.savedDescription.backslashCount).toBe(fault === "creation-description" ? 6 : 0);
  expect(JSON.stringify(receipt)).not.toContain("Schedule check complete");
  expect(f.evidence.checks).toEqual([{ id: "routine-browser-created", passed: false }]);
  expect(f.reads.some(route => route.includes("heartbeat-runs"))).toBe(false);
});

it.each(["body", "document-author", "revision-run"] as const)("retains closed %s attribution evidence before preserving the failed grade", async fault => {
  const f = await fixture(fault);
  await expect(f.run()).rejects.toMatchObject({ code: "routine_result_attributed" });
  const receipt = JSON.parse(await readFile(path.join(f.directory, "scheduled-routine-result.json"), "utf8"));
  expect(receipt.matches).toMatchObject({ documentExactBody: fault !== "body", documentAuthor: fault !== "document-author", revisionRun: fault !== "revision-run" });
  expect(Object.values(receipt.matches).every(Boolean)).toBe(false);
  expect(receipt.documentBody.sha256).toBe(createHash("sha256").update(f.body).digest("hex"));
  expect(receipt.revision.createdByRunId).toBe(fault === "revision-run" ? "foreign-run" : "native-run");
  expect(JSON.stringify(receipt)).not.toContain("Schedule check complete");
  expect(f.evidence.checks.at(-1)).toEqual({ id: "routine-result-attributed", passed: false });
  expect(f.trigger.enabled).toBe(false);
});

it("keeps the real journey attribution failure when final trigger disabling also fails", async () => {
  const f = await fixture("body", true);
  await expect(f.run()).rejects.toMatchObject({ code: "routine_result_attributed" });
  expect(f.evidence.checks.at(-1)).toEqual({ id: "routine-result-attributed", passed: false });
  const receipt = JSON.parse(await readFile(path.join(f.directory, "scheduled-routine-cleanup-failure.json"), "utf8"));
  expect(receipt).toMatchObject({ code: "routine_trigger_disable_failed", primaryFailurePreserved: true });
  expect(JSON.stringify(receipt)).not.toContain("Private transport");
});

it("sends the unchanged exact two-line body as a delimited instruction and accepts valid attribution", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toMatchObject({ code: "routine_open_history_failed" });
  const block = f.instructions().match(/```text\n([\s\S]*?)\n```/);
  expect(block?.[1]).toBe(f.expectedBody);
  expect(f.instructions()).toContain("including the final period");
  expect(f.instructions()).toContain("document body.\n\n```text\n");
  expect(f.instructions()).toContain("\n```\n\nThen finish the task.");
  expect(f.pastes()).toBe(1);
  const creation = JSON.parse(await readFile(path.join(f.directory, "scheduled-routine-creation.json"), "utf8"));
  expect(Object.values(creation.matches).every(Boolean)).toBe(true);
  expect(creation.savedDescription.sha256).toBe(createHash("sha256").update(f.instructions()).digest("hex"));
  const receipt = JSON.parse(await readFile(path.join(f.directory, "scheduled-routine-result.json"), "utf8"));
  expect(Object.values(receipt.matches).every(Boolean)).toBe(true);
  expect(f.evidence.checks.at(-1)).toEqual({ id: "routine-result-attributed", passed: true });
  expect(f.trigger.enabled).toBe(false);
});
