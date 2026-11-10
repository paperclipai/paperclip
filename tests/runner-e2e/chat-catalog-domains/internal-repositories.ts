import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { makeDefinition } from "./internal-definition.js";
import { externalRequirements, selectedExternalBinding, selectedExternalCredential } from "./external-fixtures.js";
import { internalResultLink, checks, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";

interface Repository { id: string; fullName: string; url: string; connectionIds?: string[] }
interface Workspace extends Entity { repoUrl?: string | null; cwd?: string | null; metadata?: { githubRepositoryId?: string } }
interface RepositoryProject extends Entity { workspaces: Workspace[] }
interface RepositoryObservation extends InternalObservation {
  repositoryProject?: RepositoryProject; repositories: Repository[]; connection: { id: string; status: string; enabled: boolean };
}
function repositoriesOf(p: RepositoryProject | undefined) { return p?.workspaces.filter(row => row.repoUrl) ?? []; }
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export async function connectRepositoryFixture(ctx: ChatCatalogContext) {
  const siteOnly = ["projects.add-repository", "workspaces.prepare-repository", "workspaces.private-repository-no-access"].includes(ctx.scenario.id);
  if (!siteOnly && ctx.scenario.id !== "projects.replace-repository") throw new Error("Repository fixture is not declared for this selected scenario");
  const binding = selectedExternalBinding(ctx);
  await ctx.input.evidence("chat-catalog-github-prerequisite.json", { scenarioId: ctx.scenario.id, provider: "github", configured: true, missing: [] });
  const envName = binding.prerequisites.tokenEnv!;
  if (!binding.credentialEnv.includes(envName) || !/^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(envName))
    throw new Error("Setup blocker: GitHub tokenEnv must name an explicitly authorized scoped credentialEnv binding");
  if (!ctx.input.privateSecrets) throw new Error("Setup blocker: disposable GitHub credential and attempt-private redaction sink are required");
  const token = selectedExternalCredential(ctx, binding, "tokenEnv");
  const requested = siteOnly
    ? [{ id: binding.prerequisites.siteRepositoryId!, fullName: binding.prerequisites.siteRepositoryFullName! }]
    : [{ id: binding.prerequisites.oldRepositoryId!, fullName: binding.prerequisites.oldRepositoryFullName! }, { id: binding.prerequisites.newRepositoryId!, fullName: binding.prerequisites.newRepositoryFullName! }];
  if (requested.some(row => !/^[1-9]\d*$/.test(row.id) || !Number.isSafeInteger(Number(row.id)) || !binding.resourceIds.includes(row.id)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.fullName)) || new Set(requested.map(row => row.id)).size !== requested.length)
    throw new Error("Setup blocker: each GitHub repository requires its distinct safe numeric disposable allowlist ID and explicit provider owner/repository identity");
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const secret = await ctx.input.api.postSensitive<{ id: string }>(`${root}/secrets`, { name: "Disposable repository GitHub token",
    key: `CATALOG_GITHUB_${ctx.input.nonce.replaceAll("-", "_").toUpperCase()}`, provider: "local_encrypted", value: token });
  let connectionId: string | undefined;
  try {
    const connection = await ctx.input.api.postSensitive<{ id: string }>(`${root}/tools/connections`, {
      applicationName: "Disposable Repository GitHub", name: "Authorized synthetic repositories", transport: "rest_api", authKind: "api_key",
      credentialPolicy: "shared", status: "active", enabled: true, config: { sourceTemplateKey: "github" },
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token", required: true }],
    });
    connectionId = connection.id;
    const options = await ctx.input.api.get<{ repositories: Repository[]; failedConnectionCount: number }>(`${root}/project-repositories`);
    if (options.failedConnectionCount || !requested.every(expected => options.repositories.some(row => row.id === expected.id
      && row.fullName === expected.fullName && row.url === `https://github.com/${expected.fullName}` && row.connectionIds?.includes(connection.id))))
      throw new Error("Setup blocker: the current authorized GitHub connection must independently expose each explicit disposable repository name and ID");
    const receipt = (row: typeof requested[number]) => ({ id: Number(row.id), fullName: row.fullName, connectionId: connection.id, companyId: ctx.input.fixtures.company.id });
    return { connectionId: connection.id, secretId: secret.id, requested,
      ...(siteOnly ? { siteRepository: receipt(requested[0]!) }
        : { oldRepository: receipt(requested[0]!), newRepository: receipt(requested[1]!) }) };
  } catch (error) {
    if (connectionId) await ctx.input.api.delete(`/api/tool-connections/${connectionId}`, { allowNotFound: true });
    await ctx.input.api.delete(`/api/secrets/${secret.id}`, { allowNotFound: true });
    throw error;
  }
}
/** Keep broad authorized metadata discovery private. Public case observations
 * retain only the selected resources and this actual connection's attribution. */
export function projectRequestedRepositories(
  repositories: readonly Repository[],
  requested: readonly { id: string; fullName: string }[],
  connectionId: string,
): Repository[] {
  return repositories.filter(row => requested.some(target => target.id === row.id && target.fullName === row.fullName)
    && row.url === `https://github.com/${row.fullName}` && row.connectionIds?.includes(connectionId))
    .map(row => ({ id: row.id, fullName: row.fullName, url: row.url, connectionIds: [connectionId] }));
}
async function agentReplacementStatus(ctx: ChatCatalogContext, projectId: string, repositoryId: string) {
  const agentId = ctx.input.fixtures.agent.id;
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${agentId}/keys`, { name: "repository-replacement-boundary-control" });
  ctx.input.privateSecrets?.push(key.token);
  try {
    const response = await fetch(new URL(`/api/projects/${projectId}/repositories`, ctx.input.api.baseURL), {
      method: "PUT", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ repositoryIds: [repositoryId] }),
    });
    await response.body?.cancel(); return response.status;
  } finally { await ctx.input.api.delete(`/api/agents/${agentId}/keys/${key.id}`); }
}
function affirmativeCheckoutClaim(reply: string) {
  return reply.split(/[.\n;]/).some(part => !/\b(?:not|no|without|yet|only|metadata)\b/i.test(part)
    && /\b(?:cloned|checked out|checkout is ready|repository is ready|website is ready|deployed|workspaces? (?:have|has) (?:moved|switched))\b/i.test(part));
}
export function gradeRepositories(value: unknown) {
  const c = checks(); const o = observation(value) as RepositoryObservation | undefined;
  c.add("independent-current-repository-evidence", !!o && Array.isArray(o.repositories) && !!o.connection,
    "Actual current-connection repository discovery and saved project workspaces are required.");
  if (!o || !Array.isArray(o.repositories) || !o.connection) return c.result();
  const requested = o.state.requested as Array<{ id: string; fullName: string }>;
  c.add("authorized-current-connection", o.connection.id === o.state.connectionId && o.connection.enabled && o.connection.status === "active"
    && Array.isArray(requested) && requested.every(expected => o.repositories.some(row => row.id === expected.id && row.fullName === expected.fullName
      && row.connectionIds?.includes(o.connection.id))), "The actual active fixture connection still authorizes each intended repository.");
  const p = o.repositoryProject; const selected = repositoriesOf(p);
  const desired = requested?.[o.scenarioId === "projects.add-repository" ? 0 : 1];
  c.add("exact-supported-repository-selection", !!p && p.companyId === o.companyId && p.name === "Launch" && selected.length === 1 && !!desired
    && selected[0]?.repoUrl === `https://github.com/${desired.fullName}`
    && (!selected[0]?.metadata?.githubRepositoryId || selected[0].metadata.githubRepositoryId === desired.id)
    && p.workspaces.every(row => !row.cwd && !/\b(?:token|password)\b|https:\/\/[^/]*@/i.test(row.repoUrl ?? "")),
    "The exact authorized repository persists without operator filesystem paths or embedded credentials.");
  if (o.scenarioId === "projects.add-repository") {
    c.add("agent-created-intended-project", !!p && o.projects.filter(row => row.name === "Launch").length === 1 && o.tasks.length === 0
      && o.activity.some(row => row.entityId === p.id && row.action === "project.created" && row.agentId === o.leadId),
      "One intended Launch project is created by the CEO through the supported path.");
    c.add("metadata-is-not-ready-checkout", !affirmativeCheckoutClaim(o.reply), "Chat distinguishes recorded repository metadata from actual checkout or deployment readiness.");
  } else {
    const before = o.state.beforeOwnerReplacement as { project: RepositoryProject; reply: string; agentStatus: number } | undefined;
    c.add("agent-cannot-replace-existing-selection", !!before && before.agentStatus === 403 && repositoriesOf(before.project).length === 1
      && repositoriesOf(before.project)[0]?.repoUrl === `https://github.com/${requested[0]!.fullName}`
      && before.reply.includes(requested[0]!.fullName) && before.reply.includes(requested[1]!.fullName)
      && /\b(?:human|owner|you|board|administrator)\b/i.test(before.reply) && /\b(?:future|new work|next|existing|current workspaces)\b/i.test(before.reply)
      && !/\bI(?:'ve| have)?\s+(?:already\s+)?(?:switched|replaced|updated)\b/i.test(before.reply)
      && !new RegExp(`\\bnow (?:uses?|points? to)\\b[^.\\n]*${regexEscape(requested[1]!.fullName)}`, "i").test(before.reply)
      && !affirmativeCheckoutClaim(before.reply), "The first agent phase retains the old selection, explains the real human replacement path and its future-work scope.");
    c.add("real-owner-replacement", !!p && o.activity.some(row => row.action === "project.repositories_updated" && row.entityId === p.id
      && row.actorType === "user" && row.actorId === o.state.ownerId)
      && !o.activity.some(row => row.action === "project.repositories_updated" && row.agentId === o.leadId),
      "A real human UI action saves the new repository; ordinary agent mutation never bypasses the board boundary.");
    c.add("existing-work-retained", sameTask(entity(o.state, "task"), o.tasks.find(row => row.id === entity(o.state, "task").id)),
      "Repository selection does not rewrite the existing task or claim its execution has moved.");
  }
  return c.result();
}
async function openProject(ctx: ChatCatalogContext, o: RepositoryObservation) {
  const p = o.repositoryProject; if (!p) throw new Error("No saved repository project");
  const href = o.links.find(link => hasLink({ ...o, links: [link] }, "projects", p));
  if (href) await internalResultLink(ctx, o, href).first().click();
  else await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/projects/${p.urlKey ?? p.id}`, o.origin).href, { waitUntil: "domcontentloaded" });
  await expect(ctx.input.page.getByRole("heading", { name: p.name!, exact: true }).first()).toBeVisible();
  await ctx.input.page.getByText("Configuration", { exact: true }).last().click();
  const section = ctx.input.page.getByRole("region", { name: "Repositories", exact: true }); await expect(section).toBeVisible();
  return section;
}
function repositoryCase(scenarioId: string): ChatCatalogCase {
  const base = makeDefinition(scenarioId, async ctx => {
    const fixture = await connectRepositoryFixture(ctx);
    try {
      if (scenarioId === "projects.add-repository") return fixture;
      const session = await ctx.input.api.get<{ user?: { id: string } }>("/api/auth/get-session");
      if (!session.user?.id) throw new Error("Repository replacement requires a real owner browser session");
      const p = await project(ctx, "Launch", { repositoryIds: [fixture.requested[0]!.id] });
      const existing = await task(ctx, "Existing Launch work", p.id);
      return { ...fixture, project: p, task: existing, ownerId: session.user.id };
    } catch (error) {
      await ctx.input.api.delete(`/api/tool-connections/${fixture.connectionId}`, { allowNotFound: true });
      await ctx.input.api.delete(`/api/secrets/${fixture.secretId}`, { allowNotFound: true }); throw error;
    }
  }, gradeRepositories);
  return { ...base, authentication: "human-session", externalInput: externalRequirements[scenarioId], sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-repositories.ts", "chat-catalog-domains/external-fixtures.ts"],
    queryBindings: scenarioId === "projects.add-repository"
      ? [{ catalogToken: "acorn/site", stateKey: "siteRepository", resourceKind: "project-repository", valueField: "fullName" }]
      : [{ catalogToken: "acorn/site-old", stateKey: "oldRepository", resourceKind: "project-repository", valueField: "fullName" },
        { catalogToken: "acorn/site-new", stateKey: "newRepository", resourceKind: "project-repository", valueField: "fullName" }],
    async observe(ctx, state): Promise<RepositoryObservation> {
      const o = await observeInternal(ctx, state); const p = o.projects.find(row => row.id === (state.project as Entity | undefined)?.id)
        ?? o.projects.find(row => row.name === "Launch");
      const [options, connection] = await Promise.all([
        ctx.input.api.get<{ repositories: Repository[] }>(`/api/companies/${o.companyId}/project-repositories`),
        ctx.input.api.get<RepositoryObservation["connection"]>(`/api/tool-connections/${state.connectionId}`),
      ]);
      return { ...o, repositoryProject: p ? await ctx.input.api.get<RepositoryProject>(`/api/projects/${p.id}`) : undefined,
        repositories: projectRequestedRepositories(options.repositories, state.requested as Array<{ id: string; fullName: string }>, String(state.connectionId)), connection };
    },
    ...(scenarioId === "projects.replace-repository" ? { async act(ctx: ChatCatalogContext, state: Record<string, unknown>) {
      const first = await pollUntil({ label: "Repository owner handoff", deadlineAt: Date.now() + 150_000,
        load: () => observeInternal(ctx, state),
        accept: value => { const o = value as InternalObservation; return o.runs.length === 1 && o.runs.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting"; } }) as InternalObservation;
      const p = entity(state, "project"); const requested = state.requested as Array<{ id: string; fullName: string }>;
      const saved = await ctx.input.api.get<RepositoryProject>(`/api/projects/${p.id}`);
      const status = await agentReplacementStatus(ctx, p.id, requested[1]!.id);
      state.beforeOwnerReplacement = { project: saved, reply: first.reply, agentStatus: status };
      await ctx.input.evidence("chat-catalog-before-owner-repository-replacement.json", state.beforeOwnerReplacement);
      if (status !== 403 || repositoriesOf(saved)[0]?.repoUrl !== `https://github.com/${requested[0]!.fullName}`) throw new Error("Existing repository changed before an authorized owner action");
      const source = ctx.input.page.url();
      const section = await openProject(ctx, { ...first, repositoryProject: saved } as RepositoryObservation);
      await section.getByRole("button", { name: `Remove ${requested[0]!.fullName}`, exact: true }).click();
      await section.getByRole("button", { name: "Add GitHub repo", exact: true }).click();
      await section.getByRole("combobox").click();
      await ctx.input.page.getByPlaceholder("Search GitHub repos…", { exact: true }).fill(requested[1]!.fullName);
      await ctx.input.page.getByRole("option", { name: new RegExp(`(?:^|\\s)${regexEscape(requested[1]!.fullName)}(?:\\s|$)`) }).click();
      await section.getByRole("button", { name: "Save changes", exact: true }).click();
      await pollUntil({ label: "Saved owner repository replacement", deadlineAt: Date.now() + 30_000,
        load: () => ctx.input.api.get<RepositoryProject>(`/api/projects/${p.id}`), accept: value => repositoriesOf(value).length === 1 && repositoriesOf(value)[0]?.repoUrl === `https://github.com/${requested[1]!.fullName}` });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    } } : {}),
    async verifyResult(ctx, _state, value) {
      const o = value as RepositoryObservation; const source = ctx.input.page.url(); const section = await openProject(ctx, o);
      const desired = (o.state.requested as Array<{ fullName: string }>)[scenarioId === "projects.add-repository" ? 0 : 1]!;
      await expect(section.getByText(desired.fullName, { exact: true }).first()).toBeVisible();
      await ctx.input.evidence("chat-catalog-repository-project-opened.json", { projectId: o.repositoryProject!.id, repository: desired.fullName, url: ctx.input.page.url() });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    },
    async cleanup(ctx, state) {
      if (state.connectionId) await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`, { allowNotFound: true });
      if (state.secretId) await ctx.input.api.delete(`/api/secrets/${state.secretId}`, { allowNotFound: true });
    },
  };
}
export const repositoryProjectCases: readonly ChatCatalogCase[] = [repositoryCase("projects.add-repository"), repositoryCase("projects.replace-repository")];
