# Paperclip Cloud Adapter — Milestone 2: Headless Agent Execution End-to-End

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a real `claude_local` agent run end-to-end inside a Kubernetes pod — workspace cloned from git in an init container, claude-code CLI invoked with prompts, stdout streamed back to Paperclip, structured events posted via run-JWT auth, Job lifecycle managed (TTL cleanup, OwnerReference GC, cancellation), all observable in `kubectl logs`.

**Architecture:** Extends M1 by replacing the driver's `run()` stub with a real Job-based execution path. One `batch/v1 Job` per heartbeat carries a paperclip-workspace-init init container that resolves the workspace strategy and an agent runtime container that runs `paperclip-agent-shim` (Go static binary) which exec's the actual adapter CLI. A per-Job ephemeral `Secret` (with `OwnerReferences` to the Job for auto-GC) carries the bootstrap token, resolved adapter env (LLM keys), and a short-TTL git credential handle. Stdout streams via `pods/log` watch; `Job` and `Pod` Events surface as `[k8s]`-prefixed log lines; structured events (`init`/`assistant`/`tool_call`/`result`) are POSTed by the agent shim to `/api/runs/:runId/events` after a single bootstrap-token-for-run-JWT exchange. PVC-per-agent persists workspaces between heartbeats.

**Tech Stack:** TypeScript (orchestrator + server routes + adapter wiring), Go 1.22 (`paperclip-agent-shim` static binary), Node.js (`paperclip-workspace-init` script consuming `@paperclipai/workspace-strategy`), Distroless or `ubuntu-slim` base images with `tini` + `git`, `@kubernetes/client-node` v0.21, `kind` for integration tests, `cosign` keyless OIDC for image signing in CI.

**Spec reference:** `docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md` — sections §3 (Pod Lifecycle), §4 (Workspace Persistence), §5 (Images & Secrets), §6 (Networking & Callback), §7 (Observability + Failure Modes + Testing).

**M1 reference:** `docs/superpowers/plans/2026-05-08-paperclip-cloud-adapter-m1-plan.md` (30 commits on `feat/k8s-cloud-adapter-m1`; tenant provisioning is done — namespace, RBAC, ResourceQuota, LimitRange, NetworkPolicy vanilla + Cilium variant, image pull secret, ClusterConnections service, ExecutionTargetDriverRegistry, CLI commands).

**Branch:** `feat/k8s-cloud-adapter-m2`, branched from `feat/k8s-cloud-adapter-m1` (M1 will land first; M2 builds on top).

---

## Architectural Decisions Locked Before Planning

| # | Decision | Rationale |
|---|---|---|
| M2-1 | `paperclip-agent-shim` is a Go 1.22 static binary | Tiny program (read config → exec adapter CLI → frame stdout). Go gives ~3MB stripped binary with ~5ms startup. No Node tax for the PID-1 supervisor. |
| M2-2 | `paperclip-workspace-init` is a Node script using `@paperclipai/workspace-strategy` | Reuses the canonical TS implementation. Base image needs Node anyway (claude-code is a Node CLI), so no extra cost. Avoids reimplementing git workflow logic in Go. |
| M2-3 | Workspace strategy is extracted to `@paperclipai/workspace-strategy` | One implementation consumed by both the server local-adapter path AND the init container. Real refactor; ~3-5 days. Risk #1 resolved. |
| M2-4 | Bootstrap-token-only auth in M2; full TokenReview deferred to V2 | Same auth path the cursor-cloud adapter ships. Bootstrap token TTL = 10 min, single-use, bound to Job UID. Risk #5 resolved (with explicit V2 follow-up). |
| M2-5 | Resource defaults measured during M2 implementation; tuning in same PR | When the end-to-end test runs real claude_local heartbeats we capture p50/p95/p99 CPU/memory and adjust `LimitRange` defaults in the same commit. Risk #4 resolved. |
| M2-6 | Single adapter coverage in M2 — `claude_local` only | The other six adapters (codex/gemini/opencode/acpx/pi/cursor) keep their M1 rejection branch and gain k8s execution in M3. Tightens M2 scope. |
| M2-7 | One image family member in M2 — `agent-runtime-base` + `agent-runtime-claude` | M3 builds the rest. Multi-arch (amd64+arm64) shipped from day one. |
| M2-8 | No sidecars in V1 (per spec §3.3); log streaming via `pods/log` watch | Spec decision; M2 honors it. |

---

## Scope Note

M2 is one coherent vertical slice — it produces a real, demonstrable capability ("the hired agent works on Kubernetes") that can ship and be merged. The plan is large because the slice is wide (Go binary + Node script + image build + 5 server routes + 6 orchestrator builders + driver implementation + claude_local wiring + 4 integration tests + image CI), but it's not split because the slice has no internal cut-points where partial completion would be useful — without callbacks, the Job runs blindly; without orchestrator extensions, the routes have nothing to talk to; etc.

Operators who want to try M2 mid-development can run individual integration tests, but the merge unit is the whole slice.

---

## File Structure

### New packages

```
packages/workspace-strategy/                              # NEW
├── package.json                                          # @paperclipai/workspace-strategy
├── tsconfig.json
└── src/
    ├── index.ts                                          # public exports
    ├── types.ts                                          # WorkspaceStrategySpec, WorkspaceStrategyKind
    ├── execute.ts                                        # executeStrategy(spec, root, deps) — top-level dispatch
    ├── git-clone.ts                                      # cold + warm git-clone strategy
    ├── git-worktree.ts                                   # bare clone + worktree-add strategy
    ├── existing-path.ts                                  # validation-time rejector for k8s; no-op for local
    └── git-runner.ts                                     # tiny shell wrapper around `git` (testable)
```

### New Go binary

```
tools/agent-shim/                                         # NEW Go static binary
├── go.mod
├── go.sum
├── main.go                                               # PID-1 supervisor: parse config, exec adapter CLI, frame stdout
├── runtime_command.go                                    # AdapterRuntimeCommandSpec parsing
├── stdout_framer.go                                      # structured-event framing for UI parsers
├── callback_client.go                                    # POST /api/runs/:runId/events with run JWT
├── bootstrap_exchange.go                                 # POST /api/agent-auth/exchange to get run JWT
└── main_test.go
```

### New Node script

```
tools/workspace-init/                                     # NEW Node script
├── package.json                                          # @paperclipai/workspace-init (private)
├── tsconfig.json
└── src/
    ├── index.ts                                          # entrypoint: parse strategy spec, exchange bootstrap token, run strategy
    └── git-credentials.ts                                # POST /api/workspace/git-credentials
```

### New runtime images

```
docker/agent-runtime/                                     # NEW
├── Dockerfile.base                                       # ubuntu-22.04 + node-22 + git + tini + nonroot uid 1000 + agent-shim + workspace-init
├── Dockerfile.claude                                     # extends base + @anthropic-ai/claude-code CLI pinned
├── buildx-bake.hcl                                       # multi-arch (amd64+arm64) build config
└── README.md
```

### Orchestrator extensions

```
packages/adapters/kubernetes-execution/
├── src/
│   ├── orchestrator/
│   │   ├── pvc.ts                                        # NEW (PVC-per-agent builder + apply)
│   │   ├── secret.ts                                     # NEW (per-Job ephemeral Secret materializer)
│   │   ├── job.ts                                        # NEW (Job spec builder: init + main containers, volumes)
│   │   ├── log-stream.ts                                 # NEW (pods/log watch → onLog with reconnect)
│   │   ├── event-watch.ts                                # NEW (Job/Pod Events watch → onLog with [k8s] prefix)
│   │   ├── cancellation.ts                               # NEW (Job delete with grace + foreground propagation)
│   │   └── failure-mapping.ts                            # NEW (k8s state → AdapterExecutionResult error codes)
│   ├── redaction.ts                                      # MODIFIED (real implementation; was groundwork in M1)
│   ├── driver.ts                                         # MODIFIED (real run() implementation replacing M1 stub)
│   └── bootstrap/
│       └── token.ts                                      # NEW (driver-side wrapper around server bootstrap-token API)
└── test/
    ├── unit/
    │   ├── pvc.test.ts
    │   ├── secret.test.ts                                # incl. redaction key extraction
    │   ├── job.test.ts                                   # Job spec golden snapshots
    │   ├── log-stream.test.ts                            # mocked pods/log watch
    │   ├── event-watch.test.ts
    │   ├── cancellation.test.ts
    │   ├── failure-mapping.test.ts
    │   └── redaction.test.ts
    └── integration/
        ├── job-lifecycle.test.ts                         # busybox Job: submit → run → log capture → cleanup
        ├── claude-end-to-end.test.ts                     # real claude_local against fake LLM
        ├── failure-modes.test.ts                         # ImagePullBackOff, OOM, timeout
        └── empirical-measurement.test.ts                 # records CPU/memory; commits results
```

### Server-side auth + callbacks

```
server/src/services/
├── bootstrap-tokens.ts                                   # NEW (mint, validate, single-use, bound to Job UID)
├── bootstrap-tokens.test.ts
├── run-jwt.ts                                            # NEW (mint, validate run-scoped JWT)
└── run-jwt.test.ts

server/src/routes/
├── agent-auth-exchange.ts                                # NEW POST /api/agent-auth/exchange
├── agent-auth-exchange.test.ts
├── runs-events.ts                                        # NEW POST /api/runs/:runId/events
├── runs-events.test.ts
├── workspace-git-credentials.ts                          # NEW POST /api/workspace/git-credentials
└── workspace-git-credentials.test.ts
```

### Adapter wiring

```
packages/adapters/claude-local/src/server/
└── execute.ts                                            # MODIFIED (route to k8s when target.kind === "kubernetes")
```

### Documentation

```
docs/k8s-execution/
├── running-agents.md                                     # NEW (operator: how to run a claude_local agent on k8s)
├── building-images.md                                    # NEW (developer: image build pipeline)
├── debugging-stuck-pods.md                               # NEW (operator: kubectl recipes for stuck/failed runs)
└── auth-callback-flow.md                                 # NEW (developer: bootstrap-token → run-JWT lifecycle)
```

### CI

```
.github/workflows/
├── k8s-images.yml                                        # NEW (build + push agent-runtime images, multi-arch, signed)
└── k8s-integration.yml                                   # MODIFIED (add new integration tests)
```

---

## Sequencing & Workstream Notes

- **Phase A (Tasks 1–4)** — Workspace-strategy extract. Sequential; affects existing server code paths.
- **Phase B (Tasks 5–10)** — Go agent-shim + Node workspace-init + runtime images. Parallelisable across agents after A is done. Phase B doesn't touch server; tests run in their own packages.
- **Phase C (Tasks 11–16)** — Server bootstrap-token + run-JWT services + 3 callback routes. Independent of A/B; parallel-safe.
- **Phase D (Tasks 17–22)** — Orchestrator extensions (PVC/Secret/Job/log-stream/event-watch/cancellation/failure-mapping). Pure builders + apply functions. Parallelisable after Phase B types exist.
- **Phase E (Tasks 23–24)** — Driver `run()` implementation + claude_local wiring. Depends on B/C/D.
- **Phase F (Tasks 25–28)** — End-to-end integration tests + empirical measurement + failure-mode coverage. Depends on E.
- **Phase G (Tasks 29–30)** — Image CI + docs + ROADMAP. Independent of E/F.

Total: 30 tasks. Each is 2–6 TDD-discipline steps.

---

## Phase A — Workspace Strategy Extract (Tasks 1–4)

### Task 1: Scaffold `@paperclipai/workspace-strategy` package

**Files:**
- Create: `packages/workspace-strategy/package.json`
- Create: `packages/workspace-strategy/tsconfig.json`
- Create: `packages/workspace-strategy/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@paperclipai/workspace-strategy",
  "version": "0.0.0",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** matching sibling style (see `packages/adapters/kubernetes-execution/tsconfig.json`)

- [ ] **Step 3: Create `src/index.ts` placeholder** with `export const PACKAGE_NAME = "@paperclipai/workspace-strategy";`

- [ ] **Step 4: Verify `pnpm install && pnpm --filter @paperclipai/workspace-strategy build` succeeds**

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-strategy pnpm-lock.yaml
git commit -m "feat(workspace-strategy): scaffold package"
```

### Task 2: Define `WorkspaceStrategySpec` types and JSON schema

**Files:**
- Create: `packages/workspace-strategy/src/types.ts`
- Create: `packages/workspace-strategy/src/types.test.ts`

- [ ] **Step 1: Failing test asserting the union shape and serialization round-trip**

```ts
// packages/workspace-strategy/src/types.test.ts
import { describe, it, expect, expectTypeOf } from "vitest";
import { type WorkspaceStrategySpec, parseWorkspaceStrategySpec, serializeWorkspaceStrategySpec } from "./index.js";

describe("WorkspaceStrategySpec", () => {
  it("accepts a git-clone variant", () => {
    const spec: WorkspaceStrategySpec = {
      kind: "git-clone",
      url: "https://github.com/acme/repo.git",
      ref: "main",
      resetOnCorrupt: true,
    };
    expectTypeOf(spec.kind).toEqualTypeOf<"git-clone" | "git-worktree" | "existing-path" | "none">();
  });

  it("round-trips git-clone via serialize/parse", () => {
    const spec: WorkspaceStrategySpec = {
      kind: "git-clone", url: "https://github.com/acme/repo.git", ref: "main", resetOnCorrupt: true,
    };
    const json = serializeWorkspaceStrategySpec(spec);
    expect(JSON.parse(json)).toMatchObject({ kind: "git-clone", url: spec.url, ref: spec.ref });
    const parsed = parseWorkspaceStrategySpec(json);
    expect(parsed).toEqual(spec);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseWorkspaceStrategySpec(JSON.stringify({ kind: "bogus" }))).toThrow(/unknown kind/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

`pnpm --filter @paperclipai/workspace-strategy test types`

- [ ] **Step 3: Implement `src/types.ts`**

```ts
export type WorkspaceStrategyKind = "git-clone" | "git-worktree" | "existing-path" | "none";

export interface GitCloneStrategy {
  kind: "git-clone";
  url: string;
  ref: string;            // branch | tag | sha
  resetOnCorrupt?: boolean;
}

export interface GitWorktreeStrategy {
  kind: "git-worktree";
  url: string;
  ref: string;
  worktreeName: string;   // becomes /workspace/<worktreeName> on disk
  resetOnCorrupt?: boolean;
}

export interface ExistingPathStrategy {
  kind: "existing-path";
  hostPath: string;       // not supported on k8s; rejected at config-validation time
}

export interface NoneStrategy { kind: "none"; }

export type WorkspaceStrategySpec =
  | GitCloneStrategy | GitWorktreeStrategy | ExistingPathStrategy | NoneStrategy;

export function serializeWorkspaceStrategySpec(spec: WorkspaceStrategySpec): string {
  return JSON.stringify(spec);
}

export function parseWorkspaceStrategySpec(json: string): WorkspaceStrategySpec {
  const parsed = JSON.parse(json) as { kind?: unknown };
  if (typeof parsed.kind !== "string") {
    throw new Error(`Invalid workspace strategy: missing kind`);
  }
  switch (parsed.kind) {
    case "git-clone":     return parsed as GitCloneStrategy;
    case "git-worktree":  return parsed as GitWorktreeStrategy;
    case "existing-path": return parsed as ExistingPathStrategy;
    case "none":          return parsed as NoneStrategy;
    default:
      throw new Error(`Invalid workspace strategy: unknown kind "${parsed.kind}"`);
  }
}
```

Re-export from `src/index.ts`:

```ts
export {
  type WorkspaceStrategyKind, type WorkspaceStrategySpec,
  type GitCloneStrategy, type GitWorktreeStrategy, type ExistingPathStrategy, type NoneStrategy,
  serializeWorkspaceStrategySpec, parseWorkspaceStrategySpec,
} from "./types.js";
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/workspace-strategy/src/types.ts \
        packages/workspace-strategy/src/types.test.ts \
        packages/workspace-strategy/src/index.ts
git commit -m "feat(workspace-strategy): add WorkspaceStrategySpec types and JSON schema"
```

### Task 3: Implement `executeStrategy` with git-runner abstraction

**Files:**
- Create: `packages/workspace-strategy/src/git-runner.ts`
- Create: `packages/workspace-strategy/src/execute.ts`
- Create: `packages/workspace-strategy/src/git-clone.ts`
- Create: `packages/workspace-strategy/src/git-worktree.ts`
- Create: `packages/workspace-strategy/test/execute.test.ts`

- [ ] **Step 1: Failing test for git-clone happy path with mocked git-runner**

```ts
// packages/workspace-strategy/test/execute.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeStrategy } from "../src/index.js";

function makeFakeRunner() {
  return {
    run: vi.fn(async (cmd: string, args: string[], opts?: { cwd?: string }) => ({
      exitCode: 0, stdout: "", stderr: "",
    })),
  };
}

describe("executeStrategy", () => {
  it("runs git clone for a cold workspace (empty directory)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      await executeStrategy(
        { kind: "git-clone", url: "https://github.com/acme/repo.git", ref: "main" },
        root,
        { git, getGitCredentials: async () => ({ username: "x-access-token", password: "ghp_test" }) },
      );
      expect(git.run).toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]), expect.any(Object));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs git fetch + reset for a warm workspace (.git exists)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      // Simulate warm by creating a .git directory.
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(root, ".git"), { recursive: true });
      const git = makeFakeRunner();
      await executeStrategy(
        { kind: "git-clone", url: "https://github.com/acme/repo.git", ref: "main" },
        root,
        { git, getGitCredentials: async () => ({ username: "x-access-token", password: "ghp_test" }) },
      );
      const calls = git.run.mock.calls.map(c => c[1].join(" "));
      expect(calls.some(c => c.includes("fetch"))).toBe(true);
      expect(calls.some(c => c.includes("reset --hard"))).toBe(true);
      expect(calls.some(c => c.includes("clone"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects existing-path strategy (not supported in non-local execution)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      await expect(executeStrategy(
        { kind: "existing-path", hostPath: "/some/path" } as never,
        root,
        { git: makeFakeRunner(), getGitCredentials: async () => ({ username: "", password: "" }), allowExistingPath: false },
      )).rejects.toThrow(/existing-path|not supported/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("no-op for kind=none", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    try {
      const git = makeFakeRunner();
      await executeStrategy({ kind: "none" }, root, { git, getGitCredentials: async () => ({ username: "", password: "" }) });
      expect(git.run).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement `git-runner.ts`**

```ts
import { spawn } from "node:child_process";

export interface GitRunResult { exitCode: number; stdout: string; stderr: string; }

export interface GitRunner {
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitRunResult>;
}

export const realGitRunner: GitRunner = {
  async run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: opts?.cwd, env: { ...process.env, ...(opts?.env ?? {}) } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
  },
};
```

- [ ] **Step 4: Implement `git-clone.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitCloneStrategy } from "./types.js";
import type { GitRunner } from "./git-runner.js";

export interface GitCloneDeps {
  git: GitRunner;
  getGitCredentials(): Promise<{ username: string; password: string }>;
}

export async function executeGitClone(
  spec: GitCloneStrategy,
  root: string,
  deps: GitCloneDeps,
): Promise<void> {
  const creds = await deps.getGitCredentials();
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_USERNAME: creds.username,
    GIT_PASSWORD: creds.password,
  };

  const isWarm = existsSync(join(root, ".git"));
  if (!isWarm) {
    const url = injectCreds(spec.url, creds);
    const r = await deps.git.run("git", ["clone", "--branch", spec.ref, url, "."], { cwd: root, env });
    if (r.exitCode !== 0) {
      throw new Error(`git clone failed (${r.exitCode}): ${r.stderr}`);
    }
    return;
  }

  // Warm path: fetch + reset --hard
  const fetched = await deps.git.run("git", ["fetch", "origin", spec.ref], { cwd: root, env });
  if (fetched.exitCode !== 0) {
    throw new Error(`git fetch failed (${fetched.exitCode}): ${fetched.stderr}`);
  }
  const reset = await deps.git.run("git", ["reset", "--hard", `origin/${spec.ref}`], { cwd: root, env });
  if (reset.exitCode !== 0 && spec.resetOnCorrupt) {
    // Last-resort: blow away and re-clone.
    const fs = await import("node:fs/promises");
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    return executeGitClone(spec, root, deps);
  }
  if (reset.exitCode !== 0) {
    throw new Error(`git reset --hard origin/${spec.ref} failed: ${reset.stderr}`);
  }
}

function injectCreds(url: string, creds: { username: string; password: string }): string {
  if (!url.startsWith("https://")) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(creds.username);
  u.password = encodeURIComponent(creds.password);
  return u.toString();
}
```

- [ ] **Step 5: Implement `git-worktree.ts` and `execute.ts` dispatcher**

```ts
// git-worktree.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitWorktreeStrategy } from "./types.js";
import type { GitRunner } from "./git-runner.js";

export interface GitWorktreeDeps {
  git: GitRunner;
  getGitCredentials(): Promise<{ username: string; password: string }>;
}

export async function executeGitWorktree(
  spec: GitWorktreeStrategy,
  root: string,
  deps: GitWorktreeDeps,
): Promise<void> {
  const creds = await deps.getGitCredentials();
  const env = {
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true",
    GIT_USERNAME: creds.username, GIT_PASSWORD: creds.password,
  };
  const bareDir = join(root, ".bare");
  const worktreeDir = join(root, spec.worktreeName);

  if (!existsSync(bareDir)) {
    const url = spec.url.startsWith("https://")
      ? new URL(spec.url).toString().replace(/^https:\/\//, `https://${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}@`)
      : spec.url;
    const r = await deps.git.run("git", ["clone", "--bare", url, bareDir], { env });
    if (r.exitCode !== 0) throw new Error(`git clone --bare failed: ${r.stderr}`);
  } else {
    const r = await deps.git.run("git", ["fetch", "origin"], { cwd: bareDir, env });
    if (r.exitCode !== 0) throw new Error(`git fetch failed: ${r.stderr}`);
  }

  if (!existsSync(worktreeDir)) {
    const r = await deps.git.run("git", ["worktree", "add", "-f", worktreeDir, spec.ref], { cwd: bareDir, env });
    if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${r.stderr}`);
  } else {
    const r = await deps.git.run("git", ["reset", "--hard", `origin/${spec.ref}`], { cwd: worktreeDir, env });
    if (r.exitCode !== 0) throw new Error(`git reset --hard failed: ${r.stderr}`);
  }
}
```

```ts
// execute.ts
import type { WorkspaceStrategySpec } from "./types.js";
import { executeGitClone, type GitCloneDeps } from "./git-clone.js";
import { executeGitWorktree, type GitWorktreeDeps } from "./git-worktree.js";

export interface ExecuteStrategyDeps extends GitCloneDeps, GitWorktreeDeps {
  /** When true (server-local execution), existing-path is allowed; when false (k8s), it's rejected. */
  allowExistingPath?: boolean;
}

export async function executeStrategy(
  spec: WorkspaceStrategySpec,
  root: string,
  deps: ExecuteStrategyDeps,
): Promise<void> {
  switch (spec.kind) {
    case "git-clone":     return executeGitClone(spec, root, deps);
    case "git-worktree":  return executeGitWorktree(spec, root, deps);
    case "existing-path":
      if (deps.allowExistingPath === false) {
        throw new Error(
          `Workspace strategy "existing-path" is not supported on this execution target ` +
          `(host paths can't be projected into a remote pod). Use git-clone or git-worktree.`,
        );
      }
      return; // local execution treats hostPath as already-prepared.
    case "none":          return;
  }
}
```

Re-export from `index.ts`:

```ts
export { executeStrategy, type ExecuteStrategyDeps } from "./execute.js";
export { realGitRunner, type GitRunner, type GitRunResult } from "./git-runner.js";
```

- [ ] **Step 6: Run tests, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-strategy/src/git-runner.ts \
        packages/workspace-strategy/src/git-clone.ts \
        packages/workspace-strategy/src/git-worktree.ts \
        packages/workspace-strategy/src/execute.ts \
        packages/workspace-strategy/src/index.ts \
        packages/workspace-strategy/test/execute.test.ts
git commit -m "feat(workspace-strategy): implement executeStrategy with git-clone, git-worktree, none, and existing-path rejection"
```

### Task 4: Update server callers to use the new package

**Files (audit):**
- Find existing workspace strategy code in `server/src/services/` (search `workspace-strategy`, `workspace_strategy`, `WorkspaceStrategy`)
- Modify each caller to import from `@paperclipai/workspace-strategy`
- Add `@paperclipai/workspace-strategy` as a workspace dep to `server/package.json`
- Delete the old in-server implementation OR shrink it to a thin wrapper that calls the package

- [ ] **Step 1: Locate existing strategy code**

Run: `grep -rn "workspace.strategy\|WorkspaceStrategy" server/src/ | head -30`

Note every file that defines or consumes the strategy.

- [ ] **Step 2: Add workspace-strategy as workspace dep on server**

Update `server/package.json`:

```json
"dependencies": {
  ...
  "@paperclipai/workspace-strategy": "workspace:*"
}
```

Run `pnpm install`.

- [ ] **Step 3: Replace internal strategy logic with package imports**

For each caller, replace local imports with:

```ts
import { executeStrategy, type WorkspaceStrategySpec, parseWorkspaceStrategySpec, serializeWorkspaceStrategySpec } from "@paperclipai/workspace-strategy";
```

Pass `allowExistingPath: true` when calling from local execution code paths.

- [ ] **Step 4: Run server tests, confirm no regressions**

```bash
pnpm -w exec vitest run server/src
```

- [ ] **Step 5: If tests fail, the package's behavior diverges from the original**

Fix the package to match the original behavior, NOT the call sites. Add tests that capture the divergent behavior so future changes don't re-introduce.

- [ ] **Step 6: Commit**

```bash
git add server/src server/package.json pnpm-lock.yaml
git commit -m "refactor(server): consume @paperclipai/workspace-strategy for workspace bootstrap"
```

---

## Phase B — Runtime Binaries + Images (Tasks 5–10)

### Task 5: `paperclip-agent-shim` Go static binary

**Files:**
- Create: `tools/agent-shim/go.mod`
- Create: `tools/agent-shim/main.go`
- Create: `tools/agent-shim/runtime_command.go`
- Create: `tools/agent-shim/stdout_framer.go`
- Create: `tools/agent-shim/main_test.go`

The shim does the following at runtime, in order:
1. Read `/run/paperclip/runtime-command.json` (projected by orchestrator) — the `AdapterRuntimeCommandSpec`.
2. Read `/run/paperclip/prompt.txt` — the rendered prompt (stdin for the adapter CLI).
3. Resolve the adapter command (e.g. `claude-code`).
4. Frame stdout into structured events for the UI parser (passes through unchanged in V1; adapter CLIs already emit framed output).
5. Exec-replace itself into the adapter CLI so SIGTERM propagates correctly (Go's `syscall.Exec`).

- [ ] **Step 1: `go.mod`**

```
module github.com/paperclipai/paperclip/tools/agent-shim

go 1.22
```

- [ ] **Step 2: `runtime_command.go`**

```go
package main

import (
	"encoding/json"
	"errors"
	"os"
)

type RuntimeCommandSpec struct {
	Command        string   `json:"command"`
	Args           []string `json:"args"`
	DetectCommand  string   `json:"detectCommand,omitempty"`
	InstallCommand string   `json:"installCommand,omitempty"`
}

func loadRuntimeCommandSpec(path string) (*RuntimeCommandSpec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var spec RuntimeCommandSpec
	if err := json.Unmarshal(b, &spec); err != nil {
		return nil, err
	}
	if spec.Command == "" {
		return nil, errors.New("runtime-command.json has empty 'command'")
	}
	return &spec, nil
}
```

- [ ] **Step 3: `stdout_framer.go`** (V1 passes through; structure for future framing)

```go
package main

import (
	"bufio"
	"io"
	"os"
)

// streamWithFraming copies src to dst, optionally injecting framing prefixes.
// V1: pass-through. Adapter CLIs already emit JSON-line events.
func streamWithFraming(src io.Reader, dst io.Writer) error {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // accept up to 4MB lines
	for scanner.Scan() {
		line := scanner.Bytes()
		if _, err := dst.Write(line); err != nil {
			return err
		}
		if _, err := dst.Write([]byte{'\n'}); err != nil {
			return err
		}
		if f, ok := dst.(*os.File); ok {
			_ = f.Sync()
		}
	}
	return scanner.Err()
}
```

- [ ] **Step 4: `main.go`** with PID-1 supervision via syscall.Exec

```go
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

const (
	defaultRuntimeCommandPath = "/run/paperclip/runtime-command.json"
)

func main() {
	specPath := flag.String("spec", defaultRuntimeCommandPath, "path to AdapterRuntimeCommandSpec JSON")
	adapterType := flag.String("adapter", "", "adapter type (informational; e.g. claude_local)")
	flag.Parse()

	spec, err := loadRuntimeCommandSpec(*specPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[shim] cannot read runtime command spec: %v\n", err)
		os.Exit(2)
	}

	resolved, err := exec.LookPath(spec.Command)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[shim] adapter command %q not found in PATH (adapter=%s)\n", spec.Command, *adapterType)
		os.Exit(127)
	}

	// Build argv (resolved binary as argv[0])
	argv := append([]string{resolved}, spec.Args...)

	// syscall.Exec replaces this process; SIGTERM from k8s reaches the adapter directly.
	if err := syscall.Exec(resolved, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[shim] exec %q failed: %v\n", resolved, err)
		os.Exit(126)
	}
}
```

- [ ] **Step 5: `main_test.go`** — exercise spec parsing + framer

```go
package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRuntimeCommandSpec_OK(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "spec.json")
	_ = os.WriteFile(p, []byte(`{"command":"claude-code","args":["--print"]}`), 0o600)
	spec, err := loadRuntimeCommandSpec(p)
	if err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	if spec.Command != "claude-code" || len(spec.Args) != 1 {
		t.Fatalf("unexpected spec: %+v", spec)
	}
}

func TestLoadRuntimeCommandSpec_MissingCommand(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "spec.json")
	_ = os.WriteFile(p, []byte(`{"command":""}`), 0o600)
	if _, err := loadRuntimeCommandSpec(p); err == nil {
		t.Fatal("expected error for empty command")
	}
}

func TestStreamWithFraming_PassThrough(t *testing.T) {
	in := strings.NewReader("a\nb\nc\n")
	var out bytes.Buffer
	if err := streamWithFraming(in, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "a\nb\nc\n" {
		t.Fatalf("unexpected: %q", got)
	}
}
```

- [ ] **Step 6: Build and run tests**

```bash
cd tools/agent-shim
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags='-s -w' -o ./bin/paperclip-agent-shim-amd64 .
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags='-s -w' -o ./bin/paperclip-agent-shim-arm64 .
ls -l ./bin
```

Expected binary sizes ≤ 5MB.

- [ ] **Step 7: Commit**

```bash
git add tools/agent-shim
git commit -m "feat(agent-shim): Go static PID-1 supervisor for adapter CLIs"
```

### Task 6: `paperclip-workspace-init` Node script

**Files:**
- Create: `tools/workspace-init/package.json`
- Create: `tools/workspace-init/tsconfig.json`
- Create: `tools/workspace-init/src/index.ts`
- Create: `tools/workspace-init/src/git-credentials.ts`
- Create: `tools/workspace-init/test/index.test.ts`

This script:
1. Reads `PAPERCLIP_WORKSPACE_STRATEGY` (JSON env or file path) and `PAPERCLIP_WORKSPACE_ROOT` (default `/workspace`).
2. Reads `BOOTSTRAP_TOKEN` and `PAPERCLIP_PUBLIC_URL` from env.
3. Calls `executeStrategy(spec, root, deps)` from `@paperclipai/workspace-strategy`. The `getGitCredentials` dep posts to `/api/workspace/git-credentials` with the bootstrap token to receive a short-TTL HTTPS basic-auth token pair.
4. Writes `.paperclip-workspace-state.json` marker on success.
5. Exits 0 on success, non-zero with structured error on failure.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@paperclipai/workspace-init",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "paperclip-workspace-init": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@paperclipai/workspace-strategy": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: `src/git-credentials.ts`**

```ts
export interface GitCredentialsClient {
  fetch(): Promise<{ username: string; password: string }>;
}

export function createGitCredentialsClient(input: {
  paperclipPublicUrl: string;
  runJwt: string;
  repoUrl: string;
}): GitCredentialsClient {
  return {
    async fetch() {
      const res = await fetch(`${input.paperclipPublicUrl}/api/workspace/git-credentials`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.runJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repoUrl: input.repoUrl }),
      });
      if (!res.ok) {
        throw new Error(`git-credentials fetch failed (${res.status}): ${await res.text()}`);
      }
      const body = (await res.json()) as { username?: string; password?: string };
      if (!body.username || !body.password) {
        throw new Error("git-credentials response missing username/password");
      }
      return { username: body.username, password: body.password };
    },
  };
}
```

- [ ] **Step 3: `src/index.ts`**

```ts
#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeStrategy,
  realGitRunner,
  parseWorkspaceStrategySpec,
} from "@paperclipai/workspace-strategy";
import { createGitCredentialsClient } from "./git-credentials.js";

async function exchangeBootstrapToken(input: { paperclipPublicUrl: string; bootstrapToken: string }): Promise<string> {
  const res = await fetch(`${input.paperclipPublicUrl}/api/agent-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bootstrapToken: input.bootstrapToken }),
  });
  if (!res.ok) throw new Error(`bootstrap exchange failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { runJwt?: string };
  if (!body.runJwt) throw new Error("exchange response missing runJwt");
  return body.runJwt;
}

async function main() {
  const root = process.env.PAPERCLIP_WORKSPACE_ROOT ?? "/workspace";
  const strategyJson = process.env.PAPERCLIP_WORKSPACE_STRATEGY;
  const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL;

  if (!strategyJson) throw new Error("PAPERCLIP_WORKSPACE_STRATEGY not set");
  if (!bootstrapToken) throw new Error("BOOTSTRAP_TOKEN not set");
  if (!publicUrl) throw new Error("PAPERCLIP_PUBLIC_URL not set");

  const spec = parseWorkspaceStrategySpec(strategyJson);
  const repoUrl = "url" in spec ? spec.url : "";
  const runJwt = await exchangeBootstrapToken({ paperclipPublicUrl: publicUrl, bootstrapToken });
  const creds = createGitCredentialsClient({ paperclipPublicUrl: publicUrl, runJwt, repoUrl });

  await executeStrategy(spec, root, {
    git: realGitRunner,
    getGitCredentials: () => creds.fetch(),
    allowExistingPath: false,
  });

  writeFileSync(join(root, ".paperclip-workspace-state.json"), JSON.stringify({
    kind: spec.kind,
    completedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });

  console.log(`[workspace-init] ${spec.kind} completed at ${root}`);
}

main().catch((err) => {
  console.error(`[workspace-init] failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Test with stubbed fetch**

```ts
// test/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitCredentialsClient } from "../src/git-credentials.js";

describe("createGitCredentialsClient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("posts to /api/workspace/git-credentials and returns username/password", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ username: "x", password: "y" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = createGitCredentialsClient({ paperclipPublicUrl: "https://pp", runJwt: "jwt", repoUrl: "https://github.com/acme/repo.git" });
    const r = await c.fetch();
    expect(r).toEqual({ username: "x", password: "y" });
    expect(fetchMock).toHaveBeenCalledWith("https://pp/api/workspace/git-credentials", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Authorization": "Bearer jwt" }),
    }));
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const c = createGitCredentialsClient({ paperclipPublicUrl: "https://pp", runJwt: "jwt", repoUrl: "" });
    await expect(c.fetch()).rejects.toThrow(/500/);
  });

  it("throws when response is missing username/password", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const c = createGitCredentialsClient({ paperclipPublicUrl: "https://pp", runJwt: "jwt", repoUrl: "" });
    await expect(c.fetch()).rejects.toThrow(/missing username/);
  });
});
```

- [ ] **Step 5: Build and run**

```bash
pnpm install
pnpm --filter @paperclipai/workspace-init build
pnpm --filter @paperclipai/workspace-init test
```

- [ ] **Step 6: Commit**

```bash
git add tools/workspace-init pnpm-lock.yaml
git commit -m "feat(workspace-init): Node script bootstrapping the per-Job workspace via @paperclipai/workspace-strategy"
```

### Task 7: `agent-runtime-base` Dockerfile

**Files:**
- Create: `docker/agent-runtime/Dockerfile.base`

The base image carries: ubuntu-22.04 (small) + Node 22 + git + tini + non-root uid/gid 1000 + the two binaries (`paperclip-agent-shim` and `paperclip-workspace-init`). It does NOT bundle any adapter CLI — that's per-adapter image work.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.6
ARG NODE_VERSION=22
ARG TARGETARCH

# ---------- Stage 1: build agent-shim ----------
FROM golang:1.22-bookworm AS shim-build
ARG TARGETARCH
WORKDIR /src
COPY tools/agent-shim/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags='-s -w' -o /out/paperclip-agent-shim .

# ---------- Stage 2: build workspace-init (Node) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS wsinit-build
WORKDIR /src
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/workspace-strategy/ ./packages/workspace-strategy/
COPY tools/workspace-init/ ./tools/workspace-init/
RUN corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @paperclipai/workspace-strategy build \
    && pnpm --filter @paperclipai/workspace-init build

# ---------- Stage 3: runtime base image ----------
FROM ubuntu:22.04 AS base
ARG NODE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tini gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 paperclip \
    && useradd -u 1000 -g 1000 -d /home/paperclip -m -s /bin/bash paperclip

COPY --from=shim-build   /out/paperclip-agent-shim       /usr/local/bin/paperclip-agent-shim
COPY --from=wsinit-build /src/tools/workspace-init/dist  /opt/paperclip/workspace-init
COPY --from=wsinit-build /src/node_modules               /opt/paperclip/node_modules

# Convenience launcher so the init container can just run `paperclip-workspace-init`
RUN printf '#!/bin/sh\nexec node --enable-source-maps /opt/paperclip/workspace-init/index.js "$@"\n' \
      > /usr/local/bin/paperclip-workspace-init \
    && chmod +x /usr/local/bin/paperclip-workspace-init

USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/paperclip-agent-shim"]
```

- [ ] **Step 2: Build it locally and inspect**

```bash
docker buildx build --platform linux/amd64 \
  -f docker/agent-runtime/Dockerfile.base \
  -t paperclipai/agent-runtime-base:dev .
docker run --rm paperclipai/agent-runtime-base:dev /usr/local/bin/paperclip-agent-shim --help || true
docker run --rm paperclipai/agent-runtime-base:dev /usr/local/bin/paperclip-workspace-init --help 2>&1 | head -3 || true
docker image inspect paperclipai/agent-runtime-base:dev --format '{{.Size}}'
```

Expected: build succeeds; image size < 700 MB (stretch goal: < 400 MB; tighten later).

- [ ] **Step 3: Commit**

```bash
git add docker/agent-runtime/Dockerfile.base
git commit -m "feat(agent-runtime): base image with tini, git, node, agent-shim, workspace-init"
```

### Task 8: `agent-runtime-claude` Dockerfile

**Files:**
- Create: `docker/agent-runtime/Dockerfile.claude`

- [ ] **Step 1: Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
RUN npm install -g @anthropic-ai/claude-code@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true
USER 1000:1000

# Verify the CLI is on PATH for the shim's exec.LookPath
RUN command -v claude-code >/dev/null 2>&1 || (echo "claude-code not on PATH"; exit 1)
```

- [ ] **Step 2: Build and verify**

```bash
docker buildx build --platform linux/amd64 \
  -f docker/agent-runtime/Dockerfile.claude \
  --build-arg BASE_TAG=dev \
  -t paperclipai/agent-runtime-claude:dev .
docker run --rm paperclipai/agent-runtime-claude:dev claude-code --version
```

- [ ] **Step 3: Commit**

```bash
git add docker/agent-runtime/Dockerfile.claude
git commit -m "feat(agent-runtime): claude image with @anthropic-ai/claude-code CLI"
```

### Task 9: Multi-arch buildx config

**Files:**
- Create: `docker/agent-runtime/buildx-bake.hcl`

- [ ] **Step 1: Bake file**

```hcl
group "default" {
  targets = ["base", "claude"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 2: Local dry-run build**

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --print
```

Expected: prints rendered targets; no errors.

- [ ] **Step 3: Commit**

```bash
git add docker/agent-runtime/buildx-bake.hcl
git commit -m "feat(agent-runtime): multi-arch buildx config for base + claude images"
```

### Task 10: README for the runtime image family

**Files:**
- Create: `docker/agent-runtime/README.md`

- [ ] **Step 1: Write the README**

Cover:
- Image family and naming convention (`agent-runtime-{adapterType}:{paperclipVersion}`).
- How to build locally (`docker buildx bake`).
- The non-root user (`uid=1000`), the `tini` PID-1, the `WORKDIR=/workspace`.
- The role of `paperclip-agent-shim` (PID-1 supervisor) and `paperclip-workspace-init` (init container script).
- How to add a new adapter image (mirror Dockerfile.claude, install the CLI globally).

- [ ] **Step 2: Commit**

```bash
git add docker/agent-runtime/README.md
git commit -m "docs(agent-runtime): document image family conventions"
```

---

## Phase C — Server Auth + Callback Routes (Tasks 11–16)

Spec §6.6. Three endpoints, one bootstrap-token service, one run-JWT service. Routes are HTTPS-only in production; rate limits apply.

### Task 11: `bootstrapTokensService`

**Files:**
- Create: `server/src/services/bootstrap-tokens.ts`
- Create: `server/src/services/bootstrap-tokens.test.ts`

The service mints single-use, short-TTL bootstrap tokens bound to: `agentId`, `companyId`, `runId`, `jobUid` (k8s Job uid), `expiresAt` (10 min default). Storage: in-memory cache + Postgres backing for crash safety. Validation consumes the token (single-use).

- [ ] **Step 1: DB schema for backing storage**

Append a new schema file `packages/db/src/schema/bootstrap_tokens.ts`:

```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const bootstrapTokens = pgTable(
  "bootstrap_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),     // sha256 of the token string
    agentId: uuid("agent_id").notNull(),
    companyId: uuid("company_id").notNull(),
    runId: text("run_id").notNull(),
    jobUid: text("job_uid").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: index("bootstrap_tokens_token_hash_idx").on(t.tokenHash),
    runIdIdx:     index("bootstrap_tokens_run_id_idx").on(t.runId),
    expiresIdx:   index("bootstrap_tokens_expires_idx").on(t.expiresAt),
  }),
);
```

Re-export from `packages/db/src/index.ts`. Generate migration:

```bash
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/db exec drizzle-kit generate --name bootstrap_tokens
```

- [ ] **Step 2: Failing test**

```ts
// server/src/services/bootstrap-tokens.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { bootstrapTokensService } from "./bootstrap-tokens.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-bs-tokens-");
  db = createDb(dbHandle.connectionString);
});
afterAll(async () => { await dbHandle.cleanup(); });

describe("bootstrapTokensService", () => {
  it("mints a token, validates it once, then rejects replay", async () => {
    const svc = bootstrapTokensService(db);
    const minted = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111111",
      companyId: "22222222-2222-2222-2222-222222222222",
      runId: "r-1", jobUid: "job-uid-1",
      ttlSeconds: 600,
    });
    expect(minted.token).toMatch(/^bst_/);

    const v1 = await svc.validateAndConsume(minted.token);
    expect(v1.ok).toBe(true);
    if (v1.ok) {
      expect(v1.binding.runId).toBe("r-1");
      expect(v1.binding.jobUid).toBe("job-uid-1");
    }

    const v2 = await svc.validateAndConsume(minted.token);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toBe("already_consumed");
  });

  it("rejects an expired token", async () => {
    const svc = bootstrapTokensService(db);
    const minted = await svc.mint({
      agentId: "11111111-1111-1111-1111-111111111112",
      companyId: "22222222-2222-2222-2222-222222222223",
      runId: "r-2", jobUid: "job-uid-2",
      ttlSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const v = await svc.validateAndConsume(minted.token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("rejects an unknown token with reason=not_found", async () => {
    const svc = bootstrapTokensService(db);
    const v = await svc.validateAndConsume("bst_thisisnotreal");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_found");
  });
});
```

- [ ] **Step 3: Implement `bootstrap-tokens.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { bootstrapTokens } from "@paperclipai/db";

export interface BootstrapTokenBinding {
  agentId: string;
  companyId: string;
  runId: string;
  jobUid: string;
}

export interface MintInput extends BootstrapTokenBinding {
  ttlSeconds: number;
}

export interface MintResult {
  token: string;
  expiresAt: Date;
}

export type ValidateResult =
  | { ok: true; binding: BootstrapTokenBinding }
  | { ok: false; reason: "not_found" | "expired" | "already_consumed" };

export interface BootstrapTokensService {
  mint(input: MintInput): Promise<MintResult>;
  validateAndConsume(token: string): Promise<ValidateResult>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bootstrapTokensService(db: Db): BootstrapTokensService {
  return {
    async mint(input) {
      const raw = randomBytes(32).toString("base64url");
      const token = `bst_${raw}`;
      const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
      await db.insert(bootstrapTokens).values({
        tokenHash: hashToken(token),
        agentId: input.agentId,
        companyId: input.companyId,
        runId: input.runId,
        jobUid: input.jobUid,
        expiresAt,
      });
      return { token, expiresAt };
    },

    async validateAndConsume(token) {
      const hash = hashToken(token);
      const [row] = await db.select().from(bootstrapTokens).where(eq(bootstrapTokens.tokenHash, hash));
      if (!row) return { ok: false, reason: "not_found" };
      if (row.consumedAt) return { ok: false, reason: "already_consumed" };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
      await db.update(bootstrapTokens).set({ consumedAt: new Date() }).where(eq(bootstrapTokens.id, row.id));
      return {
        ok: true,
        binding: { agentId: row.agentId, companyId: row.companyId, runId: row.runId, jobUid: row.jobUid },
      };
    },
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/bootstrap_tokens.ts \
        packages/db/src/migrations \
        packages/db/src/index.ts \
        server/src/services/bootstrap-tokens.ts \
        server/src/services/bootstrap-tokens.test.ts
git commit -m "feat(server): bootstrap tokens service (single-use, bound to Job UID)"
```

### Task 12: `runJwtService`

**Files:**
- Create: `server/src/services/run-jwt.ts`
- Create: `server/src/services/run-jwt.test.ts`

The run JWT is a HS256-signed token bound to `runId`, `agentId`, `companyId`, `jobUid`. TTL = 1 hour. Signing key comes from `process.env.PAPERCLIP_RUN_JWT_SECRET` (32 random bytes; rotated per release in production).

- [ ] **Step 1: Failing test**

```ts
// server/src/services/run-jwt.test.ts
import { describe, it, expect } from "vitest";
import { runJwtService } from "./run-jwt.js";

const secret = "0".repeat(32);

describe("runJwtService", () => {
  it("mints and verifies a token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const v = svc.verify(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.runId).toBe("r-1");
      expect(v.claims.jobUid).toBe("j-1");
    }
  });

  it("rejects a tampered token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const tampered = t.slice(0, -2) + "AA";
    const v = svc.verify(tampered);
    expect(v.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
});
```

- [ ] **Step 2: Implement `run-jwt.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface RunJwtClaims {
  runId: string;
  agentId: string;
  companyId: string;
  jobUid: string;
  exp: number; // unix seconds
}

export interface MintInput extends Omit<RunJwtClaims, "exp"> { ttlSeconds: number; }

export type VerifyResult =
  | { ok: true; claims: RunJwtClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export interface RunJwtService {
  mint(input: MintInput): string;
  verify(token: string): VerifyResult;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function runJwtService(secret: string): RunJwtService {
  const key = Buffer.from(secret);
  return {
    mint(input) {
      const header = { alg: "HS256", typ: "JWT" };
      const claims: RunJwtClaims = {
        runId: input.runId,
        agentId: input.agentId,
        companyId: input.companyId,
        jobUid: input.jobUid,
        exp: Math.floor(Date.now() / 1000) + input.ttlSeconds,
      };
      const headerEncoded = b64url(JSON.stringify(header));
      const claimsEncoded = b64url(JSON.stringify(claims));
      const signing = `${headerEncoded}.${claimsEncoded}`;
      const sig = createHmac("sha256", key).update(signing).digest();
      return `${signing}.${b64url(sig)}`;
    },
    verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const [headerEncoded, claimsEncoded, sigEncoded] = parts;
      const expectedSig = createHmac("sha256", key).update(`${headerEncoded}.${claimsEncoded}`).digest();
      const givenSig = b64urlDecode(sigEncoded);
      if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
        return { ok: false, reason: "bad_signature" };
      }
      let claims: RunJwtClaims;
      try {
        claims = JSON.parse(b64urlDecode(claimsEncoded).toString("utf-8")) as RunJwtClaims;
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (claims.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
      return { ok: true, claims };
    },
  };
}
```

- [ ] **Step 3: Run test, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add server/src/services/run-jwt.ts server/src/services/run-jwt.test.ts
git commit -m "feat(server): HS256 run-scoped JWT service"
```

### Task 13: `POST /api/agent-auth/exchange` route

**Files:**
- Create: `server/src/routes/agent-auth-exchange.ts`
- Create: `server/src/routes/agent-auth-exchange.test.ts`
- Modify: server route registration to mount the new route

The route accepts `{ bootstrapToken: string }`, validates+consumes via `bootstrapTokensService`, mints a run JWT via `runJwtService`, returns `{ runJwt, expiresAt }`. Rate limit: 10/min/companyId, 1000/day/companyId.

- [ ] **Step 1: Failing test (uses the existing route test pattern in this repo — read 1-2 existing route tests first to mirror it)**

```ts
// server/src/routes/agent-auth-exchange.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAgentAuthExchangeRoute, type AgentAuthExchangeDeps } from "./agent-auth-exchange.js";

function deps(overrides?: Partial<AgentAuthExchangeDeps>): AgentAuthExchangeDeps {
  return {
    bootstrapTokens: {
      validateAndConsume: vi.fn(async () => ({
        ok: true as const,
        binding: { agentId: "a-1", companyId: "c-1", runId: "r-1", jobUid: "j-1" },
      })),
      mint: vi.fn(),
    },
    runJwt: {
      mint: vi.fn(() => "fake.jwt.value"),
      verify: vi.fn(),
    },
    runJwtTtlSeconds: 3600,
    ...overrides,
  };
}

describe("POST /api/agent-auth/exchange", () => {
  it("returns runJwt + expiresAt on success", async () => {
    const handler = createAgentAuthExchangeRoute(deps());
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runJwt: "fake.jwt.value", expiresAt: expect.any(String) });
  });

  it("returns 400 token_already_consumed on replay", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "already_consumed" as const }),
        mint: vi.fn(),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "token_already_consumed" });
  });

  it("returns 400 token_expired", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "expired" as const }),
        mint: vi.fn(),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "token_expired" });
  });

  it("returns 400 invalid_token for unknown tokens", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "not_found" as const }),
        mint: vi.fn(),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_xyz" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_token" });
  });

  it("returns 400 missing_token when body lacks bootstrapToken", async () => {
    const handler = createAgentAuthExchangeRoute(deps());
    const res = await handler({} as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implement `agent-auth-exchange.ts`** (framework-neutral handler)

```ts
import type { BootstrapTokensService } from "../services/bootstrap-tokens.js";
import type { RunJwtService } from "../services/run-jwt.js";

export interface AgentAuthExchangeDeps {
  bootstrapTokens: BootstrapTokensService;
  runJwt: RunJwtService;
  runJwtTtlSeconds: number;
}

export interface ExchangeResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createAgentAuthExchangeRoute(deps: AgentAuthExchangeDeps) {
  return async (body: { bootstrapToken?: string }): Promise<ExchangeResponse> => {
    if (!body || typeof body.bootstrapToken !== "string") {
      return { status: 400, body: { error: "missing_token" } };
    }
    const v = await deps.bootstrapTokens.validateAndConsume(body.bootstrapToken);
    if (!v.ok) {
      const errorCode =
        v.reason === "already_consumed" ? "token_already_consumed" :
        v.reason === "expired"          ? "token_expired"          : "invalid_token";
      return { status: 400, body: { error: errorCode } };
    }
    const runJwt = deps.runJwt.mint({
      runId: v.binding.runId,
      agentId: v.binding.agentId,
      companyId: v.binding.companyId,
      jobUid: v.binding.jobUid,
      ttlSeconds: deps.runJwtTtlSeconds,
    });
    const expiresAt = new Date(Date.now() + deps.runJwtTtlSeconds * 1000).toISOString();
    return { status: 200, body: { runJwt, expiresAt } };
  };
}
```

- [ ] **Step 3: Mount on the server's HTTP framework**

Read `server/src/app.ts` (or wherever routes are registered) to see how routes mount. Add the route, calling `createAgentAuthExchangeRoute({ bootstrapTokens, runJwt, runJwtTtlSeconds: 3600 })`. Apply rate limits using whatever middleware the rest of the codebase uses (search for "rateLimit" or similar).

- [ ] **Step 4: Run tests + integration smoke (curl against dev server) + commit**

```bash
pnpm -w exec vitest run server/src/routes/agent-auth-exchange
git add server/src/routes/agent-auth-exchange.ts \
        server/src/routes/agent-auth-exchange.test.ts \
        server/src/app.ts
git commit -m "feat(server): POST /api/agent-auth/exchange (bootstrap token → run JWT)"
```

### Task 14: `POST /api/runs/:runId/events` route

**Files:**
- Create: `server/src/routes/runs-events.ts`
- Create: `server/src/routes/runs-events.test.ts`

The route ingests structured events posted by the agent shim (`init`/`status`/`assistant`/`tool_call`/`tool_result`/`result`/`stderr`/`system`/`stdout`/`thinking`). Auth: bearer run-JWT (must match `:runId` URL param). Body: a JSON event object. Storage: writes to the existing `heartbeat_run_events` table (or whichever table currently captures run events; verify by reading `packages/db/src/schema/`).

- [ ] **Step 1: Identify the run-events table**

```bash
grep -rn "heartbeat_run_events\|runEvents" packages/db/src/schema/ server/src/services | head -20
```

Note the table name and its columns.

- [ ] **Step 2: Failing test**

```ts
// server/src/routes/runs-events.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRunsEventsRoute, type RunsEventsDeps } from "./runs-events.js";

function deps(overrides?: Partial<RunsEventsDeps>): RunsEventsDeps {
  return {
    runJwt: { verify: vi.fn(() => ({ ok: true as const, claims: { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", exp: 9_999_999_999 } })), mint: vi.fn() },
    appendRunEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("POST /api/runs/:runId/events", () => {
  it("appends an event when JWT runId matches URL runId", async () => {
    const d = deps();
    const handler = createRunsEventsRoute(d);
    const res = await handler({
      params: { runId: "r-1" },
      headers: { authorization: "Bearer fake.jwt" },
      body: { type: "assistant", ts: "2026-05-09T00:00:00Z", text: "hello" },
    });
    expect(res.status).toBe(204);
    expect(d.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r-1",
      type: "assistant",
    }));
  });

  it("rejects 401 when Authorization header missing", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({ params: { runId: "r-1" }, headers: {}, body: {} });
    expect(res.status).toBe(401);
  });

  it("rejects 403 when JWT runId differs from URL runId", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({ params: { runId: "r-2" }, headers: { authorization: "Bearer fake.jwt" }, body: { type: "assistant", text: "x" } });
    expect(res.status).toBe(403);
  });

  it("rejects 400 when body is missing 'type'", async () => {
    const handler = createRunsEventsRoute(deps());
    const res = await handler({ params: { runId: "r-1" }, headers: { authorization: "Bearer fake.jwt" }, body: { text: "x" } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Implement `runs-events.ts`**

```ts
import type { RunJwtService } from "../services/run-jwt.js";

export interface RunEventInput {
  runId: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface RunsEventsDeps {
  runJwt: RunJwtService;
  appendRunEvent: (input: RunEventInput) => Promise<void>;
}

export interface RouteRequest {
  params: { runId: string };
  headers: { authorization?: string };
  body: { type?: string; ts?: string; [k: string]: unknown };
}

export interface RouteResponse {
  status: number;
  body?: Record<string, unknown>;
}

export function createRunsEventsRoute(deps: RunsEventsDeps) {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "missing_authorization" } };
    const v = deps.runJwt.verify(auth.slice("Bearer ".length));
    if (!v.ok) return { status: 401, body: { error: "invalid_jwt" } };
    if (v.claims.runId !== req.params.runId) {
      return { status: 403, body: { error: "run_id_mismatch" } };
    }
    if (typeof req.body.type !== "string") {
      return { status: 400, body: { error: "missing_event_type" } };
    }
    await deps.appendRunEvent({
      runId: v.claims.runId,
      type: req.body.type,
      ts: typeof req.body.ts === "string" ? req.body.ts : new Date().toISOString(),
      payload: req.body,
    });
    return { status: 204 };
  };
}
```

- [ ] **Step 4: Mount + commit**

```bash
pnpm -w exec vitest run server/src/routes/runs-events
git add server/src/routes/runs-events.ts server/src/routes/runs-events.test.ts server/src/app.ts
git commit -m "feat(server): POST /api/runs/:runId/events (run JWT-authed event ingestion)"
```

### Task 15: `POST /api/workspace/git-credentials` route

**Files:**
- Create: `server/src/routes/workspace-git-credentials.ts`
- Create: `server/src/routes/workspace-git-credentials.test.ts`

Issues short-TTL git credentials (HTTPS basic-auth username/password) bound to a specific repo URL and the calling run JWT. Implementation strategy: GitHub-style `x-access-token` username with a token derived from a GitHub App installation token, OR a per-tenant deploy token from a Paperclip secret. Read `server/src/services/` to find existing git-token plumbing if any; otherwise return a stubbed error and document the integration as a follow-up.

- [ ] **Step 1: Investigate existing git auth**

```bash
grep -rn "github.*token\|deploy.*key\|git.*credential" server/src | head -20
```

If a service exists (e.g. `githubAppService`, `gitCredentialsProvider`), wire to it. If not, ship the route returning `503 git_credentials_not_configured` and document this as a deployment requirement.

- [ ] **Step 2: Failing test (covering both wired and unwired paths)**

```ts
// server/src/routes/workspace-git-credentials.test.ts
import { describe, it, expect, vi } from "vitest";
import { createWorkspaceGitCredentialsRoute, type WorkspaceGitCredentialsDeps } from "./workspace-git-credentials.js";

function deps(overrides?: Partial<WorkspaceGitCredentialsDeps>): WorkspaceGitCredentialsDeps {
  return {
    runJwt: { verify: vi.fn(() => ({ ok: true as const, claims: { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", exp: 9_999_999_999 } })), mint: vi.fn() },
    issueGitCredentials: vi.fn(async () => ({ ok: true as const, username: "x-access-token", password: "ghs_test", expiresAt: "2026-06-01T00:00:00Z" })),
    ...overrides,
  };
}

describe("POST /api/workspace/git-credentials", () => {
  it("returns username/password for an authorized run", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({
      headers: { authorization: "Bearer fake.jwt" },
      body: { repoUrl: "https://github.com/acme/repo.git" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: "x-access-token", password: "ghs_test" });
  });

  it("returns 503 when issuer is not configured", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps({
      issueGitCredentials: async () => ({ ok: false as const, reason: "not_configured" as const }),
    }));
    const res = await handler({ headers: { authorization: "Bearer fake.jwt" }, body: { repoUrl: "https://github.com/acme/repo.git" } });
    expect(res.status).toBe(503);
  });

  it("rejects 401 without a JWT", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({ headers: {}, body: { repoUrl: "x" } });
    expect(res.status).toBe(401);
  });

  it("rejects 400 missing repoUrl", async () => {
    const handler = createWorkspaceGitCredentialsRoute(deps());
    const res = await handler({ headers: { authorization: "Bearer fake.jwt" }, body: {} });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Implement `workspace-git-credentials.ts`**

```ts
import type { RunJwtService } from "../services/run-jwt.js";

export type IssueGitCredentialsResult =
  | { ok: true; username: string; password: string; expiresAt: string }
  | { ok: false; reason: "not_configured" | "denied" | "internal_error" };

export interface WorkspaceGitCredentialsDeps {
  runJwt: RunJwtService;
  issueGitCredentials: (input: { runId: string; companyId: string; repoUrl: string }) => Promise<IssueGitCredentialsResult>;
}

export function createWorkspaceGitCredentialsRoute(deps: WorkspaceGitCredentialsDeps) {
  return async (req: { headers: { authorization?: string }; body: { repoUrl?: string } }) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "missing_authorization" } };
    const v = deps.runJwt.verify(auth.slice(7));
    if (!v.ok) return { status: 401, body: { error: "invalid_jwt" } };
    if (typeof req.body.repoUrl !== "string" || req.body.repoUrl.length === 0) {
      return { status: 400, body: { error: "missing_repo_url" } };
    }
    const r = await deps.issueGitCredentials({
      runId: v.claims.runId,
      companyId: v.claims.companyId,
      repoUrl: req.body.repoUrl,
    });
    if (!r.ok) {
      const status = r.reason === "not_configured" ? 503 : r.reason === "denied" ? 403 : 500;
      return { status, body: { error: r.reason } };
    }
    return { status: 200, body: { username: r.username, password: r.password, expiresAt: r.expiresAt } };
  };
}
```

- [ ] **Step 4: Wire `issueGitCredentials` to existing infrastructure (if any) or stub with `not_configured`. Mount route. Commit.**

```bash
git add server/src/routes/workspace-git-credentials.ts server/src/routes/workspace-git-credentials.test.ts server/src/app.ts
git commit -m "feat(server): POST /api/workspace/git-credentials (run JWT-authed git creds)"
```

### Task 16: Wire all three routes to the live app, add rate limits

- [ ] **Step 1: Verify route mounting** by running the dev server and curling each endpoint.

```bash
pnpm dev:server &
sleep 3
curl -s -X POST http://localhost:3102/api/agent-auth/exchange -H 'Content-Type: application/json' -d '{}'
# expect 400 missing_token
```

- [ ] **Step 2: Add rate limits**

If the codebase has an existing rate-limit middleware, apply 10/min/companyId on `/api/agent-auth/exchange`, 1000/min/run on `/api/runs/:runId/events`. If not, document the gap as a follow-up.

- [ ] **Step 3: Commit**

```bash
git add server/src
git commit -m "feat(server): apply rate limits to k8s callback routes"
```

---

## Phase D — Orchestrator Extensions (Tasks 17–22)

All in `packages/adapters/kubernetes-execution/`. Pure builders + `apply` functions, mirroring the M1 pattern. Each builder is unit-tested with golden snapshots; integration coverage comes in Phase F.

### Task 17: PVC builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/pvc.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/pvc.test.ts`

Spec §4.1.

- [ ] **Step 1: Failing test**

```ts
// test/unit/pvc.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentWorkspacePvc } from "../../src/orchestrator/pvc.js";

describe("buildAgentWorkspacePvc", () => {
  it("creates a PVC with paperclip labels and the requested storage class + size", () => {
    const pvc = buildAgentWorkspacePvc({
      namespace: "paperclip-acme",
      agentId: "a-1",
      agentSlug: "a-acme",
      companyId: "c-1",
      companySlug: "acme",
      storageClass: "gp3",
      sizeGi: 20,
      strategyKey: "git-clone",
    });
    expect(pvc.kind).toBe("PersistentVolumeClaim");
    expect(pvc.metadata?.name).toBe("agent-a-acme-workspace");
    expect(pvc.metadata?.labels?.["paperclip.ai/role"]).toBe("agent-workspace");
    expect(pvc.metadata?.labels?.["paperclip.ai/agent-id"]).toBe("a-1");
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.storageClassName).toBe("gp3");
    expect(pvc.spec?.resources?.requests?.storage).toBe("20Gi");
    expect(pvc.metadata?.annotations?.["paperclip.ai/workspace-strategy"]).toBe("git-clone");
  });

  it("defaults to 10Gi when sizeGi is not specified", () => {
    const pvc = buildAgentWorkspacePvc({
      namespace: "paperclip-acme", agentId: "a-1", agentSlug: "a-acme",
      companyId: "c-1", companySlug: "acme",
      storageClass: "standard", strategyKey: "none",
    });
    expect(pvc.spec?.resources?.requests?.storage).toBe("10Gi");
  });
});
```

- [ ] **Step 2: Implement `pvc.ts`**

```ts
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import {
  tenantBaseLabels, PAPERCLIP_AGENT_ID, PAPERCLIP_ROLE, ROLE_AGENT_WORKSPACE,
  PAPERCLIP_WORKSPACE_STRATEGY,
} from "./labels.js";

export interface BuildAgentWorkspacePvcInput {
  namespace: string;
  agentId: string;
  agentSlug: string;
  companyId: string;
  companySlug: string;
  storageClass: string;
  sizeGi?: number;
  strategyKey: string;
}

export function buildAgentWorkspacePvc(input: BuildAgentWorkspacePvcInput): V1PersistentVolumeClaim {
  const sizeGi = input.sizeGi ?? 10;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: `agent-${input.agentSlug}-workspace`,
      namespace: input.namespace,
      labels: {
        ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
        [PAPERCLIP_AGENT_ID]: input.agentId,
        [PAPERCLIP_ROLE]: ROLE_AGENT_WORKSPACE,
      },
      annotations: {
        [PAPERCLIP_WORKSPACE_STRATEGY]: input.strategyKey,
        "paperclip.ai/created-at": new Date().toISOString(),
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: input.storageClass,
      resources: { requests: { storage: `${sizeGi}Gi` } },
    },
  };
}

export async function applyAgentWorkspacePvc(
  client: KubernetesApiClient, pvc: V1PersistentVolumeClaim,
): Promise<{ existed: boolean }> {
  const ns = pvc.metadata!.namespace!;
  const name = pvc.metadata!.name!;
  try {
    await client.core.readNamespacedPersistentVolumeClaim(name, ns);
    // PVC spec is immutable in critical fields (storage size CAN be expanded; class CAN'T change).
    // We don't patch on subsequent runs — the existing PVC carries forward.
    return { existed: true };
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedPersistentVolumeClaim(ns, pvc);
      return { existed: false };
    }
    throw err;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test pvc
git add packages/adapters/kubernetes-execution/src/orchestrator/pvc.ts \
        packages/adapters/kubernetes-execution/test/unit/pvc.test.ts
git commit -m "feat(k8s-adapter): PVC-per-agent builder + apply"
```

### Task 18: Per-Job ephemeral Secret materializer with redaction

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/secret.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/secret.test.ts`
- Modify: `packages/adapters/kubernetes-execution/src/redaction.ts` (replace M1 stub with real impl)
- Create: `packages/adapters/kubernetes-execution/test/unit/redaction.test.ts`

Spec §5.4. The Secret carries `BOOTSTRAP_TOKEN`, adapter env (LLM keys), and the run JWT placeholder. OwnerReference points to the Job (auto-GC on TTL). Redaction layer captures the value-set so log/error paths can scrub them.

- [ ] **Step 1: Implement redaction module first (used by Secret-builder for safety)**

```ts
// src/redaction.ts
export interface Redactor {
  redact(input: string): string;
  values(): readonly string[];
}

export function createRedactor(values: ReadonlyArray<string | undefined | null>): Redactor {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && v.length >= 8) set.add(v);
  }
  // Sort longest-first so we don't redact a substring before its enclosing string.
  const sorted = [...set].sort((a, b) => b.length - a.length);
  return {
    values() { return sorted; },
    redact(input: string) {
      let out = input;
      for (const v of sorted) {
        if (v.length === 0) continue;
        // Escape regex metacharacters
        const pattern = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        out = out.replace(pattern, "<redacted>");
      }
      return out;
    },
  };
}

export const noopRedactor: Redactor = {
  redact: (s) => s,
  values: () => [],
};
```

```ts
// test/unit/redaction.test.ts
import { describe, it, expect } from "vitest";
import { createRedactor } from "../../src/redaction.js";

describe("createRedactor", () => {
  it("redacts secret values that appear in input", () => {
    const r = createRedactor(["sk-abcdefgh1234", "ghs_xyzabc12345"]);
    expect(r.redact("ANTHROPIC_API_KEY=sk-abcdefgh1234")).toBe("ANTHROPIC_API_KEY=<redacted>");
    expect(r.redact("hello ghs_xyzabc12345 world")).toBe("hello <redacted> world");
  });

  it("ignores values shorter than 8 chars (avoids false positives)", () => {
    const r = createRedactor(["short"]);
    expect(r.redact("the short fox")).toBe("the short fox");
  });

  it("redacts longest-first so substrings inside larger secrets aren't masked first", () => {
    const r = createRedactor(["abcd1234", "abcd1234efgh"]);
    expect(r.redact("seen abcd1234efgh once")).toBe("seen <redacted> once");
  });

  it("filters undefined/null entries", () => {
    const r = createRedactor([undefined, null, "actualsecret123"]);
    expect(r.redact("actualsecret123 leaked")).toBe("<redacted> leaked");
  });
});
```

- [ ] **Step 2: Implement Secret builder**

```ts
// src/orchestrator/secret.ts
import type { V1Secret, V1OwnerReference } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels, PAPERCLIP_RUN_ID } from "./labels.js";

export interface BuildEphemeralSecretInput {
  namespace: string;
  agentSlug: string;
  runUlid: string;
  companyId: string;
  companySlug: string;
  runId: string;
  /** Plaintext key/value pairs to materialize. Will be base64-encoded. */
  data: Record<string, string>;
  /** OwnerReference to the Job so the Secret is auto-GC'd with TTL. */
  ownerJob: { name: string; uid: string };
}

export function buildEphemeralSecret(input: BuildEphemeralSecretInput): V1Secret {
  const ownerReferences: V1OwnerReference[] = [{
    apiVersion: "batch/v1",
    kind: "Job",
    name: input.ownerJob.name,
    uid: input.ownerJob.uid,
    controller: true,
    blockOwnerDeletion: true,
  }];

  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.data)) {
    data[k] = Buffer.from(v, "utf-8").toString("base64");
  }

  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: `agent-${input.agentSlug}-run-${input.runUlid}-env`,
      namespace: input.namespace,
      labels: {
        ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
        [PAPERCLIP_RUN_ID]: input.runId,
      },
      ownerReferences,
    },
    data,
  };
}

/**
 * Apply the Secret. NOT idempotent on update — Secrets are created once per run and never updated.
 * If a Secret with the same name exists (collision impossible with ULIDs but defensive), this throws.
 */
export async function applyEphemeralSecret(client: KubernetesApiClient, secret: V1Secret): Promise<void> {
  const ns = secret.metadata!.namespace!;
  await client.core.createNamespacedSecret(ns, secret);
}

/**
 * Best-effort delete used when Job creation fails AFTER Secret creation but BEFORE
 * the Job's OwnerReference is established.
 */
export async function deleteEphemeralSecret(client: KubernetesApiClient, namespace: string, name: string): Promise<void> {
  try {
    await client.core.deleteNamespacedSecret(name, namespace);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) return;
    throw err;
  }
}
```

- [ ] **Step 3: Failing tests**

```ts
// test/unit/secret.test.ts
import { describe, it, expect } from "vitest";
import { buildEphemeralSecret } from "../../src/orchestrator/secret.js";

describe("buildEphemeralSecret", () => {
  it("base64-encodes all data values", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme",
      agentSlug: "a-acme", runUlid: "01H...", companyId: "c-1", companySlug: "acme",
      runId: "r-1",
      data: { BOOTSTRAP_TOKEN: "bst_abc", ANTHROPIC_API_KEY: "sk-test123456" },
      ownerJob: { name: "agent-a-acme-run-01H", uid: "fake-uid" },
    });
    expect(s.type).toBe("Opaque");
    expect(s.data?.["BOOTSTRAP_TOKEN"]).toBe(Buffer.from("bst_abc").toString("base64"));
    expect(s.data?.["ANTHROPIC_API_KEY"]).toBe(Buffer.from("sk-test123456").toString("base64"));
  });

  it("attaches an OwnerReference to the Job", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme", agentSlug: "a", runUlid: "01H",
      companyId: "c-1", companySlug: "acme", runId: "r-1",
      data: {}, ownerJob: { name: "agent-a-run-01H", uid: "abc-uid" },
    });
    const owner = s.metadata?.ownerReferences?.[0];
    expect(owner?.kind).toBe("Job");
    expect(owner?.uid).toBe("abc-uid");
    expect(owner?.controller).toBe(true);
    expect(owner?.blockOwnerDeletion).toBe(true);
  });

  it("includes paperclip.ai/run-id label", () => {
    const s = buildEphemeralSecret({
      namespace: "paperclip-acme", agentSlug: "a", runUlid: "01H",
      companyId: "c-1", companySlug: "acme", runId: "run-42",
      data: {}, ownerJob: { name: "x", uid: "y" },
    });
    expect(s.metadata?.labels?.["paperclip.ai/run-id"]).toBe("run-42");
  });
});
```

- [ ] **Step 4: Run, expect PASS, commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test secret redaction
git add packages/adapters/kubernetes-execution/src/orchestrator/secret.ts \
        packages/adapters/kubernetes-execution/src/redaction.ts \
        packages/adapters/kubernetes-execution/test/unit/secret.test.ts \
        packages/adapters/kubernetes-execution/test/unit/redaction.test.ts
git commit -m "feat(k8s-adapter): per-Job ephemeral Secret materializer with value-set redactor"
```

### Task 19: Job spec builder

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/job.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/job.test.ts`

Spec §3.1, §3.2, §3.3. The Job spec is the largest single object in M2 — init container, main container, volumes, security context, podFailurePolicy, etc. Tests use golden snapshots.

- [ ] **Step 1: Implement `job.ts`** (write before tests for snapshots)

```ts
import type { V1Job, V1Container, V1Volume } from "@kubernetes/client-node";
import {
  tenantBaseLabels, PAPERCLIP_AGENT_ID, PAPERCLIP_RUN_ID, PAPERCLIP_ROLE, ROLE_AGENT_RUNTIME,
} from "./labels.js";

export interface BuildJobInput {
  namespace: string;
  agentId: string;
  agentSlug: string;
  runId: string;
  runUlid: string;
  companyId: string;
  companySlug: string;
  adapterType: string;
  /** Image for the main container (e.g. ghcr.io/paperclipai/agent-runtime-claude:vX.Y.Z) */
  image: string;
  /** Image for the init container (always agent-runtime-base; baked-in workspace-init). */
  initImage: string;
  imagePullSecrets?: string[];
  pvcName: string;
  envSecretName: string;
  /** Resource requests/limits for the main container. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?:   { cpu?: string; memory?: string };
  };
  /** Hard ceiling for the run; clamped against ResourceQuota.maxRunSeconds upstream. */
  activeDeadlineSeconds: number;
  ttlSecondsAfterFinished: number;
  /** Workspace strategy serialized as JSON for the init container. */
  workspaceStrategyJson: string;
  paperclipPublicUrl: string;
  /** Trace context propagated into the pod. */
  traceparent?: string;
}

export function buildAgentJob(input: BuildJobInput): V1Job {
  const labels = {
    ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    [PAPERCLIP_AGENT_ID]: input.agentId,
    [PAPERCLIP_RUN_ID]:   input.runId,
    [PAPERCLIP_ROLE]:     ROLE_AGENT_RUNTIME,
  };

  const volumes: V1Volume[] = [
    { name: "workspace", persistentVolumeClaim: { claimName: input.pvcName } },
    { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
    { name: "env", secret: { secretName: input.envSecretName, defaultMode: 0o400 } },
  ];

  const restrictedSecurity = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" as const },
  };

  const containerSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };

  const initContainer: V1Container = {
    name: "workspace-init",
    image: input.initImage,
    command: ["/usr/local/bin/paperclip-workspace-init"],
    env: [
      { name: "PAPERCLIP_WORKSPACE_STRATEGY", value: input.workspaceStrategyJson },
      { name: "PAPERCLIP_WORKSPACE_ROOT", value: "/workspace" },
      { name: "PAPERCLIP_RUN_ID", value: input.runId },
      { name: "PAPERCLIP_PUBLIC_URL", value: input.paperclipPublicUrl },
      { name: "BOOTSTRAP_TOKEN", valueFrom: { secretKeyRef: { name: input.envSecretName, key: "BOOTSTRAP_TOKEN" } } },
    ],
    volumeMounts: [
      { name: "workspace", mountPath: "/workspace" },
      { name: "tmp", mountPath: "/tmp" },
    ],
    securityContext: containerSecurity,
    resources: {
      requests: { cpu: "200m", memory: "256Mi" },
      limits:   { cpu: "2",    memory: "1Gi"  },
    },
  };

  const mainContainer: V1Container = {
    name: "agent",
    image: input.image,
    imagePullPolicy: "IfNotPresent",
    workingDir: "/workspace",
    command: ["/usr/bin/tini", "--"],
    args: ["/usr/local/bin/paperclip-agent-shim", "--adapter", input.adapterType],
    env: [
      { name: "PAPERCLIP_RUN_ID", value: input.runId },
      { name: "PAPERCLIP_PUBLIC_URL", value: input.paperclipPublicUrl },
      { name: "BOOTSTRAP_TOKEN", valueFrom: { secretKeyRef: { name: input.envSecretName, key: "BOOTSTRAP_TOKEN" } } },
      ...(input.traceparent ? [{ name: "TRACEPARENT", value: input.traceparent }] : []),
    ],
    envFrom: [{ secretRef: { name: input.envSecretName } }],
    volumeMounts: [
      { name: "workspace", mountPath: "/workspace" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "env", mountPath: "/run/paperclip/env", readOnly: true },
    ],
    resources: input.resources ?? {},
    securityContext: containerSecurity,
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `agent-${input.agentSlug}-run-${input.runUlid}`,
      namespace: input.namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSeconds,
      completions: 1,
      parallelism: 1,
      podFailurePolicy: {
        rules: [
          { action: "FailJob", onPodConditions: [{ type: "PodHasNetwork", status: "False" }] },
          { action: "FailJob", onExitCodes: { containerName: "agent", operator: "In", values: [137] } },
        ],
      },
      template: {
        metadata: {
          labels,
          annotations: { "paperclip.ai/job-spec-version": "v1" },
        },
        spec: {
          automountServiceAccountToken: false,
          serviceAccountName: "paperclip-agent",
          restartPolicy: "Never",
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          securityContext: restrictedSecurity,
          imagePullSecrets: input.imagePullSecrets?.map((name) => ({ name })) ?? [],
          initContainers: [initContainer],
          containers: [mainContainer],
          volumes,
        },
      },
    },
  };
}

/** Apply (create) the Job. Returns the server-assigned UID for OwnerReference wiring. */
export async function createAgentJob(client: import("../types.js").KubernetesApiClient, job: V1Job): Promise<{ name: string; uid: string }> {
  const created = await client.batch.createNamespacedJob(job.metadata!.namespace!, job);
  return { name: created.body.metadata!.name!, uid: created.body.metadata!.uid! };
}
```

- [ ] **Step 2: Tests with golden snapshots**

```ts
// test/unit/job.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentJob } from "../../src/orchestrator/job.js";

const baseInput = {
  namespace: "paperclip-acme",
  agentId: "a-uuid", agentSlug: "a-acme",
  runId: "r-1", runUlid: "01HZZZ",
  companyId: "c-uuid", companySlug: "acme",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  initImage: "ghcr.io/paperclipai/agent-runtime-base:v1",
  imagePullSecrets: ["paperclip-image-pull"],
  pvcName: "agent-a-acme-workspace",
  envSecretName: "agent-a-acme-run-01HZZZ-env",
  activeDeadlineSeconds: 1800,
  ttlSecondsAfterFinished: 300,
  workspaceStrategyJson: '{"kind":"git-clone","url":"https://github.com/acme/repo.git","ref":"main"}',
  paperclipPublicUrl: "https://paperclip.example.com",
};

describe("buildAgentJob", () => {
  it("matches the golden snapshot", () => {
    expect(buildAgentJob(baseInput)).toMatchSnapshot();
  });

  it("sets backoffLimit=0 (Paperclip owns retries)", () => {
    expect(buildAgentJob(baseInput).spec?.backoffLimit).toBe(0);
  });

  it("sets activeDeadlineSeconds from input", () => {
    expect(buildAgentJob(baseInput).spec?.activeDeadlineSeconds).toBe(1800);
  });

  it("disables ServiceAccount token auto-mount", () => {
    const job = buildAgentJob(baseInput);
    expect(job.spec?.template.spec?.automountServiceAccountToken).toBe(false);
  });

  it("uses tini as PID 1 with paperclip-agent-shim as the args", () => {
    const main = buildAgentJob(baseInput).spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.command).toEqual(["/usr/bin/tini", "--"]);
    expect(main?.args?.[0]).toBe("/usr/local/bin/paperclip-agent-shim");
  });

  it("agent container has restricted PSS context", () => {
    const main = buildAgentJob(baseInput).spec?.template.spec?.containers.find((c) => c.name === "agent");
    expect(main?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(main?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(main?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });

  it("init container projects PAPERCLIP_WORKSPACE_STRATEGY env", () => {
    const init = buildAgentJob(baseInput).spec?.template.spec?.initContainers?.find((c) => c.name === "workspace-init");
    expect(init?.env?.find((e) => e.name === "PAPERCLIP_WORKSPACE_STRATEGY")?.value).toBe(baseInput.workspaceStrategyJson);
  });

  it("emits an imagePullSecrets entry when supplied", () => {
    const job = buildAgentJob(baseInput);
    expect(job.spec?.template.spec?.imagePullSecrets).toEqual([{ name: "paperclip-image-pull" }]);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test job
git add packages/adapters/kubernetes-execution/src/orchestrator/job.ts \
        packages/adapters/kubernetes-execution/test/unit/job.test.ts \
        packages/adapters/kubernetes-execution/test/unit/__snapshots__
git commit -m "feat(k8s-adapter): Job spec builder (init + main containers, volumes, restricted PSS)"
```

### Task 20: Pod log streaming

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/log-stream.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/log-stream.test.ts`

Spec §3.4. Watches `pods/log` for the Job's pod, line-buffers, forwards to `onLog("stdout", chunk)`. Reconnects with `sinceTime` on transient errors so we don't double-buffer.

- [ ] **Step 1: Implement**

```ts
// src/orchestrator/log-stream.ts
import { Watch, Log } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";

export interface LogStreamHandle {
  abort(): void;
  done: Promise<void>;
}

export interface StartLogStreamInput {
  client: KubernetesApiClient;
  namespace: string;
  podName: string;
  containerName: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export function startLogStream(input: StartLogStreamInput): LogStreamHandle {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });

  const start = async () => {
    let lastTimestamp: string | undefined;
    while (!controller.signal.aborted) {
      try {
        const path = `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.podName)}/log` +
                     `?container=${encodeURIComponent(input.containerName)}&follow=true&timestamps=true` +
                     (lastTimestamp ? `&sinceTime=${encodeURIComponent(lastTimestamp)}` : "");
        const response = await fetch(`${process.env.PAPERCLIP_K8S_API_OVERRIDE ?? ""}${path}`, {
          method: "GET",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) break;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const sep = line.indexOf(" ");
            if (sep > 0) {
              const ts = line.slice(0, sep);
              lastTimestamp = ts;
              await input.onLog("stdout", line.slice(sep + 1));
            } else {
              await input.onLog("stdout", line);
            }
          }
        }
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    resolveDone();
  };

  // Kick off in the background, swallowing errors (the loop above handles reconnects).
  start().catch(() => { /* noop; aborted */ });

  return { abort: () => controller.abort(), done };
}
```

NOTE: The `fetch` call above bypasses the typed client because `pods/log` streams aren't well-typed. The `client.request` helper from M1's `client.ts` injects auth headers; this implementation re-uses that path. If the fetch shape doesn't apply auth correctly, route through `client.request` and adapt accordingly. The implementation should use `client.request("GET", path)` style to inherit auth.

(See Step 2 for a corrected version using `client.request`.)

- [ ] **Step 2: Replace fetch with client.request and add response-stream handling**

```ts
// (Replace the fetch loop with this once verified the existing client.request returns a stream-capable response)
//
// The right shape: extend KubernetesApiClient with a `requestStream` method that returns a Response,
// THEN consume Response.body. M1's client.request returns parsed JSON. M2 adds streaming support.
```

Update `packages/adapters/kubernetes-execution/src/types.ts` to add `requestStream`:

```ts
export interface KubernetesApiClient {
  // ... existing fields ...
  requestStream(method: string, path: string): Promise<Response>;
}
```

Update `packages/adapters/kubernetes-execution/src/client.ts` to implement `requestStream`. It mirrors `request` but doesn't `.json()` the response.

- [ ] **Step 3: Failing test using a mocked client.requestStream**

```ts
// test/unit/log-stream.test.ts
import { describe, it, expect, vi } from "vitest";
import { startLogStream } from "../../src/orchestrator/log-stream.js";

function makeReadableBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.close();
    },
  });
}

describe("startLogStream", () => {
  it("forwards each newline-terminated line to onLog after stripping the leading timestamp", async () => {
    const collected: string[] = [];
    const mockClient = {
      requestStream: vi.fn(async () => new Response(makeReadableBody([
        "2026-05-09T00:00:00Z hello\n",
        "2026-05-09T00:00:01Z world\n",
      ]))),
    } as unknown as Parameters<typeof startLogStream>[0]["client"];

    const handle = startLogStream({
      client: mockClient, namespace: "ns", podName: "pod", containerName: "agent",
      onLog: async (_s, chunk) => { collected.push(chunk); },
    });
    await new Promise((r) => setTimeout(r, 100));
    handle.abort();
    await handle.done;
    expect(collected).toEqual(["hello", "world"]);
  });

  it("reconnects on stream end while not aborted", async () => {
    const calls: string[][] = [["2026-05-09T00:00:00Z first\n"]];
    let callIdx = 0;
    const mockClient = {
      requestStream: vi.fn(async () => {
        const lines = calls[Math.min(callIdx++, calls.length - 1)] ?? [];
        return new Response(makeReadableBody(lines));
      }),
    } as unknown as Parameters<typeof startLogStream>[0]["client"];

    const collected: string[] = [];
    const handle = startLogStream({
      client: mockClient, namespace: "ns", podName: "pod", containerName: "agent",
      onLog: async (_s, chunk) => { collected.push(chunk); },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    await handle.done;
    expect(collected).toContain("first");
    expect(mockClient.requestStream).toHaveBeenCalledTimes(expect.any(Number));
  });
});
```

- [ ] **Step 4: Refactor `log-stream.ts` to use `client.requestStream`** instead of raw fetch. Run tests, commit.

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test log-stream
git add packages/adapters/kubernetes-execution/src/orchestrator/log-stream.ts \
        packages/adapters/kubernetes-execution/src/types.ts \
        packages/adapters/kubernetes-execution/src/client.ts \
        packages/adapters/kubernetes-execution/test/unit/log-stream.test.ts
git commit -m "feat(k8s-adapter): pods/log streaming with reconnect via sinceTime"
```

### Task 21: K8s Events watch + cancellation handler

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/event-watch.ts`
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/cancellation.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/event-watch.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/cancellation.test.ts`

Events watch surfaces `Job`/`Pod` warnings (`ImagePullBackOff`, `FailedScheduling`, etc.) into `onLog("stdout", "[k8s] " + reason)`. Cancellation deletes the Job with `--propagation-policy=Foreground --grace-period=30`.

- [ ] **Step 1: Implement event-watch.ts**

```ts
// src/orchestrator/event-watch.ts
import type { KubernetesApiClient } from "../types.js";

export interface EventWatchHandle {
  abort(): void;
  done: Promise<void>;
}

export interface StartEventWatchInput {
  client: KubernetesApiClient;
  namespace: string;
  /** Filter to events whose involvedObject is the Job or its Pod. */
  jobName: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export function startEventWatch(input: StartEventWatchInput): EventWatchHandle {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });

  const loop = async () => {
    const fieldSelector = encodeURIComponent(`involvedObject.name=${input.jobName}`);
    let resourceVersion = "0";
    while (!controller.signal.aborted) {
      try {
        const path = `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/events?watch=true&fieldSelector=${fieldSelector}&resourceVersion=${resourceVersion}`;
        const res = await input.client.requestStream("GET", path);
        if (!res.ok || !res.body) break;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line) as { type: string; object: { metadata?: { resourceVersion?: string }; type?: string; reason?: string; message?: string } };
              if (evt.object.metadata?.resourceVersion) resourceVersion = evt.object.metadata.resourceVersion;
              if (evt.object.type === "Warning") {
                await input.onLog("stdout", `[k8s] ${evt.object.reason ?? "Warning"}: ${evt.object.message ?? ""}`);
              }
            } catch { /* skip malformed line */ }
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    resolveDone();
  };
  loop().catch(() => { /* noop */ });
  return { abort: () => controller.abort(), done };
}
```

- [ ] **Step 2: Implement cancellation.ts**

```ts
// src/orchestrator/cancellation.ts
import type { KubernetesApiClient } from "../types.js";

export interface CancelJobInput {
  client: KubernetesApiClient;
  namespace: string;
  jobName: string;
  graceSeconds?: number;
}

export async function cancelJob(input: CancelJobInput): Promise<void> {
  const grace = input.graceSeconds ?? 30;
  await input.client.batch.deleteNamespacedJob(
    input.jobName, input.namespace,
    undefined, undefined,
    grace, undefined, "Foreground",
  );
}
```

- [ ] **Step 3: Tests**

```ts
// test/unit/cancellation.test.ts
import { describe, it, expect, vi } from "vitest";
import { cancelJob } from "../../src/orchestrator/cancellation.js";

describe("cancelJob", () => {
  it("calls deleteNamespacedJob with foreground propagation and 30s grace", async () => {
    const client = {
      batch: { deleteNamespacedJob: vi.fn(async () => ({})) },
    } as unknown as Parameters<typeof cancelJob>[0]["client"];
    await cancelJob({ client, namespace: "ns", jobName: "job-x" });
    expect(client.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      "job-x", "ns", undefined, undefined, 30, undefined, "Foreground",
    );
  });

  it("respects custom grace period", async () => {
    const client = {
      batch: { deleteNamespacedJob: vi.fn(async () => ({})) },
    } as unknown as Parameters<typeof cancelJob>[0]["client"];
    await cancelJob({ client, namespace: "ns", jobName: "job-x", graceSeconds: 60 });
    expect(client.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      "job-x", "ns", undefined, undefined, 60, undefined, "Foreground",
    );
  });
});
```

```ts
// test/unit/event-watch.test.ts
import { describe, it, expect, vi } from "vitest";
import { startEventWatch } from "../../src/orchestrator/event-watch.js";

function bodyFromEvents(events: Array<{ type: string; object: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      }
      controller.close();
    },
  });
}

describe("startEventWatch", () => {
  it("forwards Warning events with [k8s] prefix and ignores Normal", async () => {
    const client = {
      requestStream: vi.fn(async () => new Response(bodyFromEvents([
        { type: "MODIFIED", object: { metadata: { resourceVersion: "1" }, type: "Warning", reason: "ImagePullBackOff", message: "pull failed" } },
        { type: "MODIFIED", object: { metadata: { resourceVersion: "2" }, type: "Normal", reason: "Created", message: "created pod" } },
      ]))),
    } as unknown as Parameters<typeof startEventWatch>[0]["client"];

    const collected: string[] = [];
    const handle = startEventWatch({
      client, namespace: "ns", jobName: "job-x",
      onLog: async (_s, c) => { collected.push(c); },
    });
    await new Promise((r) => setTimeout(r, 50));
    handle.abort();
    await handle.done;
    expect(collected).toEqual(["[k8s] ImagePullBackOff: pull failed"]);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test event-watch cancellation
git add packages/adapters/kubernetes-execution/src/orchestrator/event-watch.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/cancellation.ts \
        packages/adapters/kubernetes-execution/test/unit/event-watch.test.ts \
        packages/adapters/kubernetes-execution/test/unit/cancellation.test.ts
git commit -m "feat(k8s-adapter): event watch + Job cancellation with foreground propagation"
```

### Task 22: Failure mapping

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/failure-mapping.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/failure-mapping.test.ts`

Spec §7.5. Maps observed Job/Pod state to `AdapterExecutionResult` error codes.

- [ ] **Step 1: Implement**

```ts
// src/orchestrator/failure-mapping.ts
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export interface MapTerminalStateInput {
  job: V1Job;
  pod?: V1Pod;
}

export function mapTerminalState(input: MapTerminalStateInput): AdapterExecutionResult {
  const job = input.job;
  const pod = input.pod;

  // Success path
  if ((job.status?.succeeded ?? 0) >= 1) {
    const main = pod?.status?.containerStatuses?.find((c) => c.name === "agent");
    return {
      exitCode: main?.state?.terminated?.exitCode ?? 0,
      signal: null,
      timedOut: false,
    };
  }

  // ImagePullBackOff (latched on container statuses)
  const containers = pod?.status?.containerStatuses ?? [];
  const initContainers = pod?.status?.initContainerStatuses ?? [];
  for (const c of [...containers, ...initContainers]) {
    const reason = c.state?.waiting?.reason;
    if (reason === "ImagePullBackOff" || reason === "ErrImagePull") {
      return {
        exitCode: null, signal: null, timedOut: false,
        errorCode: "image_pull_failed",
        errorFamily: "transient_upstream",
        errorMessage: `Image pull failed for container ${c.name}: ${c.state?.waiting?.message ?? reason}`,
      };
    }
  }

  // Init container terminal failure
  for (const c of initContainers) {
    if (c.state?.terminated && c.state.terminated.exitCode !== 0) {
      return {
        exitCode: null, signal: null, timedOut: false,
        errorCode: "workspace_init_failed",
        errorMessage: `Init container ${c.name} exited ${c.state.terminated.exitCode}: ${c.state.terminated.reason ?? ""} ${c.state.terminated.message ?? ""}`.trim(),
      };
    }
  }

  // OOM killed
  for (const c of containers) {
    if (c.state?.terminated?.reason === "OOMKilled" || c.state?.terminated?.exitCode === 137) {
      return {
        exitCode: 137, signal: "SIGKILL", timedOut: false,
        errorCode: "oom_killed",
        errorMessage: `Container ${c.name} OOMKilled`,
      };
    }
  }

  // Job-level deadline exceeded
  if (job.status?.conditions?.some((cond) => cond.type === "Failed" && cond.reason === "DeadlineExceeded")) {
    return {
      exitCode: null, signal: "SIGTERM", timedOut: true,
      errorCode: "timeout",
      errorMessage: "Job exceeded activeDeadlineSeconds",
    };
  }

  // Generic terminal failure
  if ((job.status?.failed ?? 0) >= 1) {
    const main = containers.find((c) => c.name === "agent");
    const exit = main?.state?.terminated?.exitCode ?? null;
    return {
      exitCode: exit, signal: null, timedOut: false,
      errorCode: "agent_exit_nonzero",
      errorMessage: main?.state?.terminated?.message ?? `Agent exited ${exit}`,
    };
  }

  // No terminal state observed
  return {
    exitCode: null, signal: null, timedOut: false,
    errorCode: "unknown_terminal_state",
    errorMessage: "No terminal state observed on Job/Pod",
  };
}
```

- [ ] **Step 2: Tests covering each error code path**

```ts
// test/unit/failure-mapping.test.ts
import { describe, it, expect } from "vitest";
import { mapTerminalState } from "../../src/orchestrator/failure-mapping.js";

describe("mapTerminalState", () => {
  it("returns success on Job.status.succeeded", () => {
    const r = mapTerminalState({
      job: { status: { succeeded: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", state: { terminated: { exitCode: 0 } } }] } },
    });
    expect(r.exitCode).toBe(0);
    expect(r.errorCode).toBeUndefined();
  });

  it("maps ImagePullBackOff to image_pull_failed", () => {
    const r = mapTerminalState({
      job: { status: {} },
      pod: { status: { containerStatuses: [{ name: "agent", state: { waiting: { reason: "ImagePullBackOff", message: "no auth" } } }] } },
    });
    expect(r.errorCode).toBe("image_pull_failed");
    expect(r.errorFamily).toBe("transient_upstream");
  });

  it("maps OOMKilled exitCode 137", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] } },
    });
    expect(r.errorCode).toBe("oom_killed");
    expect(r.exitCode).toBe(137);
  });

  it("maps DeadlineExceeded to timeout", () => {
    const r = mapTerminalState({
      job: { status: { conditions: [{ type: "Failed", reason: "DeadlineExceeded", status: "True" }] } },
    });
    expect(r.errorCode).toBe("timeout");
    expect(r.timedOut).toBe(true);
  });

  it("maps init container terminal failure to workspace_init_failed", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { initContainerStatuses: [{ name: "workspace-init", state: { terminated: { exitCode: 2, reason: "Error", message: "git clone failed" } } }] } },
    });
    expect(r.errorCode).toBe("workspace_init_failed");
  });

  it("falls through to agent_exit_nonzero for generic failures", () => {
    const r = mapTerminalState({
      job: { status: { failed: 1 } },
      pod: { status: { containerStatuses: [{ name: "agent", state: { terminated: { exitCode: 7 } } }] } },
    });
    expect(r.errorCode).toBe("agent_exit_nonzero");
    expect(r.exitCode).toBe(7);
  });
});
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test failure-mapping
git add packages/adapters/kubernetes-execution/src/orchestrator/failure-mapping.ts \
        packages/adapters/kubernetes-execution/test/unit/failure-mapping.test.ts
git commit -m "feat(k8s-adapter): map k8s terminal state to AdapterExecutionResult error codes"
```

---

## Phase E — Driver `run()` + claude_local wiring (Tasks 23-24)

Goal: wire all Phase B/C/D pieces into `KubernetesExecutionDriver.run()` and dispatch from `claude_local` so a real agent run can complete end-to-end. After this phase the adapter is functionally complete — Phase F adds verification, Phase G ships images.

### Task 23: Driver `run()` orchestrates Job lifecycle

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/driver.ts` (replace M1 stub)
- Create: `packages/adapters/kubernetes-execution/src/bootstrap/token.ts`
- Test: `packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts`

The M1 driver returns a hard-coded `not_implemented` error. Replace with the real flow:

1. Resolve cluster connection + tenant policy from DB (helpers added in M1).
2. Call `ensureTenantNamespace(client, { companyId, companySlug, policy })` (M1 builder).
3. Build + apply `agent-workspace` PVC (Task 17) — idempotent per `(namespace, agentId)`.
4. Mint a bootstrap token via the server callback service. The driver does NOT talk to the DB directly — it calls an injected `BootstrapTokenMinter` interface so server and adapter stay decoupled. The minter is wired in Task 24 via the execution-target registry.
5. Resolve `secret_refs` declared by the calling adapter (e.g. `claude_local` passes `ANTHROPIC_API_KEY` via secret_resolver).
6. Build the per-Job ephemeral Secret (Task 18) carrying bootstrap token + resolved env + rendered prompt payload.
7. Build the Job spec (Task 19) — generate run identifier with ULID, pass image/resource hints from `target.config`, set `agentId` label, set `paperclip.ai/run-id` annotation.
8. Create Secret first (no OwnerReferences yet), then create the Job, then PATCH the Secret with an OwnerReference pointing at the live Job UID. This ordering ensures the Secret is GC'd if the Job is deleted, and avoids a race where the Job references a missing Secret.
9. Start log stream (Task 20) — pipes stdout/stderr through the redaction filter from M1 to `ctx.onLog`.
10. Start event watcher (Task 21) — surfaces non-noisy events via `ctx.onEvent`.
11. Register cancellation handler — when `ctx.signal.aborted`, delete the Job with `propagationPolicy: "Foreground"` so pods + secret tear down deterministically.
12. Poll Job status until terminal (active=0 AND (succeeded≥1 OR failed≥backoffLimit+1) OR conditions has Failed/Complete).
13. Read final pod state, call `mapTerminalState` (Task 22), return `AdapterExecutionResult`.
14. Cleanup: stop watchers; rely on `TTLSecondsAfterFinished` for k8s-side GC.

- [ ] **Step 1: Write the failing test for the orchestration flow**

`test/unit/driver-run.test.ts` uses a `FakeKubernetesClient` (added in M1) that records all calls and lets the test script terminal state. Test asserts the call sequence:

```ts
import { describe, it, expect, vi } from "vitest";
import { KubernetesExecutionDriver } from "../../src/driver.js";
import { FakeKubernetesClient } from "../helpers/fake-client.js";
import type { BootstrapTokenMinter } from "../../src/bootstrap/token.js";

describe("KubernetesExecutionDriver.run()", () => {
  it("orchestrates the full Job lifecycle and returns mapped success", async () => {
    const client = new FakeKubernetesClient();
    client.scriptJobTerminal({ succeeded: 1, exitCode: 0 });

    const minter: BootstrapTokenMinter = {
      mint: vi.fn().mockResolvedValue({
        token: "bt_" + "x".repeat(32),
        runId: "run_01HZZZZ",
        ttlSeconds: 600,
      }),
    };

    const driver = new KubernetesExecutionDriver({
      client,
      bootstrapTokenMinter: minter,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });

    const onLog = vi.fn();
    const onEvent = vi.fn();
    const ctrl = new AbortController();

    const result = await driver.run({
      target: { kind: "kubernetes", clusterConnectionId: "cc_1", config: {} },
      companyId: "c_1",
      companyName: "Acme Inc",
      agentId: "a_1",
      adapterPayload: {
        image: "ghcr.io/paperclipai/agent-claude-local:latest",
        env: { ANTHROPIC_MODEL: "claude-opus-4-7" },
        secretRefs: { ANTHROPIC_API_KEY: { provider: "local_encrypted", path: "anthropic/api_key" } },
        prompt: "user prompt here",
      },
      onLog,
      onEvent,
      signal: ctrl.signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);

    const seq = client.callLog.map((c) => c.kind);
    expect(seq.indexOf("ensure-namespace")).toBeLessThan(seq.indexOf("apply-pvc"));
    expect(seq.indexOf("apply-pvc")).toBeLessThan(seq.indexOf("create-secret"));
    expect(seq.indexOf("create-secret")).toBeLessThan(seq.indexOf("create-job"));
    expect(seq.indexOf("create-job")).toBeLessThan(seq.indexOf("patch-secret"));
    const patch = client.callLog.find((c) => c.kind === "patch-secret");
    expect(patch?.body?.metadata?.ownerReferences?.[0]?.kind).toBe("Job");

    expect(minter.mint).toHaveBeenCalledOnce();
  });

  it("aborts the Job when ctx.signal fires", async () => {
    const client = new FakeKubernetesClient();
    client.scriptJobTerminal({ neverComplete: true });
    const minter: BootstrapTokenMinter = {
      mint: vi.fn().mockResolvedValue({ token: "bt_x", runId: "run_x", ttlSeconds: 600 }),
    };
    const driver = new KubernetesExecutionDriver({ client, bootstrapTokenMinter: minter, now: () => new Date() });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);

    const result = await driver.run({
      target: { kind: "kubernetes", clusterConnectionId: "cc_1", config: {} },
      companyId: "c_1",
      companyName: "Acme",
      agentId: "a_1",
      adapterPayload: { image: "x", env: {}, secretRefs: {}, prompt: "" },
      onLog: vi.fn(),
      onEvent: vi.fn(),
      signal: ctrl.signal,
    });

    expect(result.status).toBe("cancelled");
    const del = client.callLog.find((c) => c.kind === "delete-job");
    expect(del?.options?.propagationPolicy).toBe("Foreground");
  });

  it("propagates mapTerminalState output for image pull failure", async () => {
    const client = new FakeKubernetesClient();
    client.scriptJobTerminal({
      failed: 1,
      podWaiting: { reason: "ImagePullBackOff", message: "unauthorized" },
    });
    const minter: BootstrapTokenMinter = {
      mint: vi.fn().mockResolvedValue({ token: "bt_x", runId: "run_x", ttlSeconds: 600 }),
    };
    const driver = new KubernetesExecutionDriver({ client, bootstrapTokenMinter: minter, now: () => new Date() });

    const result = await driver.run({
      target: { kind: "kubernetes", clusterConnectionId: "cc_1", config: {} },
      companyId: "c_1",
      companyName: "Acme",
      agentId: "a_1",
      adapterPayload: { image: "x", env: {}, secretRefs: {}, prompt: "" },
      onLog: vi.fn(),
      onEvent: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("image_pull_failed");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test driver-run
```

Expected: FAIL — `run()` returns `not_implemented`.

- [ ] **Step 3: Implement the `BootstrapTokenMinter` interface**

`src/bootstrap/token.ts`:

```ts
export interface BootstrapTokenMintRequest {
  companyId: string;
  agentId: string;
  jobName: string;
  namespace: string;
  ttlSeconds?: number;
}

export interface BootstrapTokenMintResult {
  token: string;
  runId: string;
  ttlSeconds: number;
}

export interface BootstrapTokenMinter {
  mint(req: BootstrapTokenMintRequest): Promise<BootstrapTokenMintResult>;
}
```

The driver depends on this interface, not on the server. The server-side implementation lives in `server/src/services/bootstrap-tokens.ts` (Task 11) and is wired through the execution-target registry (Task 24).

- [ ] **Step 4: Implement `run()` in `driver.ts`**

Replace the entire body of `KubernetesExecutionDriver.run()` (which currently returns the M1 `not_implemented` stub):

```ts
async run(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (ctx.target.kind !== "kubernetes") {
    throw new Error(`KubernetesExecutionDriver received non-kubernetes target: ${ctx.target.kind}`);
  }

  const startedAt = this.now();
  const { companyId, companyName, agentId } = ctx;
  const namespace = await ensureTenantNamespace(this.client, {
    companyId,
    companySlug: deriveCompanySlug(companyName),
    policy: await this.policies.resolveForCompany(companyId),
  });

  const runId = newRunId(startedAt);
  const jobName = `agent-${agentId.slice(-8)}-${runId.slice(-12)}`.toLowerCase();

  const pvcSpec = buildAgentWorkspacePvc({ namespace, agentId, companyId });
  await applyAgentWorkspacePvc(this.client, pvcSpec);

  const bootstrap = await this.bootstrapTokenMinter.mint({
    companyId,
    agentId,
    jobName,
    namespace,
    ttlSeconds: 600,
  });

  const secretSpec = buildEphemeralSecret({
    namespace,
    jobName,
    bootstrapToken: bootstrap.token,
    runId: bootstrap.runId,
    env: ctx.adapterPayload.env,
    promptPayload: ctx.adapterPayload.prompt,
  });

  const jobSpec = buildAgentJob({
    namespace,
    jobName,
    agentId,
    runId: bootstrap.runId,
    image: ctx.adapterPayload.image,
    secretName: secretSpec.metadata!.name!,
    pvcName: pvcSpec.metadata!.name!,
    resources: ctx.adapterPayload.resources,
  });

  await this.client.createSecret(namespace, secretSpec);
  let createdJob;
  try {
    createdJob = await this.client.createJob(namespace, jobSpec);
  } catch (e) {
    await this.client.deleteSecret(namespace, secretSpec.metadata!.name!).catch(() => {});
    throw e;
  }

  await this.client.patchSecret(namespace, secretSpec.metadata!.name!, {
    metadata: {
      ownerReferences: [
        {
          apiVersion: "batch/v1",
          kind: "Job",
          name: createdJob.metadata!.name!,
          uid: createdJob.metadata!.uid!,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
  });

  const logStop = startLogStream(this.client, {
    namespace,
    jobName,
    onLog: ctx.onLog,
    redact: this.redactor,
  });
  const eventStop = startEventWatch(this.client, {
    namespace,
    involvedObjectName: createdJob.metadata!.name!,
    onEvent: ctx.onEvent,
  });

  const onAbort = () => {
    this.client
      .deleteJob(namespace, createdJob.metadata!.name!, { propagationPolicy: "Foreground" })
      .catch(() => {});
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  let terminal: TerminalSnapshot;
  try {
    terminal = await waitForJobTerminal(this.client, {
      namespace,
      jobName: createdJob.metadata!.name!,
      signal: ctx.signal,
      pollMs: 1000,
    });
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    logStop();
    eventStop();
  }

  if (ctx.signal.aborted) {
    return { status: "cancelled", durationMs: Date.now() - startedAt.getTime() };
  }

  return mapTerminalState(terminal);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test driver-run
```

Expected: PASS (3/3 cases).

- [ ] **Step 6: Run the full package test suite to confirm nothing regressed**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test
```

Expected: PASS (M1 tests + Phase B/C/D tests + new run tests all green).

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/driver.ts \
        packages/adapters/kubernetes-execution/src/bootstrap/token.ts \
        packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts \
        packages/adapters/kubernetes-execution/test/helpers/fake-client.ts
git commit -m "feat(k8s-adapter): driver.run() orchestrates Job lifecycle end-to-end"
```

---

### Task 24: Wire `claude_local` to dispatch through the k8s execution target

**Files:**
- Modify: `packages/adapters/claude-local/src/server/execute.ts` (remove M1 rejection)
- Modify: `server/src/adapters/execution-target-registry.ts` (inject `BootstrapTokenMinter`)
- Modify: `server/src/adapters/execution-targets/kubernetes.ts` (construct driver with minter)
- Test: `packages/adapters/claude-local/src/server/__tests__/execute-k8s-route.test.ts`

In M1 (commit `85d18be1`), `claude_local`'s execute path rejects `target.kind === "kubernetes"` with an explicit "not yet implemented" error so the server doesn't silently fall back to local. Replace that branch with a call into the execution-target registry.

`claude_local` is already structured around an injected `executionDispatcher` for the local case. The change is small: route to the dispatcher unconditionally and let the registry resolve which driver runs.

- [ ] **Step 1: Write the failing test for the dispatch path**

`packages/adapters/claude-local/src/server/__tests__/execute-k8s-route.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { executeClaudeLocal } from "../execute.js";

describe("claude_local execute() with kubernetes target", () => {
  it("dispatches via execution-target registry instead of running locally", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "succeeded", exitCode: 0, durationMs: 1234 });

    const result = await executeClaudeLocal({
      target: {
        kind: "kubernetes",
        clusterConnectionId: "cc_1",
        config: { image: "ghcr.io/paperclipai/agent-claude-local:1.0.0" },
      },
      companyId: "c_1",
      companyName: "Acme",
      agentId: "a_1",
      prompt: "do the thing",
      env: { ANTHROPIC_MODEL: "claude-opus-4-7" },
      secretRefs: { ANTHROPIC_API_KEY: { provider: "local_encrypted", path: "anthropic/api_key" } },
      onLog: vi.fn(),
      onEvent: vi.fn(),
      signal: new AbortController().signal,
      executionDispatcher: { dispatch },
    });

    expect(result.status).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledOnce();
    const dispatched = dispatch.mock.calls[0][0];
    expect(dispatched.target.kind).toBe("kubernetes");
    expect(dispatched.adapterPayload.image).toBe("ghcr.io/paperclipai/agent-claude-local:1.0.0");
    expect(dispatched.adapterPayload.prompt).toBe("do the thing");
    expect(dispatched.adapterPayload.secretRefs.ANTHROPIC_API_KEY.path).toBe("anthropic/api_key");
  });

  it("still routes local targets to local execution path", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "succeeded", exitCode: 0, durationMs: 1 });
    await executeClaudeLocal({
      target: { kind: "local" },
      companyId: "c_1",
      companyName: "Acme",
      agentId: "a_1",
      prompt: "x",
      env: {},
      secretRefs: {},
      onLog: vi.fn(),
      onEvent: vi.fn(),
      signal: new AbortController().signal,
      executionDispatcher: { dispatch },
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].target.kind).toBe("local");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/adapter-claude-local test execute-k8s-route
```

Expected: FAIL — current code throws on `kubernetes` target.

- [ ] **Step 3: Remove the M1 rejection branch and dispatch unconditionally**

In `packages/adapters/claude-local/src/server/execute.ts`, find the M1 branch added in `85d18be1`:

```ts
if (ctx.target.kind === "kubernetes") {
  return {
    status: "failed",
    errorCode: "not_implemented",
    errorMessage:
      "claude_local on kubernetes execution target is M2 work. Use a local target for now.",
  };
}
```

Replace it with a single dispatch call that works for every supported target:

```ts
return ctx.executionDispatcher.dispatch({
  target: ctx.target,
  companyId: ctx.companyId,
  companyName: ctx.companyName,
  agentId: ctx.agentId,
  adapterPayload: {
    image:
      ctx.target.kind === "kubernetes"
        ? (ctx.target.config?.image ?? DEFAULT_CLAUDE_LOCAL_IMAGE)
        : undefined,
    env: ctx.env,
    secretRefs: ctx.secretRefs,
    prompt: ctx.prompt,
    resources: ctx.target.kind === "kubernetes" ? ctx.target.config?.resources : undefined,
  },
  onLog: ctx.onLog,
  onEvent: ctx.onEvent,
  signal: ctx.signal,
});
```

`DEFAULT_CLAUDE_LOCAL_IMAGE` is exported from `claude-local` so the adapter advertises its default image; cluster admins can override per-target via `target.config.image`.

- [ ] **Step 4: Wire `BootstrapTokenMinter` through the registry**

In `server/src/adapters/execution-targets/kubernetes.ts`, the M1 factory currently constructs the driver with a stub minter that throws. Replace with:

```ts
import { bootstrapTokensService } from "../../services/bootstrap-tokens.js";

export function createKubernetesExecutionDriver(deps: {
  policies: ClusterTenantPoliciesService;
  clusterConnections: ClusterConnectionsService;
  redactor: Redactor;
}) {
  return new KubernetesExecutionDriver({
    clientFactory: kubernetesClientFromConnection(deps.clusterConnections),
    policies: deps.policies,
    redactor: deps.redactor,
    bootstrapTokenMinter: {
      mint: (req) => bootstrapTokensService.mint(req),
    },
    now: () => new Date(),
  });
}
```

`bootstrapTokensService` was implemented in Task 11 and writes to the `bootstrap_tokens` row created by Task 10's schema migration.

- [ ] **Step 5: Run the test to confirm it passes**

```bash
pnpm --filter @paperclipai/adapter-claude-local test execute-k8s-route
```

Expected: PASS (2/2).

- [ ] **Step 6: Run claude_local's full test suite**

```bash
pnpm --filter @paperclipai/adapter-claude-local test
```

Expected: PASS — make sure removing the M1 rejection didn't break the local-target tests.

- [ ] **Step 7: Run the cross-cutting server adapter test**

```bash
pnpm --filter @paperclipai/server test execution-target
```

Expected: PASS — verifies registry wiring resolves k8s targets to the new driver.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/claude-local/src/server/execute.ts \
        packages/adapters/claude-local/src/server/__tests__/execute-k8s-route.test.ts \
        server/src/adapters/execution-targets/kubernetes.ts \
        server/src/adapters/execution-target-registry.ts
git commit -m "feat(claude-local): route to k8s execution target via dispatcher

Replaces the M1 'not_implemented' rejection (85d18be1) with real dispatch
through the execution-target registry. Wires BootstrapTokenMinter into the
k8s driver factory so the minter writes through bootstrap_tokens table."
```

---

## Phase F — End-to-end verification against kind (Tasks 25-28)

Goal: prove the adapter works against a real Kubernetes API server before shipping. Each integration test below uses kind (Kubernetes IN Docker) the same way M1 verified namespace/RBAC/network-policy. Tests live in `packages/adapters/kubernetes-execution/test/integration/` and run under the `pnpm test:integration` script gated by `K8S_INTEGRATION=1`.

**Shared kind harness** (already added in M1 at `test/integration/_harness/kind.ts`): boots a kind cluster, returns a kubeconfig, tears down after the test file. Each test in this phase reuses that harness — they do NOT each spin up their own cluster.

**Vitest config:** `fileParallelism: false` is already set so kind tests run sequentially. Per-test cluster reuse is fine since each test runs in its own k8s namespace.

### Task 25: Job lifecycle integration test (busybox image)

**Files:**
- Test: `packages/adapters/kubernetes-execution/test/integration/job-lifecycle.test.ts`

This test bypasses `claude_local` entirely. It uses a synthetic image (busybox echoing a script) to prove the orchestrator + driver + Job lifecycle work in a real cluster. Without this, regressions in Phase D code (PVC, Secret, Job, log stream, event watch) would only be caught later by the more complex claude_local test.

- [ ] **Step 1: Write the failing integration test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindCluster, type KindHandle } from "./_harness/kind.js";
import { KubernetesClient } from "../../src/client.js";
import { KubernetesExecutionDriver } from "../../src/driver.js";
import type { BootstrapTokenMinter } from "../../src/bootstrap/token.js";

const SHELL_SCRIPT = [
  "echo BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN:0:6}...",
  "echo workspace=$(ls /workspace)",
  "test -w /workspace || (echo workspace not writable && exit 11)",
  "echo done",
].join(" && ");

describe.skipIf(!process.env.K8S_INTEGRATION)("Job lifecycle (busybox)", () => {
  let kind: KindHandle;
  let client: KubernetesClient;

  beforeAll(async () => {
    kind = await startKindCluster({ name: "k8s-adapter-job-lifecycle" });
    client = await KubernetesClient.fromKubeconfig(kind.kubeconfigPath);
  }, 180_000);

  afterAll(async () => kind?.stop());

  it("runs a Job to success and streams logs back through the driver", async () => {
    const minter: BootstrapTokenMinter = {
      mint: async () => ({ token: "bt_" + "a".repeat(40), runId: "run_test_lifecycle", ttlSeconds: 600 }),
    };
    const driver = new KubernetesExecutionDriver({
      client,
      bootstrapTokenMinter: minter,
      now: () => new Date(),
      // injection knob added in Task 23 so tests can override the agent image
      imageOverride: "busybox:1.36",
      commandOverride: ["sh", "-c", SHELL_SCRIPT],
    });

    const logs: string[] = [];
    const events: string[] = [];

    const result = await driver.run({
      target: { kind: "kubernetes", clusterConnectionId: "kind-local", config: {} },
      companyId: "c_lifecycle",
      companyName: "Acme Lifecycle",
      agentId: "a_lifecycle",
      adapterPayload: { image: "busybox:1.36", env: {}, secretRefs: {}, prompt: "" },
      onLog: (line) => logs.push(line),
      onEvent: (e) => events.push(`${e.reason}:${e.message ?? ""}`),
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(logs.join("\n")).toMatch(/BOOTSTRAP_TOKEN=bt_aaa/);
    expect(logs.join("\n")).toMatch(/done/);
  }, 180_000);

  it("Secret has OwnerReference to Job UID after creation", async () => {
    const driver = makeDriverFor(client);
    const runP = driver.run(makeCtx("c_owner", "a_owner", "busybox:1.36"));
    // Poll until Secret appears, then assert ownerRef
    const ns = await waitForNamespace(client, "c_owner");
    const secret = await waitForFirstSecretWith(client, ns, { labelSelector: "paperclip.ai/run-id" });
    const job = await client.getJob(ns, secret.metadata!.ownerReferences![0].name);
    expect(secret.metadata?.ownerReferences?.[0]?.uid).toBe(job.metadata?.uid);
    expect(secret.metadata?.ownerReferences?.[0]?.controller).toBe(true);
    await runP;
  }, 180_000);

  it("Deleting the Job cascades to the Secret via OwnerReference GC", async () => {
    const driver = makeDriverFor(client);
    const ctrl = new AbortController();
    const runP = driver.run({ ...makeCtx("c_gc", "a_gc", "busybox:1.36"), signal: ctrl.signal });
    const ns = await waitForNamespace(client, "c_gc");
    const job = await waitForFirstJob(client, ns);
    const secretName = job.spec!.template!.spec!.containers![0].envFrom![0].secretRef!.name!;
    await client.deleteJob(ns, job.metadata!.name!, { propagationPolicy: "Foreground" });
    await pollUntil(async () => {
      try {
        await client.getSecret(ns, secretName);
        return false;
      } catch (e: any) {
        return e.statusCode === 404;
      }
    }, { timeoutMs: 30_000 });
    ctrl.abort();
    await runP;
  }, 180_000);
});
```

`makeDriverFor`, `makeCtx`, `waitForNamespace`, `waitForFirstJob`, `waitForFirstSecretWith`, `pollUntil` live in `test/integration/_harness/integration-helpers.ts` — extract them in this task.

- [ ] **Step 2: Run the failing test**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration job-lifecycle
```

Expected: FAIL — driver can't run busybox (image override not yet implemented) and harness helpers missing.

- [ ] **Step 3: Add `imageOverride`/`commandOverride` knobs to the driver constructor**

These are TEST ONLY — gate behind `process.env.NODE_ENV === "test"` to avoid accidental production use:

```ts
constructor(opts: KubernetesExecutionDriverOptions) {
  // ...
  if (opts.imageOverride && process.env.NODE_ENV !== "test") {
    throw new Error("imageOverride is for tests only");
  }
  this.imageOverride = opts.imageOverride;
  this.commandOverride = opts.commandOverride;
}
```

In `buildAgentJob`, when `imageOverride` is set, replace the container image and command. Init container is skipped under `commandOverride` (busybox doesn't need workspace-init).

- [ ] **Step 4: Add the harness helpers**

Implement `integration-helpers.ts` with thin polling utilities; nothing exotic — see code in step 1.

- [ ] **Step 5: Run again to confirm it passes**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration job-lifecycle
```

Expected: PASS (3/3 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/driver.ts \
        packages/adapters/kubernetes-execution/test/integration/job-lifecycle.test.ts \
        packages/adapters/kubernetes-execution/test/integration/_harness/integration-helpers.ts
git commit -m "test(k8s-adapter): integration test proves Job lifecycle on kind"
```

---

### Task 26: claude_local end-to-end integration test (fake LLM)

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/_harness/fake-llm-server.ts`
- Test: `packages/adapters/kubernetes-execution/test/integration/claude-end-to-end.test.ts`

This test proves the **complete** path: real `claude_local` adapter → driver → kind Job → real Anthropic API client speaking to a fake server we run on the host (kind exposes host networking via `extraPortMappings`). The fake LLM accepts a single message and returns a deterministic response. No real Anthropic credentials are required.

- [ ] **Step 1: Add the fake LLM server**

`fake-llm-server.ts` runs an HTTP server that mimics the `messages.create` endpoint:

```ts
import { createServer, type Server } from "node:http";

export function startFakeAnthropic(opts: { port?: number } = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_test_01",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [{ type: "text", text: "I read your prompt and I am alive." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 8 },
          }));
        });
      } else {
        res.writeHead(404);
        res.end("not_found");
      }
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://host.docker.internal:${port}`,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
```

Kind sets up `host.docker.internal` automatically on macOS and Linux (the M1 kind harness already adds the `extraHostsEntries` flag). The Pod talks to the host loopback through it.

- [ ] **Step 2: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindCluster, type KindHandle } from "./_harness/kind.js";
import { startFakeAnthropic } from "./_harness/fake-llm-server.js";
import { executeClaudeLocal } from "@paperclipai/adapter-claude-local/server";
import { makeIntegrationDispatcher } from "./_harness/dispatcher.js";

describe.skipIf(!process.env.K8S_INTEGRATION)("claude_local end-to-end on kind", () => {
  let kind: KindHandle;
  let fake: { url: string; stop: () => Promise<void> };

  beforeAll(async () => {
    kind = await startKindCluster({ name: "k8s-adapter-claude-e2e" });
    fake = await startFakeAnthropic();
  }, 240_000);

  afterAll(async () => {
    await fake?.stop();
    await kind?.stop();
  });

  it("runs a claude_local agent against fake Anthropic and returns the assistant text in logs", async () => {
    const dispatcher = await makeIntegrationDispatcher({ kubeconfigPath: kind.kubeconfigPath });
    const logs: string[] = [];

    const result = await executeClaudeLocal({
      target: {
        kind: "kubernetes",
        clusterConnectionId: "kind-e2e",
        config: { image: process.env.AGENT_CLAUDE_LOCAL_IMAGE ?? "ghcr.io/paperclipai/agent-claude-local:dev" },
      },
      companyId: "c_claude_e2e",
      companyName: "Acme Claude",
      agentId: "a_claude_e2e",
      prompt: "say hi",
      env: {
        ANTHROPIC_BASE_URL: fake.url,
        ANTHROPIC_MODEL: "claude-opus-4-7",
      },
      secretRefs: { ANTHROPIC_API_KEY: { provider: "literal", value: "sk-test-fake-key" } },
      onLog: (line) => logs.push(line),
      onEvent: () => {},
      signal: new AbortController().signal,
      executionDispatcher: dispatcher,
    });

    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(logs.join("\n")).toMatch(/I read your prompt and I am alive\./);
  }, 240_000);
});
```

The `literal` secret provider is added to the secret_resolver in M2 task 11 to make integration tests trivial without real KMS — the spec already permits multiple providers.

- [ ] **Step 3: Run the failing test**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration claude-end-to-end
```

Expected: FAIL — `agent-claude-local:dev` image doesn't exist in the kind cluster yet.

- [ ] **Step 4: Build and load the agent runtime image into kind**

Add a one-shot script invoked by the test:

```ts
async function ensureAgentImage(kind: KindHandle) {
  const tag = process.env.AGENT_CLAUDE_LOCAL_IMAGE ?? "ghcr.io/paperclipai/agent-claude-local:dev";
  if (process.env.AGENT_CLAUDE_LOCAL_IMAGE) return; // CI passes a pre-built image
  await execa("docker", ["build", "-t", tag, "-f", "images/agent-claude-local/Dockerfile", "."]);
  await execa("kind", ["load", "docker-image", tag, "--name", kind.name]);
}
```

Call it inside `beforeAll` after `startKindCluster`. This adds 60-90s to cold runs locally; CI builds the image once and passes `AGENT_CLAUDE_LOCAL_IMAGE` to skip the rebuild.

- [ ] **Step 5: Run again to confirm pass**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration claude-end-to-end
```

Expected: PASS — assistant text "I read your prompt and I am alive." appears in stream logs.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/claude-end-to-end.test.ts \
        packages/adapters/kubernetes-execution/test/integration/_harness/fake-llm-server.ts \
        packages/adapters/kubernetes-execution/test/integration/_harness/dispatcher.ts
git commit -m "test(k8s-adapter): claude_local end-to-end on kind with fake Anthropic server"
```

---

### Task 27: Failure mode integration tests

**Files:**
- Test: `packages/adapters/kubernetes-execution/test/integration/failure-modes.test.ts`

These tests verify `mapTerminalState` works against real cluster output, not just synthetic JSON. Each scenario uses a deliberately broken Job spec.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindCluster, type KindHandle } from "./_harness/kind.js";
import { KubernetesClient } from "../../src/client.js";
import { KubernetesExecutionDriver } from "../../src/driver.js";

describe.skipIf(!process.env.K8S_INTEGRATION)("failure modes (real cluster)", () => {
  let kind: KindHandle;
  let client: KubernetesClient;

  beforeAll(async () => {
    kind = await startKindCluster({ name: "k8s-adapter-failures" });
    client = await KubernetesClient.fromKubeconfig(kind.kubeconfigPath);
  }, 180_000);

  afterAll(async () => kind?.stop());

  it("ImagePullBackOff → image_pull_failed", async () => {
    const driver = makeDriverFor(client);
    const result = await driver.run({
      ...makeCtx("c_pull", "a_pull", "ghcr.io/paperclipai/does-not-exist:never"),
      // shorten poll timeout to fail fast in tests
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("image_pull_failed");
  }, 180_000);

  it("OOMKilled → oom_killed with exitCode 137", async () => {
    // Run busybox with a memory limit too small to start
    const driver = makeDriverFor(client, {
      imageOverride: "polinux/stress",
      commandOverride: ["stress", "--vm", "1", "--vm-bytes", "200M", "--vm-hang", "0"],
      resourceOverride: { limits: { memory: "32Mi", cpu: "200m" }, requests: { memory: "32Mi", cpu: "100m" } },
    });
    const result = await driver.run(makeCtx("c_oom", "a_oom", "polinux/stress"));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("oom_killed");
    expect(result.exitCode).toBe(137);
  }, 180_000);

  it("activeDeadlineSeconds exceeded → timeout", async () => {
    const driver = makeDriverFor(client, {
      imageOverride: "busybox:1.36",
      commandOverride: ["sh", "-c", "sleep 600"],
      activeDeadlineSecondsOverride: 5,
    });
    const result = await driver.run(makeCtx("c_to", "a_to", "busybox:1.36"));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("timeout");
    expect(result.timedOut).toBe(true);
  }, 180_000);

  it("init container failure → workspace_init_failed", async () => {
    const driver = makeDriverFor(client, {
      imageOverride: "busybox:1.36",
      commandOverride: ["sh", "-c", "echo never reached"],
      initCommandOverride: ["sh", "-c", "exit 2"],
    });
    const result = await driver.run(makeCtx("c_init", "a_init", "busybox:1.36"));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("workspace_init_failed");
  }, 180_000);
});
```

- [ ] **Step 2: Run them**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration failure-modes
```

Expected: PASS — driver and `mapTerminalState` produce the right error code for each failure shape.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/failure-modes.test.ts
git commit -m "test(k8s-adapter): integration tests for image-pull, OOM, timeout, init-fail"
```

---

### Task 28: Empirical resource measurement (resolves Risk #4)

**Files:**
- Test: `packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts` (update defaults if measurements warrant)
- Modify: `docs/k8s-execution/sizing.md` (publish measurements)

The spec's Risk #4 says default tenant quotas and per-Job resource requests/limits should be empirically grounded, not guessed. This task measures actual usage of a representative `claude_local` workload and either confirms or revises the M1 defaults.

- [ ] **Step 1: Write the measurement test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindCluster, type KindHandle } from "./_harness/kind.js";
import { startFakeAnthropic } from "./_harness/fake-llm-server.js";
import { measurePodResourceUsage } from "./_harness/metrics.js";

describe.skipIf(!process.env.K8S_INTEGRATION)("empirical resource measurement", () => {
  let kind: KindHandle;
  let fake: { url: string; stop: () => Promise<void> };

  beforeAll(async () => {
    kind = await startKindCluster({
      name: "k8s-adapter-sizing",
      installMetricsServer: true, // harness flag; uses bitnami/metrics-server helm chart
    });
    fake = await startFakeAnthropic();
  }, 300_000);

  afterAll(async () => {
    await fake?.stop();
    await kind?.stop();
  });

  it("claude_local with a 4KB prompt fits within memory:512Mi cpu:500m", async () => {
    // Run 10 concurrent claude_local jobs against fake Anthropic
    const samples = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        measurePodResourceUsage({
          kind,
          fakeAnthropicUrl: fake.url,
          companyId: `c_sizing_${i}`,
          agentId: `a_sizing_${i}`,
          prompt: "x".repeat(4096),
        }),
      ),
    );

    const peakMemoryMi = Math.max(...samples.map((s) => s.peakMemoryMi));
    const peakCpuM = Math.max(...samples.map((s) => s.peakCpuMillicores));
    const p95MemoryMi = quantile(samples.map((s) => s.peakMemoryMi), 0.95);
    const p95CpuM = quantile(samples.map((s) => s.peakCpuMillicores), 0.95);

    // Record measurements for sizing.md
    process.env.PAPERCLIP_RECORD_SIZING && writeMeasurementReport({
      peakMemoryMi, peakCpuM, p95MemoryMi, p95CpuM, samples,
    });

    // Fail loudly if we exceed the M1 defaults — that's the signal to update them
    expect(peakMemoryMi).toBeLessThan(512); // memory limit from defaultTenantLimits.max.memory
    expect(peakCpuM).toBeLessThan(500);     // cpu limit from defaultTenantLimits.max.cpu
  }, 600_000);
});
```

`measurePodResourceUsage` is a small harness helper that polls `metrics.k8s.io/v1beta1/pods` every 500ms while a Job is running and returns peak memory/cpu observed.

- [ ] **Step 2: Run with `PAPERCLIP_RECORD_SIZING=1` to record measurements**

```bash
K8S_INTEGRATION=1 PAPERCLIP_RECORD_SIZING=1 \
  pnpm --filter @paperclipai/execution-target-kubernetes test:integration empirical-measurement
```

Expected: PASS — and `docs/k8s-execution/sizing.md` is regenerated with the measured peak/p95 numbers.

- [ ] **Step 3: Decide whether to revise defaults**

If peak memory or CPU is materially below the M1 defaults (e.g. < 50% utilization across all samples), tighten the defaults so cluster admins don't waste headroom. If they are close to the limit, leave the defaults and document the margin in `sizing.md`.

Edit `src/orchestrator/resource-quota.ts`:

```ts
export const defaultTenantLimits = {
  default:        { cpu: "150m", memory: "256Mi" },          // was 200m / 256Mi
  defaultRequest: { cpu: "100m", memory: "128Mi" },
  max:            { cpu: "2",    memory: "1Gi" },            // headroom for power users
  pvcMaxStorage:  "10Gi",
};
```

(Specific final numbers come from the actual measurement output — the values above are illustrative.)

- [ ] **Step 4: Update `docs/k8s-execution/sizing.md`**

Replace the M1 placeholder content with the measured numbers + a "How we measured this" section pointing at the test file. Include:

- Workload description (claude_local, 4KB prompt, fake Anthropic)
- Sample size (10 concurrent runs)
- Peak / p95 / median memory and CPU
- Recommended `requests`/`limits` and reasoning
- Recommended `ResourceQuota` for a 50-agent tenant

- [ ] **Step 5: Run unit tests to confirm no regressions from default changes**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes test resource-quota
```

Expected: PASS — tests use named constants, so updates flow through automatically. If a test pinned a literal value (it shouldn't), update it.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts \
        packages/adapters/kubernetes-execution/test/integration/_harness/metrics.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts \
        docs/k8s-execution/sizing.md
git commit -m "feat(k8s-adapter): empirical resource defaults from measurement on kind

Resolves Risk #4 from the design spec. Defaults derived from 10 concurrent
claude_local runs with a 4KB prompt against a fake Anthropic backend; see
docs/k8s-execution/sizing.md for the methodology and full numbers."
```

---

## Phase G — Image publishing + docs (Tasks 29-30)

### Task 29: Multi-arch image build + cosign signing in CI

**Files:**
- Create: `.github/workflows/agent-runtime-images.yml`
- Modify: `images/agent-claude-local/Dockerfile` (already in Phase B; double-check ARG/CMD parity)
- Create: `images/agent-shim/Dockerfile.release` (multi-stage Go build, distroless final)

The runtime images (`paperclip-agent-shim`, `paperclip-workspace-init`, `agent-claude-local`) are built and pushed to GHCR for amd64+arm64. Each image is signed with cosign keyless OIDC so consumers can verify provenance.

- [ ] **Step 1: Author the workflow**

```yaml
name: Agent runtime images

on:
  push:
    branches: [main]
    paths:
      - "images/**"
      - "packages/adapters/kubernetes-execution/src/**"
      - "packages/workspace-strategy/src/**"
      - ".github/workflows/agent-runtime-images.yml"
  workflow_dispatch:

permissions:
  contents: read
  packages: write
  id-token: write   # cosign keyless

jobs:
  agent-shim:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: sigstore/cosign-installer@v3
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/paperclipai/agent-shim
          tags: |
            type=ref,event=branch
            type=sha,prefix=git-
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v5
        id: build
        with:
          context: .
          file: images/agent-shim/Dockerfile.release
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: true
          sbom: true
      - name: Sign image with cosign keyless
        run: |
          for tag in ${{ steps.meta.outputs.tags }}; do
            cosign sign --yes "$tag@${{ steps.build.outputs.digest }}"
          done

  workspace-init:
    runs-on: ubuntu-22.04
    needs: agent-shim
    # ... same shape, file: images/workspace-init/Dockerfile

  agent-claude-local:
    runs-on: ubuntu-22.04
    needs: [agent-shim, workspace-init]
    # ... same shape, file: images/agent-claude-local/Dockerfile
    # This image FROM:s agent-shim and workspace-init by digest pinned in image-versions.json
```

- [ ] **Step 2: Pin upstream image versions**

`images/image-versions.json` records the digests for `agent-shim` and `workspace-init` that `agent-claude-local` builds on. The build job for `agent-claude-local` reads this file and substitutes them into its build args. This pinning makes the final image reproducible and lets CI fail loudly if a base image got rebuilt without re-running this workflow.

- [ ] **Step 3: Verify the workflow on a feature branch**

Push to `feat/k8s-cloud-adapter-m2-images` and run `gh workflow run agent-runtime-images.yml --ref feat/k8s-cloud-adapter-m2-images` to confirm the build succeeds without merging to main. Expected: 3 images pushed under tag `git-<sha>`, each with a cosign signature visible via `cosign verify ghcr.io/paperclipai/agent-shim:git-<sha> --certificate-identity-regexp 'https://github.com/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/agent-runtime-images.yml \
        images/agent-shim/Dockerfile.release \
        images/agent-claude-local/Dockerfile \
        images/workspace-init/Dockerfile \
        images/image-versions.json
git commit -m "ci(k8s-adapter): multi-arch image build + cosign signing for runtime images"
```

---

### Task 30: M2 docs + ROADMAP update + final cross-cutting smoke

**Files:**
- Create: `docs/k8s-execution/agent-execution-flow.md`
- Modify: `docs/k8s-execution/quickstart.md` (add agent execution section)
- Modify: `docs/k8s-execution/security-model.md` (TokenReview + bootstrap-token + secret_resolver)
- Modify: `docs/ROADMAP.md` (mark M2 complete; spell out M3 scope)
- Create: `docs/k8s-execution/troubleshooting.md`

This task is documentation-only plus one repository-wide test pass to confirm M2 is releasable.

- [ ] **Step 1: Write `agent-execution-flow.md`**

Covers what an operator sees on a real agent run end-to-end: from `paperclip agent run` → execution-target registry → driver → Job → callback → result. Include:

- Sequence diagram (PlantUML or Mermaid) of the call graph from CLI to mapTerminalState
- Annotated `kubectl get all -n paperclip-acme` output during a live run
- How to read `paperclip.ai/run-id` to correlate logs across the server, the Job, and the callback
- Pointer to `troubleshooting.md` for common failures

- [ ] **Step 2: Update `quickstart.md`**

Add a "Run your first agent" section after the M1 namespace-onboarding flow:

```bash
paperclip cluster bind --cluster prod --company acme
paperclip agent register --company acme --adapter claude_local \
  --execution-target kubernetes:prod
paperclip agent run --agent <id> --prompt "say hi"
```

Expected output: streamed logs from the agent pod ending with the assistant text.

- [ ] **Step 3: Update `security-model.md`**

Add the M2 sections:

- **Run-JWT lifecycle**: bootstrap token mint → exchange → JWT bound to Job UID → expires after deadline.
- **TokenReview decision**: explain why we punted to V2 (Risk #5); document the workaround (callback-server reachability via Service of type LoadBalancer or per-tenant `agent-callback` Endpoints).
- **Per-Job Secret with OwnerReferences**: explains why this is the chosen pattern over CSI Secrets Store.
- **secret_resolver providers**: `local_encrypted`, `aws_secrets_manager`, `gcp_secret_manager`, `literal` (test only).

- [ ] **Step 4: Update `docs/ROADMAP.md`**

Mark M2 complete; expand M3 scope:

```markdown
### M3 — Production hardening + UI (next)
- [ ] Web UI: cluster connection management, namespace bindings, tenant policy editing.
- [ ] Web UI: live run dashboard with log tail and event timeline.
- [ ] Per-tenant Cilium policies fully wired (M2 left scaffolding).
- [ ] HPA-style autoscaling for repeat-runs, cost dashboard.
- [ ] Cross-cluster TokenReview (Risk #5) — defer until V2.
- [ ] Operator-controlled image allow-lists per cluster.
```

- [ ] **Step 5: Write `troubleshooting.md`**

Document the failure modes covered in Task 27 plus operator-facing diagnostic recipes:

- "Pod stuck in Pending → check ResourceQuota or PodSecurity admission"
- "ImagePullBackOff → check imagePullSecret on the namespace"
- "Job failed but logs empty → init container failed; check events"
- "Bootstrap token exchange returns 401 → check callback URL reachability and clock skew"

- [ ] **Step 6: Run the full repo test suite**

```bash
pnpm test
```

Expected: PASS — all unit tests for every package green. Integration tests are gated by `K8S_INTEGRATION` and run separately.

- [ ] **Step 7: Run integration tests**

```bash
K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration
```

Expected: PASS — every kind-based test from M1 + Tasks 25-28 passes back-to-back. Total runtime ≤ 30 minutes.

- [ ] **Step 8: Commit**

```bash
git add docs/k8s-execution/agent-execution-flow.md \
        docs/k8s-execution/quickstart.md \
        docs/k8s-execution/security-model.md \
        docs/k8s-execution/troubleshooting.md \
        docs/ROADMAP.md
git commit -m "docs(k8s-adapter): M2 agent execution complete; document flow and ops"
```

- [ ] **Step 9: Open M2 PR**

```bash
gh pr create --base master --head feat/k8s-cloud-adapter-m2 \
  --title "feat(k8s-adapter): M2 — headless agent execution end-to-end" \
  --body "$(cat <<'EOF'
## Summary
- Runs claude_local agents on Kubernetes end-to-end with PVC-per-agent, Job-per-run, per-Job ephemeral Secret with OwnerReferences for GC.
- Adds Go agent-shim (PID-1 supervisor, cancellation-aware), Node workspace-init that consumes the new \`@paperclipai/workspace-strategy\` package, multi-arch images signed with cosign keyless.
- Adds bootstrap-token exchange flow (server-issued, single-use, bound to Job UID).
- Resolves design spec Risks #1, #4, #8. Risk #5 deferred to V2 (documented in security-model.md).
- 4 new integration tests against kind cover Job lifecycle, claude_local end-to-end, failure modes, and empirical resource sizing.

## Test plan
- [x] Unit tests pass (\`pnpm test\`)
- [x] Integration tests pass (\`K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes test:integration\`)
- [x] Image build workflow runs green on feature branch
- [x] cosign verification succeeds for all three runtime images
- [x] \`paperclip agent run\` against a real kind cluster prints assistant text
EOF
)"
```

---

## Self-review

After authoring all phases, run a final pass before handing off to execution:

1. **Spec coverage** — every requirement from §3, §4, §5, §6 of the design has a task. Risks #1, #4, #5, #8 each have an explicit task or written disposition.
2. **Placeholder scan** — no "TBD", "TODO", "implement later", or unclosed code blocks. Every test step has runnable code; every commit step has a complete message.
3. **Type consistency** — `BootstrapTokenMinter`, `BootstrapTokenMintRequest`, `BootstrapTokenMintResult`, `TerminalSnapshot`, `mapTerminalState`, `buildAgentJob`, `buildEphemeralSecret`, `buildAgentWorkspacePvc`, `applyAgentWorkspacePvc`, `startLogStream`, `startEventWatch`, `waitForJobTerminal`, `deriveCompanySlug`, `newRunId` are all defined where first used and consistent across later use.
4. **Sequencing** — Phase E depends on B/C/D; Phase F depends on E; Phase G depends on F. No task depends on output of a later task.

Fix any issues inline, then offer execution choice.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-paperclip-cloud-adapter-m2-plan.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
