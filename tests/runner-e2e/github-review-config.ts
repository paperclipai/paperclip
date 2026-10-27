import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConnectionBlock, parseConnectionConfig, targetOrigin, type ConnectionConfig } from "./connection-config.js";
import { parseJourneyCredentialBinding, type JourneyCredentialBinding } from "./journey-dependencies.js";

export interface GitHubReviewJourneyConfig {
  version: 1;
  setupId: string;
  hosting: "self-hosted" | "paperclip-cloud";
  executionEnvironment: "local" | "daytona";
  target: Extract<ConnectionConfig["target"], { mode: "attach" }> & { companyId: string; environmentId: string };
  browser: ConnectionConfig["browser"];
  authentication?: { module: string; configFile: string };
  agent: { id: string; name: string; skill: string; model: string; provider: string; runtimeMode: "native" | "legacy" };
  github: { repository: string; ownerType: "personal" | "organization"; appOwner: string; account: string; login: "passkey" | "password"; username: JourneyCredentialBinding; password?: JourneyCredentialBinding };
  deadlineMs: number;
  maximumRuns: number;
}

const invalid = (): never => { throw new ConnectionBlock("blocked_target", "invalid_github_journey_configuration"); };
function object(v: unknown, keys: string[]): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) return invalid();
  return v as Record<string, any>;
}
function text(v: unknown, pattern?: RegExp): string {
  if (typeof v !== "string" || !v.trim() || v.length > 1024 || (pattern && !pattern.test(v))) return invalid();
  return v;
}
export function parseGitHubReviewJourneyConfig(input: unknown): GitHubReviewJourneyConfig {
  try {
    const v = object(input, ["version", "setupId", "hosting", "executionEnvironment", "target", "browser", "authentication", "agent", "github", "deadlineMs", "maximumRuns"]);
    if (v.version !== 1 || !["self-hosted", "paperclip-cloud"].includes(v.hosting)) return invalid();
    if (v.executionEnvironment !== undefined && !["local", "daytona"].includes(v.executionEnvironment)) return invalid();
    const target = object(v.target, ["mode", "baseURL", "expectedCommit", "deploymentMode", "companyId", "environmentId"]);
    if (target.mode !== "attach") return invalid();
    const common = parseConnectionConfig({ target, browser: v.browser });
    if (common.target.mode !== "attach" || !common.browser.profileDir) return invalid();
    const agent = object(v.agent, ["id", "name", "skill", "model", "provider", "runtimeMode"]);
    const github = object(v.github, ["repository", "ownerType", "appOwner", "account", "login", "username", "password"]);
    if (!["personal", "organization"].includes(github.ownerType) || !["passkey", "password"].includes(github.login)
      || !["native", "legacy"].includes(agent.runtimeMode) || (github.login === "password" && !github.password)) return invalid();
    const deadlineMs = v.deadlineMs ?? 900_000; const maximumRuns = v.maximumRuns ?? 3;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 60_000 || deadlineMs > 1_800_000
      || !Number.isInteger(maximumRuns) || maximumRuns < 1 || maximumRuns > 5) return invalid();
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    const authentication = v.authentication === undefined ? undefined : object(v.authentication, ["module", "configFile"]);
    if (authentication && (!path.isAbsolute(text(authentication.module)) || !path.isAbsolute(text(authentication.configFile)))) return invalid();
    return { version: 1, setupId: text(v.setupId, /^[a-z0-9-]{1,80}$/), hosting: v.hosting, executionEnvironment: v.executionEnvironment ?? "local",
      target: { ...common.target, baseURL: targetOrigin(common.target.baseURL), companyId: text(target.companyId, uuid), environmentId: text(target.environmentId, uuid) }, browser: common.browser,
      ...(authentication ? { authentication: { module: authentication.module, configFile: authentication.configFile } } : {}),
      agent: { id: text(agent.id, uuid), name: text(agent.name), skill: text(agent.skill, /^[a-z0-9-]+$/), model: text(agent.model), provider: text(agent.provider), runtimeMode: agent.runtimeMode },
      github: { repository: text(github.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), ownerType: github.ownerType, appOwner: text(github.appOwner, /^[A-Za-z0-9-]+$/),
        account: text(github.account ?? (github.ownerType === "personal" ? github.appOwner : undefined), /^[A-Za-z0-9-]+$/), login: github.login,
        username: parseJourneyCredentialBinding(github.username), ...(github.password ? { password: parseJourneyCredentialBinding(github.password) } : {}) }, deadlineMs, maximumRuns };
  } catch { return invalid(); }
}

export async function loadGitHubReviewJourneyConfig(file?: string) {
  if (!file) throw new ConnectionBlock("blocked_target", "github_journey_config_required");
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.browser?.profileDir?.startsWith("~/")) value.browser.profileDir = path.join(os.homedir(), value.browser.profileDir.slice(2));
    // Profile paths are relative to the profile, not the invoking checkout.
    if (value.browser?.profileDir && !path.isAbsolute(value.browser.profileDir)) value.browser.profileDir = path.resolve(path.dirname(file), value.browser.profileDir);
    for (const key of ["module", "configFile"]) if (value.authentication?.[key] && !path.isAbsolute(value.authentication[key])) value.authentication[key] = path.resolve(path.dirname(file), value.authentication[key]);
    return parseGitHubReviewJourneyConfig(value);
  } catch { throw new ConnectionBlock("blocked_target", "invalid_github_journey_configuration"); }
}
