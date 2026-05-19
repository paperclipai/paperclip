---
name: create-agent-adapter
description: >
  Technical guide for creating a new Paperclip agent adapter. Use when building
  a new adapter package, adding support for a new AI coding tool (e.g. a new
  CLI agent, API-based agent, or custom process), or when modifying the adapter
  system. Covers the required interfaces, module structure, registration points,
  and conventions derived from the existing claude-local and codex-local adapters.
---

# Creating a Paperclip Agent Adapter

An adapter bridges Paperclip's orchestration layer to a specific AI agent runtime (Claude Code, Codex CLI, a custom process, an HTTP endpoint, etc.). Each adapter is a self-contained package that provides implementations for **three consumers**: the server, the UI, and the CLI.

---

## 1. Architecture Overview

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models, agentConfigurationDoc)
    server/
      index.ts          # Server exports: execute, sessionCodec, parse helpers
      execute.ts        # Core execution logic (AdapterExecutionContext -> AdapterExecutionResult)
      parse.ts          # Stdout/result parsing for the agent's output format
    ui/
      index.ts          # UI exports: parseStdoutLine, buildConfig
      parse-stdout.ts   # Line-by-line stdout -> TranscriptEntry[] for the run viewer
      build-config.ts   # CreateConfigValues -> adapterConfig JSON for agent creation form
    cli/
      index.ts          # CLI exports: formatStdoutEvent
      format-event.ts   # Colored terminal output for `paperclipai run --watch`
  package.json
  tsconfig.json
```

Three separate registries consume adapter modules:

| Registry | Location | Interface |
|----------|----------|-----------|
| Server | `server/src/adapters/registry.ts` | `ServerAdapterModule` |
| UI | `ui/src/adapters/registry.ts` | `UIAdapterModule` |
| CLI | `cli/src/adapters/registry.ts` | `CLIAdapterModule` |

---

## 2. Shared Types (`@paperclipai/adapter-utils`)

All adapter interfaces live in `packages/adapter-utils/src/types.ts`. Import from `@paperclipai/adapter-utils` (types) or `@paperclipai/adapter-utils/server-utils` (runtime helpers).

### Core Interfaces

```ts
// The execute function signature — every adapter must implement this
interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;          // { id, companyId, name, adapterType, adapterConfig }
  runtime: AdapterRuntime;      // { sessionId, sessionParams, sessionDisplayId, taskKey }
  config: Record<string, unknown>;  // The agent's adapterConfig blob
  context: Record<string, unknown>; // Runtime context (taskId, wakeReason, approvalId, etc.)
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  authToken?: string;
}

interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: UsageSummary;           // { inputTokens, outputTokens, cachedInputTokens? }
  sessionId?: string | null;      // Legacy — prefer sessionParams
  sessionParams?: Record<string, unknown> | null;  // Opaque session state persisted between runs
  sessionDisplayId?: string | null;
  provider?: string | null;       // "anthropic", "openai", etc.
  model?: string | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;        // Human-readable summary of what the agent did
  clearSession?: boolean;         // true = tell Paperclip to forget the stored session
}

interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}
```

### Module Interfaces

```ts
// Server — registered in server/src/adapters/registry.ts
interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  sessionCodec?: AdapterSessionCodec;
  supportsLocalAgentJwt?: boolean;
  models?: { id: string; label: string }[];
  agentConfigurationDoc?: string;
}

// UI — registered in ui/src/adapters/registry.ts
interface UIAdapterModule {
  type: string;
  label: string;
  parseStdoutLine: (line: string, ts: string) => TranscriptEntry[];
  ConfigFields: ComponentType<AdapterConfigFieldsProps>;
  buildAdapterConfig: (values: CreateConfigValues) => Record<string, unknown>;
}

// CLI — registered in cli/src/adapters/registry.ts
interface CLIAdapterModule {
  type: string;
  formatStdoutEvent: (line: string, debug: boolean) => void;
}
```

---

## 2.1 Adapter Environment Test Contract

Every server adapter must implement `testEnvironment(...)`. This powers the board UI "Test environment" button in agent configuration.

```ts
type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string; // ISO timestamp
}

interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>; // runtime-resolved adapterConfig
}
```

Guidelines:

- Return structured diagnostics, never throw for expected findings.
- Use `error` for invalid/unusable runtime setup (bad cwd, missing command, invalid URL).
- Use `warn` for non-blocking but important situations.
- Use `info` for successful checks and context.

Severity policy is product-critical: warnings are not save blockers.  
Example: for `claude_local`, detected `ANTHROPIC_API_KEY` must be a `warn`, not an `error`, because Claude can still run (it just uses API-key auth instead of subscription auth).

---

## 3. Step-by-Step: Creating a New Adapter

### 3.1 Create the Package

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts
    server/index.ts
    server/execute.ts
    server/parse.ts
    ui/index.ts
    ui/parse-stdout.ts
    ui/build-config.ts
    cli/index.ts
    cli/format-event.ts
```

**package.json** — must use the four-export convention:

```json
{
  "name": "@paperclipai/adapter-<name>",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./ui": "./src/ui/index.ts",
    "./cli": "./src/cli/index.ts"
  },
  "dependencies": {
    "@paperclipai/adapter-utils": "workspace:*",
    "picocolors": "^1.1.1"
  },
  "devDependencies": {
    "typescript": "^5.7.3"
  }
}
```

### 3.2 Root `index.ts` — Adapter Metadata

This file is imported by **all three** consumers (server, UI, CLI). Keep it dependency-free (no Node APIs, no React).

```ts
export const type = "my_agent";        // snake_case, globally unique
export const label = "My Agent (local)";

export const models = [
  { id: "model-a", label: "Model A" },
  { id: "model-b", label: "Model B" },
];

export const agentConfigurationDoc = `# my_agent agent configuration
...document all config fields here...
`;
```

**Required exports:**
- `type` — the adapter type key, stored in `agents.adapter_type`
- `label` — human-readable name for the UI
- `models` — available model options for the agent creation form
- `agentConfigurationDoc` — markdown describing all `adapterConfig` fields (used by LLM agents configuring other agents)

**Writing `agentConfigurationDoc` as routing logic:**

The `agentConfigurationDoc` is read by LLM agents (including Paperclip agents that create other agents). Write it as **routing logic**, not marketing copy. Include concrete "use when" and "don't use when" guidance so an LLM can decide whether this adapter is appropriate for a given task.

```ts
export const agentConfigurationDoc = `# my_agent agent configuration

Adapter: my_agent

Use when:
- The agent needs to run MyAgent CLI locally on the host machine
- You need session persistence across runs (MyAgent supports thread resumption)
- The task requires MyAgent-specific tools (e.g. web search, code execution)

Don't use when:
- You need a simple one-shot script execution (use the "process" adapter instead)
- The agent doesn't need conversational context between runs (process adapter is simpler)
- MyAgent CLI is not installed on the host

Core fields:
- cwd (string, required): absolute working directory for the agent process
...
`;
```

Adding explicit negative cases improves adapter selection accuracy. One concrete anti-pattern is worth more than three paragraphs of description.

### 3.3 Server Module

#### `server/execute.ts` — The Core

This is the most important file. It receives an `AdapterExecutionContext` and must return an `AdapterExecutionResult`.

**Required behavior:**

1. **Read config** — extract typed values from `ctx.config` using helpers (`asString`, `asNumber`, `asBoolean`, `asStringArray`, `parseObject` from `@paperclipai/adapter-utils/server-utils`)
2. **Build environment** — call `buildPaperclipEnv(agent)` then layer in `PAPERCLIP_RUN_ID`, context vars (`PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`), user env overrides, and auth token
3. **Resolve session** — check `runtime.sessionParams` / `runtime.sessionId` for an existing session; validate it's compatible (e.g. same cwd); decide whether to resume or start fresh
4. **Render prompt** — use `renderTemplate(template, data)` with the template variables: `agentId`, `companyId`, `runId`, `company`, `agent`, `run`, `context`
5. **Call onMeta** — emit adapter invocation metadata before spawning the process
6. **Spawn the process** — use `runChildProcess()` for CLI-based agents or `fetch()` for HTTP-based agents
7. **Parse output** — convert the agent's stdout into structured data (session id, usage, summary, errors)
8. **Handle session errors** — if resume fails with "unknown session", retry with a fresh session and set `clearSession: true`
9. **Return AdapterExecutionResult** — populate all fields the agent runtime supports

**Environment variables the server always injects:**

| Variable | Source |
|----------|--------|
| `PAPERCLIP_AGENT_ID` | `agent.id` |
| `PAPERCLIP_COMPANY_ID` | `agent.companyId` |
| `PAPERCLIP_API_URL` | Server's own URL |
| `PAPERCLIP_RUN_ID` | Current run id |
| `PAPERCLIP_TASK_ID` | `context.taskId` or `context.issueId` |
| `PAPERCLIP_WAKE_REASON` | `context.wakeReason` |
| `PAPERCLIP_WAKE_COMMENT_ID` | `context.wakeCommentId` or `context.commentId` |
| `PAPERCLIP_APPROVAL_ID` | `context.approvalId` |
| `PAPERCLIP_APPROVAL_STATUS` | `context.approvalStatus` |
| `PAPERCLIP_LINKED_ISSUE_IDS` | `context.issueIds` (comma-separated) |
| `PAPERCLIP_API_KEY` | `authToken` (if no explicit key in config) |

#### `server/parse.ts` — Output Parser

Parse the agent's stdout format into structured data. Must handle:

- **Session identification** — extract session/thread ID from init events
- **Usage tracking** — extract token counts (input, output, cached)
- **Cost tracking** — extract cost if available
- **Summary extraction** — pull the agent's final text response
- **Error detection** — identify error states, extract error messages
- **Unknown session detection** — export an `is<Agent>UnknownSessionError()` function for retry logic

**Treat agent output as untrusted.** The stdout you're parsing comes from an LLM-driven process that may have executed arbitrary tool calls, fetched external content, or been influenced by prompt injection in the files it read. Parse defensively:
- Never `eval()` or dynamically execute anything from output
- Use safe extraction helpers (`asString`, `asNumber`, `parseJson`) — they return fallbacks on unexpected types
- Validate session IDs and other structured data before passing them through
- If output contains URLs, file paths, or commands, do not act on them in the adapter — just record them

#### `server/index.ts` — Server Exports

```ts
export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseMyAgentOutput, isMyAgentUnknownSessionError } from "./parse.js";

// Session codec — required for session persistence
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) { /* raw DB JSON -> typed params or null */ },
  serialize(params) { /* typed params -> JSON for DB storage */ },
  getDisplayId(params) { /* -> human-readable session id string */ },
};
```

#### `server/test.ts` — Environment Diagnostics

Implement adapter-specific preflight checks used by the UI test button.

Minimum expectations:

1. Validate required config primitives (paths, commands, URLs, auth assumptions)
2. Return check objects with deterministic `code` values
3. Map severity consistently (`info` / `warn` / `error`)
4. Compute final status:
   - `fail` if any `error`
   - `warn` if no errors and at least one warning
   - `pass` otherwise

This operation should be lightweight and side-effect free.

### 3.4 UI Module

#### `ui/parse-stdout.ts` — Transcript Parser

Converts individual stdout lines into `TranscriptEntry[]` for the run detail viewer. Must handle the agent's streaming output format and produce entries of these kinds:

- `init` — model/session initialization
- `assistant` — agent text responses
- `thinking` — agent thinking/reasoning (if supported)
- `tool_call` — tool invocations with name and input
- `tool_result` — tool results with content and error flag
- `user` — user messages in the conversation
- `result` — final result with usage stats
- `stdout` — fallback for unparseable lines

```ts
export function parseMyAgentStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Parse JSON line, map to appropriate TranscriptEntry kind(s)
  // Return [{ kind: "stdout", ts, text: line }] as fallback
}
```

#### `ui/build-config.ts` — Config Builder

Converts the UI form's `CreateConfigValues` into the `adapterConfig` JSON blob stored on the agent.

```ts
export function buildMyAgentConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.model) ac.model = v.model;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  // ... adapter-specific fields
  return ac;
}
```

#### UI Config Fields Component

Create `ui/src/adapters/<name>/config-fields.tsx` with a React component implementing `AdapterConfigFieldsProps`. This renders adapter-specific form fields in the agent creation/edit form.

Use the shared primitives from `ui/src/components/agent-config-primitives`:
- `Field` — labeled form field wrapper
- `ToggleField` — boolean toggle with label and hint
- `DraftInput` — text input with draft/commit behavior
- `DraftNumberInput` — number input with draft/commit behavior
- `help` — standard hint text for common fields

The component must support both `create` mode (using `values`/`set`) and `edit` mode (using `config`/`eff`/`mark`).

### 3.5 CLI Module

#### `cli/format-event.ts` — Terminal Formatter

Pretty-prints stdout lines for `paperclipai run --watch`. Use `picocolors` for coloring.

```ts
import pc from "picocolors";

export function printMyAgentStreamEvent(raw: string, debug: boolean): void {
  // Parse JSON line from agent stdout
  // Print colored output: blue for system, green for assistant, yellow for tools
  // In debug mode, print unrecognized lines in gray
}
```

---

## 4. Registration Checklist

After creating the adapter package, register it in all three consumers:

### 4.1 Server Registry (`server/src/adapters/registry.ts`)

```ts
import { execute as myExecute, sessionCodec as mySessionCodec } from "@paperclipai/adapter-my-agent/server";
import { agentConfigurationDoc as myDoc, models as myModels } from "@paperclipai/adapter-my-agent";

const myAgentAdapter: ServerAdapterModule = {
  type: "my_agent",
  execute: myExecute,
  sessionCodec: mySessionCodec,
  models: myModels,
  supportsLocalAgentJwt: true,  // true if agent can use Paperclip API
  agentConfigurationDoc: myDoc,
};

// Add to the adaptersByType map
const adaptersByType = new Map<string, ServerAdapterModule>(
  [..., myAgentAdapter].map((a) => [a.type, a]),
);
```

### 4.2 UI Registry (`ui/src/adapters/registry.ts`)

```ts
import { myAgentUIAdapter } from "./my-agent";

const adaptersByType = new Map<string, UIAdapterModule>(
  [..., myAgentUIAdapter].map((a) => [a.type, a]),
);
```

With `ui/src/adapters/my-agent/index.ts`:

```ts
import type { UIAdapterModule } from "../types";
import { parseMyAgentStdoutLine } from "@paperclipai/adapter-my-agent/ui";
import { MyAgentConfigFields } from "./config-fields";
import { buildMyAgentConfig } from "@paperclipai/adapter-my-agent/ui";

export const myAgentUIAdapter: UIAdapterModule = {
  type: "my_agent",
  label: "My Agent",
  parseStdoutLine: parseMyAgentStdoutLine,
  ConfigFields: MyAgentConfigFields,
  buildAdapterConfig: buildMyAgentConfig,
};
```

### 4.3 CLI Registry (`cli/src/adapters/registry.ts`)

```ts
import { printMyAgentStreamEvent } from "@paperclipai/adapter-my-agent/cli";

const myAgentCLIAdapter: CLIAdapterModule = {
  type: "my_agent",
  formatStdoutEvent: printMyAgentStreamEvent,
};

// Add to the adaptersByType map
```

---

## 5. Session Management — Designing for Long Runs

Sessions allow agents to maintain conversation context across runs. The system is **codec-based** — each adapter defines how to serialize/deserialize its session state.

**Design for long runs from the start.** Treat session reuse as the default primitive, not an optimization to add later. An agent working on an issue may be woken dozens of times — for the initial assignment, approval callbacks, re-assignments, manual nudges. Each wake should resume the existing conversation so the agent retains full context about what it has already done, what files it has read, and what decisions it has made. Starting fresh each time wastes tokens on re-reading the same files and risks contradictory decisions.

**Key concepts:**
- `sessionParams` is an opaque `Record<string, unknown>` stored in the DB per task
- The adapter's `sessionCodec.serialize()` converts execution result data to storable params
- `sessionCodec.deserialize()` converts stored params back for the next run
- `sessionCodec.getDisplayId()` extracts a human-readable session ID for the UI
- **cwd-aware resume**: if the session was created in a different cwd than the current config, skip resuming (prevents cross-project session contamination)
- **Unknown session retry**: if resume fails with a "session not found" error, retry with a fresh session and return `clearSession: true` so Paperclip wipes the stale session

If the agent runtime supports any form of context compaction or conversation compression (e.g. Claude Code's automatic context management, or Codex's `previous_response_id` chaining), lean on it. Adapters that support session resume get compaction for free — the agent runtime handles context window management internally across resumes.

**Pattern** (from both claude-local and codex-local):

```ts
const canResumeSession =
  runtimeSessionId.length > 0 &&
  (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
const sessionId = canResumeSession ? runtimeSessionId : null;

// ... run attempt ...

// If resume failed with unknown session, retry fresh
if (sessionId && !proc.timedOut && exitCode !== 0 && isUnknownSessionError(output)) {
  const retry = await runAttempt(null);
  return toResult(retry, { clearSessionOnMissingSession: true });
}
```

---

## 6. Server-Utils Helpers

Import from `@paperclipai/adapter-utils/server-utils`:

| Helper | Purpose |
|--------|---------|
| `asString(val, fallback)` | Safe string extraction |
| `asNumber(val, fallback)` | Safe number extraction |
| `asBoolean(val, fallback)` | Safe boolean extraction |
| `asStringArray(val)` | Safe string array extraction |
| `parseObject(val)` | Safe `Record<string, unknown>` extraction |
| `parseJson(str)` | Safe JSON.parse returning `Record` or null |
| `renderTemplate(tmpl, data)` | `{{path.to.value}}` template rendering |
| `buildPaperclipEnv(agent)` | Standard `PAPERCLIP_*` env vars |
| `redactEnvForLogs(env)` | Redact sensitive keys for onMeta |
| `ensureAbsoluteDirectory(cwd)` | Validate cwd exists and is absolute |
| `ensureCommandResolvable(cmd, cwd, env)` | Validate command is in PATH |
| `ensurePathInEnv(env)` | Ensure PATH exists in env |
| `runChildProcess(runId, cmd, args, opts)` | Spawn with timeout, logging, capture |

---

## 7. Conventions and Patterns

### Naming
- Adapter type: `snake_case` (e.g. `claude_local`, `codex_local`)
- Package name: `@paperclipai/adapter-<kebab-name>`
- Package directory: `packages/adapters/<kebab-name>/`

### Config Parsing
- Never trust `config` values directly — always use `asString`, `asNumber`, etc.
- Provide sensible defaults for every optional field
- Document all fields in `agentConfigurationDoc`

### Prompt Templates
- Support `promptTemplate` for every run
- Use `renderTemplate()` with the standard variable set
- Default prompt should use `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` from `@paperclipai/adapter-utils/server-utils` so local adapters share Paperclip's execution contract: act in the same heartbeat, avoid planning-only exits unless requested, leave durable progress and a next action, use child issues instead of polling, mark blockers with owner/action, and respect governance boundaries.

### Error Handling
- Differentiate timeout vs process error vs parse failure
- Always populate `errorMessage` on failure
- Include raw stdout/stderr in `resultJson` when parsing fails
- Handle the agent CLI not being installed (command not found)

### Logging
- Call `onLog("stdout", ...)` and `onLog("stderr", ...)` for all process output — this feeds the real-time run viewer
- Call `onMeta(...)` before spawning to record invocation details
- Use `redactEnvForLogs()` when including env in meta

### Paperclip Skills Injection

Paperclip ships shared skills (in the repo's top-level `skills/` directory) that agents need at runtime — things like the `paperclip` API skill and the `paperclip-create-agent` workflow skill. Each adapter is responsible for making these skills discoverable by its agent runtime **without polluting the agent's working directory**.

**The constraint:** never copy or symlink skills into the agent's `cwd`. The cwd is the user's project checkout — writing `.claude/skills/` or any other files into it would contaminate the repo with Paperclip internals, break git status, and potentially leak into commits.

**The pattern:** create a clean, isolated location for skills and tell the agent runtime to look there.

**How claude-local does it:**

1. At execution time, create a fresh tmpdir: `mkdtemp("paperclip-skills-")`
2. Inside it, create `.claude/skills/` (the directory structure Claude Code expects)
3. Symlink each skill directory from the repo's `skills/` into the tmpdir's `.claude/skills/`
4. Pass the tmpdir to Claude Code via `--add-dir <tmpdir>` — this makes Claude Code discover the skills as if they were registered in that directory, without touching the agent's actual cwd
5. Clean up the tmpdir in a `finally` block after the run completes

```ts
// From claude-local execute.ts
async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(PAPERCLIP_SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(
        path.join(PAPERCLIP_SKILLS_DIR, entry.name),
        path.join(target, entry.name),
      );
    }
  }
  return tmp;
}

// In execute(): pass --add-dir to Claude Code
const skillsDir = await buildSkillsDir();
args.push("--add-dir", skillsDir);
// ... run process ...
// In finally: fs.rm(skillsDir, { recursive: true, force: true })
```

**How codex-local does it:**

Codex has a global personal skills directory (`$CODEX_HOME/skills` or `~/.codex/skills`). The adapter symlinks Paperclip skills there if they don't already exist. This is acceptable because it's the agent tool's own config directory, not the user's project.

```ts
// From codex-local execute.ts
async function ensureCodexSkillsInjected(onLog) {
  const skillsHome = path.join(codexHomeDir(), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  for (const entry of entries) {
    const target = path.join(skillsHome, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;  // Don't overwrite user's own skills
    await fs.symlink(source, target);
  }
}
```

**For a new adapter:** figure out how your agent runtime discovers skills/plugins, then choose the cleanest injection path:

1. **Best: tmpdir + flag** (like claude-local) — if the runtime supports an "additional directory" flag, create a tmpdir, symlink skills in, pass the flag, clean up after. Zero side effects.
2. **Acceptable: global config dir** (like codex-local) — if the runtime has a global skills/plugins directory separate from the project, symlink there. Skip existing entries to avoid overwriting user customizations.
3. **Acceptable: env var** — if the runtime reads a skills/plugin path from an environment variable, point it at the repo's `skills/` directory directly.
4. **Last resort: prompt injection** — if the runtime has no plugin system, include skill content in the prompt template itself. This uses tokens but avoids filesystem side effects entirely.

**Skills as loaded procedures, not prompt bloat.** The Paperclip skills (like `paperclip` and `paperclip-create-agent`) are designed as on-demand procedures: the agent sees skill metadata (name + description) in its context, but only loads the full SKILL.md content when it decides to invoke a skill. This keeps the base prompt small. When writing `agentConfigurationDoc` or prompt templates for your adapter, do not inline skill content — let the agent runtime's skill discovery do the work. The descriptions in each SKILL.md frontmatter act as routing logic: they tell the agent when to load the full skill, not what the skill contains.

**Explicit vs. fuzzy skill invocation.** For production workflows where reliability matters (e.g. an agent that must always call the Paperclip API to report status), use explicit instructions in the prompt template: "Use the paperclip skill to report your progress." Fuzzy routing (letting the model decide based on description matching) is fine for exploratory tasks but unreliable for mandatory procedures.

---

## 8. Security Considerations

Adapters sit at the boundary between Paperclip's orchestration layer and arbitrary agent execution. This is a high-risk surface.

### Treat Agent Output as Untrusted

The agent process runs LLM-driven code that reads external files, fetches URLs, and executes tools. Its output may be influenced by prompt injection from the content it processes. The adapter's parse layer is a trust boundary — validate everything, execute nothing.

### Secret Injection via Environment, Not Prompts

Never put secrets (API keys, tokens) into prompt templates or config fields that flow through the LLM. Instead, inject them as environment variables that the agent's tools can read directly:

- `PAPERCLIP_API_KEY` is injected by the server into the process environment, not the prompt
- User-provided secrets in `config.env` are passed as env vars, redacted in `onMeta` logs
- The `redactEnvForLogs()` helper automatically masks any key matching `/(key|token|secret|password|authorization|cookie)/i`

This follows the "sidecar injection" pattern: the model never sees the real secret value, but the tools it invokes can read it from the environment.

### Network Access

If your agent runtime supports network access controls (sandboxing, allowlists), configure them in the adapter:

- Prefer minimal allowlists over open internet access. An agent that only needs to call the Paperclip API and GitHub should not have access to arbitrary hosts.
- Skills + network = amplified risk. A skill that teaches the agent to make HTTP requests combined with unrestricted network access creates an exfiltration path. Constrain one or the other.
- If the runtime supports layered policies (org-level defaults + per-request overrides), wire the org-level policy into the adapter config and let per-agent config narrow further.

### Process Isolation

- CLI-based adapters inherit the server's user permissions. The `cwd` and `env` config determine what the agent process can access on the filesystem.
- `dangerouslySkipPermissions` / `dangerouslyBypassApprovalsAndSandbox` flags exist for development convenience but must be documented as dangerous in `agentConfigurationDoc`. Production deployments should not use them.
- Timeout and grace period (`timeoutSec`, `graceSec`) are safety rails — always enforce them. A runaway agent process without a timeout can consume unbounded resources.

---

## 9. TranscriptEntry Kinds Reference

The UI run viewer displays these entry kinds:

| Kind | Fields | Usage |
|------|--------|-------|
| `init` | `model`, `sessionId` | Agent initialization |
| `assistant` | `text` | Agent text response |
| `thinking` | `text` | Agent reasoning/thinking |
| `user` | `text` | User message |
| `tool_call` | `name`, `input` | Tool invocation |
| `tool_result` | `toolUseId`, `content`, `isError` | Tool result |
| `result` | `text`, `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`, `subtype`, `isError`, `errors` | Final result with usage |
| `stderr` | `text` | Stderr output |
| `system` | `text` | System messages |
| `stdout` | `text` | Raw stdout fallback |

---

## 10. Testing

Create tests in `server/src/__tests__/<adapter-name>-adapter.test.ts`. Test:

1. **Output parsing** — feed sample stdout through your parser, verify structured output
2. **Unknown session detection** — verify the `is<Agent>UnknownSessionError` function
3. **Config building** — verify `buildConfig` produces correct adapterConfig from form values
4. **Session codec** — verify serialize/deserialize round-trips

---

## 11. Minimal Adapter Checklist

- [ ] `packages/adapters/<name>/package.json` with four exports (`.`, `./server`, `./ui`, `./cli`)
- [ ] Root `index.ts` with `type`, `label`, `models`, `agentConfigurationDoc`
- [ ] `server/execute.ts` implementing `AdapterExecutionContext -> AdapterExecutionResult`
- [ ] `server/test.ts` implementing `AdapterEnvironmentTestContext -> AdapterEnvironmentTestResult`
- [ ] `server/parse.ts` with output parser and unknown-session detector
- [ ] `server/index.ts` exporting `execute`, `testEnvironment`, `sessionCodec`, parse helpers
- [ ] `ui/parse-stdout.ts` with `StdoutLineParser` for the run viewer
- [ ] `ui/build-config.ts` with `CreateConfigValues -> adapterConfig` builder
- [ ] `ui/src/adapters/<name>/config-fields.tsx` React component for agent form
- [ ] `ui/src/adapters/<name>/index.ts` assembling the `UIAdapterModule`
- [ ] `cli/format-event.ts` with terminal formatter
- [ ] `cli/index.ts` exporting the formatter
- [ ] Registered in `server/src/adapters/registry.ts`
- [ ] Registered in `ui/src/adapters/registry.ts`
- [ ] Registered in `cli/src/adapters/registry.ts`
- [ ] Added to workspace in root `pnpm-workspace.yaml` (if not already covered by glob)
- [ ] Tests for parsing, session codec, and config building
