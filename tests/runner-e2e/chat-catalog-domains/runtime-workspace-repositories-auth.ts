import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Cookie } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ConnectionGrant, ToolConnection, ToolConnectionInstall } from "../../../packages/shared/src/types/tool-access.js";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import { selectedExternalBinding, selectedExternalCredential } from "./external-fixtures.js";
import { digest } from "./runtime-workspace-repositories-support.js";
export const humanAuthReference = "PAPERCLIP_CHAT_EVAL_GITHUB_HUMAN_AUTH";
export interface HumanGitHubAuth { clientId: string; clientSecret: string; appSlug: string; installationId: string; storageState: { cookies: Cookie[]; origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> } }
export interface GitHubAppQualification { id: number; slug: string; client_id: string; name: string; permissions: Record<string, string>; html_url: string }
export function parseHumanGitHubAuth(value: string): HumanGitHubAuth {
  let auth: HumanGitHubAuth;
  try { if (value.length > 220000) throw new Error(); auth = JSON.parse(value) as HumanGitHubAuth; } catch { throw new Error("Setup blocker: private GitHub human session/client bundle is invalid"); }
  if (!auth || Object.keys(auth).sort().join(",") !== "appSlug,clientId,clientSecret,installationId,storageState" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(auth.appSlug)
    || !/^[1-9][0-9]{0,19}$/.test(auth.installationId) || !/^[a-zA-Z0-9._-]{8,120}$/.test(auth.clientId) || typeof auth.clientSecret !== "string" || auth.clientSecret.length < 16 || auth.clientSecret.length > 256
    || !Array.isArray(auth.storageState?.cookies) || !auth.storageState.cookies.length || auth.storageState.cookies.length > 100 || !Array.isArray(auth.storageState.origins)
    || auth.storageState.cookies.some(cookie => !["github.com", ".github.com"].includes(cookie.domain) || typeof cookie.value !== "string" || !cookie.value || !cookie.name)
    || auth.storageState.origins.some(origin => origin.origin !== "https://github.com" || !Array.isArray(origin.localStorage))) throw new Error("Setup blocker: require a genuine GitHub-only human session and bounded customer-owned OAuth client");
  return auth;
}
export function qualifiesReadOnlyApp(app: GitHubAppQualification, auth: Pick<HumanGitHubAuth, "appSlug" | "clientId">) {
  return Number.isSafeInteger(app.id) && app.id > 0 && app.slug === auth.appSlug && app.client_id === auth.clientId
    && typeof app.name === "string" && !!app.name && app.html_url === `https://github.com/apps/${auth.appSlug}`
    && app.permissions?.contents === "read" && Object.values(app.permissions).every(permission => permission === "read" || permission === "none");
}
export interface ReadOnlyGitHubGrant {
  appId: number; appSlug: string; appClientSha256: string; appMetadataSha256: string;
  connectionId: string; grantId: string; personId: string; workerId: string; installationId: string; repositoryId: string; repositoryFullName: string;
  interactionId: string; providerUserId: string; providerLogin: string; readonlyAppVerified: true; selectedRepositoryVerified: true;
  actualProviderConsent: true; actualInstallationSelection: true; genuineHumanSession: true; uiCompletionObserved: true; workerPausedBeforeConsent: true;
  isolatedPrivateBrowser: true; tracingEnabled: false; videoEnabled: false; testRunnerAttached: false;
}
export function qualifiesReadOnlyGrant(input: { companyId: string; personId: string; workerId: string; repositoryId: string; repositoryFullName: string; app: GitHubAppQualification; auth: Pick<HumanGitHubAuth, "appSlug" | "clientId">;
  connection: ToolConnection; grant: ConnectionGrant; installs: ToolConnectionInstall[]; interaction: ConnectionIntentInteraction }) {
  const { grant: g, connection: c, interaction: i } = input, github = g.providerTenant?.github;
  return qualifiesReadOnlyApp(input.app, input.auth) && c.companyId === input.companyId && c.status === "active" && c.enabled && c.credentialPolicy === "per_user"
    && c.config?.sourceTemplateKey === "github" && (c.config.oauth as { clientId?: string } | undefined)?.clientId === input.auth.clientId
    && g.companyId === input.companyId && g.connectionId === c.id && g.status === "active" && g.kind === "user" && g.subjectUserId === input.personId
    && !!github && github.appSlug === input.app.slug && github.installationCount === 1 && github.repositoryCount === 1 && github.repositorySelection === "selected"
    && github.installationIds.length === 1 && github.repositories?.length === 1 && github.repositories[0]?.id === input.repositoryId
    && github.repositories[0]?.fullName === input.repositoryFullName && github.repositories[0]?.private === true && github.repositories[0]?.installationId === github.installationIds[0]
    && input.installs.length === 1 && input.installs[0]?.connectionId === c.id && input.installs[0]?.targetType === "agent" && input.installs[0]?.targetId === input.workerId
    && i.kind === "connection_intent" && i.payload.serviceSlug === "github" && i.status === "accepted" && i.addresseeUserId === input.personId && i.resolvedByUserId === input.personId && !i.resolvedByAgentId
    && i.result?.outcome === "connected" && i.result.connectionId === c.id;
}
export interface GitHubHumanRequest { origin: string; companyId: string; issuePrefix: string; taskId: string; workerId: string; interactionId: string; personId: string; repositoryId: string; repositoryFullName: string; auth: HumanGitHubAuth; cookies: Cookie[]; deadlineAt: number }
export async function completeHumanGitHubGrant(ctx: ChatCatalogContext, input: Omit<GitHubHumanRequest, "auth" | "cookies" | "origin" | "deadlineAt">): Promise<ReadOnlyGitHubGrant> {
  const binding = selectedExternalBinding(ctx);
  if (binding.prerequisites.humanAuthEnv !== humanAuthReference || !binding.credentialEnv.includes(humanAuthReference)) throw new Error(`Setup blocker: humanAuthEnv must explicitly declare ${humanAuthReference}`);
  const auth = parseHumanGitHubAuth(selectedExternalCredential(ctx, binding, "humanAuthEnv"));
  if (!ctx.input.privateSecrets) throw new Error("Private GitHub human grant requires its attempt redaction sink");
  const cookies = await ctx.input.page.context().cookies();
  ctx.input.privateSecrets.push(auth.clientSecret, ...auth.storageState.cookies.map(cookie => cookie.value), ...auth.storageState.origins.flatMap(origin => origin.localStorage.map(row => row.value)), ...cookies.map(cookie => cookie.value));
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-repository-human-"));
  try {
    const request = path.join(directory, "request.json"), channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
    await writeFile(request, JSON.stringify({ ...input, origin: ctx.input.api.baseURL, auth, cookies, deadlineAt: Date.now() + 420000,
      executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? (channel ? undefined : chromium.executablePath()), channel }), { mode: 0o600 });
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("./runtime-workspace-repositories-auth-worker.ts", import.meta.url)), request],
      { timeout: 425000, maxBuffer: 32768, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DO_NOT_TRACK: "1", HOME: directory, TMPDIR: directory } })).stdout; }
    catch { throw new Error("GitHub human authorization prerequisite or UI completion failed; private child diagnostics withheld"); }
    let receipt: ReadOnlyGitHubGrant;
    try { receipt = JSON.parse(output) as ReadOnlyGitHubGrant; } catch { throw new Error("Invalid closed human GitHub grant receipt"); }
    if (receipt.interactionId !== input.interactionId || receipt.personId !== input.personId || receipt.workerId !== input.workerId || receipt.repositoryId !== input.repositoryId || receipt.repositoryFullName !== input.repositoryFullName
      || receipt.appSlug !== auth.appSlug || receipt.appClientSha256 !== digest(auth.clientId) || receipt.readonlyAppVerified !== true || receipt.selectedRepositoryVerified !== true
      || receipt.actualProviderConsent !== true || receipt.actualInstallationSelection !== true || receipt.genuineHumanSession !== true || receipt.uiCompletionObserved !== true || receipt.workerPausedBeforeConsent !== true
      || receipt.isolatedPrivateBrowser !== true || receipt.tracingEnabled !== false || receipt.videoEnabled !== false || receipt.testRunnerAttached !== false
      || Object.keys(receipt).sort().join(",") !== "actualInstallationSelection,actualProviderConsent,appClientSha256,appId,appMetadataSha256,appSlug,connectionId,genuineHumanSession,grantId,installationId,interactionId,isolatedPrivateBrowser,personId,providerLogin,providerUserId,readonlyAppVerified,repositoryFullName,repositoryId,selectedRepositoryVerified,testRunnerAttached,tracingEnabled,uiCompletionObserved,videoEnabled,workerId,workerPausedBeforeConsent") throw new Error("Invalid closed human GitHub grant receipt");
    return receipt;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
