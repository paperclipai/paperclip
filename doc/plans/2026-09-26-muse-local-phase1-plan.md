# Muse Code adapter (`muse_local`), Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `muse_local` adapter that runs Paperclip agents on Meta's Muse Code CLI (`muse exec --json`), with session resume, skills, an environment test, and full server/UI/CLI registration.

**Architecture:** A new workspace package `packages/adapters/muse-local` modelled on `packages/adapters/grok-local`. It exposes `.` (constants, models, config doc), `./server` (execute, JSONL parser, skills, environment test, session codec), `./ui` (stdout→transcript parser, config builder) and `./cli` (stream printer). It is registered everywhere `grok_local` is registered as a plain adapter. Grok's login and AI-connection registrations are left for Phases 2 and 3. Credentials in Phase 1 are `META_API_KEY` from the agent's env bindings, or else the host's own `muse login`.

**Tech Stack:** TypeScript (ESM, `tsc`), Vitest, pnpm workspaces, React (UI registry only). Node ≥ 24.11.

**Spec:** `doc/plans/2026-09-26-muse-local-adapter-design.md` (rev 2). Fixtures: `doc/plans/2026-09-26-muse-exec-{basic,tool,badkey}.jsonl`.

## Global Constraints

- Adapter type `muse_local`, label `Muse Code`, package `@paperclipai/adapter-muse-local`, version `0.1.0`, license MIT, `"engines": { "node": ">=24.11.0" }`.
- Default command `muse`. Models: `muse-spark-1.3` (default) and `muse-spark-1.3-contributor`.
- Reasoning efforts: `none | minimal | low | medium | high | xhigh | max | ultra`. Unset means the CLI default (`high`).
- argv is always `exec --json --model <m> [--reasoning-effort <e>] --approval-mode never --trust-workspace --workspace <cwd> --session-id <uuid> --prompt-file <file> [extraArgs]`.
- Child env always has `XDG_DATA_HOME=<instanceRoot>/companies/<companyId>/muse-data/<agentId>` and `MUSE_NO_AUTO_UPDATE=1`. It never has `TBH_CREDENTIAL_BACKEND` (ruled during Task 8: it hides a keychain login). Never set `XDG_CONFIG_HOME` in Phase 1.
- Skills are staged into `<cwd>/.agents/skills/<runtimeName>` and removed after the run. Pre-existing targets are never touched.
- Result billing: `provider: "meta"`, `biller: "muse"`, `billingType: "subscription"` unless `META_API_KEY` is set (then `"api"`), `costUsd: null`, `usageBasis: "per_run"`, and usage is all zeros (Muse JSONL carries no token usage).
- Auth failure sets `errorCode: "muse_auth_required"`. It matches `/API key .* was rejected|No Meta credentials|saved Meta credentials are invalid|run `?muse login`?/i`.
- Remote execution targets are rejected in Phase 1 with the message `muse_local supports local execution only in this release`.
- Never log, return or persist `META_API_KEY` or any `LLM|…` value. Never emit the `turn.input.user` prompt echo into transcripts.
- Do NOT add `muse_local` to the telemetry generated contract (`packages/shared/src/telemetry/generated/paperclip-telemetry.ts`): that needs a privacy review (AGENTS.md §7), and the enum already has an `other` fallback.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A host with no `muse login` and no `META_API_KEY` must fail with a clear "run `muse login` or bind META_API_KEY" message (`muse_auth_required`), not a generic exit code. Pinned in Task 3 (`execute.test.ts` "maps auth failures") and Task 4.
2. An agent whose workspace cwd changed since the last run must start a fresh Muse session, not resume one bound to another directory. Pinned in Task 3 ("does not resume across cwd changes").
3. A user's own `.agents/skills/<name>` directory in the repo must survive a run: staging skips it and cleanup never deletes it. Pinned in Task 3 ("leaves pre-existing skill dirs untouched").
4. An unreadable `instructionsFilePath` must warn and continue, not fail the run. Pinned in Task 3 ("continues when the instructions file is unreadable").
5. The prompt echo (`turn.input.user`) and tool output can hold secrets. The UI transcript must never show the prompt echo, and tool output goes only into `tool_result` entries. Pinned in Task 5 ("does not echo the user prompt").

---

## File Structure

```
packages/adapters/muse-local/
  package.json, tsconfig.json, vitest.config.ts
  src/index.ts                      constants, models, efforts, agentConfigurationDoc
  src/shared/records.ts             one-line MSP record decoder shared by server/ui/cli
  src/shared/records.test.ts
  src/server/__fixtures__/exec-basic.jsonl, exec-tool.jsonl, exec-badkey.jsonl
  src/server/parse.ts               whole-run JSONL summary + auth-error detector
  src/server/parse.test.ts
  src/server/skills.ts              skill snapshot (list/sync)
  src/server/execute.ts             run muse exec
  src/server/execute.test.ts
  src/server/test.ts                testEnvironment
  src/server/test.test.ts
  src/server/index.ts               sessionCodec + re-exports
  src/ui/parse-stdout.ts            line → TranscriptEntry[]
  src/ui/parse-stdout.test.ts
  src/ui/build-config.ts
  src/ui/index.ts
  src/cli/format-event.ts
  src/cli/index.ts
ui/src/adapters/muse-local/index.ts, config-fields.tsx
ui/public/brands/adapters/muse.png
```

Modified (registration): `vitest.config.ts`, `scripts/run-vitest-stable.mjs`, `scripts/release-package-manifest.json`, `Dockerfile`, `server/package.json`, `cli/package.json`, `ui/package.json`, `packages/shared/src/constants.ts`, `server/src/adapters/builtin-adapter-types.ts`, `server/src/adapters/registry.ts`, `server/src/services/heartbeat.ts`, `server/src/services/conversation-continuation.ts`, `cli/src/adapters/registry.ts`, `tests/runner-acceptance/catalog.ts`, `ui/src/adapters/registry.ts`, `ui/src/adapters/adapter-display-registry.ts`, `ui/src/adapters/use-adapter-capabilities.ts`, `ui/src/lib/agent-setup-fields.ts`, `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/new-agent/AgentBasicsDialog.tsx`, `ui/src/components/TaskChatThread.tsx`, `README.md`.

---

### Task 1: Package scaffold, constants, and the MSP record decoder

**Files:**
- Create: `packages/adapters/muse-local/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/adapters/muse-local/src/index.ts`
- Create: `packages/adapters/muse-local/src/shared/records.ts`, `records.test.ts`
- Create: `packages/adapters/muse-local/src/server/__fixtures__/exec-{basic,tool,badkey}.jsonl` (copies of `doc/plans/2026-09-26-muse-exec-*.jsonl`)
- Modify: `vitest.config.ts` (projects list), `scripts/run-vitest-stable.mjs` (`nonServerProjects`)

**Interfaces:**
- Produces: `type`, `label`, `DEFAULT_MUSE_LOCAL_MODEL`, `models`, `MUSE_LOCAL_REASONING_EFFORTS`, `museLocalReasoningEffortsForModel(model: string): readonly string[]`, `agentConfigurationDoc` from `src/index.ts`.
- Produces: `interface MuseRecord { recordType: string; payloadType: string; streamId: string | null; sequence: number; payload: Record<string, unknown> }` and `decodeMuseRecord(line: string): MuseRecord | null` from `src/shared/records.ts`.

- [ ] **Step 1: Install workspace deps once**

Run: `cd ~/paperclip && pnpm install`
Expected: completes; `node_modules/` exists.

- [ ] **Step 2: Create package files**

`packages/adapters/muse-local/package.json`:
```json
{
  "name": "@paperclipai/adapter-muse-local",
  "version": "0.1.0",
  "license": "MIT",
  "homepage": "https://github.com/paperclipai/paperclip",
  "bugs": { "url": "https://github.com/paperclipai/paperclip/issues" },
  "repository": { "type": "git", "url": "https://github.com/paperclipai/paperclip", "directory": "packages/adapters/muse-local" },
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./ui": "./src/ui/index.ts",
    "./cli": "./src/cli/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
      "./server": { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.js" },
      "./ui": { "types": "./dist/ui/index.d.ts", "import": "./dist/ui/index.js" },
      "./cli": { "types": "./dist/cli/index.d.ts", "import": "./dist/cli/index.js" }
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "files": ["dist"],
  "scripts": { "build": "tsc", "clean": "rm -rf dist", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@paperclipai/adapter-utils": "workspace:*",
    "@paperclipai/shared": "workspace:*",
    "picocolors": "^1.1.1"
  },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^7.0.2" },
  "engines": { "node": ">=24.11.0" }
}
```

`tsconfig.json` (identical to grok-local's):
```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

Copy fixtures:
```bash
mkdir -p packages/adapters/muse-local/src/server/__fixtures__
for f in basic tool badkey; do cp doc/plans/2026-09-26-muse-exec-$f.jsonl packages/adapters/muse-local/src/server/__fixtures__/exec-$f.jsonl; done
```

Add `"packages/adapters/muse-local",` after `"packages/adapters/kimi-local",` in the root `vitest.config.ts` projects list, and `"@paperclipai/adapter-muse-local",` after the grok entry in `scripts/run-vitest-stable.mjs` `nonServerProjects`. Then run `pnpm install` again so the workspace link exists.

- [ ] **Step 3: Write `src/index.ts`**

```ts
export const type = "muse_local";
export const label = "Muse Code";

export const DEFAULT_MUSE_LOCAL_MODEL = "muse-spark-1.3";

export const models = [
  { id: DEFAULT_MUSE_LOCAL_MODEL, label: "Muse Spark 1.3" },
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 (contributor)" },
];

export const MUSE_LOCAL_REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const;

export function museLocalReasoningEffortsForModel(_model: string): readonly string[] {
  return MUSE_LOCAL_REASONING_EFFORTS;
}

export const agentConfigurationDoc = `# muse_local agent configuration

Adapter: muse_local

Use when:
- You want Paperclip to run Meta's Muse Code CLI locally on the host machine
- You want Muse sessions resumed across heartbeats via \`--session-id\`
- You want runs billed to a Muse Code subscription (host \`muse login\`) or a Meta API key

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- Muse Code is not installed on the machine that runs Paperclip (install: \`curl -fsSL https://api.meta.ai/muse-launcher.sh | bash\`)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Muse model id. Defaults to muse-spark-1.3.
- reasoningEffort (string, optional): none|minimal|low|medium|high|xhigh|max|ultra, passed via \`--reasoning-effort\` (CLI default: high)
- command (string, optional): defaults to "muse"
- extraArgs (string[], optional): additional \`muse exec\` args
- env (object, optional): KEY=VALUE environment variables. Bind META_API_KEY to a secret to authenticate without a host login.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`muse exec --json --approval-mode never --trust-workspace\`; Muse's OS sandbox stays on (it allows localhost, so Paperclip API calls work).
- Sessions live in a per-agent XDG_DATA_HOME under the Paperclip instance, so \`--session-id\` resumes across heartbeats when the cwd is unchanged.
- Paperclip stages desired skills into \`.agents/skills\` in the execution workspace for the run.
- META_API_KEY takes priority over the host \`muse login\`. Muse reports no token usage, so runs record zero tokens.
`;
```

- [ ] **Step 4: Write the failing decoder test** `src/shared/records.test.ts`

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMuseRecord } from "./records.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/__fixtures__");
const lines = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), "utf8").split(/\r?\n/).filter(Boolean);

describe("decodeMuseRecord", () => {
  it("decodes every fixture line", () => {
    for (const name of ["exec-basic.jsonl", "exec-tool.jsonl", "exec-badkey.jsonl"]) {
      for (const line of lines(name)) {
        const record = decodeMuseRecord(line);
        expect(record).not.toBeNull();
        expect(record!.payloadType.length).toBeGreaterThan(0);
      }
    }
  });

  it("exposes the session stream id and payload", () => {
    const record = decodeMuseRecord(lines("exec-basic.jsonl")[0]!)!;
    expect(record.streamId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(record.recordType).toBe("reconciliation");
    expect(record.payloadType).toBe("runtime.command.accepted");
  });

  it("returns null for non-JSON, non-object and envelope-less lines", () => {
    expect(decodeMuseRecord("muse: workspace root: /x")).toBeNull();
    expect(decodeMuseRecord("[1,2]")).toBeNull();
    expect(decodeMuseRecord(JSON.stringify({ type: "text" }))).toBeNull();
    expect(decodeMuseRecord("")).toBeNull();
  });
});
```

- [ ] **Step 5: Run it and verify it fails**

Run: `cd ~/paperclip && pnpm exec vitest run packages/adapters/muse-local/src/shared/records.test.ts`
Expected: FAIL (`Cannot find module './records.js'`).

- [ ] **Step 6: Implement `src/shared/records.ts`**

```ts
// Decodes one line of `muse exec --json` output. Every line is an MSP record
// envelope: { schema_version, id, stream: { kind, id }, sequence, record_type,
// payload_type, payload }. Anything else (stderr chatter that leaked onto
// stdout, blank lines, foreign JSON) decodes to null so callers can skip it.

export interface MuseRecord {
  recordType: string;
  payloadType: string;
  streamId: string | null;
  sequence: number;
  payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function decodeMuseRecord(line: string): MuseRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (!envelope) return null;
  const recordType = typeof envelope.record_type === "string" ? envelope.record_type : "";
  const payloadType = typeof envelope.payload_type === "string" ? envelope.payload_type : "";
  const payload = asRecord(envelope.payload);
  if (!recordType || !payloadType || !payload) return null;
  const stream = asRecord(envelope.stream);
  const streamId = stream && typeof stream.id === "string" && stream.id.trim() ? stream.id.trim() : null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  return { recordType, payloadType, streamId, sequence, payload };
}
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/shared/records.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/muse-local vitest.config.ts scripts/run-vitest-stable.mjs pnpm-lock.yaml
git commit -m "feat(muse-local): scaffold adapter package and MSP record decoder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Whole-run JSONL summary parser

**Files:**
- Create: `packages/adapters/muse-local/src/server/parse.ts`, `parse.test.ts`

**Interfaces:**
- Consumes: `decodeMuseRecord` (Task 1).
- Produces:
```ts
export interface ParsedMuseJsonl {
  sessionId: string | null;
  model: string | null;
  summary: string;          // run.terminal.completed payload.text, else joined deltas
  terminal: string | null;  // "completed" | "failed" | "cancelled" | other | null
  reason: string | null;    // run_terminal reason, else first failed-task reason
  toolResultCount: number;
}
export function parseMuseJsonl(stdout: string): ParsedMuseJsonl;
export function isMuseAuthError(text: string): boolean;
```

- [ ] **Step 1: Write the failing test** `src/server/parse.test.ts`

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

describe("parseMuseJsonl", () => {
  it("reads the basic run", () => {
    const parsed = parseMuseJsonl(fixture("exec-basic.jsonl"));
    expect(parsed.sessionId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(parsed.model).toBe("muse-spark-1.3");
    expect(parsed.summary).toBe("MUSE OK");
    expect(parsed.terminal).toBe("completed");
    expect(parsed.reason).toBeNull();
    expect(parsed.toolResultCount).toBe(0);
  });

  it("reads a tool run", () => {
    const parsed = parseMuseJsonl(fixture("exec-tool.jsonl"));
    expect(parsed.summary).toBe("Files: a.txt\n\nDONE");
    expect(parsed.terminal).toBe("completed");
    expect(parsed.toolResultCount).toBe(1);
  });

  it("reads a failed auth run", () => {
    const parsed = parseMuseJsonl(fixture("exec-badkey.jsonl"));
    expect(parsed.terminal).toBe("failed");
    expect(parsed.summary).toBe("");
    expect(parsed.reason).toBe("your API key from META_API_KEY was rejected — update or unset it");
    expect(isMuseAuthError(parsed.reason!)).toBe(true);
  });

  it("falls back to joined deltas when the terminal record is missing", () => {
    const basic = fixture("exec-basic.jsonl").split("\n").filter(Boolean);
    const truncated = basic.filter((line) => !line.includes('"run.terminal.completed"')).join("\n");
    const parsed = parseMuseJsonl(truncated);
    expect(parsed.terminal).toBeNull();
    expect(parsed.summary).toBe("MUSE OK");
  });

  it("ignores garbage lines", () => {
    const parsed = parseMuseJsonl("muse: hello\nnot json\n");
    expect(parsed).toEqual({ sessionId: null, model: null, summary: "", terminal: null, reason: null, toolResultCount: 0 });
  });
});

describe("isMuseAuthError", () => {
  it.each([
    "your API key from META_API_KEY was rejected — update or unset it",
    "No Meta credentials were found. Your message was not sent. Quit Muse Code and run `muse login`.",
    "Your saved Meta credentials are invalid. Your message was not sent.",
  ])("detects %s", (text) => expect(isMuseAuthError(text)).toBe(true));

  it("ignores unrelated errors", () => expect(isMuseAuthError("model overloaded, retry later")).toBe(false));
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/parse.ts`**

```ts
import { decodeMuseRecord } from "../shared/records.js";

export interface ParsedMuseJsonl {
  sessionId: string | null;
  model: string | null;
  summary: string;
  terminal: string | null;
  reason: string | null;
  toolResultCount: number;
}

const MUSE_AUTH_ERROR_RE =
  /API key .* was rejected|No Meta credentials|saved Meta credentials are invalid|run `?muse login`?/i;

export function isMuseAuthError(text: string): boolean {
  return MUSE_AUTH_ERROR_RE.test(text);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseMuseJsonl(stdout: string): ParsedMuseJsonl {
  let sessionId: string | null = null;
  let model: string | null = null;
  let terminal: string | null = null;
  let terminalText: string | null = null;
  let terminalReason: string | null = null;
  let failedTaskReason: string | null = null;
  let toolResultCount = 0;
  const deltas: Array<{ sequence: number; text: string }> = [];

  for (const line of stdout.split(/\r?\n/)) {
    const record = decodeMuseRecord(line);
    if (!record) continue;
    if (record.streamId && !sessionId) sessionId = record.streamId;
    const { payload } = record;
    switch (record.payloadType) {
      case "run.model.configured":
        model = str(payload.model_id).trim() || model;
        break;
      case "run.output.delta": {
        const text = str(payload.text);
        if (text) deltas.push({ sequence: record.sequence, text });
        break;
      }
      case "tool.result":
        toolResultCount += 1;
        break;
      case "run.terminal.completed":
        terminal = str(payload.terminal).trim() || null;
        terminalText = str(payload.text);
        terminalReason = str(payload.reason).trim() || null;
        break;
      default: {
        const event = payload.event;
        if (
          record.payloadType.startsWith("task.lifecycle.") &&
          typeof event === "object" && event !== null &&
          (event as Record<string, unknown>).kind === "failed" &&
          !failedTaskReason
        ) {
          failedTaskReason = str((event as Record<string, unknown>).reason).trim() || null;
        }
      }
    }
  }

  const joinedDeltas = deltas.sort((a, b) => a.sequence - b.sequence).map((d) => d.text).join("");
  return {
    sessionId,
    model,
    summary: (terminalText ?? joinedDeltas).trim(),
    terminal,
    reason: terminalReason ?? failedTaskReason,
    toolResultCount,
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/parse.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/muse-local/src/server/parse.ts packages/adapters/muse-local/src/server/parse.test.ts
git commit -m "feat(muse-local): JSONL run summary parser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `execute`, session codec, and skills

**Files:**
- Create: `packages/adapters/muse-local/src/server/skills.ts`, `execute.ts`, `execute.test.ts`, `index.ts`

**Interfaces:**
- Consumes: `parseMuseJsonl`, `isMuseAuthError` (Task 2); `DEFAULT_MUSE_LOCAL_MODEL` (Task 1).
- Produces: `execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>`, `resolveMuseDataHome(env: NodeJS.ProcessEnv, companyId: string, agentId: string): string`, `listMuseSkills`, `syncMuseSkills`, `sessionCodec`, and the `./server` barrel (`src/server/index.ts`) that Task 4 extends with `testEnvironment`.

- [ ] **Step 1: Write `src/server/skills.ts`** (copy of grok's with the Muse label and path)

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildMuseSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "muse_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be copied into `.agents/skills` in the execution workspace on the next run.",
  });
}

export async function listMuseSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildMuseSkillSnapshot(ctx.config);
}

export async function syncMuseSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildMuseSkillSnapshot(ctx.config);
}
```

- [ ] **Step 2: Write `src/server/index.ts`** (the session codec is copied verbatim from `packages/adapters/grok-local/src/server/index.ts` lines 1–65, the `readNonEmptyString` helper plus the `sessionCodec` object, unchanged), followed by:

```ts
export { execute, resolveMuseDataHome } from "./execute.js";
export { listMuseSkills, syncMuseSkills } from "./skills.js";
export { parseMuseJsonl, isMuseAuthError, type ParsedMuseJsonl } from "./parse.js";
```

- [ ] **Step 3: Write the failing tests** `src/server/execute.test.ts`

The mock block is the same pattern as `grok-local/src/server/execute.test.ts` lines 1–70: it hoists mocks for `@paperclipai/adapter-utils/execution-target` so no real process is spawned.

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({
  isRemote: false,
  ensureRuntimeInstalledMock: vi.fn(async () => {}),
  ensureCommandMock: vi.fn(async () => {}),
  resolveCommandForLogsMock: vi.fn(async () => "muse"),
  runProcessMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => mocks.isRemote,
  adapterExecutionTargetRemoteCwd: (_t: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => (mocks.isRemote ? "remote" : "local"),
  ensureAdapterExecutionTargetCommandResolvable: (...a: unknown[]) => (mocks.ensureCommandMock as (...x: unknown[]) => unknown)(...a),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: (...a: unknown[]) => (mocks.ensureRuntimeInstalledMock as (...x: unknown[]) => unknown)(...a),
  readAdapterExecutionTarget: () => (mocks.isRemote ? { kind: "remote", transport: "ssh" } : { kind: "local" }),
  resolveAdapterExecutionTargetCommandForLogs: (...a: unknown[]) => (mocks.resolveCommandForLogsMock as (...x: unknown[]) => unknown)(...a),
  resolveAdapterExecutionTargetTimeoutSec: (_t: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: (...a: unknown[]) => (mocks.runProcessMock as (...x: unknown[]) => unknown)(...a),
}));

import { execute, resolveMuseDataHome } from "./execute.js";

const fixture = (name: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

const tempRoots: string[] = [];
async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-local-"));
  tempRoots.push(root);
  return root;
}
const pathExists = (p: string) => fs.access(p).then(() => true).catch(() => false);

function makeCtx(cwd: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Muse Agent", adapterType: "muse_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

async function okRun(name = "exec-basic.jsonl") {
  return { exitCode: 0, signal: null, timedOut: false, stdout: await fixture(name), stderr: "" };
}

let paperclipHome: string;

describe("muse_local execute", () => {
  beforeEach(async () => {
    mocks.isRemote = false;
    mocks.runProcessMock.mockReset();
    paperclipHome = await makeTempRoot();
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("META_API_KEY", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
  });

  it("builds the exec argv and env", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, { config: { cwd: root, model: "muse-spark-1.3-contributor", reasoningEffort: "low", extraArgs: ["--max-model-steps", "40"] } }));

    const [, , command, args, options] = mocks.runProcessMock.mock.calls[0]!;
    expect(command).toBe("muse");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args[args.indexOf("--model") + 1]).toBe("muse-spark-1.3-contributor");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("low");
    expect(args).toContain("--trust-workspace");
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("never");
    expect(args[args.indexOf("--workspace") + 1]).toBe(root);
    expect(args[args.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.slice(-2)).toEqual(["--max-model-steps", "40"]);
    const env = (options as { env: Record<string, string> }).env;
    expect(env.XDG_DATA_HOME).toBe(resolveMuseDataHome(process.env, "company-1", "agent-1"));
    expect(env.TBH_CREDENTIAL_BACKEND).toBe("file");
    expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
    expect(env.XDG_CONFIG_HOME).toBeUndefined();

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("MUSE OK");
    expect(result.sessionId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(result.sessionParams).toMatchObject({ sessionId: "01a0df95-ddaf-7cd0-91f4-246c59f925e8", cwd: root });
    expect(result.provider).toBe("meta");
    expect(result.biller).toBe("muse");
    expect(result.billingType).toBe("subscription");
    expect(result.costUsd).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });

  it("writes the prompt to a file passed via --prompt-file and removes it afterwards", async () => {
    const root = await makeTempRoot();
    let promptPath = "";
    mocks.runProcessMock.mockImplementation(async (_r: unknown, _t: unknown, _c: unknown, args: string[]) => {
      promptPath = args[args.indexOf("--prompt-file") + 1]!;
      expect(await fs.readFile(promptPath, "utf8")).toContain("Paperclip");
      return okRun();
    });
    await execute(makeCtx(root));
    expect(promptPath).not.toBe("");
    expect(await pathExists(promptPath)).toBe(false);
  });

  it("resumes the stored session when cwd matches", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const sessionId = "01a0df95-ddaf-7cd0-91f4-246c59f925e8";
    await execute(makeCtx(root, { runtime: { sessionId, sessionParams: { sessionId, cwd: root }, sessionDisplayId: null, taskKey: null } }));
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
  });

  it("does not resume across cwd changes", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await execute(makeCtx(root, { runtime: { sessionId, sessionParams: { sessionId, cwd: "/somewhere/else" }, sessionDisplayId: null, taskKey: null } }));
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--session-id") + 1]).not.toBe(sessionId);
  });

  it("maps auth failures to muse_auth_required", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: await fixture("exec-badkey.jsonl"), stderr: "" });
    const result = await execute(makeCtx(root));
    expect(result.errorCode).toBe("muse_auth_required");
    expect(result.errorMessage).toMatch(/muse login|META_API_KEY/);
  });

  it("reports api billing when META_API_KEY is bound", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, { config: { cwd: root, env: { META_API_KEY: "LLM|test-key-000000000000000000000000000000000000" } } }));
    expect(result.billingType).toBe("api");
    expect(JSON.stringify(result)).not.toContain("LLM|test-key");
  });

  it("stages skills into .agents/skills and cleans them up", async () => {
    const root = await makeTempRoot();
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n");
    mocks.runProcessMock.mockImplementation(async () => {
      expect(await pathExists(path.join(root, ".agents", "skills", "paperclip", "SKILL.md"))).toBe(true);
      return okRun();
    });
    await execute(makeCtx(root, {
      config: { cwd: root, paperclipRuntimeSkills: [{ key: "paperclip", runtimeName: "paperclip", source: skillSource, required: true }] },
    }));
    expect(await pathExists(path.join(root, ".agents"))).toBe(false);
  });

  it("leaves pre-existing skill dirs untouched", async () => {
    const root = await makeTempRoot();
    const existing = path.join(root, ".agents", "skills", "paperclip");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "SKILL.md"), "user-owned");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n");
    mocks.runProcessMock.mockResolvedValue(await okRun());
    await execute(makeCtx(root, {
      config: { cwd: root, paperclipRuntimeSkills: [{ key: "paperclip", runtimeName: "paperclip", source: skillSource, required: true }] },
    }));
    expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("user-owned");
  });

  it("continues when the instructions file is unreadable", async () => {
    const root = await makeTempRoot();
    const logs: string[] = [];
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, {
      config: { cwd: root, instructionsFilePath: path.join(root, "missing.md") },
      onLog: async (_s, line) => { logs.push(line); },
    }));
    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toMatch(/could not read agent instructions file/);
  });

  it("prepends the instructions file to the prompt", async () => {
    const root = await makeTempRoot();
    const instructions = path.join(root, "AGENTS.md");
    await fs.writeFile(instructions, "You are a Muse agent.\n");
    mocks.runProcessMock.mockImplementation(async (_r: unknown, _t: unknown, _c: unknown, args: string[]) => {
      const prompt = await fs.readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8");
      expect(prompt.startsWith("You are a Muse agent.")).toBe(true);
      return okRun();
    });
    await execute(makeCtx(root, { config: { cwd: root, instructionsFilePath: instructions } }));
  });

  it("rejects remote execution targets", async () => {
    const root = await makeTempRoot();
    mocks.isRemote = true;
    await expect(execute(makeCtx(root))).rejects.toThrow("muse_local supports local execution only in this release");
  });
});
```

`paperclipRuntimeSkills` is the config key `readPaperclipRuntimeSkillEntries` reads. Before running, confirm it with `grep -n "paperclipRuntimeSkills" packages/adapter-utils/src/server-utils.ts`. If the key or entry shape differs, use exactly what `packages/adapters/grok-local/src/server/execute.test.ts` uses in its "stages Grok-native instructions and skills" test.

- [ ] **Step 4: Run it and verify it fails**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/execute.test.ts`
Expected: FAIL (module `./execute.js` not found).

- [ ] **Step 5: Implement `src/server/execute.ts`**

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  renderTemplate,
  renderPaperclipWakePrompt,
  resolveLegacyPaperclipDesiredSkillNames,
  resolvePaperclipInstanceRootForAdapter,
  refreshPaperclipWorkspaceEnvForExecution,
  selectInitialCommunicationGuidance,
  selectPaperclipTaskMarkdown,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasNonEmptyEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  return nonEmpty(env[key]) !== null;
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** The per-agent Muse data home (session store). Never the operator's ~/.local/share/muse. */
export function resolveMuseDataHome(env: NodeJS.ProcessEnv, companyId: string, agentId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "muse-data", agentId);
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_")).sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${keys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

const pathExists = (candidate: string) => fs.access(candidate).then(() => true).catch(() => false);

/** Copies desired skills into <cwd>/.agents/skills. Returns a cleanup that removes only what it created. */
async function stageMuseSkills(input: {
  cwd: string;
  skillEntries: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames: string[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ count: number; cleanup: () => Promise<void> }> {
  const created: string[] = [];
  const desired = new Set(input.desiredSkillNames);
  const selected = input.skillEntries.filter((entry) => desired.has(entry.key));
  let count = 0;
  if (selected.length > 0) {
    const agentsDir = path.join(input.cwd, ".agents");
    const skillsRoot = path.join(agentsDir, "skills");
    if (!(await pathExists(agentsDir))) {
      await fs.mkdir(agentsDir, { recursive: true });
      created.push(agentsDir);
    }
    if (!(await pathExists(skillsRoot))) {
      await fs.mkdir(skillsRoot, { recursive: true });
      created.push(skillsRoot);
    }
    for (const skill of selected) {
      const target = path.join(skillsRoot, skill.runtimeName);
      if (await pathExists(target)) {
        await input.onLog("stdout", `[paperclip] Muse skill target already exists at ${target}; leaving it unchanged.\n`);
        continue;
      }
      await materializePaperclipSkillCopy(skill.source, target);
      created.push(target);
      count += 1;
    }
  }
  return {
    count,
    cleanup: async () => {
      for (const entry of [...created].reverse()) {
        await fs.rm(entry, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    throw new Error("muse_local supports local execution only in this release");
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "muse");
  const model = asString(config.model, DEFAULT_MUSE_LOCAL_MODEL).trim() || DEFAULT_MUSE_LOCAL_MODEL;
  const reasoningEffort = asString(config.reasoningEffort, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const stagedSkills = await stageMuseSkills({ cwd, skillEntries, desiredSkillNames, onLog });
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-prompt-"));

  try {
    const envConfig = parseObject(config.env);
    const env: Record<string, string> = { ...buildPaperclipEnv(agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
    env.PAPERCLIP_RUN_ID = runId;
    const pick = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
    const wakeTaskId = pick(context.taskId) ?? pick(context.issueId);
    const wakeReason = pick(context.wakeReason);
    const wakeCommentId = pick(context.wakeCommentId) ?? pick(context.commentId);
    const approvalId = pick(context.approvalId);
    const approvalStatus = pick(context.approvalStatus);
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote: false,
      executionCwd: cwd,
    });
    if (authToken) env.PAPERCLIP_API_KEY = authToken;

    const dataHome = resolveMuseDataHome(process.env, agent.companyId, agent.id);
    await fs.mkdir(dataHome, { recursive: true, mode: 0o700 });
    env.XDG_DATA_HOME = dataHome;
    env.TBH_CREDENTIAL_BACKEND = "file";
    env.MUSE_NO_AUTO_UPDATE = "1";

    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand });
    const billingType: "api" | "subscription" = hasNonEmptyEnvValue(effectiveEnv, "META_API_KEY") ? "api" : "subscription";

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const storedSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const storedSessionCwd = asString(runtimeSessionParams.cwd, "");
    const canResume =
      storedSessionId.length > 0 &&
      (storedSessionCwd.length === 0 || path.resolve(storedSessionCwd) === path.resolve(cwd));
    if (storedSessionId && !canResume) {
      await onLog(
        "stdout",
        `[paperclip] Muse session "${storedSessionId}" was saved for cwd "${storedSessionCwd}" and will not be resumed in "${cwd}".\n`,
      );
    }
    const sessionId = canResume ? storedSessionId : randomUUID();

    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    let instructionsPrefix = "";
    if (instructionsFilePath) {
      try {
        const contents = await fs.readFile(instructionsFilePath, "utf8");
        const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
        instructionsPrefix =
          `${contents}\n\n` +
          `The above agent instructions were loaded from ${instructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
      }
    }

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const resumed = canResume;
    const taskContextNote = context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: resumed, includeCommunicationGuidance: false })
      : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: resumed,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const renderedPrompt = (resumed && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      instructionsPrefix,
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      wakePrompt,
      taskContextNote,
      asString(context.paperclipSessionHandoffMarkdown, "").trim(),
      renderPaperclipEnvNote(env),
      renderApiAccessNote(env),
      renderedPrompt,
    ]);
    const promptFile = path.join(promptDir, "prompt.md");
    await fs.writeFile(promptFile, prompt, { mode: 0o600 });

    const args = [
      "exec", "--json",
      "--model", model,
      ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []),
      "--approval-mode", "never",
      "--trust-workspace",
      "--workspace", cwd,
      "--session-id", sessionId,
      "--prompt-file", promptFile,
      ...(() => {
        const fromExtra = asStringArray(config.extraArgs);
        return fromExtra.length > 0 ? fromExtra : asStringArray(config.args);
      })(),
    ];

    if (onMeta) {
      await onMeta({
        adapterType: "muse_local",
        command: resolvedCommand,
        cwd,
        commandNotes: [
          "Prompt is passed to Muse via --prompt-file in headless mode.",
          "Added --approval-mode never and --trust-workspace for unattended execution (Muse sandbox stays on).",
          ...(instructionsPrefix ? [`Prepended agent instructions from ${instructionsFilePath}.`] : []),
          ...(stagedSkills.count > 0 ? [`Staged ${stagedSkills.count} Paperclip skill(s) into .agents/skills.`] : []),
        ],
        commandArgs: args,
        env: loggedEnv,
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog,
    });
    const parsed = parseMuseJsonl(proc.stdout);
    const failed = proc.timedOut || (proc.exitCode ?? 0) !== 0 || (parsed.terminal !== null && parsed.terminal !== "completed");
    const rawError = parsed.reason || firstNonEmptyLine(proc.stderr) || `Muse exited with code ${proc.exitCode ?? -1}`;
    const authFailure = failed && isMuseAuthError(`${rawError}\n${proc.stderr}`);
    const errorMessage = proc.timedOut
      ? `Timed out after ${timeoutSec}s`
      : !failed
        ? null
        : authFailure
          ? `Muse Code is not authenticated: ${rawError}. Run \`muse login\` on this host or bind META_API_KEY in the agent env.`
          : rawError;
    const resolvedSessionId = parsed.sessionId ?? sessionId;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage,
      ...(authFailure ? { errorCode: "muse_auth_required" } : {}),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      usageBasis: "per_run",
      sessionId: resolvedSessionId,
      sessionParams: {
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      },
      sessionDisplayId: resolvedSessionId,
      provider: "meta",
      biller: "muse",
      model: parsed.model ?? model,
      billingType,
      costUsd: null,
      resultJson: {
        terminal: parsed.terminal,
        toolResultCount: parsed.toolResultCount,
        ...(failed ? { stderr: proc.stderr } : {}),
      },
      summary: parsed.summary,
    };
  } finally {
    await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    await stagedSkills.cleanup();
  }
}
```

If `tsc` reports that `errorCode` is not a field of `AdapterExecutionResult`, check `packages/adapter-utils/src/types.ts` for the error-code field name other adapters use (`grep -rn "errorCode" packages/adapters/*/src/server/execute.ts`) and use that field. Keep the value `"muse_auth_required"`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/execute.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 7: Typecheck the package**

Run: `pnpm --filter @paperclipai/adapter-muse-local typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/muse-local/src/server
git commit -m "feat(muse-local): execute with session resume, skills staging, auth mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `testEnvironment`

**Files:**
- Create: `packages/adapters/muse-local/src/server/test.ts`, `test.test.ts`
- Modify: `packages/adapters/muse-local/src/server/index.ts` (add `export { testEnvironment } from "./test.js";`)

**Interfaces:**
- Consumes: `parseMuseJsonl`, `isMuseAuthError`, `resolveMuseDataHome`.
- Produces: `testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>` with check codes `muse_cwd_valid|muse_cwd_invalid`, `muse_command_resolvable|muse_command_unresolvable`, `muse_remote_unsupported`, `muse_hello_probe_passed|muse_hello_probe_auth_required|muse_hello_probe_failed|muse_hello_probe_timed_out|muse_hello_probe_unexpected_output`.

- [ ] **Step 1: Write the failing test** `src/server/test.test.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runProcessMock: vi.fn(), ensureCommandMock: vi.fn(async () => {}) }));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "remote box",
  ensureAdapterExecutionTargetCommandResolvable: (...a: unknown[]) => (mocks.ensureCommandMock as (...x: unknown[]) => unknown)(...a),
  ensureAdapterExecutionTargetDirectory: async () => {},
  resolveAdapterExecutionTargetCwd: (_t: unknown, cwd: string, fallback: string) => cwd || fallback,
  runAdapterExecutionTargetProcess: (...a: unknown[]) => (mocks.runProcessMock as (...x: unknown[]) => unknown)(...a),
}));

import { testEnvironment } from "./test.js";

const fixture = (name: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

function helloStdout(text: string) {
  return JSON.stringify({ schema_version: 1, stream: { kind: "session", id: "s" }, sequence: 1, record_type: "event", payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text, reason: null } });
}

describe("muse_local testEnvironment", () => {
  beforeEach(() => {
    mocks.runProcessMock.mockReset();
    mocks.ensureCommandMock.mockReset();
    mocks.ensureCommandMock.mockResolvedValue(undefined);
  });

  it("passes when the hello probe answers", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: helloStdout("hello"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("pass");
    expect(result.checks.map((c) => c.code)).toContain("muse_hello_probe_passed");
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args).toEqual(expect.arrayContaining(["exec", "--json", "--no-session-log", "--approval-mode", "never"]));
  });

  it("warns with auth_required when the key is rejected", async () => {
    mocks.runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: await fixture("exec-badkey.jsonl"), stderr: "" });
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    const check = result.checks.find((c) => c.code === "muse_hello_probe_auth_required");
    expect(check?.level).toBe("warn");
    expect(check?.hint).toMatch(/muse login/);
    expect(result.status).toBe("warn");
  });

  it("errors when the command is missing and skips the probe", async () => {
    mocks.ensureCommandMock.mockRejectedValue(new Error("Command not found: muse"));
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" } } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toContain("muse_command_unresolvable");
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
  });

  it("reports remote targets as unsupported", async () => {
    const result = await testEnvironment({ companyId: "c", adapterType: "muse_local", config: { cwd: "/tmp" }, executionTarget: { kind: "remote", transport: "ssh" } } as never);
    expect(result.checks.map((c) => c.code)).toContain("muse_remote_unsupported");
    expect(result.status).toBe("fail");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/test.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/test.ts`**

```ts
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function clip(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(input))) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "muse");
  const target = ctx.executionTarget ?? null;
  const result = () => ({ adapterType: "muse_local", status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() });

  if (target?.kind === "remote") {
    checks.push({
      code: "muse_remote_unsupported",
      level: "error",
      message: `muse_local supports local execution only in this release (target: ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}).`,
    });
    return result();
  }

  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `muse-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env: {}, createIfMissing: true });
    checks.push({ code: "muse_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({ code: "muse_cwd_invalid", level: "error", message: err instanceof Error ? err.message : "Invalid working directory", detail: cwd });
  }

  const env = { ...normalizeEnv(config.env), TBH_CREDENTIAL_BACKEND: "file", MUSE_NO_AUTO_UPDATE: "1" };
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({ code: "muse_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "muse_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Muse Code: curl -fsSL https://api.meta.ai/muse-launcher.sh | bash",
    });
  }
  if (checks.some((c) => c.code === "muse_cwd_invalid" || c.code === "muse_command_unresolvable")) return result();

  const model = asString(config.model, DEFAULT_MUSE_LOCAL_MODEL).trim() || DEFAULT_MUSE_LOCAL_MODEL;
  const probe = await runAdapterExecutionTargetProcess(
    runId,
    target,
    command,
    ["exec", "--json", "--no-session-log", "--approval-mode", "never", "--model", model, "--reasoning-effort", "low", "--workspace", cwd, "Respond with exactly hello."],
    { cwd, env, timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 60)), graceSec: 5, onLog: async () => {} },
  );
  const parsed = parseMuseJsonl(probe.stdout);
  const detail = clip(parsed.reason ?? probe.stderr);
  if (probe.timedOut) {
    checks.push({ code: "muse_hello_probe_timed_out", level: "warn", message: "Muse hello probe timed out.", hint: "Retry; if it persists run `muse exec \"say hello\"` manually." });
  } else if ((probe.exitCode ?? 1) !== 0 || parsed.terminal !== "completed") {
    const auth = isMuseAuthError(`${parsed.reason ?? ""}\n${probe.stderr}`);
    checks.push({
      code: auth ? "muse_hello_probe_auth_required" : "muse_hello_probe_failed",
      level: auth ? "warn" : "error",
      message: auth ? "Muse Code is not authenticated." : "Muse hello probe failed.",
      ...(detail ? { detail } : {}),
      hint: auth ? "Run `muse login` on this host, or bind META_API_KEY in the agent env." : undefined,
    });
  } else if (/\bhello\b/i.test(parsed.summary)) {
    checks.push({ code: "muse_hello_probe_passed", level: "info", message: `Muse hello probe succeeded (${parsed.model ?? model}).` });
  } else {
    checks.push({ code: "muse_hello_probe_unexpected_output", level: "warn", message: "Muse hello probe returned unexpected output.", ...(detail ? { detail } : {}) });
  }
  return result();
}
```

Add `export { testEnvironment } from "./test.js";` to `src/server/index.ts`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/server/test.test.ts && pnpm --filter @paperclipai/adapter-muse-local typecheck`
Expected: PASS (4 tests); typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/muse-local/src/server
git commit -m "feat(muse-local): environment test with hello probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: UI stdout parser, config builder, CLI printer

**Files:**
- Create: `packages/adapters/muse-local/src/ui/{parse-stdout.ts,parse-stdout.test.ts,build-config.ts,index.ts}`
- Create: `packages/adapters/muse-local/src/cli/{format-event.ts,index.ts}`

**Interfaces:**
- Consumes: `decodeMuseRecord` (Task 1), `DEFAULT_MUSE_LOCAL_MODEL`.
- Produces: `parseMuseStdoutLine(line: string, ts: string): TranscriptEntry[]`, `createMuseStdoutParser(): { parseLine(line, ts): TranscriptEntry[]; reset(): void }`, `buildMuseLocalConfig(v: CreateConfigValues): Record<string, unknown>`, `printMuseStreamEvent(raw: string, debug: boolean): void`.

- [ ] **Step 1: Write the failing test** `src/ui/parse-stdout.test.ts`

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMuseStdoutParser, parseMuseStdoutLine } from "./parse-stdout.js";

const lines = (name: string) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/__fixtures__", name), "utf8")
    .split(/\r?\n/).filter(Boolean);
const run = (name: string) => {
  const parser = createMuseStdoutParser();
  return lines(name).flatMap((line) => parser.parseLine(line, "2026-09-26T00:00:00Z"));
};

describe("muse stdout parser", () => {
  it("emits init, assistant deltas and a completion line for a basic run", () => {
    const entries = run("exec-basic.jsonl");
    expect(entries[0]).toMatchObject({ kind: "init", model: "muse-spark-1.3", sessionId: "01a0df95-ddaf-7cd0-91f4-246c59f925e8" });
    expect(entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text).join("")).toBe("MUSE OK");
    expect(entries.at(-1)).toMatchObject({ kind: "system", text: "Muse run completed" });
  });

  it("emits a tool_result for tool runs", () => {
    const toolResults = run("exec-tool.jsonl").filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ kind: "tool_result", toolUseId: "call_01a0df9defc4748786ec3e88dd3873f0", isError: false });
    expect((toolResults[0] as { content: string }).content).toContain("a.txt");
  });

  it("surfaces failures as stderr", () => {
    const stderr = run("exec-badkey.jsonl").filter((e) => e.kind === "stderr").map((e) => (e as { text: string }).text);
    expect(stderr.some((t) => t.includes("META_API_KEY was rejected"))).toBe(true);
  });

  it("does not echo the user prompt", () => {
    const entries = run("exec-basic.jsonl");
    expect(JSON.stringify(entries)).not.toContain("Reply with exactly");
  });

  it("passes non-JSON lines through as stdout", () => {
    expect(parseMuseStdoutLine("plain text", "t")).toEqual([{ kind: "stdout", ts: "t", text: "plain text" }]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm exec vitest run packages/adapters/muse-local/src/ui/parse-stdout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/ui/parse-stdout.ts`**

```ts
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { decodeMuseRecord } from "../shared/records.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toolResultIsError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { exit_code?: unknown; terminal_status?: unknown };
    if (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) return true;
    return typeof parsed.terminal_status === "string" && parsed.terminal_status !== "completed";
  } catch {
    return false;
  }
}

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const record = decodeMuseRecord(trimmed);
  if (!record) return [{ kind: "stdout", ts, text: line }];
  const { payload } = record;
  switch (record.payloadType) {
    case "run.model.configured":
      return [{ kind: "init", ts, model: str(payload.model_id), sessionId: record.streamId ?? "" }];
    case "run.output.delta": {
      const text = str(payload.text);
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    case "tool.result": {
      const content = str(payload.text);
      return [{ kind: "tool_result", ts, toolUseId: str(payload.call_id), content, isError: toolResultIsError(content) }];
    }
    case "run.terminal.completed": {
      const terminal = str(payload.terminal) || "unknown";
      if (terminal === "completed") return [{ kind: "system", ts, text: "Muse run completed" }];
      const reason = str(payload.reason);
      return [{ kind: "stderr", ts, text: reason ? `Muse run ${terminal}: ${reason}` : `Muse run ${terminal}` }];
    }
    default: {
      const event = payload.event as Record<string, unknown> | undefined;
      if (record.payloadType === "task.lifecycle.failed" || (event && event.kind === "failed")) {
        const reason = str(event?.reason);
        return reason ? [{ kind: "stderr", ts, text: reason }] : [];
      }
      // Lifecycle bookkeeping and the turn.input.user prompt echo are
      // intentionally dropped: the echo repeats the full prompt (it can carry
      // secrets) and lifecycle records are noise in a transcript.
      return [];
    }
  }
}

export function createMuseStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts);
    },
    reset() {},
  };
}

export function parseMuseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
```

- [ ] **Step 4: Implement `src/ui/build-config.ts` and `src/ui/index.ts`**

```ts
// build-config.ts
import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function buildMuseLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  ac.model = v.model || DEFAULT_MUSE_LOCAL_MODEL;
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  if (v.thinkingEffort) ac.reasoningEffort = v.thinkingEffort;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
```

```ts
// index.ts
export { parseMuseStdoutLine, createMuseStdoutParser } from "./parse-stdout.js";
export { buildMuseLocalConfig } from "./build-config.js";
```

- [ ] **Step 5: Implement the CLI printer** `src/cli/format-event.ts` and `src/cli/index.ts`

```ts
// format-event.ts
import pc from "picocolors";
import { decodeMuseRecord } from "../shared/records.js";

export function printMuseStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const record = decodeMuseRecord(line);
  if (!record) {
    console.log(line);
    return;
  }
  const { payload } = record;
  const text = typeof payload.text === "string" ? payload.text : "";
  switch (record.payloadType) {
    case "run.model.configured":
      console.log(pc.blue(`Muse model: ${String(payload.model_id ?? "")} (session ${record.streamId ?? "?"})`));
      return;
    case "run.output.delta":
      if (text) console.log(pc.green(`assistant: ${text}`));
      return;
    case "tool.result":
      console.log(pc.gray(`tool result (${String(payload.call_id ?? "")}): ${text.slice(0, 400)}`));
      return;
    case "run.terminal.completed": {
      const terminal = String(payload.terminal ?? "unknown");
      const reason = typeof payload.reason === "string" ? payload.reason : "";
      console.log(terminal === "completed" ? pc.blue("Muse run completed") : pc.red(`Muse run ${terminal}${reason ? `: ${reason}` : ""}`));
      return;
    }
    default:
      if (debug && record.payloadType !== "turn.input.user") console.log(pc.gray(`event: ${record.payloadType}`));
  }
}
```

```ts
// cli/index.ts
export { printMuseStreamEvent } from "./format-event.js";
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm exec vitest run packages/adapters/muse-local && pnpm --filter @paperclipai/adapter-muse-local typecheck`
Expected: every muse-local test passes; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/muse-local/src/ui packages/adapters/muse-local/src/cli
git commit -m "feat(muse-local): UI transcript parser, config builder, CLI printer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Server, shared and CLI registration plus packaging

**Files:**
- Modify: `packages/shared/src/constants.ts` (add `"muse_local",`; see the placement rule in Step 2)
- Modify: `server/src/adapters/builtin-adapter-types.ts` (add `"muse_local",`)
- Modify: `server/src/adapters/registry.ts` (imports, `museLocalAdapter`, `registerBuiltInAdapters` array)
- Modify: `server/src/services/heartbeat.ts` (`GIT_SENSITIVE_LOCAL_ADAPTER_TYPES` add `"muse_local"`)
- Modify: `server/src/services/conversation-continuation.ts` (`CONVERSATION_ADAPTER_TYPES` add `"muse_local"`)
- Modify: `cli/src/adapters/registry.ts` (`museLocalCLIAdapter` + register)
- Modify: `server/package.json`, `cli/package.json` (`"@paperclipai/adapter-muse-local": "workspace:*"` next to the grok dep)
- Modify: `Dockerfile` (after the grok COPY line: `COPY packages/adapters/muse-local/package.json packages/adapters/muse-local/`)
- Modify: `scripts/release-package-manifest.json` (entry mirroring grok-local's with `dir: "packages/adapters/muse-local"`, `name: "@paperclipai/adapter-muse-local"`)
- Modify: `tests/runner-acceptance/catalog.ts` (add `"muse_local",`)
- Test: existing `server/src/__tests__/adapter-models.test.ts`, `server/src/adapters/registry.test.ts`, `server/src/__tests__/question-response-delivery.test.ts`

**Interfaces:**
- Consumes: package exports from Tasks 1–5.
- Produces: `findActiveServerAdapter("muse_local")` returns a module with `type: "muse_local"`, `runtimeToolDelivery: "environment"`, and `models` equal to the two Muse models.

- [ ] **Step 1: Extend the exhaustive tests first (failing)**

In `server/src/__tests__/adapter-models.test.ts`, add a row next to the grok row in the per-adapter `it.each` model table:
```ts
["muse_local", ["muse-spark-1.3", "muse-spark-1.3-contributor"]],
```
In `server/src/adapters/registry.test.ts`, add `muse_local: "environment"` to the runtime-delivery expectations map next to `grok_local`. In `server/src/__tests__/question-response-delivery.test.ts`, add `"muse_local"` to `DIRECT_ADAPTER_TYPES` next to `"grok_local"`.

Run: `pnpm exec vitest run server/src/__tests__/adapter-models.test.ts server/src/adapters/registry.test.ts server/src/__tests__/question-response-delivery.test.ts`
Expected: FAIL on the new `muse_local` rows (adapter not registered).

- [ ] **Step 2: Register in the server**

In `server/src/adapters/registry.ts`, after the grok import blocks:
```ts
import {
  execute as museExecute,
  listMuseSkills,
  syncMuseSkills,
  testEnvironment as museTestEnvironment,
  sessionCodec as museSessionCodec,
} from "@paperclipai/adapter-muse-local/server";
import {
  agentConfigurationDoc as museAgentConfigurationDoc,
  models as museModels,
} from "@paperclipai/adapter-muse-local";
```
After `grokLocalAdapter`:
```ts
const museLocalAdapter: ServerAdapterModule = {
  type: "muse_local",
  runtimeToolDelivery: "environment",
  execute: museExecute,
  testEnvironment: museTestEnvironment,
  listSkills: listMuseSkills,
  syncSkills: syncMuseSkills,
  sessionCodec: museSessionCodec,
  sessionManagement: getAdapterSessionManagement("muse_local") ?? undefined,
  models: museModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: readConfiguredCommand(config, "muse"),
    detectCommand: readConfiguredCommand(config, "muse"),
    installCommand: null,
  }),
  agentConfigurationDoc: museAgentConfigurationDoc,
};
```
Add `museLocalAdapter,` right after `grokLocalAdapter,` in the `registerBuiltInAdapters` array. Add `"muse_local"` to `builtin-adapter-types.ts`, `heartbeat.ts` `GIT_SENSITIVE_LOCAL_ADAPTER_TYPES`, `conversation-continuation.ts` `CONVERSATION_ADAPTER_TYPES`, and `packages/shared/src/constants.ts` `AGENT_ADAPTER_TYPES`. Placement rule: if the list is alphabetical, insert `"muse_local"` in alphabetical position; otherwise insert it directly after `"grok_local"`.

- [ ] **Step 3: Register in the CLI**

In `cli/src/adapters/registry.ts`:
```ts
import { printMuseStreamEvent } from "@paperclipai/adapter-muse-local/cli";

const museLocalCLIAdapter: CLIAdapterModule = {
  type: "muse_local",
  formatStdoutEvent: printMuseStreamEvent,
};
```
Add `museLocalCLIAdapter` to the adapters list, next to `grokLocalCLIAdapter`.

- [ ] **Step 4: Packaging**

Add the workspace dependency to `server/package.json` and `cli/package.json`, the `Dockerfile` COPY line, the release-manifest entry and the runner-acceptance catalog entry (file list above). Then run `pnpm install`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm exec vitest run server/src/__tests__/adapter-models.test.ts server/src/adapters/registry.test.ts server/src/__tests__/question-response-delivery.test.ts && pnpm --filter @paperclipai/server typecheck && pnpm --filter paperclipai typecheck`
Expected: PASS; both typechecks exit 0. (If a package filter name differs, read `name` from `server/package.json` / `cli/package.json`.)

Then run the whole server suite once to catch other exhaustive adapter lists: `pnpm exec vitest run server`. Any failure that enumerates adapter types (for example `environment-execution-target.test.ts`) gets `muse_local` added next to `grok_local` **only if** the list is about all registered adapters. Lists of remote-managed adapters stay unchanged in Phase 1.

- [ ] **Step 6: Commit**

```bash
git add packages/shared server cli Dockerfile scripts/release-package-manifest.json tests/runner-acceptance/catalog.ts pnpm-lock.yaml
git commit -m "feat(muse-local): register muse_local in shared types, server and CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: UI registration

**Files:**
- Create: `ui/src/adapters/muse-local/index.ts`, `ui/src/adapters/muse-local/config-fields.tsx`
- Create: `ui/public/brands/adapters/muse.png` (copy of `doc/assets/logos/muse.png`)
- Modify: `ui/package.json`, `ui/src/adapters/registry.ts`, `ui/src/adapters/adapter-display-registry.ts`, `ui/src/adapters/use-adapter-capabilities.ts`, `ui/src/lib/agent-setup-fields.ts`, `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/new-agent/AgentBasicsDialog.tsx`, `ui/src/components/TaskChatThread.tsx`
- Test: `ui/src/adapters/adapter-display-registry.test.ts`, `ui/src/lib/agent-setup-fields.test.ts`

**Interfaces:**
- Consumes: `parseMuseStdoutLine`, `createMuseStdoutParser`, `buildMuseLocalConfig` (Task 5), `museLocalReasoningEffortsForModel` (Task 1).
- Produces: `museLocalUIAdapter: UIAdapterModule`, `getAdapterLabel("muse_local") === "Muse Code"`, and `setupEfforts("muse_local", m)` returning the eight Muse efforts.

- [ ] **Step 1: Extend the UI tests first (failing)**

In `ui/src/adapters/adapter-display-registry.test.ts`, add `muse_local: "Muse Code"` to the exhaustive label map next to `grok_local`. In `ui/src/lib/agent-setup-fields.test.ts`, add:
```ts
it("lists Muse reasoning efforts", () => {
  expect(setupEfforts("muse_local", "muse-spark-1.3")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
});
```
Run: `pnpm exec vitest run ui/src/adapters/adapter-display-registry.test.ts ui/src/lib/agent-setup-fields.test.ts`
Expected: FAIL on the Muse cases.

- [ ] **Step 2: Create the UI adapter**

`ui/src/adapters/muse-local/config-fields.tsx`: copy `ui/src/adapters/grok-local/config-fields.tsx`, rename the component to `MuseLocalConfigFields`, and change the hint to `"Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Paperclip prepends it to every Muse run prompt."`.

`ui/src/adapters/muse-local/index.ts`:
```ts
import type { UIAdapterModule } from "../types";
import { buildMuseLocalConfig, createMuseStdoutParser, parseMuseStdoutLine } from "@paperclipai/adapter-muse-local/ui";
import { MuseLocalConfigFields } from "./config-fields";

export const museLocalUIAdapter: UIAdapterModule = {
  type: "muse_local",
  label: "Muse Code",
  parseStdoutLine: parseMuseStdoutLine,
  createStdoutParser: createMuseStdoutParser,
  ConfigFields: MuseLocalConfigFields,
  buildAdapterConfig: buildMuseLocalConfig,
};
```
Register it in `ui/src/adapters/registry.ts` (import plus `museLocalUIAdapter,` after `grokLocalUIAdapter,`). Add `"@paperclipai/adapter-muse-local": "workspace:*"` to `ui/package.json`.

- [ ] **Step 3: Display, capabilities, setup fields, form, brand, retry list**

`adapter-display-registry.ts`, after `grok_local`:
```ts
  muse_local: {
    label: "Muse Code",
    description: "Meta Muse Code harness",
    icon: Bot,
  },
```
`use-adapter-capabilities.ts` `KNOWN_DEFAULTS` (no `login` key in Phase 1):
```ts
  muse_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsAcp: false },
```
`agent-setup-fields.ts`: import `museLocalReasoningEffortsForModel` from `@paperclipai/adapter-muse-local`; add a `setupEfforts` case:
```ts
    case "muse_local":
      return [...museLocalReasoningEffortsForModel(model)];
```
and a `SETUP_LOGIN_HINTS` entry:
```ts
  muse_local:
    "Muse Code uses its CLI sign-in. Run muse login on the selected environment's host (or bind META_API_KEY), then test the connection here.",
```
`AgentConfigForm.tsx`: at line ~1272, change `adapterType === "grok_local" ? "reasoningEffort"` to `adapterType === "grok_local" || adapterType === "muse_local" ? "reasoningEffort"`. At line ~1288, add `|| adapterType === "muse_local"` to the `claude_local || grok_local` condition. At line ~1724, add `"muse_local"` to the `clearUnsupportedEffort` list.
`AgentBasicsDialog.tsx` brand marks: add `muse_local: { src: "/brands/adapters/muse.png" },` next to the `gemini_local` single-src entry, and copy the PNG: `cp doc/assets/logos/muse.png ui/public/brands/adapters/muse.png`.
`TaskChatThread.tsx` line ~565: add `"muse_local"` to the legacy-retry list next to `"grok_local"` (it mirrors `CONVERSATION_ADAPTER_TYPES`).

- [ ] **Step 4: Run the tests, typecheck and token gates**

Run: `pnpm exec vitest run ui/src/adapters ui/src/lib/agent-setup-fields.test.ts ui/src/components/NewAgentDialog.test.tsx && pnpm --filter @paperclipai/ui typecheck && pnpm check:token-gates`
Expected: PASS; typecheck exit 0; token gates pass. If `NewAgentDialog.test.tsx` fails because it enumerates all picker adapters, add `muse_local` to its expected list in the same position the picker renders it.

- [ ] **Step 5: Commit**

```bash
git add ui pnpm-lock.yaml
git commit -m "feat(muse-local): UI adapter registration, efforts, brand mark

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification, live smoke test, docs

**Files:**
- Modify: `README.md` (adapter examples paragraph at line ~218: add "Muse Code" to "Claude Code, Codex, …")
- Modify: `doc/plans/2026-09-26-muse-local-adapter-design.md` (Status line: "Phase 1 implemented <date>")
- Vault: `/Users/rossfisher/Documents/Master Vault/Tech/Paperclip — Muse Code subscription adapter.md`, Status section

- [ ] **Step 1: Full repo checks**

Run: `cd ~/paperclip && pnpm -r typecheck && pnpm test:run && pnpm build`
Expected: all exit 0. Record anything that fails; fix failures caused by this branch. If a failure also happens on `master` (`git stash; git checkout master; <same command>`), note it as pre-existing and do not fix it.

- [ ] **Step 2: Live smoke on the Muse Code subscription**

```bash
cd ~/paperclip && pnpm dev   # background; API + UI on http://localhost:3100
```
In the UI: create a company, add an agent with adapter **Muse Code**, model `muse-spark-1.3`, cwd a scratch git repo. Click **Test environment** and expect `muse_hello_probe_passed`. Assign it an issue: "Create hello.txt containing 'hi from muse' and comment on this issue with its contents via the Paperclip API." Expect:
- the run succeeds, the transcript shows assistant text and at least one tool result, and there is no prompt echo;
- `hello.txt` exists in the workspace, and the issue has the comment (this proves the Paperclip API is reachable from Muse's sandbox);
- a second wake on the same issue resumes the same session id (visible in run details);
- `.agents/` does not exist in the workspace after the run.

Then set the agent env `META_API_KEY` to `LLM|bogus000000000000000000000000000000000000000`, run again, and expect the run to fail with "Muse Code is not authenticated … Run `muse login` …" and errorCode `muse_auth_required`.

- [ ] **Step 3: Update docs and commit**

Edit the README paragraph and the spec status line, then:
```bash
git add README.md doc/plans/2026-09-26-muse-local-adapter-design.md
git commit -m "docs: muse_local phase 1 shipped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Update the vault note's Status section with the smoke-test results (run ids, what passed).
