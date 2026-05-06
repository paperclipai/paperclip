import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "cursor_sdk";
export const label = "Cursor SDK";

export const DEFAULT_CURSOR_SDK_MODEL = "auto";
export const DEFAULT_CURSOR_SDK_RUNTIME: CursorSdkRuntime = "local";

export type CursorSdkRuntime = "local" | "cloud" | "self_hosted";

// Mirrors the cursor-local fallback list. Used as the offline catalog when
// Cursor.models.list() cannot be reached. Keep in sync with cursor-local until
// we extract a shared package.
const CURSOR_SDK_FALLBACK_MODEL_IDS = [
  "auto",
  "composer-2",
  "composer-1.5",
  "composer-1",
  "gpt-5.5",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-high",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "opus-4.6",
  "opus-4.6-thinking",
  "opus-4.5",
  "sonnet-4.6",
  "sonnet-4.6-thinking",
  "sonnet-4.5",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
  "kimi-k2.5",
];

export const models = CURSOR_SDK_FALLBACK_MODEL_IDS.map((id) => ({ id, label: id }));

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Cursor's known Codex mini model as the budget lane instead of assuming auto is cheap.",
    adapterConfig: {
      model: "gpt-5.1-codex-mini",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# cursor_sdk agent configuration

Adapter: cursor_sdk

Use when:
- You want Paperclip to drive Cursor agents through the official @cursor/sdk
- You want one adapter that can run agents locally OR in Cursor-managed cloud VMs
- You want richer streaming events than the cursor-agent CLI exposes (thinking, tool_call, task, request, status)
- You want typed errors, native cancellation, and session resume via Agent.resume()

Don't use when:
- You only need the cursor-agent CLI behavior — keep using the existing "cursor" adapter
- You need webhook-style external invocation (use openclaw_gateway or http)
- @cursor/sdk is not installed in this Paperclip server's node_modules

Core fields:
- runtime (string, optional): "local" | "cloud" | "self_hosted" (default "local")
- model (string, optional): Cursor model id, or empty to let the SDK pick
- modelParams (object, optional): { id: value } pairs forwarded to the SDK as ModelParameterValue[]
- promptTemplate (string, optional): run prompt template
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- timeoutSec (number, optional, default 0): adapter-side wait timeout for run.wait()
- graceSec (number, optional, default 20): grace window applied around cancellation
- env.CURSOR_API_KEY (required, secret_ref preferred): authenticates the SDK

Runtime "local":
- cwd (string, optional): working directory for the in-process agent (defaults to Paperclip workspace cwd)
- settingSources (string[], optional, default ["project","user","plugins"]): which Cursor setting sources to load
- sandbox (boolean, optional, default false): enable the SDK's sandbox option

Runtime "cloud" / "self_hosted":
- repository (string, required): primary GitHub repo URL (mapped to cloud.repos[0].url)
- ref (string, optional, default "main"): starting ref (mapped to startingRef)
- additionalRepos (object[], optional): extra { url, startingRef? } entries appended to cloud.repos
- workOnCurrentBranch (boolean, optional, default false)
- autoCreatePr (boolean, optional, default false)
- skipReviewerRequest (boolean, optional, default false)
- vmEnv.type (string, optional, default "cloud"): "cloud" | "pool" | "machine"
- vmEnv.name (string, required when vmEnv.type !== "cloud")
- sessionEnvVars (object, optional): { KEY: value } forwarded as cloud.envVars (encrypted at rest, cannot start with CURSOR_)

Advanced:
- mcpServers (object, optional): forwarded to the SDK as-is. NOTE: not persisted across Agent.resume(); re-pass on resume.
- subagents (object, optional): { name: { description, prompt, model?, mcpServers? } } forwarded as the SDK's "agents" field.

Notes:
- The SDK runs in-process; there is no spawned subprocess to log. The adapter calls onMeta with adapter/runtime/model/cwd/prompt info.
- SDK stream events (system/user/assistant/thinking/tool_call/status/task/request) are emitted to onLog as one JSON object per stdout line, parsable by both this adapter's UI parser and (for overlapping shapes) the cursor-local parser.
- Sessions are resumed by SDK Agent.resume(agentId, ...) when the stored session identity matches the current runtime (cwd for local; repository for cloud/self_hosted).
- Cancellation is wired via run.cancel() + agent[Symbol.asyncDispose]() within the timeout/grace budget.
- Token usage and cost are not exposed by the SDK in V1; both fields stay null.
`;
