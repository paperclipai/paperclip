import { expect, type Page } from "@playwright/test";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import { nativeCompletionProfile } from "./native-completion-defaults.js";
import { createRemoteFixtureClient } from "./remote-native-bootstrap.js";
import { gradeRepositoryBundles, inspectRepositoryBundle, isOwnedRepositoryRuntimeRoot, remoteRepositoryInspector, type RepositoryBundleReceipt, type RepositoryFileReceipt } from "./repository-skill-evidence.js";
import { createTaskThroughUi } from "./user-actions.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { CredentialName, MatrixExecution, RunnerTaskFixture } from "./types.js";

type Row = Record<string, any>;
export { nativeCompletionProfile as repositorySkillsProfile };
export const POTETO_REPOSITORY = "https://github.com/paperclipai/poteto-stack";
const SKILLS = ["architect", "bro"];
export const repositorySkillsTask: RunnerTaskFixture = {
  id: "poteto-package", label: "Private Poteto repository package", flow: "repository_skills",
  groups: [], requiredCredentials: ["GITHUB_TOKEN"], workMode: "standard",
  expectedRunCount: 1, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 600_000, daytona: 900_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Verify Poteto skill delivery ${nonce}`,
  buildPrompt: () => "Read the assigned Poteto repository skills and verify their delivered files.",
  buildVisibleMarker: nonce => `POTETO-VERIFIED-${nonce}`,
  buildMatchers: () => [],
};

export async function runRepositorySkillsFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  credentials: Partial<Record<CredentialName, string>>; secrets: string[]; deadlineAt: number;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
}) {
  const { api, page, fixtures, nonce, execution } = input;
  const company = `/api/companies/${fixtures.company.id}`;
  await api.patch("/api/instance/settings/experimental", { enableBetaSkills: true, enableClassicTaskInterface: false });
  await api.patch(`${company}/budgets`, { budgetMonthlyCents: 1_000 });
  const github = await api.post<Row>(`${company}/tools/connections`, {
    name: `Repository E2E GitHub ${nonce}`, applicationName: "GitHub", transport: "mcp_remote", authKind: "api_key",
    credentialPolicy: "shared", status: "active", enabled: true,
    config: { sourceTemplateKey: "github", url: "https://api.githubcopilot.com/mcp/" }, transportConfig: { sourceTemplateKey: "github", url: "https://api.githubcopilot.com/mcp/" },
    credentialRefs: [{ name: "GitHub", secretId: fixtures.secretRefs.GITHUB_TOKEN!.secretId, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
    credentialSecretRefs: [{ secretId: fixtures.secretRefs.GITHUB_TOKEN!.secretId, versionSelector: "latest", configPath: "headers.Authorization", required: true }],
  });
  await page.goto(`/${fixtures.company.issuePrefix}/skills/sources/new`);
  const dialog = page.getByRole("dialog", { name: "Import from GitHub", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "... or add public repo by URL", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Repository URL", exact: true }).fill(POTETO_REPOSITORY);
  await dialog.getByRole("button", { name: "Find skills", exact: true }).click();
  const together = dialog.getByRole("checkbox", { name: "Keep repository files together", exact: true });
  await expect(together).toBeEnabled({ timeout: 120_000 });
  // The controlled checkbox changes only after the repository rescan returns.
  await together.click();
  await expect(together).toBeChecked({ timeout: 120_000 });
  await expect(dialog.getByText(/The full repository travels/)).toBeVisible({ timeout: 120_000 });
  await expect(together).toBeEnabled({ timeout: 120_000 });
  await dialog.locator("summary").filter({ hasText: "Choose skills" }).click();
  // Deselect every default; exactly two become discoverable, all siblings stay supporting files.
  const all = dialog.getByRole("checkbox", { name: "Import folder Repository", exact: true });
  if (await all.isChecked()) await all.uncheck();
  else { await all.check(); await all.uncheck(); }
  for (const skill of SKILLS) await dialog.getByRole("checkbox", { name: `Import skills/${skill}/SKILL.md`, exact: true }).check();
  const importedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${company}/skill-sources`, { timeout: 120_000 });
  await dialog.getByRole("button", { name: "Import 2 skills", exact: true }).click();
  const response = await importedResponse;
  expect(response.ok()).toBe(true);
  const imported = await response.json() as Row;
  expect(imported.imported).toHaveLength(2);
  expect(imported.source.packageMode).toBe("repository");
  const commit = imported.source.lastScanCommit as string;
  const treeResponse = await fetch(`https://api.github.com/repos/paperclipai/poteto-stack/git/trees/${commit}?recursive=1`, {
    headers: { Authorization: `Bearer ${input.credentials.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!treeResponse.ok) throw new Error(`Independent GitHub tree read failed (${treeResponse.status})`);
  const tree = await treeResponse.json() as { truncated: boolean; tree: Array<{ path: string; type: string; mode: string; sha: string; size: number }> };
  expect(tree.truncated).toBe(false);
  const expected: RepositoryFileReceipt[] = tree.tree.filter(file => file.type === "blob").map(file => ({ path: file.path, sha: file.sha, size: file.size, executable: file.mode === "100755" }));
  expect(expected.some(file => file.path === "agents/poteto-agent.md")).toBe(true);
  expect(expected.some(file => file.path === "NOTICE.md")).toBe(true);
  await api.post(`/api/agents/${fixtures.agent.id}/skills/sync?companyId=${fixtures.company.id}`, { desiredSkills: imported.imported.map((skill: Row) => skill.key), mode: "replace" });
  const assigned = await api.get<Row>(`/api/agents/${fixtures.agent.id}/skills?companyId=${fixtures.company.id}`);
  expect(assigned.desiredSkills).toHaveLength(2);
  // Source credentials are disabled before the provider starts: delivery must use persisted bytes.
  await api.patch(`/api/tool-connections/${github.id}`, { enabled: false });
  await input.evidence("repository-import.json", { commit, source: imported.source, skills: imported.imported, assigned, expected });
  const names = imported.imported.map((skill: Row) => skill.slug);
  const prompt = [
    `Read both assigned skills ${names.map((name: string) => `/${name}`).join(" and ")} using the skill mechanism. Follow each wrapper to its canonical original SKILL.md. This task only verifies their installation; do not perform architecture changes.`,
    "Use the filesystem paths in your available-skills list to read the two selected wrappers under codex-home/skills on this provider's filesystem. Read their canonical original instructions, then use Node.js fs to traverse each .paperclip-repository and verify that sibling skills, agents/poteto-agent.md and NOTICE.md can be read. Library paths returned by Paperclip API tools are not the provider installation being tested; CODEX_HOME may be absent from the shell environment.",
    `Publish a progress comment on this task containing exactly POTETO-ROOTS-${nonce} followed by JSON {"roots":["<absolute provider wrapper parent for first skill>","<absolute provider wrapper parent for second skill>"]}.`,
    "After publishing that comment, execute the ordinary shell command sleep 120 and wait for it to finish. The operator will independently inspect these files during that pause. Do not alter any imported file, install dependencies, fetch repository contents, or finish before the pause completes.",
    `Then reply ${execution.task.buildVisibleMarker(nonce)} and complete this task.`,
  ].join("\n");
  const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
    title: execution.task.buildTitle(nonce), prompt, workMode: "standard", requireExplicitTitle: true });
  let issue = await api.get<Row>(`/api/issues/${created.issueId}`), runs: Row[] = [];
  const refresh = async () => {
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    const listed = await api.get<Row[]>(`/api/issues/${created.issueId}/runs`);
    runs = await Promise.all(listed.map(row => api.get<Row>(`/api/heartbeat-runs/${row.runId}`)));
    input.observe(issue, runs);
  };
  const receiptMarker = `POTETO-ROOTS-${nonce}`;
  const comments = await pollUntil({ label: "provider read repository skills", deadlineAt: input.deadlineAt - 150_000,
    load: async () => { await refresh(); return api.get<Row[]>(`/api/issues/${created.issueId}/comments`); },
    accept: rows => rows.some(row => row.authorAgentId === fixtures.agent.id && row.createdByRunId === runs[0]?.id && row.body?.startsWith(receiptMarker)),
    reject: () => runs.some(run => ["failed", "cancelled", "timed_out", "succeeded"].includes(run.status)) ? "Repository delivery provider ended without a runtime receipt" : undefined,
  });
  const proof = comments.find(row => row.authorAgentId === fixtures.agent.id && row.createdByRunId === runs[0]?.id && row.body?.startsWith(receiptMarker))!;
  const roots = JSON.parse(proof.body.slice(receiptMarker.length).trim()).roots as string[];
  expect(roots).toHaveLength(2);
  expect(roots.every(root => typeof root === "string" && root.startsWith("/") && !root.split("/").some(part => part === ".."))).toBe(true);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("running");
  expect(runs[0]!.runtimeMode).toBe(execution.profile.expectedRuntimeMode);
  expect(runs[0]!.companyId).toBe(fixtures.company.id);
  expect(runs[0]!.agentId).toBe(fixtures.agent.id);
  expect(issue.companyId).toBe(fixtures.company.id);
  expect(issue.assigneeAgentId).toBe(fixtures.agent.id);
  expect(runs[0]!.contextSnapshot?.paperclipEnvironment?.id).toBe(fixtures.environment.id);
  let bundles: RepositoryBundleReceipt[];
  let runtimeLocation: Parameters<typeof isOwnedRepositoryRuntimeRoot>[2];
  if (execution.environment.id === "local") {
    const temporaryRoot = await realpath(process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT!);
    for (const root of roots) expect((await realpath(root)).startsWith(`${temporaryRoot}${path.sep}`)).toBe(true);
    bundles = (await Promise.all(roots.map(root => realpath(root)))).map(inspectRepositoryBundle);
    runtimeLocation = { kind: "local", instanceRoot: await realpath(path.dirname(process.env.PAPERCLIP_CONFIG!)) };
  } else {
    const leases = await api.get<Row[]>(`/api/environments/${fixtures.environment.id}/leases`);
    const owned = leases.filter(lease => lease.companyId === fixtures.company.id && lease.environmentId === fixtures.environment.id && lease.heartbeatRunId === runs[0]!.id && lease.issueId === issue.id && lease.status === "active" && lease.provider === "daytona");
    expect(owned).toHaveLength(1);
    expect(owned[0]!.metadata.agentId).toBe(fixtures.agent.id);
    runtimeLocation = { kind: "daytona", remoteCwd: owned[0]!.metadata.remoteCwd };
    const client = await createRemoteFixtureClient(input.credentials.DAYTONA_API_KEY!);
    const sandbox = await client.get(owned[0]!.providerLeaseId);
    expect(sandbox.id).toBe(owned[0]!.providerLeaseId);
    const result = await sandbox.process.executeCommand(remoteRepositoryInspector(roots), undefined, {}, 20);
    expect(result.exitCode).toBe(0);
    bundles = JSON.parse(result.result);
    await input.evidence("repository-owned-sandbox.json", { lease: owned[0], sandboxId: sandbox.id });
  }
  const checks = gradeRepositoryBundles(bundles, expected, SKILLS);
  checks.push({ id: "owned-native-session-skill-directories", passed: typeof runs[0]!.nativeSessionId === "string" && bundles.every(bundle =>
    isOwnedRepositoryRuntimeRoot(bundle.root, runs[0]!.nativeSessionId, runtimeLocation)) });
  await input.evidence("repository-runtime-files.json", { commit, bundles, checks });
  expect(checks.filter(check => !check.passed)).toEqual([]);
  await pollUntil({ label: "repository task completes", deadlineAt: input.deadlineAt, load: async () => { await refresh(); return { issue, runs }; },
    accept: state => state.issue.status === "done" && state.runs.length === 1 && state.runs[0]!.status === "succeeded",
    reject: state => state.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Repository task failed" : undefined });
  await input.evidence("api-state.json", { issue, run: runs[0], runs, comments: await api.get<Row[]>(`/api/issues/${created.issueId}/comments`), checks });
  await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await expect(page.getByTestId("task-chat-agent-bubble").filter({ hasText: execution.task.buildVisibleMarker(nonce) }).last()).toBeVisible();
  await input.capture("final-state", "Poteto repository skills verified in the actual agent runtime", "final-state.png");
  return { issue, runs, checks };
}
