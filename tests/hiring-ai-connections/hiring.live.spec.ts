import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Paid, opt-in acceptance against a dedicated loopback instance. No provider
// mocking, direct database writes, credential traces, or existing company edits.
test.skip(process.env.HIRING_AI_LIVE !== "1", "Set HIRING_AI_LIVE=1 with both provider keys for paid acceptance");
const environment = process.env.HIRING_AI_ENVIRONMENT ?? "local";
const runner = process.env.HIRING_AI_RUNNER ?? "legacy";
const native = runner === "native";
const providers = {
  anthropic: { label: "Claude", adapterType: "claude_local", model: "claude-sonnet-4-6", key: "ANTHROPIC_API_KEY", radio: "Claude API" },
  openai: { label: "Codex", adapterType: "codex_local", model: "gpt-5.4", key: "OPENAI_API_KEY", radio: "OpenAI API" },
} as const;
type Provider = keyof typeof providers;

function client(request: APIRequestContext) {
  return async (url: string, method = "GET", data?: unknown): Promise<any> => {
    const res = await request.fetch(`/api${url}`, { method, data });
    // Only report route/status: credential-bearing request bodies must never
    // enter a reporter's assertion or attachment output.
    if (!res.ok()) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${method} ${url}: ${res.status()} ${body.code ?? "Request failed"}`);
    }
    return res.json();
  };
}

async function createTask(page: Page, prefix: string, agentName: string, title: string, prompt: string) {
  await page.goto(`/${prefix}/issues`);
  await page.getByRole("navigation").getByRole("button", { name: "New Task", exact: true }).click();
  await page.getByPlaceholder("Task title").fill(title);
  await page.getByRole("dialog").getByRole("textbox", { name: "editable markdown", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Assignee", exact: true }).click();
  await page.getByPlaceholder("Search assignees...").fill(agentName);
  await page.getByRole("button", { name: agentName, exact: true }).click();
  await page.getByRole("button", { name: "No project", exact: true }).click();
  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(page.getByPlaceholder("Task title")).toHaveCount(0);
}

const coordination = native
  ? `Use the native Paperclip tools. First get_task_context to verify the current task and your identity. For hiring use call_api with operationId POST /api/companies/{companyId}/agent-hires and the requested JSON body. Use create_task for subtasks. Do not use shell commands or raw HTTP. Never read or print credentials. For completion call paperclip_finish exactly once with reportedWorkDisposition done, summary describing the completed work, completionClaim {contractRevision:"1",objectiveSatisfied:true,criteria:[{criterionId:"objective",status:"satisfied",evidenceRefs:[]}],remainingWork:[]}, evidence [], and verification []. Wait for that tool to succeed before your final response.`
  : `Use the injected PAPERCLIP_API_URL and PAPERCLIP_API_KEY for every API request. Include Authorization: Bearer $PAPERCLIP_API_KEY and X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID. Never print credentials or the environment. Verify GET /api/agents/me identifies you before writes; stop if it does not. You must act as the agent, not the local board. Use standard Paperclip APIs or the managed API tool, and do not install a CLI. Do not read or modify unrelated files. For completion use PATCH /api/issues/$PAPERCLIP_TASK_ID with status done and a comment.`;

for (const source of ["anthropic", "openai"] as const) {
  test(`${environment}: ${runner}: ${providers[source].label} hires both providers, delegates, and repairs missing auth in the task`, async ({ page, request }, testInfo) => {
    const api = client(request);
    const base = new URL(testInfo.project.use.baseURL!);
    expect(base.protocol).toBe("http:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(base.hostname);
    expect((await api("/health")).deploymentMode).toBe("local_trusted");
    expect(["legacy", "native"]).toContain(runner);
    if (native) await api("/instance/settings/experimental", "PATCH", { enableNativeRunner: true });
    for (const p of Object.values(providers)) if (!process.env[p.key]) throw new Error(`Missing ${p.key}`);
    const target: Provider = source === "anthropic" ? "openai" : "anthropic";
    const nonce = randomUUID().slice(0, 8);
    const company = await api("/companies", "POST", { name: `Hiring QA ${environment} ${providers[source].label} ${nonce}`, description: "Disposable live AI hiring acceptance" });
    const account = await api(`/companies/${company.id}/ai-connections`, "POST", { provider: source, method: "api_key", name: `${providers[source].label} QA account`, ownership: "personal", apiKey: process.env[providers[source].key], agentIds: [], allAgents: false });
    let environmentId: string | undefined;
    if (environment === "daytona") {
      if (!process.env.DAYTONA_API_KEY || !process.env.HIRING_AI_DAYTONA_IMAGE) throw new Error("Daytona requires DAYTONA_API_KEY and HIRING_AI_DAYTONA_IMAGE");
      const installed = (await api("/plugins")).find((plugin: any) => plugin.packageName === "@paperclipai/plugin-daytona");
      if (!installed) await api("/plugins/install", "POST", { packageName: path.resolve(import.meta.dirname, "../../packages/plugins/sandbox-providers/daytona"), isLocalPath: true });
      else expect(installed.status).toBe("ready");
      const secret = await api(`/companies/${company.id}/secrets`, "POST", { name: `Daytona QA ${nonce}`, key: "DAYTONA_API_KEY", value: process.env.DAYTONA_API_KEY });
      const env = await api(`/companies/${company.id}/environments`, "POST", { name: `Hiring QA Daytona ${nonce}`, driver: "sandbox", config: { provider: "daytona", apiKey: { type: "secret_ref", secretId: secret.id, version: "latest" }, image: process.env.HIRING_AI_DAYTONA_IMAGE, cpu: 4, memory: 4, disk: 10, reuseLease: false, runnerLifecycleMode: "per_turn", autoStopInterval: 5, autoArchiveInterval: 15, autoDeleteInterval: 60, timeoutMs: 300_000 }, envVars: {} });
      environmentId = env.id;
    }
    const binding = { provider: source, method: "api_key", mode: "responsible_user" };
    const adapterType = (provider: Provider) => native ? "paperclip_runner" : providers[provider].adapterType;
    const config = (provider: Provider) => native
      ? { model: providers[provider].model, lifecycleMode: "per_turn", ...(provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude", acpxPermissionMode: "approve-all" } : { provider: "codex", codexPermissionMode: "never" }) }
      : { model: providers[provider].model, engine: "cli", ...(provider === "anthropic" ? { dangerouslySkipPermissions: true } : { dangerouslyBypassApprovalsAndSandbox: true }) };
    const manager = await api(`/companies/${company.id}/agents`, "POST", { name: `${providers[source].label} Manager ${nonce}`, role: "ceo", adapterType: adapterType(source), adapterConfig: config(source), defaultEnvironmentId: environmentId, runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false } }, instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": `# Acceptance manager\n${coordination}\nPerform only the requested bounded hiring workflow. This test has no code deliverable.` } } });
    const sameName = `${providers[source].label} Teammate ${nonce}`;
    const crossName = `${providers[target].label} Teammate ${nonce}`;
    const selfTitle = `Self subtask ${nonce}`;
    const proof = (kind: string) => `HIRING-${kind}-${nonce}: 1147`;
    const simplePrompt = (kind: string) => `${coordination}\nCalculate 31*37 and use exactly ${proof(kind)} as your ${native ? "paperclip_finish summary and final response" : "completion comment"}. Mark this task done. No subtasks or files.`;
    const hire = (provider: Provider, name: string) => ({ name, role: "engineer", reportsTo: manager.id, adapterType: adapterType(provider), adapterConfig: config(provider), ...(environmentId ? { defaultEnvironmentId: environmentId } : {}), instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": `# Acceptance worker\n${coordination}` } } });
    const title = `Hire both providers ${nonce}`;
    const child = native
      ? `Use create_task with idempotencyKey self-${nonce}, title ${JSON.stringify(selfTitle)}, assigneeActorId ${manager.id}, and description ${JSON.stringify(simplePrompt("SELF"))}.`
      : `Create a subtask with title ${JSON.stringify(selfTitle)}, parentId equal to PAPERCLIP_TASK_ID, assigneeAgentId ${manager.id}, status todo, and description ${JSON.stringify(simplePrompt("SELF"))}.`;
    const prompt = `${coordination}\nPerform exactly these three operations, then mark this manager task done with links. Do not wait for the child and do not configure AI connections.\n1. POST /api/companies/${company.id}/agent-hires with ${JSON.stringify(hire(source, sameName))}.\n2. POST the same endpoint with ${JSON.stringify(hire(target, crossName))}. It is expected that ${providers[target].label} has no connection yet; hiring must still succeed. Do not provide runtimeConfig.aiConnection or credentials for either hire; the server must select defaults.\n3. ${child} The board will assign tasks to the two hires separately.`;
    const evidence: Record<string, unknown> = { companyId: company.id, prefix: company.issuePrefix, managerId: manager.id, account, source, target, runner, environment, environmentId };
    console.log(`Fixture ${JSON.stringify(evidence)}`);
    try {
      await createTask(page, company.issuePrefix, manager.name, title, prompt);
      const findIssue = async (name: string) => (await api(`/companies/${company.id}/issues`)).find((issue: any) => issue.title === name);
      let hiringIssue: any;
      await expect.poll(async () => { hiringIssue = await findIssue(title); return hiringIssue?.status; }, { timeout: 300_000, intervals: [1500, 3000] }).toBe("done");
      evidence.hiringIssueId = hiringIssue.id;
      const agents = await api(`/companies/${company.id}/agents`);
      const same = agents.find((agent: any) => agent.name === sameName);
      const cross = agents.find((agent: any) => agent.name === crossName);
      expect(same?.runtimeConfig.aiConnection).toEqual(binding);
      expect(cross?.runtimeConfig.aiConnection).toMatchObject({ provider: target, mode: "responsible_user" });
      evidence.sameAgentId = same.id; evidence.crossAgentId = cross.id;
      const activity = await api(`/companies/${company.id}/activity`);
      for (const agent of [same, cross]) expect(activity.some((entry: any) => entry.action === "agent.hire_created" && entry.entityId === agent.id && entry.actorType === "agent" && entry.agentId === manager.id)).toBe(true);
      const completed = async (issue: any, kind: string, agentId: string, connectionId?: string) => {
        await expect.poll(async () => (await api(`/issues/${issue.id}`)).status, { timeout: 300_000, intervals: [2000, 3000] }).toBe("done");
        const comments = await api(`/issues/${issue.id}/comments`);
        expect(comments.some((comment: any) => comment.authorAgentId === agentId && comment.body.includes(proof(kind)))).toBe(true);
        let successful: any;
        await expect.poll(async () => {
          const runs = await api(`/issues/${issue.id}/runs`);
          successful = runs.find((run: any) => run.status === "succeeded" && run.agentId === agentId && run.contextIssueId === issue.id);
          return Boolean(successful);
        }, { timeout: 60_000, intervals: [1000] }).toBe(true);
        const run = await api(`/heartbeat-runs/${successful.runId}`);
        expect(run.runtimeMode).toBe(runner);
        if (native) expect(run.runnerInstanceId).toBeTruthy();
        expect(run.contextSnapshot.aiConnection).toMatchObject({ responsibleUserId: "local-board", ...(connectionId ? { connectionId } : {}) });
        if (environmentId) {
          expect(successful.environment).toMatchObject({ id: environmentId, driver: "sandbox" });
          expect(successful.environmentLease).toMatchObject({ provider: "daytona", leasePolicy: "ephemeral" });
          expect(successful.environmentLease.providerLeaseId).toBeTruthy();
        }
        evidence[kind] = { issueId: issue.id, runId: run.id, runtimeMode: run.runtimeMode, runnerInstanceId: run.runnerInstanceId, attribution: run.contextSnapshot.aiConnection, environment: successful.environment, environmentLease: successful.environmentLease };
        await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
        await expect(page.getByText(proof(kind), { exact: true }).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`${kind.toLowerCase()}-completed.png`), fullPage: true });
      };
      const self = await findIssue(selfTitle);
      expect(self).toMatchObject({ parentId: hiringIssue.id, createdByAgentId: manager.id, responsibleUserId: "local-board" });
      await completed(self, "SELF", manager.id, account.connectionId);
      const sameTitle = `Work for same provider ${nonce}`;
      await createTask(page, company.issuePrefix, same.name, sameTitle, simplePrompt("SAME"));
      await completed(await findIssue(sameTitle), "SAME", same.id, account.connectionId);
      const crossTitle = `Work pending new connection ${nonce}`;
      await createTask(page, company.issuePrefix, cross.name, crossTitle, simplePrompt("CROSS"));
      const crossIssue = await findIssue(crossTitle);
      evidence.crossIssueId = crossIssue.id;
      await page.goto(`/${company.issuePrefix}/issues/${crossIssue.identifier}`);
      await expect(page.getByRole("button", { name: "Fix connection", exact: true })).toBeVisible({ timeout: 90_000 });
      const before = await api(`/issues/${crossIssue.id}/interactions`);
      expect(before.filter((interaction: any) => interaction.kind === "connection_intent" && interaction.payload.purpose === "ai" && interaction.status === "pending")).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath("missing-connection-card.png"), fullPage: true });
      await page.getByRole("button", { name: "Fix connection", exact: true }).click();
      const inline = page.getByTestId("ai-connection-inline-repair");
      await expect(inline).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await inline.getByRole("button", { name: "Use API key instead", exact: true }).click();
      await inline.getByRole("radio", { name: providers[target].radio, exact: true }).click();
      await inline.screenshot({ path: testInfo.outputPath("inline-before-credential.png") });
      try {
        await inline.getByPlaceholder("Enter API key here").fill(process.env[providers[target].key]!);
        await inline.getByRole("button", { name: "Connect", exact: true }).click();
        await expect(inline).toHaveCount(0, { timeout: 60_000 });
      } catch {
        const field = inline.getByPlaceholder("Enter API key here");
        if (await field.count()) await field.fill("").catch(() => {});
        throw new Error("Inline credential setup did not complete (credential details suppressed)");
      }
      // No follow-up message or explicit retry: connecting must resume this task.
      const accounts = (await api(`/companies/${company.id}/ai-connections`)).connections;
      const targetAccount = accounts.find((item: any) => item.provider === target && item.isDefault);
      expect(targetAccount).toMatchObject({ status: "connected", method: "api_key" });
      await completed(crossIssue, "CROSS", cross.id, targetAccount.id);
      expect((await api(`/issues/${crossIssue.id}/interactions`)).filter((interaction: any) => interaction.kind === "connection_intent" && interaction.status === "accepted")).toHaveLength(1);
    } finally {
      await writeFile(testInfo.outputPath("evidence.json"), JSON.stringify(evidence, null, 2));
      if (environmentId) {
        const runs = await api(`/companies/${company.id}/heartbeat-runs?limit=100`);
        for (const run of runs) if (["queued", "running"].includes(run.status)) await api(`/heartbeat-runs/${run.id}/cancel`, "POST");
        await expect(async () => { await api(`/environments/${environmentId}?destroyReusableSandboxLeases=true`, "DELETE"); }).toPass({ timeout: 120_000, intervals: [3000] });
      }
    }
  });
}
