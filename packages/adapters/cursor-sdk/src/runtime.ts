import { asString, asNumber, asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type {
  SdkAgentCreateOptions,
  SdkCloudRepo,
  SdkCloudRuntime,
  SdkLocalRuntime,
  SdkModelParameterValue,
  SdkModelSelection,
  SdkSettingSource,
} from "./sdk-types.js";
import {
  DEFAULT_CURSOR_SDK_MODEL,
  DEFAULT_CURSOR_SDK_RUNTIME,
  type CursorSdkRuntime,
} from "./index.js";

const VALID_RUNTIMES: ReadonlySet<CursorSdkRuntime> = new Set(["local", "cloud", "self_hosted"]);
const VALID_SETTING_SOURCES: ReadonlySet<SdkSettingSource> = new Set([
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
  "all",
]);
const VALID_VM_ENV_TYPES = new Set(["cloud", "pool", "machine"]);

export interface ResolvedRuntimeOptions {
  runtime: CursorSdkRuntime;
  model: string;
  modelSelection: SdkModelSelection | undefined;
  sdkOptions: SdkAgentCreateOptions;
  effectiveCwd: string;
  effectiveRepository: string;
  effectiveRef: string;
  identity: { kind: "local"; cwd: string } | { kind: "cloud"; repository: string };
  validationErrors: string[];
}

export interface BuildRuntimeInput {
  config: Record<string, unknown>;
  /** Workspace cwd resolved by Paperclip from context.paperclipWorkspace. */
  workspaceCwd: string;
  /** Workspace repo URL resolved by Paperclip from context.paperclipWorkspace. */
  workspaceRepoUrl: string;
  /** Workspace repo ref resolved by Paperclip from context.paperclipWorkspace. */
  workspaceRepoRef: string;
  /** Resolved CURSOR_API_KEY (after secret resolution). Empty string when missing. */
  apiKey: string;
  /** Session env vars to forward to the cloud VM (already secret-resolved). */
  sessionEnvVars: Record<string, string>;
}

export function resolveRuntimeKind(value: unknown): CursorSdkRuntime {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (VALID_RUNTIMES.has(raw as CursorSdkRuntime)) return raw as CursorSdkRuntime;
  return DEFAULT_CURSOR_SDK_RUNTIME;
}

function resolveSettingSources(value: unknown): SdkSettingSource[] | undefined {
  const arr = asStringArray(value);
  if (arr.length === 0) return undefined;
  const filtered = arr
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is SdkSettingSource => VALID_SETTING_SOURCES.has(entry as SdkSettingSource));
  return filtered.length > 0 ? filtered : undefined;
}

function resolveModelSelection(model: string, modelParams: Record<string, unknown>): SdkModelSelection | undefined {
  const id = model.trim();
  if (!id || id.toLowerCase() === "auto") return undefined;
  const params: SdkModelParameterValue[] = [];
  for (const [key, value] of Object.entries(modelParams)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof value === "string" && value.trim().length > 0) {
      params.push({ id: key.trim(), value: value.trim() });
    } else if (typeof value === "number") {
      params.push({ id: key.trim(), value: String(value) });
    } else if (typeof value === "boolean") {
      params.push({ id: key.trim(), value: value ? "true" : "false" });
    }
  }
  return params.length > 0 ? { id, params } : { id };
}

function isValidEnvKey(key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (key.startsWith("CURSOR_")) return false; // SDK rule for cloud envVars
  return true;
}

function sanitizeCloudEnvVars(envVars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (!isValidEnvKey(key)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function resolveAdditionalRepos(value: unknown): SdkCloudRepo[] {
  if (!Array.isArray(value)) return [];
  const out: SdkCloudRepo[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const url = asString(rec.url, "").trim();
    if (!url) continue;
    const startingRef = asString(rec.startingRef ?? rec.ref, "").trim();
    out.push({ url, ...(startingRef ? { startingRef } : {}) });
  }
  return out;
}

export function buildRuntimeOptions(input: BuildRuntimeInput): ResolvedRuntimeOptions {
  const { config, workspaceCwd, workspaceRepoUrl, workspaceRepoRef, apiKey, sessionEnvVars } = input;

  const runtime = resolveRuntimeKind(config.runtime);
  const model = asString(config.model, DEFAULT_CURSOR_SDK_MODEL);
  const modelParams = parseObject(config.modelParams);
  const modelSelection = resolveModelSelection(model, modelParams);
  const validationErrors: string[] = [];

  const sdkOptions: SdkAgentCreateOptions = {};
  if (apiKey) sdkOptions.apiKey = apiKey;
  if (modelSelection) sdkOptions.model = modelSelection;

  // mcpServers and subagents are forwarded as-is when present; the SDK validates shape.
  const mcpServers = parseObject(config.mcpServers);
  if (Object.keys(mcpServers).length > 0) sdkOptions.mcpServers = mcpServers;

  const subagents = parseObject(config.subagents);
  if (Object.keys(subagents).length > 0) sdkOptions.agents = subagents;

  let effectiveCwd = "";
  let effectiveRepository = "";
  let effectiveRef = "";
  let identity: ResolvedRuntimeOptions["identity"];

  if (runtime === "local") {
    const cwd = asString(config.cwd, "").trim() || workspaceCwd.trim() || "";
    if (!cwd) {
      validationErrors.push("cursor_sdk: runtime=local requires a workspace cwd or config.cwd.");
    }
    const local: SdkLocalRuntime = {};
    if (cwd) local.cwd = cwd;
    const settingSources = resolveSettingSources(config.settingSources)
      ?? (["project", "user", "plugins"] as SdkSettingSource[]);
    local.settingSources = settingSources;
    if (config.sandbox === true) local.sandboxOptions = { enabled: true };
    sdkOptions.local = local;
    effectiveCwd = cwd;
    identity = { kind: "local", cwd };
  } else {
    const repository = asString(config.repository, "").trim() || workspaceRepoUrl.trim();
    const ref = asString(config.ref, "").trim() || workspaceRepoRef.trim() || "main";
    if (!repository) {
      validationErrors.push(
        `cursor_sdk: runtime=${runtime} requires "repository" (config.repository or workspace.repoUrl).`,
      );
    }

    const repos: SdkCloudRepo[] = [];
    if (repository) {
      repos.push({ url: repository, startingRef: ref });
    }
    repos.push(...resolveAdditionalRepos(config.additionalRepos));

    const cloud: SdkCloudRuntime = {
      repos,
      workOnCurrentBranch: config.workOnCurrentBranch === true,
      autoCreatePR: config.autoCreatePr === true,
      skipReviewerRequest: config.skipReviewerRequest === true,
    };

    const vmEnv = parseObject(config.vmEnv);
    const vmEnvType = asString(vmEnv.type, runtime === "self_hosted" ? "pool" : "cloud").trim().toLowerCase();
    const vmEnvName = asString(vmEnv.name, "").trim();
    if (VALID_VM_ENV_TYPES.has(vmEnvType)) {
      if (vmEnvType !== "cloud" && !vmEnvName) {
        validationErrors.push(
          `cursor_sdk: vmEnv.name is required when vmEnv.type="${vmEnvType}".`,
        );
      }
      cloud.env = {
        type: vmEnvType as "cloud" | "pool" | "machine",
        ...(vmEnvName ? { name: vmEnvName } : {}),
      };
    }

    const cleanSessionEnv = sanitizeCloudEnvVars(sessionEnvVars);
    if (Object.keys(cleanSessionEnv).length > 0) cloud.envVars = cleanSessionEnv;

    sdkOptions.cloud = cloud;
    effectiveRepository = repository;
    effectiveRef = ref;
    identity = { kind: "cloud", repository };
  }

  // timeoutSec/graceSec are consumed by execute(), not passed to the SDK.
  void asNumber(config.timeoutSec, 0);
  void asNumber(config.graceSec, 20);

  return {
    runtime,
    model,
    modelSelection,
    sdkOptions,
    effectiveCwd,
    effectiveRepository,
    effectiveRef,
    identity,
    validationErrors,
  };
}
