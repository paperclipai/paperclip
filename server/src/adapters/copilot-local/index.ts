import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { listCopilotSkills, syncCopilotSkills } from "./skills.js";
import { testEnvironment } from "./test.js";

export const models = [
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to run GitHub Copilot CLI locally on the host machine
- You want resumable Copilot sessions across heartbeats with --resume
- You want Copilot to discover Paperclip skills from its own ~/.copilot/skills directory

Don't use when:
- GitHub Copilot CLI is not installed or not authenticated on the host
- You need a simple non-agent shell command without a coding assistant loop (use process)
- You need webhook-style remote invocation instead of a local CLI runtime (use http or openclaw_gateway)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Copilot CLI model id. Defaults to claude-sonnet-4.5.
- effort (string, optional): reasoning effort passed via --effort (low|medium|high|xhigh)
- autopilot (boolean, optional): when true, passes --autopilot (default: true)
- maxAutopilotContinues (number, optional): pass --max-autopilot-continues when greater than 0
- experimental (boolean, optional): when true, passes --experimental
- enableReasoningSummaries (boolean, optional): when true, passes --enable-reasoning-summaries
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use non-interactive prompt mode (-p) with JSON output (--output-format json).
- Paperclip always grants allow-all permissions for unattended runs and disables interactive ask_user prompts.
- Sessions resume with --resume when the stored session cwd and prompt bundle key match the current run.
- Paperclip injects desired local skills into ~/.copilot/skills/ via symlinks so Copilot can discover $paperclip and related skills without writing into the target workspace.
- Copilot continues to respect repo-scoped AGENTS.md and other Copilot instruction files in the active workspace.
`;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const promptBundleKey =
      readNonEmptyString(record.promptBundleKey) ?? readNonEmptyString(record.prompt_bundle_key);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    const promptBundleKey =
      readNonEmptyString(params.promptBundleKey) ?? readNonEmptyString(params.prompt_bundle_key);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

export {
  execute,
  listCopilotSkills,
  syncCopilotSkills,
  testEnvironment,
};
