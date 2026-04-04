# Detailed Adapter File Purpose and Mandatory Interfaces

This document details the purpose of each file in the Paperclip Gold Standard Adapter and defines the interfaces/functions that each must expose or implement.

---

## Structure, Function, and Required File Implementations

### src/index.ts
- **Function:** Adapter entry point. Registers the adapter in the Paperclip system and exports metadata and helpers.
- **Mandatory implementation:**
  ```ts
  export const type = "adapter_name";
  export const label = "Friendly Name";
  export const models = [ { id: "model-id", label: "Model Label" } ];
  export const agentConfigurationDoc = `...`;
  // Export UI config helpers if existing
  export { buildAdapterConfig } from "./ui/build-config.js";
  export { parseAdapterStdoutLine } from "./ui/parse-stdout.js";
  ```

### src/cli/index.ts
- **Function:** CLI entry point for adapter utility commands.
- **Mandatory implementation:**
  ```ts
  export { printAdapterStreamEvent } from "./format-event.js";
  ```

### src/cli/format-event.ts
- **Function:** Formats LLM events for the Paperclip standard (debug/CLI output).
- **Mandatory implementation:**
  ```ts
  export function printAdapterStreamEvent(raw: string, debug: boolean): void { /* ... */ }
  // May include helpers like printToolResult, asErrorText, etc.
  ```

### src/cli/quota-probe.ts (optional)
- **Function:** Probes LLM quota limits via CLI.
- **Typical implementation:**
  ```ts
  import { fetchAdapterQuota } from "../server/quota.js";
  async function main() { /* ... */ }
  ```

### src/server/index.ts
- **Function:** Server-side entry point for the adapter. Exposes main handlers (execution, parsing, skills, quota).
- **Mandatory implementation:**
  ```ts
  export * from "./execute.js";
  export * from "./parse.js";
  export * from "./skills.js";
  export * from "./quota.js";
  ```

### src/server/execute.ts
- **Function:** Executes LLM prompts/commands and returns responses.
- **Mandatory implementation:**
  ```ts
  import { buildPaperclipEnv, ensureAbsoluteDirectory } from "@paperclipai/adapter-utils/server-utils";
  export async function executePrompt(input: ExecuteInput): Promise<ExecuteResult> {
    // Create isolated working directory
    const cwd = input.config.cwd || "/tmp/paperclip-agent-...";
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    // Inject Paperclip and user environment variables
    const env = buildPaperclipEnv({ ...process.env, ...input.config.env, /* ...Paperclip vars */ });
    // Mount skills if necessary (e.g., .claude/skills/)
    // ...
    // Execute LLM process using cwd and env
    // ...
  }
  ```
  - **Mandatory:** Always use env helpers, create isolated directories, inject Paperclip variables, mount skills in subdirectories, and follow isolation and security recommendations.

### src/server/parse.ts
- **Function:** Parses raw LLM output into Paperclip events.
- **Mandatory implementation:**
  ```ts
  export function parseAdapterStreamJson(stdout: string): AdapterParseResult { /* ... */ }
  // May export helpers like extractAdapterErrorMessages
  ```

### src/server/quota.ts
- **Function:** Manages token limits/quota usage for the LLM.
- **Mandatory implementation:**
  ```ts
  export async function getQuotaStatus(): Promise<QuotaInfo> { /* ... */ }
  // May include helpers for quota parsing, file reading, etc.
  ```

### src/server/skills.ts
- **Function:** Exposes supported adapter skills (e.g., codegen, chat, tool-use).
- **Mandatory implementation:**
  ```ts
  import { readPaperclipRuntimeSkillEntries } from "@paperclipai/adapter-utils/server-utils";
  export async function listAdapterSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
    // Mount or link skills in isolated subdirectory (e.g., .claude/skills/)
    const entries = await readPaperclipRuntimeSkillEntries(ctx.config, __dirname);
    // ...
    return { /* ... */ };
  }
  export function resolveAdapterDesiredSkillNames(config: Record<string, unknown>, availableEntries: Array<{ key: string }>): string[] { /* ... */ }
  ```
  - **Mandatory:** Always mount skills in an isolated subdirectory and follow security recommendations.

### src/server/test.ts
- **Function:** Automated tests for the adapter and environment checks.
- **Mandatory implementation:**
  ```ts
  export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> { /* ... */ }
  // May export describe/it for unit tests
  ```

### src/ui/build-config.ts
- **Function:** Generates the adapter configuration form for UI and converts form values to config.
- **Mandatory implementation:**
  ```ts
  export function buildAdapterConfig(v: CreateConfigValues): Record<string, unknown> { /* ... */ }
  ```

### src/ui/index.ts
- **Function:** Entry point for custom adapter UI components.
- **Mandatory implementation:**
  ```ts
  export { parseAdapterStdoutLine } from "./parse-stdout.js";
  export { buildAdapterConfig } from "./build-config.js";
  // May export React components
  ```

### src/ui/parse-stdout.ts
- **Function:** Frontend parsing of LLM output (debug/local output).
- **Mandatory implementation:**
  ```ts
  export function parseAdapterStdoutLine(line: string, ts: string): TranscriptEntry[] { /* ... */ }
  ```

### src/shared/ (stream.ts, trust.ts, etc.)
- **Function:** Shared utilities between server/cli/ui.
- **Typical implementation:**
  ```ts
  export function normalizeAdapterStreamLine(rawLine: string): { stream: "stdout" | "stderr" | null; line: string } { /* ... */ }
  export function hasAdapterTrustBypassArg(args: readonly string[]): boolean { /* ... */ }
  ```

---

## Mandatory Interfaces (TypeScript)

```ts
// Base interface examples (always import from @paperclipai/adapter-utils/shared when possible)
export interface ExecuteInput {
  prompt: string;
  config?: Record<string, any>;
}

export interface ExecuteResult {
  output: string;
  events?: LLMEvent[];
}

export interface LLMEvent {
  type: string;
  data: any;
}

export interface QuotaInfo {
  used: number;
  limit: number;
  resetAt?: Date;
}

export interface AdapterSkill {
  name: string;
  description: string;
}

export interface AdapterConfigForm {
  fields: Array<{ name: string; type: string; label: string; required?: boolean }>;
}
```

---

**Notes:**
- Adapters should and use the actual types from `@paperclipai/adapter-utils` and `packages/shared` whenever possible.
- Adapters can extend these interfaces as necessary while ensuring core compatibility.
- Always export functions/handlers with clear and standardized names to facilitate automatic registration.

---

## Mandatory Checklist (Summary)

- [x] Use environment helpers (`buildPaperclipEnv`, etc.)
- [x] Create isolated working directory (`ensureAbsoluteDirectory`)
- [x] Inject Paperclip and user variables
- [x] Mount skills in isolated subdirectory
- [x] Follow isolation, security, and cleanup recommendations

---

## Standards for Creating Isolated Environments and Variable Injection

Paperclip adapters must ensure that every LLM execution occurs in an isolated and correctly configured Linux environment. This includes:

### 1. Isolated Working Directory
- Use a configurable `cwd` (e.g., via config or Paperclip context).
- Create the directory if missing using `ensureAbsoluteDirectory`.
- Never execute in global system directories.

### 2. Environment Variables
- Always inject standard Paperclip variables:
  - `PAPERCLIP_WORKSPACE_*` (e.g., `PAPERCLIP_WORKSPACE_ID`, `PAPERCLIP_WORKSPACE_PATH`)
  - `PAPERCLIP_RUNTIME_*` (e.g., `PAPERCLIP_RUNTIME_ID`, etc.)
- Use helpers like `buildPaperclipEnv` and `buildInvocationEnvForLogs` from `@paperclipai/adapter-utils` to compose the environment.
- Allow override/addition of variables via user config/env.

### 3. File and Resource Injection
- If necessary, create temporary files (e.g., instructions, credentials, skills) in the isolated working directory.
- Use utility functions to ensure correct permissions and cleanup after use.
- For skills, mount or create symlinks in isolated subdirectories (e.g., `.claude/skills/`).

### 4. Process Execution
- Always use the isolated working directory as the child process `cwd`.
- Pass the prepared environment via `env` in spawn/exec.
- Limit permissions and resources as necessary (e.g., avoid inheriting sensitive host variables).

### 5. Cleanup and Security
- Remove temporary files/directories after use when possible.
- Never expose secrets in logs.

### Environment Preparation Example (pseudo-code):
```ts
import { buildPaperclipEnv, ensureAbsoluteDirectory } from "@paperclipai/adapter-utils/server-utils";

const cwd = config.cwd || "/tmp/paperclip-agent-...";
await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
const env = buildPaperclipEnv({
  ...process.env,
  ...config.env,
  PAPERCLIP_WORKSPACE_ID: ctx.workspaceId,
  PAPERCLIP_RUNTIME_ID: ctx.runtimeId,
  // ...other variables
});
// Pass cwd and env to LLM process spawn/exec
```

---

**Summary:**
Every adapter must ensure isolation, correct resource injection, and environment cleanup, always using Paperclip core utilities for maximum compatibility and security.
