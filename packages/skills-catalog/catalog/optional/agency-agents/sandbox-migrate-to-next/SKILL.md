---
name: "sandbox-migrate-to-next"
description: "Migrate Cloudflare Sandbox apps from stable @cloudflare/sandbox to @cloudflare/sandbox@next (SDK 1.0 preview). Use sandbox-next for apps already on the preview."
key: "paperclipai/optional/agency-agents/sandbox-migrate-to-next"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "sandbox"
  - "migrate"
  - "next"
defaultInstall: false
---
# Migrate stable → Sandbox SDK 1.0 preview (`@next`)

**Perform** the port. Follow the steps in order. Depth lives in docs—fetch the linked page when a step needs detail.

Human guide: [Migrate](https://developers.cloudflare.com/sandbox/1-0-preview/migrate/) · [1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/)

**New projects** should start on `@next` (**`sandbox-next`**), not this skill. **Day-to-day stable work** → **`sandbox-stable`**. Deprecated-API cleanup **without** moving to `@next` → [2026 deprecation guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/) first if needed.

Existing apps should migrate **when you can**, so you are ready when 1.0 becomes the stable release. Do **not** force production cutover without the user agreeing.

**Prefer installed `@next` types and the migrate doc over memory.**

## Workflow

1. **Review** hard rules and the replacement map  
2. **Audit** the codebase; list hits and target shapes  
3. **Clarify** with the user (cutover, bridge, Python image, unclear sites)  
4. **Upgrade** package, image, and code  
5. **Validate**  

Stop after any step that needs a user decision.

## Hard rules

- Worker package and container image must be the **same** `@next` line.  
- Production cutover uses **immediate** container rollout. Stable and `@next` control protocols are incompatible both ways; gradual rollout leaves a broken mixed window. In-flight container work can stop.  
- After cutover, `await sandbox.exec(...)` means process **started**, not command **finished**.  
- Argv is as-is (no implicit shell). Shell syntax needs an explicit shell binary.  
- Process handles have **no stdin** → terminals for interactive input.  
- Observation `timeout` / `AbortSignal` cancel the **wait only**, not the process.  
- No single retry loop for every error.  
- Do not invent APIs (`gitCheckout` on core, process stdin, string-exec completion helper).  
- Self-deployed bridge stays on **stable** (not part of the preview line yet).  

## Replacement map

| Stable | `@next` |
| ------ | ------- |
| `SANDBOX_TRANSPORT` / `transport` / `setTransport` | Remove — RPC only |
| `await sandbox.exec("cmd")` → buffered result | `await sandbox.exec(argv)` → handle, then `output` / waits |
| `execStream` / `startProcess` | Same handle: `logs`, `waitFor*`, `kill` |
| Default / named sessions | Gone — `cwd`/`env` per launch, or one shell script |
| `sandbox.terminal(request)` / session terminal | `createTerminal` + `terminal.connect(request)` |
| xterm `sessionId` | `terminalId` |
| Interpreter methods on `Sandbox` | `withInterpreter` → `sandbox.interpreter.*` |
| `gitCheckout` | argv `git` via `exec` |
| String kill signals | Numeric only |
| Files, mounts, backups, ports, tunnels, `proxyToSandbox` | Mostly unchanged (ignore session/transport bits on stable pages) |

Depth: [Migrate](https://developers.cloudflare.com/sandbox/1-0-preview/migrate/) · after port, day-to-day → **`sandbox-next`**

## Audit

```sh
rg 'SANDBOX_TRANSPORT|transport:|setTransport|enableDefaultSession|createSession|getSession|deleteSession|execStream\(|startProcess\(|killProcess\(|sandbox\.terminal\(|sessionId|gitCheckout\(|SandboxTransport|ExecutionSession'
```

Also: string `exec(`, `cd` then a later `exec`, bare `createCodeContext` / `runCode` on `Sandbox`.

## Clarify (ask when needed)

- OK to cut production with `--containers-rollout=immediate` (live processes/terminals/streams may stop)?  
- Self-deployed bridge? Leave on stable.  
- Python interpreter → **`-python`** image variant?  
- Call sites not covered by the map?  

## Upgrade

### Package and image

```sh
npm install @cloudflare/sandbox@next
```

```dockerfile
FROM cloudflare/sandbox:next
# Python: cloudflare/sandbox:next-python
```

Same prerelease tag on Worker and image when not on floating `next`.

### Code by area

Apply replacements from the map. For each area, implement from the doc—not from stable habits:

| Area | Doc |
| ---- | --- |
| Commands / handles / waits | [Processes](https://developers.cloudflare.com/sandbox/1-0-preview/processes/) · [Processes API](https://developers.cloudflare.com/sandbox/1-0-preview/api/processes/) |
| `cwd` / `env` / secrets | [Environment](https://developers.cloudflare.com/sandbox/1-0-preview/environment/) · [Outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) |
| Drop sessions | [Migrate](https://developers.cloudflare.com/sandbox/1-0-preview/migrate/) · [Lifecycle](https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/) |
| Terminals | [Terminals](https://developers.cloudflare.com/sandbox/1-0-preview/terminals/) |
| Interpreter | [Interpreter](https://developers.cloudflare.com/sandbox/1-0-preview/interpreter/) |
| Errors | [Errors](https://developers.cloudflare.com/sandbox/1-0-preview/errors/) |
| Durable job across requests | [Process execution — lifetime / durability](https://developers.cloudflare.com/sandbox/1-0-preview/processes/) |

**Commands (shape):**

```ts
// Before (stable)
const result = await sandbox.exec("npm test");

// After (@next)
const process = await sandbox.exec(["/bin/bash", "-lc", "npm test"]);
const result = await process.output({ encoding: "utf8" });
```

```ts
const server = await sandbox.exec(["/bin/bash", "-lc", "npm run dev"], {
  cwd: "/workspace/app",
});
await server.waitForPort(3000, { timeout: 60_000 });
await server.kill(); // numeric; default 15
```

**Terminals (shape):**

```ts
const terminal = await sandbox.createTerminal({ command: ["bash"], cwd: "/workspace" });
const t = await sandbox.getTerminal(terminal.id);
if (!t) return new Response("terminal gone", { status: 410 });
return t.connect(request, { cursor, cols, rows });
```

**Interpreter (shape):**

```ts
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { withInterpreter } from "@cloudflare/sandbox/interpreter";

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);
}
```

**Git (shape):**

```ts
const clone = await sandbox.exec(
  ["git", "clone", "--depth", "1", "--", repoUrl, "/workspace/repo"],
  { cwd: "/workspace" },
);
const result = await clone.output({ encoding: "utf8" });
```

Delete transport settings entirely. Remove session APIs. Isolate users with **separate sandbox IDs**.

### Deploy cutover

Staging/branch first. Production is **one** deploy of matching Worker + image:

```sh
npx wrangler deploy --containers-rollout=immediate
```

Leave `rollout_active_grace_period` at default `0` (or set `0` if raised). After cutover, pre-deploy process/terminal IDs are invalid. Details: [Migrate](https://developers.cloudflare.com/sandbox/1-0-preview/migrate/) · [Container rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/)

## Validate

1. Lockfile + Dockerfile on the same `@next` line  
2. Typecheck against `@next`  
3. Smoke argv `exec` + `output({ encoding: "utf8" })`  
4. Smoke long process / terminal / interpreter if used  
5. Errors distinguished: unavailable / interrupted-RPC / stale / local wait  
6. No live secrets in sandbox env  
7. Grep again for removed APIs  
8. Production used `--containers-rollout=immediate`  

Then day-to-day work uses **`sandbox-next`**.

## Red flags — stop and fix

- Mixing `@next` Worker with stable image (or reverse)  
- Gradual container rollout for this cutover  
- Treating `await exec` as command completion  
- Assuming `cd` / exports persist across `exec` calls  
- One retry wrapper for every error  
- Inventing `gitCheckout`, process stdin, or undocumented APIs  
- Keeping pre-cutover process/terminal IDs after deploy  
- Forcing production cutover without user agreement  
- Putting live secrets in `setEnvVars` / launch `env`  
