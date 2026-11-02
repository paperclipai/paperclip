import { expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sendChatMessage, type ChatFlowInput, type ChatIssue, type ChatRun } from "./chat-flow.js";
import { setSettingsToggle } from "./settings-toggle.js";
import { resolveDefaultAgentWorkspaceDir } from "../../server/src/home-paths.js";

type Comment = { id: string; body: string; authorAgentId?: string; createdByRunId?: string };
type Context = {
  input: ChatFlowInput; marker: string; issue(): ChatIssue;
  idle(count: number): Promise<void>; allRuns(): Promise<ChatRun[]>; comments(): Promise<Comment[]>;
};

/** Seed only the disabled setting; the browser performs the user's opt-in. */
export async function enableChatThroughSettings(input: ChatFlowInput) {
  await input.api.patch("/api/instance/settings/experimental", { enableAgentChat: false, enableClassicTaskInterface: false });
  await setChatEnabled(input, true);
}

async function setChatEnabled(input: ChatFlowInput, enabled: boolean) {
  await input.page.goto(`/${input.fixtures.company.issuePrefix}/company/settings/instance/experimental`, { waitUntil: "domcontentloaded" });
  const toggle = input.page.getByRole("switch", { name: "Toggle agent chat experimental setting" });
  await setSettingsToggle(toggle, enabled);
  await expect.poll(async () => (await input.api.get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental")).enableAgentChat).toBe(enabled);
}

export function assertInterruptedChat(input: {
  first: string; followup: string; reference: string; marker: string; issueId: string;
  boundaryRun: ChatRun; activeAtFollowup: ChatRun; comments: Comment[]; runs: ChatRun[];
  revisedPlan?: string;
}) {
  expect(input.boundaryRun.status).toBe("running");
  expect(input.activeAtFollowup).toMatchObject({ id: input.boundaryRun.id, status: "running" });
  for (const message of [input.first, input.followup]) {
    expect(input.comments.filter(comment => !comment.authorAgentId && comment.body === message)).toHaveLength(1);
  }
  const replies = input.comments.filter(comment => comment.authorAgentId);
  const final = replies.at(-1)!;
  expect(final).toBeTruthy();
  expect(final.body).toContain(input.reference);
  expect(final.body).toContain(input.marker);
  expect(replies.filter(reply => reply.body.includes(input.marker))).toHaveLength(1);
  expect(input.runs.length).toBeGreaterThanOrEqual(1);
  expect(input.runs.length).toBeLessThanOrEqual(2);
  expect(input.runs.every(run => run.status === "succeeded" && run.runtimeMode === "native")).toBe(true);
  expect(new Set(input.runs.map(run => run.id)).size).toBe(input.runs.length);
  expect(input.runs.every(run => run.agentId === input.boundaryRun.agentId && run.contextSnapshot?.issueId === input.issueId)).toBe(true);
  expect(final.authorAgentId).toBe(input.boundaryRun.agentId);
  const responseRun = input.runs.length === 1
    ? input.boundaryRun
    : input.runs.find(run => run.id !== input.boundaryRun.id)!;
  expect(final.createdByRunId).toBe(responseRun.id);
  expect(input.runs.some(run => run.id === input.boundaryRun.id)).toBe(true);
  if (input.revisedPlan !== undefined) {
    const body = input.revisedPlan.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    expect(JSON.parse(body)).toEqual({ launchDay: "Friday", reference: input.reference, revision: input.marker });
  }
}

export async function prepareChatBrief(workspacePath: string, nonce: string, timeoutMs = 120_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("Brief wait must be bounded between 1 and 300000ms");
  await mkdir(workspacePath, { recursive: true });
  const gate = path.join(workspacePath, `chat-brief-${nonce}.txt`);
  const ready = `${gate}.waiting`;
  const scriptPath = path.join(workspacePath, `wait-for-brief-${nonce}.cjs`);
  const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ready)},"waiting");const end=Date.now()+${timeoutMs};const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){console.log(fs.readFileSync(${JSON.stringify(gate)},"utf8"));clearInterval(timer)}else if(Date.now()>end){clearInterval(timer);process.exitCode=1}},100);`;
  await writeFile(scriptPath, script, "utf8");
  return { gate, ready, scriptPath };
}

export async function runChatInterruption(context: Context & { refreshIssue(): Promise<void> }) {
  const { input, marker, idle, allRuns, comments } = context;
  // Unprojected host /tmp files are intentionally hidden from native Codex.
  // These projectless chats use the normal agent-home workspace, not the
  // harness's separate project fixture directory. Keep the asset inside it.
  const agentWorkspace = resolveDefaultAgentWorkspaceDir(input.fixtures.agent.id);
  const relative = path.relative(path.dirname(input.workspacePath), agentWorkspace);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Chat fixture workspace escaped the isolated instance");
  const { gate, ready, scriptPath } = await prepareChatBrief(agentWorkspace, input.nonce);
  const reference = `BRIEF${randomUUID().replaceAll("-", "")}`;
  // Real provider tool execution waits on an ordinary fixture file. No runner
  // hooks, provider results, database records, or task outcomes are fabricated.
  // Keep JavaScript in a seeded fixture file: rich-text input serializes raw
  // operators as Markdown escapes, which should not alter a timing fixture.
  const command = `node ${scriptPath}`;
  const first = `Our launch is planned for Monday. First run this bounded command to wait for the brief reference file I am supplying: ${command}\nAfter it returns, acknowledge the reference from the file here. This is discussion only; do not create projects or tasks.`;
  const revise = input.execution.task.id === "revise-while-running";
  const followup = revise
    ? `Change the launch day to Friday. Save the plan on this conversation as JSON with exactly launchDay, reference (from the brief file), and revision ("${marker}"). Then reply here with the brief reference and ${marker}. Do not create projects or execution tasks.`
    : `After reading the brief, reply here with its reference and ${marker}. Keep this in the current conversation; do not create projects or tasks.`;
  let boundaryRun: ChatRun | undefined;
  let activeAtFollowup: ChatRun | undefined;
  try {
    await sendChatMessage(input.page, first);
    await expect.poll(async () => {
      if (await readFile(ready, "utf8").catch(() => "") !== "waiting") return false;
      boundaryRun = (await allRuns()).find(run => run.status === "running");
      return Boolean(boundaryRun);
    }, { timeout: 120_000 }).toBe(true);
    expect(boundaryRun!.contextSnapshot?.paperclipWorkspace).toMatchObject({ cwd: agentWorkspace });
    await context.refreshIssue();
    await sendChatMessage(input.page, followup);
    await expect.poll(async () => (await comments()).filter(comment => !comment.authorAgentId && comment.body === followup).length,
      { timeout: 30_000 }).toBe(1);
    activeAtFollowup = await input.api.get<ChatRun>(`/api/heartbeat-runs/${boundaryRun!.id}`);
    await input.evidence("chat-interruption-boundary.json", { first, followup, boundaryRun, activeAtFollowup, comments: await comments() });
    expect(activeAtFollowup.status, "Follow-up must persist while the first provider run is active").toBe("running");
    await writeFile(gate, reference, "utf8");
    await expect.poll(async () => (await comments()).filter(comment => comment.authorAgentId).at(-1)?.body ?? "", { timeout: 240_000 }).toContain(marker);
    await idle(1); // Providers may queue a new run or steer the current run.
    const plan = revise ? await input.api.get<{ body: string }>(`/api/issues/${context.issue().id}/documents/plan`) : undefined;
    const evidence = { first, followup, reference, marker, issueId: context.issue().id, boundaryRun: boundaryRun!, activeAtFollowup,
      comments: await comments(), runs: await allRuns(), ...(plan ? { revisedPlan: plan.body } : {}) };
    await input.evidence("chat-interruption.json", evidence);
    assertInterruptedChat(evidence);
    expect(await input.api.get(`/api/companies/${input.fixtures.company.id}/issues`)).toEqual([]);
    expect(await input.api.get(`/api/companies/${input.fixtures.company.id}/projects`)).toEqual([]);
  } finally {
    // Always release a provider that is still waiting, including failed UI runs.
    await writeFile(gate, reference, "utf8");
    const chatPath = `/api/companies/${input.fixtures.company.id}/chats/${input.fixtures.agent.id}`;
    const current = await input.api.get<ChatIssue | null>(chatPath).catch(() => null);
    await input.evidence("chat-interruption-state.json", {
      issue: current,
      runs: await allRuns().catch(error => ({ readError: String(error) })),
      comments: current ? await input.api.get(`/api/issues/${current.id}/comments?order=asc`).catch(error => ({ readError: String(error) })) : [],
      plan: current && revise ? await input.api.get(`/api/issues/${current.id}/documents/plan`).catch(error => ({ readError: String(error) })) : null,
    });
  }
}

export async function runChatSettingsLifecycle(context: Context) {
  const { input, idle, comments, allRuns, marker } = context;
  const remembered = `REMEMBER${marker}`;
  const route = `/${input.fixtures.company.issuePrefix}/chats/${input.fixtures.agent.id}`;
  await sendChatMessage(input.page, `Remember ${remembered} in this conversation. Acknowledge only; no tasks or projects.`);
  await idle(1);
  const before = { issue: context.issue(), comments: await comments(), runs: await allRuns() };
  await setChatEnabled(input, false);
  // Full document navigation clears the client query cache. Unlike SPA
  // navigation, this verifies the disabled entry page without cached history.
  await input.page.goto(route, { waitUntil: "domcontentloaded" });
  await expect(input.page.getByText(/Agent Chat is disabled/)).toBeVisible();
  const blocked = await input.api.request.post(`/api/issues/${before.issue.id}/comments`, { data: { body: `DISABLED${marker}` } });
  expect(blocked.status()).toBe(404);
  expect(await comments()).toEqual(before.comments);
  expect((await allRuns()).map(run => ({ id: run.id, status: run.status })))
    .toEqual(before.runs.map(run => ({ id: run.id, status: run.status })));
  await setChatEnabled(input, true);
  await input.page.goto(route, { waitUntil: "domcontentloaded" });
  await sendChatMessage(input.page, `What reference did I ask you to remember? Reply with it and ${marker}. No new work.`);
  await idle(2);
  expect(context.issue().id).toBe(before.issue.id);
  expect(context.issue().conversationSessionGeneration).toBe(before.issue.conversationSessionGeneration);
  const reply = (await comments()).filter(comment => comment.authorAgentId).at(-1)?.body ?? "";
  expect(reply).toContain(remembered);
  expect(reply).toContain(marker);
  expect(await input.api.get(`/api/companies/${input.fixtures.company.id}/issues`)).toEqual([]);
  await input.evidence("chat-settings-lifecycle.json", { before, after: { issue: context.issue(), comments: await comments(), runs: await allRuns() } });
}
